import { Injectable, Res, HttpStatus, Req, Query } from '@nestjs/common';
import { Request, Response } from 'express';
import * as UaParser from 'ua-parser-js';
import isMobile from 'ismobilejs';
import { EntityManager } from 'typeorm';
import { InjectRepository, InjectEntityManager } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Base } from './base.entity';
import { HttpService } from '@nestjs/axios';
import * as iconvLite from 'iconv-lite';
import { logger } from '../utils/logger';
import { SITE_ID_CONFIG } from '../config/siteId';
import { createHmac } from 'crypto';
import { getTimeQuerySql, resServerError } from '../utils/utils';

let baseRepositoryCopy = null;
let httpServiceCopy = null;
const log = logger('base');
const logErrorStack = logger('errorStack');

@Injectable()
export class BaseService {
  constructor(
    @InjectRepository(Base)
    private readonly baseRepository: Repository<Base>,
    @InjectEntityManager('default')
    private entityManager: EntityManager,
    private httpService: HttpService,
  ) {
    // static 方法拿不到 this，main.ts 全局拦截又需要 static
    baseRepositoryCopy = baseRepository;
    httpServiceCopy = httpService;
  }

  /**
   * @description 实时访客 - 访客列表
   * @param res
   * @param req
   * @param query
   */
  async findAccess(@Res() res: Response, @Req() req: Request, @Query() query) {
    log.info(query);
    console.log(query);
    const { pageIndex = 1, pageCount = 20 } = query;
    let {
      orderBy = 'desc', // 升序 asc、降序 desc
      sortColumn = 'time', // 排序字段
    } = query;
    orderBy = orderBy || 'desc';
    sortColumn = sortColumn || 'time';

    // pageCount、visitDuration
    // ip: '',
    // referrer: 'baidu.com',
    // deviceType: 'mobile',
    // isOldUser: 'true',
    // date: '2022-04-06,2022-05-03'
    let siteId = query.siteId || '';
    // 校验 siteId 防止 sql 注入
    const isNotNumOrStr = /[^0-9a-zA-Z]/g;
    if (isNotNumOrStr.test(siteId) || siteId.length > 32) {
      siteId = '';
    }
    // const result: Base[] = await this.baseRepository.find({
    //   where: {
    //     siteId,
    //   },
    //   order: {
    //     time: 'DESC',
    //   },
    //   skip: (pageIndex - 1) * pageCount,
    //   take: pageCount,
    // });
    const skip = (pageIndex - 1) * pageCount;
    let queryRule = '';
    if (query.ip) {
      queryRule += `and ip like '%${query.ip}%' `;
    }
    if (query.referrer) {
      switch (query.referrer) {
        case 'direct':
          queryRule += `and referer='' `;
          break;
        case 'otherLink':
          queryRule += `and referer != '' and referer not like '%baidu.com%' and referer not like '%google.com%' and referer not like '%so.com%'`;
          break;
        default:
          queryRule += `and referer like '%${query.referrer}%' `;
      }
    }
    if (query.deviceType) {
      const isMobile = query.deviceType === 'mobile' ? 1 : 0;
      queryRule += `and isMobile=${isMobile} `;
    }
    if (query.isOldUser) {
      const isOldUser = query.isOldUser === 'true' ? 1 : 0;
      queryRule += `and isOldUser=${isOldUser} `;
    }
    if (query.date) {
      const [startDate, endDate] = query.date.split(',');
      queryRule += getTimeQuerySql(startDate, endDate);
    }
    queryRule = queryRule.trim();

    const sql = `SELECT *,count(*) as pageCount from base where siteId = '${siteId}' ${queryRule} GROUP BY uuid ORDER BY ${sortColumn} ${orderBy} LIMIT ${skip},${pageCount};`;
    console.log(sql);
    const result: Base[] = await this.entityManager.query(sql);
    // console.log('siteId', siteId, result);
    log.log('siteId', siteId, result);
    console.log(isNotNumOrStr.test(siteId), siteId.length > 32);
    const resCount = await this.entityManager.query(
      `SELECT count(*) FROM base where siteId = '${siteId}' ${queryRule} GROUP BY uuid`,
    );
    console.log(
      `SELECT count(*) FROM base where siteId = '${siteId}' ${queryRule} GROUP BY uuid`,
    );
    log.info(resCount.length);
    console.log(resCount.length);
    res.status(HttpStatus.OK).json({
      code: 0,
      data: {
        list: result,
        total: resCount.length,
      },
      msg: '请求成功!',
    });
  }

  /**
   * @description 实时访客 - 访问路径
   * @param res
   * @param req
   * @param query
   */
  async findAccessPath(
    @Res() res: Response,
    @Req() req: Request,
    @Query() query,
  ) {
    try {
      console.log('findAccessPath');
      log.info(query);
      const { pageIndex = 1, pageCount = 20, siteId, uuid } = query;
      const skip = (pageIndex - 1) * pageCount;
      const sql = `SELECT * from base where siteId = '${siteId}' and uuid = '${uuid}' ORDER BY time desc LIMIT ${skip},${pageCount}`;
      const result: Base[] = await this.entityManager.query(sql);
      console.log(sql);
      log.info(result);
      console.log(result);
      res.status(HttpStatus.OK).json({
        code: 0,
        data: {
          list: result,
        },
        msg: '请求成功!',
      });
    } catch (err) {
      resServerError(res, err);
    }
  }

  /**
   * @description 网站概况 - 获取某个时间段（今天/昨天/最近7天等）的 PV、UV、IP 数
   * @param res
   * @param req 入参：网站 siteId、开始时间 、结束时间 '2022-04-06'
   * @param query
   */
  async overviewGetUvPv(
    @Res() res: Response,
    @Req() req: Request,
    @Query() query,
  ) {
    try {
      console.log('====> overviewGetUvPv');
      log.info('=====> overviewGetUvPv');
      const { siteId, startDate, endDate } = query;

      // 参数校验
      const isSiteIdFormatError =
        /[^a-z0-9]/g.test(siteId) || !siteId || siteId.length !== 32;
      if (isSiteIdFormatError) {
        throw new Error('siteId 格式错误');
      }

      const dateSql = getTimeQuerySql(startDate, endDate);
      const pvSql = `SELECT count(*) from base WHERE siteId = '${siteId}' ${dateSql}`;
      const uvSql = `SELECT count(*) from base WHERE siteId = '${siteId}' ${dateSql} GROUP BY uuidUaIp`;
      const ipSql = `SELECT count(*) from base WHERE siteId = '${siteId}' ${dateSql} GROUP BY ip`;
      console.log(`${pvSql}\n${uvSql}\n${ipSql}`);
      log.info(pvSql, uvSql, ipSql);
      // 顺序执行
      // const pvResult = await this.entityManager.query(pvSql);
      // const uvResult = await this.entityManager.query(uvSql);
      // const ipResult = await this.entityManager.query(ipSql);
      // 并行
      const [pvResult, uvResult, ipResult] = await Promise.all([
        this.entityManager.query(pvSql),
        this.entityManager.query(uvSql),
        this.entityManager.query(ipSql),
      ]);
      const sqlLog = `result: ${pvResult[0]['count(*)']},${uvResult.length},${ipResult.length}`;
      console.log(sqlLog);
      log.info(sqlLog);
      res.status(HttpStatus.OK).json({
        code: 0,
        data: {
          pv: pvResult[0]['count(*)'] - 0,
          uv: uvResult.length,
          ip: ipResult.length,
        },
        msg: '请求成功!',
      });
    } catch (err) {
      console.log(err);
      log.error(err);
      resServerError(res, err);
    }
  }

  saveAccessData(@Res() res: Response) {
    console.log('接收到请求');
    res.status(HttpStatus.OK).json({
      code: 0,
      msg: '请求成功!',
    });
  }

  // gif 上报拦截处理
  static gifReportHandler() {
    // console.log(this.accessRepository)
    return async (req, res, next) => {
      req.session.visits = req.session.visits ? req.session.visits + 1 : 1;

      // connect.sid=s%3AL8TqsdGPAmyIN7ILWzVGwPICvm;\
      //  a=1
      console.log(
        req.session,
        req.headers.cookie,
        `第 ${req.session.visits} 次访问`,
      );
      const cookiesList = req.headers.cookie?.split(';') || [];
      const cookiesObj = cookiesList.reduce((result, item) => {
        const [key, value] = item.split('=');
        result[key?.trim()] = value;
        return result;
      }, {});
      // localhost 访问 cookie 为空，需要用 127.0.0.1 来调试，不然没有 uuid
      // console.log('cookie', cookiesObj, req.headers.cookie);
      if (cookiesObj['connect.sid']) {
        console.log(cookiesObj, cookiesObj['connect.sid']);
        // 根据 session sid 生成用户id
        const uuid = createHmac('sha256', 'my-secret-salt')
          .update(cookiesObj['connect.sid'])
          .digest('hex');
        console.log(uuid); // 64 位
        req.session.uuid = uuid;
      }

      const printLog = `Request..., ${req.path},${JSON.stringify(req.query)}`;
      console.log(printLog);
      log.info(printLog);

      let siteId = '';
      const siteIdPathList = ['/zs.js', '/zs.gif']; // 需要获取 siteId 的接口
      if (siteIdPathList.includes(req.path)) {
        const { referer } = req.headers;
        // host 为接口 url 的 host 部分
        // test.baidu.com 页面，script 引入 127.0.0.1:3000/zs.js 这时，请求头 referer 中可以拿到调用接口时的域名
        // referer http://test.baidu.com:3000/
        // console.log('referer', req.headers, referer);
        const { hostname } = new URL(referer);
        // TODO: 数据库查询，是否有权限、当前所在的域名与ID 是否匹配，否则不允许加载统计 js
        siteId = SITE_ID_CONFIG[hostname];
        // console.log('hostname', req.headers, host, referer, hostname, siteId);
      }

      // 统计代码 zs.js 鉴权拦截逻辑
      if (req.path === '/zs.js') {
        console.log('zs.js', req.path, req.query, req.hostname);
        const statisticsKey = Object.keys(req.query)[0]; // 统计文件 id { '183281668cc3440449274d1f93c04de6': '' }
        let errMsg = '';
        if (!siteId) {
          errMsg = '该域名未在 zuo_statistics 系统中绑定';
        } else if (siteId !== statisticsKey) {
          errMsg =
            '当前域名与上报 ID 不匹配，请登录 zuo_statistics 系统检查统计代码';
        }
        log.info('是否拦截 errMsg:', errMsg);
        console.log('是否拦截 errMsg:', errMsg);
        if (errMsg) {
          res.status(HttpStatus.FORBIDDEN).json({ code: 403, msg: errMsg });
          return;
        }
      } else if (req.path === '/zs.gif') {
        try {
          const data = JSON.parse(req.query.data); // zs.gif?data={a:1,b:2}
          // console.log(data);
          log.info('data', data);

          // 离开页面时上报
          if (data?.dataType === 'beforeunload') {
            const {
              navigationStartTime,
              beforeunloadTime,
              visitDuration,
              zsWindowId,
              pathname,
              origin,
            } = data;

            // DOMContentLoaded 和 beforeunload 时间如果间隔非常小，DOMContentLoaded 写入数据库还未成功
            // 可能会导致 update 失败，加一个延时更新
            await new Promise((resolve) => setTimeout(resolve, 2000));
            // https://typeorm.io/repository-api
            const result = await baseRepositoryCopy.update(
              {
                navigationStartTime,
                zsWindowId,
                pathname,
                origin,
                uuid: req.session.uuid,
              }, // where
              { beforeunloadTime, visitDuration }, // set
            );
            console.log('beforeunload update result', result, result.affected);
            if (result.affected !== 1) {
              log.error(
                'update 离开时间异常, 影响行数',
                result.affected,
                data,
                req.session.uuid,
              );
            }
            return;
          }

          // load 事件上报
          if (data?.dataType === 'load') {
            const { navigationStartTime, zsWindowId, pathname, origin, perf } =
              data;
            // DOMContentLoaded 和 load 时间如果间隔非常小，DOMContentLoaded 写入数据库还未成功
            // 可能会导致 update 失败，加一个延时更新
            await new Promise((resolve) => setTimeout(resolve, 2000));
            // https://typeorm.io/repository-api
            const result = await baseRepositoryCopy.update(
              {
                navigationStartTime,
                zsWindowId,
                pathname,
                origin,
                uuid: req.session.uuid,
              }, // where
              {
                perf_load: perf.calcData.Loaded,
                performance_timing: JSON.stringify(perf.raw),
                perf_calcData: JSON.stringify(perf.calcData),
              }, // set
            );
            console.log('load update result', result, result.affected);
            if (result.affected !== 1) {
              log.error(
                'update 离开时间异常, 影响行数',
                result.affected,
                data,
                req.session.uuid,
              );
            }
            return;
          }

          // DOMContentLoaded 事件上报
          const {
            perf,
            href,
            navData,
            screen,
            network,
            pathname,
            origin,
            referrer,
            zsWindowId,
            navigationStartTime,
          } = data;
          // IP、IP归属地（可用于地域统计，用于屏蔽恶意 IP 爬虫、骚扰）、宽带类型、origin/host 同源检测、页面跳转还是直接访问：Referer、UA,PV,页面怎么计算
          const { 'user-agent': ua } = req.headers;
          // referrer
          const uaObj = UaParser(ua);
          uaObj.ua = '';
          const access = new Base();
          let ipInfo: any = {};
          let ip =
            req.headers['x-forwarded-for'] || req.connection.remoteAddress;
          log.info('ip', ip); // try to catch ip === null 场景
          if (ip && ip.substr(0, 7) == '::ffff:') {
            ip = ip.substr(7);
          }
          try {
            const reqUrl =
              'http://whois.pconline.com.cn/ipJson.jsp?ip=' + ip + '&json=true';
            const res = await httpServiceCopy
              .get(reqUrl, { responseType: 'arraybuffer' })
              .toPromise();
            ipInfo = iconvLite.decode(res.data, 'gbk');
            ipInfo = JSON.parse(ipInfo);
            log.info('res ip info', ipInfo);
            console.log('res ip info', ipInfo);
          } catch (e) {
            log.error(e.message);
            logErrorStack.info(e);
          }

          const uuidUaIp = createHmac('sha256', 'my-secret-salt')
            .update(ua + ip)
            .digest('hex');
          console.log(ua + ip, uuidUaIp);

          // 判断是否是老用户
          let isOldUser = false;
          try {
            const result: Base[] = await baseRepositoryCopy.find({
              where: {
                uuidUaIp,
              },
            });
            isOldUser = !!result.length;
            console.log(result);
          } catch (e) {
            log.error(e.message);
            logErrorStack.info(e);
          }

          const {
            pro: location_province,
            city: location_city,
            region: location_region,
          } = ipInfo || {};
          Object.assign(access, {
            ip: ip,
            region: ipInfo.addr || '', // 请求接口获取
            networkServe: ipInfo.addr || '', // 请求接口获取
            count: 0, // 第几次访问
            referer: referrer,

            perf_load: perf.calcData.Loaded,
            perf_dom_content_loaded: perf.calcData.DOMContentLoaded,
            perf_ttfb: perf.calcData['Waiting(TTFB)'],
            performance_timing: JSON.stringify(perf.raw),
            perf_calcData: JSON.stringify(perf.calcData),

            ua,
            uaInfo: JSON.stringify(uaObj),
            isMobile: isMobile(ua).any,
            platform: navData.platform,
            lang: navData.language,
            hardware_concurrency: navData.hardwareConcurrency,
            deviceMemory: navData.deviceMemory,
            cookieEnabled: navData.cookieEnabled,
            network,
            href,
            origin,
            pathname,
            screen: screen.size,
            screen_info: JSON.stringify(screen),
            siteId,
            uuid: req.session.uuid,
            uuidUaIp,
            zsWindowId,
            navigationStartTime,
            location_province,
            location_city,
            location_region,
            isOldUser,
          });
          log.info(access);
          // console.log(access);

          const res = await baseRepositoryCopy.save(access);
          console.log(res);
        } catch (e) {
          log.error(e.message);
          logErrorStack.error(e);
          // console.log(e);
        }
      }
      next();
    };
  }
}
