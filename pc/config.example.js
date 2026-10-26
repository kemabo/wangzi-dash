'use strict';
// 门店大屏 - 全局配置
// 覆盖优先级：exe 旁 config.json > config.local.js > 内置默认（exe 打包后内置默认生效）
const fs = require('fs');
const path = require('path');
const os = require('os');

const isSea = (() => { try { return require('node:sea').isSea(); } catch (e) { return false; } })();
const exeDir = isSea ? path.dirname(process.execPath) : __dirname;

/**
 * 主程序目录（HOME）：同一台电脑上只允许一套数据。
 *
 * 背景：发布包文件夹里也会放一份 exe 供拷贝到新电脑。过去本机上存在两份 exe 时，
 * 它们各带一套 data（会话 / 快照 / 门店配置），双击到副本就会「从零冷启动」，
 * 表现出来就是「门店少了几家」「打开两三分钟不出数据」。
 *
 * 现在用 %LOCALAPPDATA% 下的一个小标记文件登记「这台机器的主程序在哪」：
 *   - 从发布包 / dist 这类分发目录里启动 → 直接共用已登记主程序的 data 与 config.json
 *   - 从别处（正常安装位置）启动 → 登记 / 接管为这台机器的主程序
 * 拷到新电脑时没有标记文件，就用自己所在目录，行为和以前完全一致。
 */
function resolveHome() {
  const self = exeDir;
  // 更新安装用的临时副本：主目录由调用方指定，且绝不能改写登记文件，
  // 否则「这台机器的主程序」会被指到 update 临时目录里去。
  const locked = process.env.DASH_HOME_LOCK;
  if (locked) { try { if (fs.existsSync(locked)) return locked; } catch (e) { } }
  try {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const dir = path.join(base, '王子鞋服经营数据大屏');
    const marker = path.join(dir, 'install.json');
    let reg = null;
    try { reg = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch (e) { }
    const sep = self + path.sep;
    const isDistro = /[\\/](发布包|dist)[\\/]/i.test(sep);
    // 已登记过主程序、且那份数据还在：分发副本直接共用，避免多出第二套数据
    if (isDistro && reg && reg.dir && reg.dir !== self && fs.existsSync(path.join(reg.dir, 'data'))) {
      return reg.dir;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(marker, JSON.stringify({ dir: self, at: Date.now() }), 'utf8');
    } catch (e) { }
  } catch (e) { }
  return self;
}
const homeDir = resolveHome();

const LOCALS = [
  path.join(homeDir, 'config.json'),
  path.join(exeDir, 'config.json'),
  path.join(__dirname, 'config.local.js'),
  path.join(__dirname, '..', 'config.local.js'),
];

const DEFAULT_ACCOUNTS = [];   // 仓库版不含任何真实账号：请在 config.json / config.local.js 中自行配置

let ACCOUNTS = DEFAULT_ACCOUNTS;
let PORT_FILE = 0;
for (const f of LOCALS) {
  if (!fs.existsSync(f)) continue;
  try {
    let ext;
    if (f.toLowerCase().endsWith('.json')) ext = JSON.parse(fs.readFileSync(f, 'utf8'));
    else ext = require(f);
    if (ext && Array.isArray(ext.accounts) && ext.accounts.length) ACCOUNTS = ext.accounts;
    if (ext && Number(ext.port) > 0) PORT_FILE = Number(ext.port);
    break;
  } catch (e) { /* ignore */ }
}

module.exports = {
  // 正式版本号：界面「运行」页与 /api/status 都会带出去，发版时改这里
  APP_NAME: '门店经营数据大屏',
  VERSION: '1.2.1',
  BUILD: '2026-10-26c',
  PORT: PORT_FILE || Number(process.env.DASHBOARD_PORT || 8765),
  REFRESH_MS: Number(process.env.DASHBOARD_REFRESH_MS || 60000),
  // 会话提前多久（毫秒）判定为过期并自动重登：默认 5 分钟
  SESSION_MARGIN_MS: 5 * 60 * 1000,
  // 单账号请求失败重试次数
  RETRY: 2,
  ACCOUNTS,
  EXE_DIR: exeDir,
  // 数据与门店配置统一放在这里：分发副本会自动指向已登记的主程序目录
  HOME_DIR: homeDir,
  IS_SEA: isSea,
};
