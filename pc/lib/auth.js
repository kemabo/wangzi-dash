'use strict';
// 大屏账号体系：管理员看全部门店，门店账号只看自己那家
//
// 账号文件：data/users.json
//   [ { username:'admin', name:'管理员', role:'admin', storeKey:'', pass:'<hash>' },
//     { username:'dh01',  name:'某某店', role:'store', storeKey:'10000001', pass:'<hash>' } ]
// 会话文件：data/auth-sessions.json（token 落盘，服务重启后仍然免登录）
//
// 说明：本层和零售云平台后台的账号是两回事。零售云平台那套账号密码用在「门店」页签里取数，
// 这里的是「谁能看这块屏」。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DASH_DATA_DIR || path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESS_FILE = path.join(DATA_DIR, 'auth-sessions.json');
const COOKIE = 'dash_token';
const TOKEN_DAYS = 90;
const PEPPER = 'wangzi-xiefu-dashboard';

function ensureDir() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { } }
function readJson(f, dflt) {
  try { if (!fs.existsSync(f)) return dflt; return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; }
}
function writeJson(f, o) {
  ensureDir();
  try { fs.writeFileSync(f, JSON.stringify(o, null, 2), 'utf8'); return true; } catch (e) { return false; }
}

/** 密码只存哈希，不落明文（内网大屏，强度够用即可） */
function hashOf(username, password) {
  return crypto.createHash('sha256').update(`${PEPPER}|${username}|${password}`).digest('hex');
}

let USERS = null;
function users() {
  if (USERS) return USERS;
  let list = readJson(USERS_FILE, null);
  if (!Array.isArray(list) || !list.length) {
    // 默认只有一个管理员，且没有密码 —— 等于不设防，保持原来「打开就能看」的习惯
    list = [{ username: 'admin', name: '管理员', role: 'admin', storeKey: '', pass: '' }];
    writeJson(USERS_FILE, list);
  }
  for (const u of list) {
    if (!u.role) u.role = u.storeKey ? 'store' : 'admin';
    if (u.storeKey == null) u.storeKey = '';
    if (u.name == null) u.name = u.username;
  }
  USERS = list;
  return USERS;
}
function saveUsers() { return writeJson(USERS_FILE, users()); }

function find(username) {
  const k = String(username || '').trim().toLowerCase();
  return users().find(u => String(u.username).toLowerCase() === k) || null;
}

/** 管理员是否已经设过密码：没设就是「谁打开都能看」，设了才要求登录 */
function authEnabled() {
  const a = find('admin');
  return !!(a && a.pass);
}

function setAdminPassword(password) {
  const a = find('admin');
  if (!a) return { ok: false, error: '没有管理员账号' };
  a.pass = password ? hashOf('admin', password) : '';
  // 改完密码，所有旧登录作废一次，避免别人拿着旧凭据进来
  clearSessions();
  return saveUsers() ? { ok: true, enabled: !!a.pass } : { ok: false, error: '写入失败' };
}

/**
 * 新增或修改员工账号（仅供管理员调用）
 * role='store' 时必须绑定 storeKey（门店的商户ID），该账号就只能看这一家店
 */
function upsertUser(o, actor) {
  if (actor && actor.role !== 'admin') return { ok: false, error: '只有管理员能改账号' };
  const username = String((o && o.username) || '').trim();
  if (!username) return { ok: false, error: '账号不能为空' };
  if (!/^[A-Za-z0-9_.-]{2,20}$/.test(username)) return { ok: false, error: '账号只能用字母数字、下划线或点，2-20 位' };
  const storeKey = String((o && o.storeKey) || '').trim();
  let role = String((o && o.role) || '').toLowerCase();
  if (role !== 'admin' && role !== 'store') role = storeKey ? 'store' : 'admin';
  // 没指定门店就等同于管理员（和界面上「全部门店（等同管理员权限）」那个选项一致）
  if (role === 'store' && !storeKey) role = 'admin';
  const exist = find(username);
  const password = String((o && o.password) || '');
  if (!exist && !password) return { ok: false, error: '新账号必须设密码' };
  if (username.toLowerCase() === 'admin' && exist === null) return { ok: false, error: 'admin 是内置管理员' };
  const item = {
    username: exist ? exist.username : username,
    name: String((o && o.name) || (exist && exist.name) || username),
    role: username.toLowerCase() === 'admin' ? 'admin' : role,
    storeKey: role === 'admin' ? '' : storeKey,
    pass: password ? hashOf(username, password) : (exist ? exist.pass : ''),
  };
  if (exist) Object.assign(exist, item); else users().push(item);
  if (!saveUsers()) return { ok: false, error: '写入失败' };
  // 改了密码就把这个账号的旧会话踢掉
  if (exist && password) dropSessionsOf(item.username);
  return { ok: true, created: !exist };
}

function removeUser(username, actor) {
  if (actor && actor.role !== 'admin') return { ok: false, error: '只有管理员能删账号' };
  const k = String(username || '').toLowerCase();
  if (k === 'admin') return { ok: false, error: '管理员账号不能删' };
  const i = users().findIndex(u => String(u.username).toLowerCase() === k);
  if (i < 0) return { ok: false, error: '没有这个账号' };
  const gone = users().splice(i, 1)[0];
  dropSessionsOf(gone.username);
  return saveUsers() ? { ok: true } : { ok: false, error: '写入失败' };
}

/** 对外列表：绝不带密码哈希 */
function publicUsers() {
  return users().map(u => ({
    username: u.username, name: u.name, role: u.role,
    storeKey: u.storeKey || '', hasPassword: !!u.pass,
  }));
}

function verify(username, password) {
  const u = find(username);
  if (!u) return { ok: false, error: '账号不存在' };
  if (!u.pass) return { ok: false, error: '这个账号还没设密码，请找管理员设置' };
  if (hashOf(u.username, String(password || '')) !== u.pass) return { ok: false, error: '密码不对' };
  return { ok: true, user: { username: u.username, name: u.name, role: u.role, storeKey: u.storeKey || '' } };
}

// ---------------- 会话：token 落盘，服务重启后仍然免登录 ----------------
let SESS = null;
function sessions() { if (!SESS) SESS = readJson(SESS_FILE, {}) || {}; return SESS; }
function saveSessions() { writeJson(SESS_FILE, sessions()); }
function clearSessions() { SESS = {}; saveSessions(); }
function dropSessionsOf(username) {
  const s = sessions();
  for (const t of Object.keys(s)) if (s[t] && s[t].username === username) delete s[t];
  saveSessions();
}
function issueToken(user) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions()[token] = { username: user.username, exp: Date.now() + TOKEN_DAYS * 86400000, createdAt: Date.now() };
  saveSessions();
  return token;
}
function userOfToken(token) {
  const t = String(token || '');
  if (!t) return null;
  const s = sessions()[t];
  if (!s) return null;
  if (s.exp && Date.now() > s.exp) { delete sessions()[t]; saveSessions(); return null; }
  const u = find(s.username);
  if (!u) return null;
  return { username: u.username, name: u.name, role: u.role, storeKey: u.storeKey || '' };
}
function logout(token) {
  const t = String(token || '');
  if (t && sessions()[t]) { delete sessions()[t]; saveSessions(); }
  return { ok: true };
}

/** 从 cookie 头里取 token */
function tokenFromCookie(header) {
  const m = /(?:^|;\s*)dash_token=([^;]+)/.exec(String(header || ''));
  return m ? m[1] : '';
}

module.exports = {
  COOKIE, TOKEN_DAYS, USERS_FILE, SESS_FILE, DATA_DIR,
  users, find, publicUsers, verify, issueToken, userOfToken, logout,
  upsertUser, removeUser, setAdminPassword, authEnabled, tokenFromCookie,
};
