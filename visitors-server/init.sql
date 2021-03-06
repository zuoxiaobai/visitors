create database zuo_statistics;
use zuo_statistics;
create table base (
  id int auto_increment primary key,
  ip varchar(20) default '',
  region varchar(50) default '',
  networkServe varchar(50) default '',
  count int default 1,
  referer varchar(500) default '',
  perf_load varchar(20) default '', 
  perf_dom_content_loaded varchar(20) default '',
  perf_ttfb varchar(20) default '',
  performance_timing text,
  perf_calcData varchar(200) default '',
  ua varchar(500) default '',
  uaInfo varchar(300) default '',
  isMobile boolean default 0,
  platform varchar(20) default '',
  lang varchar(20) default '',
  hardware_concurrency int default 0,
  deviceMemory int default 0,
  cookieEnabled boolean default 0,
  network varchar(10) default '',
  href varchar(300) default '',
  pathname varchar(100) default '',
  screen varchar(20) default '',
  screen_info varchar(50) default '',
  time timestamp default current_timestamp,
  extra1 varchar(100) default "",
  extra2 varchar(100) default "",
  extra3 varchar(100) default ""
);