'use strict';
// 门店（商户账号）配置中枢：以后新增门店不用改代码，在这个文件对应的 config.json 里加一条即可
//
// 落盘文件：exe 旁的 config.json（纯文本，可用记事本编辑），格式：
// { "port": 8765, "accounts": [ { "tenantCode":"8位商户ID", "userAccount":"9999",
//     "password":"xxx", "alias":"门店显示名", "enabled":true } ] }
//
// config.js 已经会优先读取 exe 旁的 config.json，所以这里改动后，
// 正在运行的服务即时生效（同一个数组引用），重启后也不会丢。

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

// 跟 HOME_DIR 走：本机上从发布包副本启动时，读写的仍是主程序那一份 config.json
const FILE = path.join(cfg.HOME_DIR || cfg.EXE_DIR, 'config.json');
const LIST = cfg.ACCOUNTS; // 与 config.js 导出的同一个数组，就地增删改即热生效

function norm(code) { return String(code == null ? '' : code).trim(); }
function fileExists() { try { return fs.existsSync(FILE); } catch (e) { return false; } }

/** 读盘重载：外部手工改了 config.json 后调用一次即可同步进内存 */
function reload() {
  if (!fileExists()) return list();
  try {
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!o || !Array.isArray(o.accounts)) return list();
    LIST.length = 0;
    for (const a of o.accounts) {
      const c = norm(a && a.tenantCode);
      if (!c) continue;
      LIST.push({
        tenantCode: c,
        userAccount: String((a && a.userAccount) || '9999'),
        password: String((a && a.password) || ''),
        alias: String((a && (a.alias || a.name)) || c),
        enabled: a && a.enabled === false ? false : true,
      });
    }
  } catch (e) { /* 文件内容有问题就保留现有内存列表 */ }
  return list();
}

function save() {
  let base = {};
  if (fileExists()) {
    try { base = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { base = {}; }
  }
  base.accounts = list().map(a => ({
    tenantCode: a.tenantCode,
    userAccount: a.userAccount,
    password: a.password,
    alias: a.alias,
    enabled: a.enabled !== false,
  }));
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(base, null, 2), 'utf8');
  } catch (e) { return { ok: false, error: '写入失败：' + e.message }; }
  return { ok: true, file: FILE };
}

/** 内部使用的原始列表（含密码） */
function list() {
  // 老数据补齐字段，避免读到残缺配置就崩
  for (const a of LIST) {
    if (a.enabled === undefined) a.enabled = true;
    if (!a.userAccount) a.userAccount = '9999';
    if (!a.password) a.password = '';
    if (!a.alias) a.alias = norm(a.tenantCode);
    a.tenantCode = norm(a.tenantCode);
  }
  return LIST;
}

/** 参与抓取的门店（停用的不抓） */
function active() { return list().filter(a => a.enabled !== false && !!a.tenantCode); }

function find(code) {
  const c = norm(code);
  return list().find(a => norm(a.tenantCode) === c) || null;
}

/** 对外输出：不泄露密码 */
function publicList(statusFn) {
  return list().map(a => {
    const st = typeof statusFn === 'function' ? statusFn(a.tenantCode) : null;
    return {
      tenantCode: a.tenantCode,
      alias: a.alias,
      userAccount: a.userAccount,
      hasPassword: !!a.password,
      enabled: a.enabled !== false,
      lastOk: st ? st.ok : null,
      lastError: st && st.error ? st.error : '',
      updatedAt: st ? st.updatedAt : 0,
    };
  });
}

/**
 * 新增或修改一个门店。传入 tenantCode 必填；password 为空表示沿用旧密码。
 * @returns {{ok:boolean, created?:boolean, error?:string, item?:object}}
 */
function upsert(o) {
  const code = norm(o && o.tenantCode);
  if (!code) return { ok: false, error: '商户ID不能为空' };
  if (!/^[0-9A-Za-z_-]{2,20}$/.test(code)) return { ok: false, error: '商户ID格式不对，通常是8位数字' };
  const exist = find(code);
  const password = o && o.password ? String(o.password) : (exist ? exist.password : '');
  if (!exist && !password) return { ok: false, error: '新门店必须填写密码' };
  const item = {
    tenantCode: code,
    userAccount: String((o && o.userAccount) || (exist && exist.userAccount) || '9999'),
    password,
    alias: String((o && o.alias) || (exist && exist.alias) || code),
    enabled: o && (o.enabled === false || o.enabled === '0') ? false : true,
  };
  if (exist) Object.assign(exist, item);
  else list().push(item);
  const w = save();
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, created: !exist, file: w.file, item: { tenantCode: code, alias: item.alias, enabled: item.enabled } };
}

function remove(code) {
  const i = list().findIndex(a => norm(a.tenantCode) === norm(code));
  if (i < 0) return { ok: false, error: '没有这个门店' };
  const gone = LIST.splice(i, 1)[0];
  const w = save();
  return { ok: w.ok, removed: norm(gone.tenantCode), error: w.error };
}

function setEnabled(code, on) {
  const a = find(code);
  if (!a) return { ok: false, error: '没有这个门店' };
  a.enabled = !!on;
  const w = save();
  return { ok: w.ok, enabled: a.enabled, error: w.error };
}

module.exports = { FILE, fileExists, reload, save, list, active, find, upsert, remove, setEnabled, publicList };
