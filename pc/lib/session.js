'use strict';
// 零售云平台（erp / star）会话与接口封装
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

const ERP_BASE = 'https://erp.example.com';
const APPKEY = 'YOUR_APPKEY';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

class CookieJar {
  constructor(pairs) { this.m = new Map(pairs || []); }
  header() { return [...this.m].map(([k, v]) => `${k}=${v}`).join('; '); }
  absorb(setCookie) {
    if (!setCookie) return;
    for (const c of (Array.isArray(setCookie) ? setCookie : [setCookie])) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (/expires=Thu, 01 Jan 1970/i.test(c)) this.m.delete(k); else this.m.set(k, v);
    }
  }
  entries() { return [...this.m.entries()]; }
}

function rawRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({
      'User-Agent': UA,
      'Accept': opts.accept || 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
    }, opts.headers || {});
    if (opts.jar) { const h = opts.jar.header(); if (h) headers.Cookie = h; }
    const buf = opts.body == null ? null : Buffer.from(opts.body, opts.bodyEncoding || 'utf8');
    if (buf) headers['Content-Length'] = buf.length;
    const r = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: opts.method || 'GET', headers, rejectUnauthorized: false, timeout: 40000,
    }, (res) => {
      if (opts.jar) opts.jar.absorb(res.headers['set-cookie']);
      const enc = res.headers['content-encoding'];
      let s = res;
      if (enc === 'gzip') s = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') s = res.pipe(zlib.createInflate());
      const chunks = [];
      s.on('data', c => chunks.push(Buffer.from(c)));
      s.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout ' + url)));
    if (buf) r.write(buf);
    r.end();
  });
}

/** 二进制安全请求：返回 Buffer 原文（导出文件下载必须走这里，
 *  toString('utf8') 会把 xlsx 的二进制字节改写坏，文件直接打不开） */
function rawBinary(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({
      'User-Agent': UA,
      'Accept': opts.accept || '*/*',
      'Accept-Encoding': 'identity',
    }, opts.headers || {});
    if (opts.jar) { const h = opts.jar.header(); if (h) headers.Cookie = h; }
    const buf = opts.body == null ? null : Buffer.from(opts.body, opts.bodyEncoding || 'utf8');
    if (buf) headers['Content-Length'] = buf.length;
    const maxBytes = opts.maxBytes || 64 * 1024 * 1024;
    const r = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: opts.method || 'GET', headers, rejectUnauthorized: false, timeout: 120000,
    }, (res) => {
      if (opts.jar) opts.jar.absorb(res.headers['set-cookie']);
      // CDN 偶发 302：跟随一次
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve({ status: res.statusCode, headers: res.headers, location: res.headers.location });
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { r.destroy(new Error('file too large: ' + url)); return; }
        chunks.push(Buffer.from(c));
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout ' + url)));
    if (buf) r.write(buf);
    r.end();
  });
}

function formEncode(o) {
  return Object.keys(o).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');
}

/** 登录认证入口 并获取业务站上下文（token / tenant / branch / cookie） */
async function login(opts) {
  const { tenantCode, userAccount, password } = opts;
  const jar = new CookieJar();
  const page = await rawRequest(ERP_BASE + '/Account/Login', { jar, accept: 'text/html,*/*' });
  const m = page.body.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  if (!m) throw new Error('登录页解析失败');

  const body = formEncode({
    LoginType: 1, TenantCode: tenantCode, UserAccountN: userAccount, PasswordN: password,
    PwdTipCode: '', ValidateCode: '', ValidateCodeN: '',
    IsKickoffCurrentUser: 'true', CustomerCode: '',
    VerifySimplePassword: 'False', AutomaticLogin: 'False', Autoactivate: 'False',
    __RequestVerificationToken: m[1],
  });
  const res = await rawRequest(ERP_BASE + '/Account/Login', {
    jar, method: 'POST', body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: ERP_BASE + '/Account/Login',
      Origin: ERP_BASE,
    },
  });
  const loc = res.headers.location;
  if (!loc) throw new Error('登录失败：商户ID、账号或密码不对');
  // 登录失败时会 302 回登录页（可能是相对路径），这时候别去解析主机
  if (/Account\/Login/i.test(loc)) throw new Error('登录失败：商户ID、账号或密码不对');
  let siteHost;
  try { siteHost = new URL(loc, ERP_BASE).hostname; }
  catch (e) { throw new Error('登录失败：商户ID、账号或密码不对'); }

  const sub = await rawRequest(`https://${siteHost}/Subsite`, { jar, accept: 'text/html,*/*' });
  const matchOne = (key) => {
    const mm = sub.body.match(new RegExp(key + "\\s*:\\s*'([^']*)'"));
    return mm ? mm[1] : null;
  };
  const token = matchOne('erpCloudTokenId');
  if (!token) throw new Error('登录失败：未取到业务站票据');

  const info = {};
  const ui = sub.body.match(/global_userInfo = \{([\s\S]*?)\n\s*\}/);
  if (ui) for (const line of ui[1].split('\n')) {
    const kv = line.match(/(\w+):\s*'([^']*)'/);
    if (kv) info[kv[1]] = kv[2];
  }

  // apptoken：后续所有接口签名都需要
  const tk = await rawRequest(`https://${siteHost}/Home/GetAppToken`, { jar, accept: '*/*' });
  let apptoken = '';
  try { apptoken = JSON.parse(tk.body).data || ''; } catch (e) { }

  return {
    tenantCode, siteHost, jar,
    apiBase: matchOne('baseApiUrl') || `https://service-${siteHost}/`,
    token, apptoken, appKey: APPKEY,
    tenantId: info.tenantId, tenantName: info.tenantName,
    branchId: info.branchId, branchName: info.branchName,
    productType: info.productType,
    loginAt: Date.now(),
    cookies: jar.entries().map(([name, value]) => ({ name, value, domain: '.example.com.cn', path: '/' })),
  };
}

/** MD5 大写签名：按 key 升序拼接非空 k=v */
function buildSign(sess, data, params) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = Object.assign({
    apptoken: sess.apptoken,
    cloudtokenid: sess.token,
    appkey: sess.appKey,
    noncestr: nonce,
    timestamp: ts,
  }, data, params);
  const parts = [];
  for (const k of Object.keys(payload).sort()) {
    const v = payload[k];
    if (v == null) continue;
    const sv = (typeof v === 'object') ? JSON.stringify(v) : String(v);
    if (sv.trim() === '') continue;
    parts.push(`${k}=${sv}`);
  }
  return {
    sign: crypto.createHash('md5').update(parts.join('&'), 'utf8').digest('hex').toUpperCase(),
    timestamp: ts, noncestr: nonce,
  };
}

function authHeaders(sess, data = {}, params = {}) {
  const s = buildSign(sess, data, params);
  const h = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json;charset=UTF-8',
    'Origin': `https://${sess.siteHost}`,
    'Referer': `https://${sess.siteHost}/Subsite`,
    'User-Agent': UA,
    'apptoken': sess.apptoken,
    'appkey': sess.appKey,
    'cloudtokenid': sess.token,
    'noncestr': s.noncestr,
    'timestamp': s.timestamp,
    'sign': s.sign,
  };
  if (sess.tenantId) h.TenantId = String(sess.tenantId);
  return h;
}

async function apiRequest(sess, apiPath, data = {}, query = {}, method = 'POST') {
  const base = sess.apiBase.endsWith('/') ? sess.apiBase : sess.apiBase + '/';
  const url = new URL(base + String(apiPath).replace(/^\//, ''));
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  // 注意：签名需包含 query 参数
  const headers = authHeaders(sess, data, Object.fromEntries(url.searchParams.entries()));
  const res = await rawRequest(url.toString(), {
    method, headers,
    body: method === 'GET' ? null : JSON.stringify(data),
  });
  let json = null;
  try { json = JSON.parse(res.body); } catch (e) { json = { __raw: res.body }; }
  json.__status = res.status;
  return json;
}

module.exports = { login, apiRequest, authHeaders, buildSign, rawRequest, rawBinary, CookieJar, formEncode, APPKEY, UA, ERP_BASE };
