'use strict';
/* 门店经营数据大屏 · 手机版核心
 * 与 Windows 版同一套思迅接口（登录 / 签名 / 报表），只是把底层 HTTP 换成安卓原生桥。
 * 单文件自包含，不依赖任何第三方库，可直接在 WebView 里跑。
 */
(function (global) {
  const APPKEY = 'sissjs@20200918#js$$##';
  const PASSPORT = 'https://passport2.td365.com.cn';
  // 注意：用桌面 UA。实测移动端 UA 访问 passport 登录页会被 302 跳走，拿不到登录令牌
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

  // ---------------- MD5（签名要用，浏览器没有原生 md5，这里自带一份） ----------------
  const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const MD5_K = (function () {
    const k = new Array(64);
    for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    return k;
  })();
  function md5(str) {
    let bytes;
    if (typeof TextEncoder !== 'undefined') bytes = new TextEncoder().encode(str);
    else {
      const a = [];
      for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c < 128) a.push(c);
        else if (c < 2048) a.push(192 | c >> 6, 128 | c & 63);
        else a.push(224 | c >> 12, 128 | (c >> 6) & 63, 128 | c & 63);
      }
      bytes = Uint8Array.from(a);
    }
    const bitLen = bytes.length * 8;
    const buf = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64);
    buf.set(bytes);
    buf[bytes.length] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(buf.length - 8, bitLen >>> 0, true);          // 长度：小端低 32 位
    dv.setUint32(buf.length - 4, Math.floor(bitLen / 4294967296), true);
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476;
    const M = new Uint32Array(16);
    for (let off = 0; off < buf.length; off += 64) {
      for (let j = 0; j < 16; j++) M[j] = dv.getUint32(off + j * 4, true);
      let A = h0, B = h1, C = h2, D = h3;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (B & C) | (~B & D); g = i; }
        else if (i < 32) { f = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { f = C ^ (B | ~D); g = (7 * i) % 16; }
        const t = (f + A + MD5_K[i] + M[g]) >>> 0;
        const s = MD5_S[i];
        A = D; D = C; C = B;
        B = (B + ((t << s) | (t >>> (32 - s)))) >>> 0;
      }
      h0 = (h0 + A) >>> 0; h1 = (h1 + B) >>> 0; h2 = (h2 + C) >>> 0; h3 = (h3 + D) >>> 0;
    }
    // 注意：MD5 的摘要要按「小端字节」输出（低字节在前），不能直接用数字的十六进制
    const hexLE = (x) => {
      let s = '';
      for (let i = 0; i < 4; i++) {
        const b = (x >>> (i * 8)) & 0xff;
        s += ('0' + b.toString(16)).slice(-2);
      }
      return s;
    };
    return (hexLE(h0) + hexLE(h1) + hexLE(h2) + hexLE(h3)).toUpperCase();
  }

  // ---------------- HTTP：安卓原生桥（网页调试时自动退回浏览器 fetch） ----------------
  const pending = new Map();
  let seq = 0;
  function bridgeHttp(req) {
    return new Promise((resolve, reject) => {
      const id = 'r' + (++seq);
      pending.set(id, { resolve, reject });
      const B = global.DashBridge;
      if (!B || typeof B.request !== 'function') {
        pending.delete(id);
        reject(new Error('当前环境没有取数通道（需要 App 内的原生网络）'));
        return;
      }
      try { B.request(id, JSON.stringify(req)); }
      catch (e) { pending.delete(id); reject(e); }
    });
  }
  // 原生回调入口：App 执行完 HTTP 后调用
  global.DashBridgeCallback = function (id, errMsg, resultJson) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (errMsg) { p.reject(new Error(errMsg)); return; }
    try { p.resolve(JSON.parse(resultJson)); } catch (e) { p.reject(new Error('返回解析失败')); }
  };

  // ---------------- Cookie ----------------
  class CookieJar {
    constructor(pairs) { this.m = new Map(pairs || []); }
    header() { return Array.from(this.m).map(([k, v]) => k + '=' + v).join('; '); }
    absorb(setCookie) {
      if (!setCookie) return;
      for (const c of (Array.isArray(setCookie) ? setCookie : [setCookie])) {
        const pair = String(c).split(';')[0];
        const i = pair.indexOf('=');
        if (i < 0) continue;
        const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
        if (/expires=Thu, 01 Jan 1970/i.test(c)) this.m.delete(k); else this.m.set(k, v);
      }
    }
    entries() { return Array.from(this.m.entries()); }
  }

  async function rawRequest(url, opts = {}) {
    const headers = Object.assign({
      'User-Agent': UA,
      'Accept': opts.accept || 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }, opts.headers || {});
    if (opts.jar) { const h = opts.jar.header(); if (h) headers.Cookie = h; }
    const res = await bridgeHttp({
      url, method: opts.method || 'GET', headers,
      body: opts.body == null ? null : String(opts.body),
      followRedirects: !!opts.followRedirects,
    });
    if (opts.jar && res.headers) {
      const sc = res.headers['set-cookie'] || res.headers['Set-Cookie'];
      opts.jar.absorb(sc);
    }
    return { status: res.status, headers: res.headers || {}, body: res.body || '' };
  }

  function formEncode(o) {
    return Object.keys(o).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');
  }

  // ---------------- 登录 ----------------
  async function login(acct) {
    const jar = new CookieJar();
    const page = await rawRequest(PASSPORT + '/Account/Login', { jar, accept: 'text/html,*/*' });
    const m = page.body.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
    if (!m) throw new Error('登录页打不开，请检查网络');
    const body = formEncode({
      LoginType: 1, TenantCode: acct.tenantCode, UserAccountN: acct.userAccount, PasswordN: acct.password,
      PwdTipCode: '', ValidateCode: '', ValidateCodeN: '',
      IsKickoffCurrentUser: 'true', CustomerCode: '',
      VerifySimplePassword: 'False', AutomaticLogin: 'False', Autoactivate: 'False',
      __RequestVerificationToken: m[1],
    });
    const res = await rawRequest(PASSPORT + '/Account/Login', {
      jar, method: 'POST', body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: PASSPORT + '/Account/Login', Origin: PASSPORT,
      },
    });
    const loc = res.headers.location || res.headers.Location;
    if (!loc || /Account\/Login/i.test(loc)) throw new Error('登录失败：商户ID、账号或密码不对');
    let siteHost;
    try { siteHost = new URL(loc, PASSPORT).hostname; } catch (e) { throw new Error('登录失败：商户ID、账号或密码不对'); }

    const sub = await rawRequest('https://' + siteHost + '/Subsite', { jar, accept: 'text/html,*/*', followRedirects: true });
    const one = (key) => { const mm = sub.body.match(new RegExp(key + "\\s*:\\s*'([^']*)'")); return mm ? mm[1] : null; };
    const token = one('sissCloudTokenId');
    if (!token) throw new Error('登录失败：没拿到业务站票据（可能账号没有后台权限）');
    const info = {};
    const ui = sub.body.match(/global_userInfo = \{([\s\S]*?)\n\s*\}/);
    if (ui) for (const line of ui[1].split('\n')) {
      const kv = line.match(/(\w+):\s*'([^']*)'/); if (kv) info[kv[1]] = kv[2];
    }
    const tk = await rawRequest('https://' + siteHost + '/Home/GetAppToken', { jar, accept: '*/*' });
    let apptoken = '';
    try { apptoken = JSON.parse(tk.body).data || ''; } catch (e) { }
    return {
      tenantCode: acct.tenantCode, siteHost, jar,
      apiBase: one('baseApiUrl') || ('https://service-' + siteHost + '/'),
      token, apptoken, appKey: APPKEY,
      tenantId: info.tenantId, tenantName: info.tenantName, branchId: info.branchId,
      loginAt: Date.now(),
      cookies: jar.entries().map(([name, value]) => ({ name, value })),
    };
  }

  function restoreSession(snap) {
    if (!snap || !snap.token || !snap.siteHost) return null;
    const jar = new CookieJar(snap.cookies || []);
    return Object.assign({}, snap, { jar });
  }

  // ---------------- 签名 ----------------
  function nonceHex() {
    const n = 8; let s = '';
    if (global.crypto && global.crypto.getRandomValues) {
      const a = new Uint8Array(n); global.crypto.getRandomValues(a);
      for (const b of a) s += ('0' + b.toString(16)).slice(-2);
    } else { for (let i = 0; i < n * 2; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)]; }
    return s;
  }
  function buildSign(sess, data, params) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = nonceHex();
    const payload = Object.assign({
      apptoken: sess.apptoken, sisscloudtokenid: sess.token, appkey: sess.appKey,
      noncestr: nonce, timestamp: ts,
    }, data || {}, params || {});
    const parts = [];
    for (const k of Object.keys(payload).sort()) {
      const v = payload[k];
      if (v == null) continue;
      const sv = (typeof v === 'object') ? JSON.stringify(v) : String(v);
      if (sv.trim() === '') continue;
      parts.push(k + '=' + sv);
    }
    return { sign: md5(parts.join('&')), timestamp: ts, noncestr: nonce };
  }
  function authHeaders(sess, data, params) {
    const s = buildSign(sess, data, params);
    const h = {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json;charset=UTF-8',
      'Origin': 'https://' + sess.siteHost,
      'Referer': 'https://' + sess.siteHost + '/Subsite',
      'User-Agent': UA,
      'apptoken': sess.apptoken, 'appkey': sess.appKey, 'sisscloudtokenid': sess.token,
      'noncestr': s.noncestr, 'timestamp': s.timestamp, 'sign': s.sign,
    };
    if (sess.tenantId) h.TenantId = String(sess.tenantId);
    return h;
  }

  // ---------------- 全局限速闸门 ----------------
  // ---------------- 取数安全：宁可慢，也绝不能把门店收银挤掉 ----------------
  // 思迅云对同一账号有「操作过于频繁(0002)」的限制，而收银机走的是同一套账号体系。
  // 所以这里的原则是：**保守限速 + 撞限流就整体退避**，绝不在异常状态下继续连打请求
  // （那样只会让厂家限得更久，甚至波及前台销售）。取数失败永远只影响看板，不影响收银。
  const RL = { hits: [], max: 12 };          // 12 次/分钟：比厂家阈值保守一大截
  const GUARD = { until: 0, reason: '', level: 0, since: 0 };
  const LIMIT_PAT = /0002|操作过于频繁|访问过于频繁|请求过于频繁|频繁操作/;

  function trip(reason) {
    // 退避时间指数增长：30s → 60s → 2min → 5min（最长 5 分钟），期间一个请求都不发
    const steps = [30e3, 60e3, 120e3, 300e3];
    const wait = steps[Math.min(GUARD.level, steps.length - 1)];
    GUARD.level = Math.min(GUARD.level + 1, steps.length - 1);
    GUARD.until = Date.now() + wait;
    GUARD.reason = reason || '厂家提示操作过于频繁';
    GUARD.since = Date.now();
  }
  function clearGuard() { GUARD.until = 0; GUARD.reason = ''; GUARD.level = 0; }
  function isLimited() { return Date.now() < GUARD.until; }
  function guardError() {
    const s = Math.ceil((GUARD.until - Date.now()) / 1000);
    return new Error('限流保护中（' + GUARD.reason + '），已暂停取数，' + s + ' 秒后自动恢复');
  }
  function status() {
    return {
      limited: isLimited(),
      waitSec: isLimited() ? Math.ceil((GUARD.until - Date.now()) / 1000) : 0,
      reason: GUARD.reason, level: GUARD.level, rpm: RL.max,
    };
  }

  async function gate() {
    if (isLimited()) throw guardError();
    const now = Date.now();
    RL.hits = RL.hits.filter((t) => now - t < 60000);
    if (RL.hits.length >= RL.max) {
      const wait = 60000 - (now - RL.hits[0]) + 400;
      RL.hits = [];
      await sleep(wait);
      return gate();
    }
    RL.hits.push(now);
  }
  /** 厂家返回里带了限流字样 → 立刻进入保护期，别再发请求 */
  function checkLimit(text) {
    if (!text) return false;
    const s = String(text);
    if (!LIMIT_PAT.test(s)) return false;
    trip('厂家返回「操作过于频繁(0002)」');
    return true;
  }

  async function apiRequest(sess, apiPath, data = {}, query = {}, method = 'POST') {
    await gate();
    const base = sess.apiBase.endsWith('/') ? sess.apiBase : sess.apiBase + '/';
    const url = new URL(base + String(apiPath).replace(/^\//, ''));
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
    const q = {}; url.searchParams.forEach((v, k) => { q[k] = v; });
    const res = await rawRequest(url.toString(), {
      method, headers: authHeaders(sess, data, q),
      body: method === 'GET' ? null : JSON.stringify(data), followRedirects: true,
    });
    if (checkLimit(res.body)) throw guardError();
    let json = null;
    try { json = JSON.parse(res.body); } catch (e) { json = { __raw: res.body }; }
    json.__status = res.status;
    if (json && json.Code !== undefined && String(json.Code) === '0002') { trip('厂家返回 Code=0002'); throw guardError(); }
    return json;
  }

  async function gridRequest(sess, controller, advancedQuery, opts = {}) {
    await gate();
    const p = new URLSearchParams();
    p.set('{2}t', String(Date.now()));
    p.set('queryaction', 'query');
    p.set('tenantid', String(sess.tenantId));
    p.set('pageIndex', String(opts.pageIndex || 1));
    p.set('SortOptions', ''); p.set('query', ''); p.set('queryFields', ''); p.set('queryField', '');
    p.set('advancedQuery', JSON.stringify(advancedQuery));
    if (opts.pageSize) p.set('pageSize', String(opts.pageSize));
    const url = 'https://' + sess.siteHost + '/' + controller + '?' + p.toString();
    const r = await rawRequest(url, {
      jar: sess.jar, accept: 'text/html,*/*', followRedirects: true,
      headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://' + sess.siteHost + '/' + controller },
    });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    if (checkLimit(r.body)) throw guardError();
    return parseGrid(r.body);
  }

  // ---------------- 报表 HTML 解析（与 Windows 版同规则） ----------------
  // 绝大多数单元格是纯数字/纯文字，先走快路径（没有标签和实体就别跑正则）
  function stripTags(s) {
    const t = String(s);
    if (t.indexOf('<') < 0 && t.indexOf('&') < 0) return t.trim();
    return t.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  }
  function num(v) {
    if (v == null) return 0;
    const n = parseFloat(String(v).replace(/[,%\s]/g, ''));
    return isNaN(n) ? 0 : n;
  }
  function parseGrid(html) {
    if (!html) return { head: [], rows: [], total: 0 };
    if (/^\s*[{[]/.test(html.trim())) {
      try { const j = JSON.parse(html); if (j.status === 'error') throw new Error((j.message && j.message.msg) || '接口返回错误'); }
      catch (e) { throw new Error(e.message); }
    }
    const head = [];
    const hm = html.match(/<thead[\s\S]*?<\/thead>/i);
    if (hm) for (const m of hm[0].matchAll(/<th[^>]*field="([^"]*)"/g)) head.push(m[1]);
    // 商品级报表动辄几万行 × 二十来列，逐格跑正则在手机上非常慢：
    // 改成按 <tr> / <td> 做字符串切分（同样结果，快一个数量级，季节表就靠这个提速）
    const rows = [];
    const bs = html.indexOf('<tbody');
    if (bs >= 0) {
      const be = html.indexOf('</tbody>', bs);
      const body = html.slice(bs, be < 0 ? html.length : be + 8);
      const trs = body.split(/<tr\b/i);
      for (let i = 1; i < trs.length; i++) {
        const chunk = trs[i];
        const cut = chunk.indexOf('</tr>');
        const inner = cut >= 0 ? chunk.slice(0, cut) : chunk;
        const obj = {};
        let idx = 0, n = 0;
        while (true) {
          const s = inner.indexOf('<td', idx);
          if (s < 0) break;
          const tagEnd = inner.indexOf('>', s);
          if (tagEnd < 0) break;
          const e = inner.indexOf('</td>', tagEnd);
          if (e < 0) break;
          const fi = inner.indexOf('field="', s);
          if (fi >= 0 && fi < tagEnd) {
            const fe = inner.indexOf('"', fi + 7);
            if (fe > fi && fe < tagEnd) { obj[inner.slice(fi + 7, fe)] = stripTags(inner.slice(tagEnd + 1, e)); n++; }
          }
          idx = e + 5;
        }
        if (n) rows.push(obj);
      }
    }
    return { head, rows, total: rows.length };
  }
  function rowsToObjects(rows) {
    return rows.map(r => ({
      branchCode: r.BranchCode || '', branchName: r.BranchName || '',
      categoryCode: r.CategoryCode || '', categoryName: r.CategoryName || '',
      date: r.OperDate || '',
      saleQty: num(r.SaleQty), saleAmount: num(r.SaleAmount),
      costAmount: num(r.SaleCostAmount), grossProfit: num(r.SaleGrossProfit),
    }));
  }

  // ---------------- 日期区间 ----------------
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmt(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function rangeOf(key, now = new Date()) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const wrap = (b, e, label) => ({ begin: b, end: e, label, beginStr: fmt(b), endStr: fmt(e) });
    switch (key) {
      case 'today': return wrap(today, today, '今日实时');
      case 'yesterday': { const y = new Date(today); y.setDate(y.getDate() - 1); return wrap(y, y, '昨天'); }
      case 'thisWeek': { const x = new Date(today); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return wrap(x, today, '本周'); }
      case 'thisMonth': return wrap(new Date(today.getFullYear(), today.getMonth(), 1), today, '本月');
      case 'lastMonth': return wrap(new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0), '上月');
      default: return wrap(today, today, '今日实时');
    }
  }

  // ---------------- 本地缓存（学官方 App：每个请求都带缓存，打开就有数） ----------------
  // 由宿主（App 的 localStorage / PC 的文件）注入：setCacheStore({ get(key), set(key, value) })
  let CACHE_STORE = null;
  const TTL = { branch: 12 * 3600e3, category: 12 * 3600e3, stock: 30 * 60e3 };
  function setCacheStore(store) { CACHE_STORE = store; }
  function cacheGet(key, ttl) {
    if (!CACHE_STORE) return null;
    try {
      const o = CACHE_STORE.get(key);
      if (o && Date.now() - Number(o.ts || 0) < ttl) return o.val;
    } catch (e) { /* 缓存坏了就当没有 */ }
    return null;
  }
  function cacheSet(key, val) {
    if (!CACHE_STORE) return;
    try { CACHE_STORE.set(key, { ts: Date.now(), val }); } catch (e) { /* 存不下就算了 */ }
  }

  // ---------------- 会话：带自动重登 ----------------
  class Session {
    constructor(acct) { this.acct = acct; this.sess = null; this.error = null, this.loginErr = ''; }
    async ensure() {
      // 账号密码不对时**绝不反复登录**：每次重试都会打厂家一次，容易被判异常
      if (this.loginErr) throw new Error(this.loginErr);
      if (!this.sess) {
        if (this.acct.snapshot) this.sess = restoreSession(this.acct.snapshot);
        if (!this.sess) {
          try { this.sess = await login(this.acct); }
          catch (e) {
            const m = String((e && e.message) || e);
            if (/密码|商户ID|账号或密码/.test(m)) this.loginErr = m;
            throw e;
          }
        }
      }
      return this.sess;
    }
    async run(fn) {
      let last = null;
      for (let i = 0; i < 2; i++) {
        if (isLimited()) throw guardError();        // 保护期内一次都不重试
        try { return await fn(await this.ensure()); }
        catch (e) {
          last = e;
          const msg = String((e && e.message) || e);
          if (/限流保护中/.test(msg)) break;
          if (/登录失败|票据|失效|HTTP 40|HTTP 50/.test(msg)) this.sess = null;
          // 撞上「操作过于频繁(0002)」就多等一会儿再试，别在同一个窗口里硬冲
          await new Promise(r => setTimeout(r, /过于频繁|0002/.test(msg) ? 4000 : 600));
        }
      }
      throw last;
    }
    async api(path, data, query, method) {
      return this.run(async (s) => {
        const r = await apiRequest(s, path, data || {}, query || {}, method || 'POST');
        if (r.__status && r.__status !== 200) throw new Error('HTTP ' + r.__status);
        if (r.Code !== undefined && r.Code !== 0) throw new Error(r.Message || ('接口错误 ' + r.Code));
        return r.Data;
      });
    }
    async grid(controller, aq, opts) {
      return this.run((s) => gridRequest(s, controller, aq, opts || {}));
    }
    snapshot() {
      if (!this.sess) return null;
      const s = this.sess;
      return {
        tenantCode: s.tenantCode, siteHost: s.siteHost, apiBase: s.apiBase, token: s.token,
        apptoken: s.apptoken, appKey: s.appKey, tenantId: s.tenantId, tenantName: s.tenantName,
        branchId: s.branchId, loginAt: s.loginAt, cookies: s.jar.entries(),
      };
    }
  }

  // ---------------- 取数 ----------------
  const BRANCH_QUERY = {
    PageSize: 10000, PageIndex: 0, FilterBranchTypeArray: [''],
    IsBranchGrant: true, IsSupervision: true, OnlyShowCurrent: false,
    Query: '', RegionId: -1, ShowAllBranchItem: true, Sort: [{ Name: 'Code', Direction: true }],
  };

  async function fetchBranches(ts) {
    // 分店清单一年也变不了几次，本地缓存 12 小时（官方 App 也是每个请求都带缓存的）
    const key = 'br:' + ts.acct.tenantCode;
    const hit = cacheGet(key, TTL.branch);
    if (hit) return hit;
    const d = await ts.api('api/v1/branch/query', BRANCH_QUERY);
    const list = (d && d.Data) || [];
    const out = list.filter(b => b.Id !== 0).map(b => ({ id: b.Id, code: b.Code, name: b.Name }));
    if (out.length) cacheSet(key, out);
    return out;
  }

  /** 首页接口里那些「名称 → 数值」的字典字段：不同版本字段名不一样，多试几个 */
  function pickMap(d, names) {
    for (const n of names) {
      const v = d[n];
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v) ? v.length : Object.keys(v).length) return v;
    }
    return {};
  }

  async function fetchHome(ts, dateStr) {
    const d = await ts.api('api/v1/Home/QueryHomeStatisticsInfo', {
      BranchId: 0, BeginDate: dateStr + ' 00:00:00', EndDate: dateStr + ' 23:59:59.997',
      DateType: 'today', DataTypes: [],
    });
    if (!d) return null;
    const pick = (n) => { const x = (d.BusinessDatas || []).find(i => i.Name === n); return x ? Number(x.Value) || 0 : 0; };
    return {
      totalSale: pick('TotalSale'), realAmount: pick('RealAmount'), grossProfit: pick('GrossAmount'),
      grossCost: pick('GrossCostAmount'), grossRate: pick('GrossRate'),
      customers: pick('CustoromNum'), avgPrice: pick('CustoromPrice'),
      offline: pick('OfflineAmount'), online: pick('OnlineAmount'),
      memberConsume: pick('MemberConsume'), memberCount: pick('MemberCount'),
      // 分小时：不同后台版本字段名不一样，依次试（SaleAmount 是目前在用的）
      hourly: pickMap(d, ['SaleAmount', 'HourSale', 'HourSaleAmount', 'SaleAmountByHour', 'TimeSaleAmount', 'HourlySaleAmount']),
      category: d.CategoryProportion || {},
      branchRanking: d.BranchRanking || {}, itemRanking: d.ItemRanking || {},
    };
  }

  async function fetchRangeSale(ts, range) {
    const all = [
      { Field: 'BranchId', Operator: 'Equals', Value: '0' },
      { Field: 'Branch.Name', Operator: 'Equals', Value: '全部门店' },
      { Field: 'OperDate', Operator: 'Between', Value: range.beginStr + ',' + range.endStr },
    ];
    // 手机端串行发，避免触发思迅「操作过于频繁」
    const cat = await ts.grid('RptSaleSummaryAnalysis', [{ Field: 'GroupType', Value: 'Category' }, { Field: 'CategoryLevel', Value: '1' }, ...all], { pageSize: 2000 });
    await sleep(150);
    const daily = await ts.grid('RptSaleSummaryAnalysis', [{ Field: 'GroupType', Value: 'BranchDaily' }, ...all], { pageSize: 2000 });
    return { cat: rowsToObjects(cat.rows || []), daily: rowsToObjects(daily.rows || []) };
  }

  /** 库存：口径必须和电脑大屏一致——按门店逐个取小类（CategoryLevel=3），再归到大类。
   *  直接取「大类 + 全店」会多算好几倍（实测 17.2 万 vs 真实 4.7 万），千万别改回去。 */
  async function fetchStock(ts, branches, catMap) {
    // 库存是慢变量，且与档位无关：本地缓存 30 分钟，切档位/二次打开直接命中
    const key = 'sk2:' + ts.acct.tenantCode;
    const hit = cacheGet(key, TTL.stock);
    if (hit && hit.length) return hit;
    // 血的教训：**不要按分店逐个取**。分店 6 个就要 6 个请求，其中一个撞上限流(0002)
    // 被 try/catch 静默吞掉，库存就少算一大截（实测女装 370 件 vs 真实 10006 件），
    // 而且脏结果还会被缓存 30 分钟。全店一次取 = 各分店之和（已实测一致），且只要 1 个请求。
    const g = await ts.grid('RptStmItems', [
      { Field: 'GroupType', Value: 'StockByCategory' }, { Field: 'CategoryLevel', Value: '3' },
    ], { pageSize: 3000 });
    const out = [];
    for (const r of (g.rows || [])) {
      const top = topCategory(catMap, r.CategoryCode);
      out.push({
        branchCode: r.BranchCode || '', branchName: r.BranchName || '',
        categoryCode: top.code, categoryName: top.name,
        stockQty: num(r.StockQty), costAmount: num(r.CostAmount), retailAmount: num(r.StockSaleAmount),
      });
    }
    if (out.length) cacheSet(key, out);
    return out;
  }

  /** 小类编码 → 它所属的大类（编码前 3 位） */
  function topCategory(catMap, code) {
    const c = String(code || '').trim();
    if (!c) return { code: '', name: '未分类' };
    const top = c.length > 3 ? c.slice(0, 3) : c;
    const hit = catMap && catMap.get(top);
    return { code: top, name: (hit && hit.name) || (c === top ? (catMap && catMap.get(c) ? catMap.get(c).name : '未分类') : '未分类') };
  }

  async function fetchCategories(ts) {
    const key = 'ct:' + ts.acct.tenantCode;
    const hit = cacheGet(key, TTL.category);
    if (hit) return new Map(hit);
    try {
      const d = await ts.api('api/v1/category/query', { PageSize: 3000, PageIndex: 0 });
      const list = (d && d.Data) || [];
      const m = new Map();
      for (const c of list) m.set(String(c.Code), { name: c.Name || '', parentId: c.ParentId || 0 });
      if (m.size) cacheSet(key, [...m.entries()]);
      return m;
    } catch (e) { return new Map(); }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /**
   * 首屏快通道：每家店只发 1～2 个请求就把最关键的数跑出来
   *   今日档 → 一条「首页统计」接口（销售额/毛利/客流/客单价/小时/门店排行，实测 0.3～1.5 秒）
   *   其它档 → 一条大类销售 + 一条日销售报表
   * 大类库存、趋势这些慢的留给第二阶段补。官方 App 的首屏也是这个思路：先看实时，明细后补。
   */
  async function collectQuick(acct, rangeKey) {
    const ts = new Session(acct);
    const range = rangeOf(rangeKey);
    const out = { tenantCode: acct.tenantCode, alias: acct.alias || acct.tenantCode, ok: false, error: '', quick: true };
    try {
      await ts.ensure();
      if (rangeKey === 'today') {
        const home = await fetchHome(ts, range.beginStr);
        if (home) out.home = home;
        // 顺带拉一条大类销售（很轻，约 0.1～0.3 秒），首屏第二块就有数
        try {
          const g = await ts.grid('RptSaleSummaryAnalysis', [
            { Field: 'GroupType', Value: 'Category' }, { Field: 'CategoryLevel', Value: '1' },
            { Field: 'BranchId', Operator: 'Equals', Value: '0' },
            { Field: 'Branch.Name', Operator: 'Equals', Value: '全部门店' },
            { Field: 'OperDate', Operator: 'Between', Value: range.beginStr + ',' + range.endStr },
          ], { pageSize: 2000 });
          out.cat = rowsToObjects(g.rows || []);
        } catch (e) { out.cat = []; }
        out.ok = !!(out.home || (out.cat && out.cat.length));
        if (!out.ok) out.error = '没有实时数据';
      } else {
        const sale = await fetchRangeSale(ts, range);
        out.cat = sale.cat; out.daily = sale.daily; out.ok = true;
      }
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    out.snapshot = ts.snapshot();
    return out;
  }

  /**
   * 取一个商户在一个档位下的全部数据。
   * opts（第二阶段复用第一阶段已经取到的东西，避免同一个接口请求两遍）：
   *   home / cat / daily —— 快通道拿到的结果；snapshot —— 复用登录票据，不再登一次
   */
  async function collectAccount(acct, rangeKey, onStep, opts) {
    const step = onStep || function () { };
    const o = opts || {};
    const ts = new Session(acct);
    const range = rangeOf(rangeKey);
    const out = { tenantCode: acct.tenantCode, alias: acct.alias || acct.tenantCode, ok: false, error: '', range };
    try {
      step('登录中');
      await ts.ensure();
      step('读取门店');
      const branches = await fetchBranches(ts);
      out.branches = branches;
      step('读取类别');
      const catMap = await fetchCategories(ts);
      // 快通道已经取过的就不重复请求（今日档不需要趋势，缺 daily 也无所谓）
      if (o.cat && (o.daily || rangeKey === 'today')) {
        out.cat = o.cat; out.daily = o.daily || [];
      } else {
        step('读取销售');
        const sale = await fetchRangeSale(ts, range);
        out.cat = sale.cat; out.daily = sale.daily;
      }
      step('读取库存');
      out.stock = await fetchStock(ts, branches, catMap);
      if (rangeKey === 'today') {
        if (o.home) out.home = o.home;               // 快通道已经取过，不再重复请求
        else { step('读取实时'); try { out.home = await fetchHome(ts, range.beginStr); } catch (e) { out.home = null; } }
      }
      out.ok = true;
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    out.snapshot = ts.snapshot();
    return out;
  }

  /** 只做连通性测试（填账号时用）
   *  tenantName 取会话里的商户名（电脑大屏同一个来源），没有再退回商户号；
   *  不要用第一个物理分店名顶替——一个 ID 下挂着好几个分店，取第一个会误导。 */
  async function testAccount(acct) {
    const ts = new Session(acct);
    await ts.ensure();
    const branches = await fetchBranches(ts);
    const sess = ts.sess || {};
    return {
      ok: true,
      tenantName: sess.tenantName || acct.tenantCode,
      branches: branches.map(b => ({ code: b.code, name: b.name })),
      snapshot: ts.snapshot(),
    };
  }

  // ---------------- 聚合（手机版口径，与 Windows 版大类/门店口径一致） ----------------
  function objToPairs(o) {
    if (!o) return [];
    if (Array.isArray(o)) return o.map(x => ({ name: (x.Name || x.name || x.Key || ''), value: Number(x.Value != null ? x.Value : x.value) || 0 }));
    return Object.keys(o).map(k => ({ name: k, value: Number(o[k]) || 0 }));
  }
  function levelOf(code) { if (!code) return 0; if (code.length <= 3) return 1; if (code.length <= 6) return 2; return 3; }

  function buildMobile(results, rangeKey) {
    const range = rangeOf(rangeKey);
    const okList = (results || []).filter(r => r && r.ok);
    const errors = (results || []).filter(r => r && !r.ok).map(r => ({ tenantCode: r.tenantCode, alias: r.alias, error: r.error }));

    const totals = { sale: 0, qty: 0, cost: 0, profit: 0, customers: 0, avgPrice: 0, stockQty: 0, stockCost: 0, stockRetail: 0 };
    const storeMap = new Map();     // 门店维度
    const catMap = new Map();       // 大类维度（按名称合并，跨商户可比）
    const storeCatMap = new Map();  // 门店 × 大类（手机上切单店时用）
    const dailyMap = new Map();
    const hourlyMap = new Map();
    let items = [];
    let catRowCount = 0;

    // 门店口径（与电脑大屏 aggregate.js 完全一致）：
    // **一个商户 ID（tenantCode）就是一个门店**，它名下的物理分店全部累加成一条数据。
    // 例如 68548362 下面挂着南充店/2分店/霍克乌德/小商品/小象仓/总部共 6 个分店，
    // 在界面上只显示「王子鞋服闪电仓」这一行，销售额与库存取 6 个分店之和。
    const storeNameByKey = new Map(); // tenantCode -> 门店显示名
    const ensureStore = (key, name) => {
      let s = storeMap.get(key);
      if (!s) {
        s = { key, name, tenant: key, sale: 0, qty: 0, profit: 0, stockQty: 0, stockCost: 0, cats: [] };
        storeMap.set(key, s);
      }
      return s;
    };

    for (const r of okList) {
      const alias = r.alias || r.tenantName || r.tenantCode;
      const storeKey = String(r.tenantCode);
      const sname = storeNameByKey.get(storeKey) || alias;
      storeNameByKey.set(storeKey, sname);
      // 大类 × 门店
      for (const row of (r.cat || [])) {
        catRowCount++;
        totals.sale += row.saleAmount; totals.qty += row.saleQty;
        totals.cost += row.costAmount; totals.profit += row.grossProfit;
        const cname = row.categoryName || '未分类';
        let c = catMap.get(cname);
        if (!c) { c = { name: cname, sale: 0, qty: 0, profit: 0, cost: 0 }; catMap.set(cname, c); }
        c.sale += row.saleAmount; c.qty += row.saleQty; c.profit += row.grossProfit; c.cost += row.costAmount;
        const s = ensureStore(storeKey, sname);
        s.sale += row.saleAmount; s.qty += row.saleQty; s.profit += row.grossProfit;
        // 门店 × 大类（切单店时用）
        let sc = storeCatMap.get(storeKey);
        if (!sc) { sc = new Map(); storeCatMap.set(storeKey, sc); }
        let cc = sc.get(cname);
        if (!cc) { cc = { name: cname, sale: 0, qty: 0, profit: 0, cost: 0, stockQty: 0, stockCost: 0 }; sc.set(cname, cc); }
        cc.sale += row.saleAmount; cc.qty += row.saleQty;
        cc.profit += row.grossProfit; cc.cost += row.costAmount;
      }
      for (const row of (r.daily || [])) {
        const d = String(row.date || '').slice(0, 10);
        if (!d) continue;
        dailyMap.set(d, (dailyMap.get(d) || 0) + row.saleAmount);
      }
      for (const row of (r.stock || [])) {
        totals.stockQty += row.stockQty; totals.stockCost += row.costAmount; totals.stockRetail += row.retailAmount;
        const cname = row.categoryName || '未分类';
        let c = catMap.get(cname);
        if (!c) { c = { name: cname, sale: 0, qty: 0, profit: 0, cost: 0, stockQty: 0, stockCost: 0 }; catMap.set(cname, c); }
        c.stockQty = (c.stockQty || 0) + row.stockQty; c.stockCost = (c.stockCost || 0) + row.costAmount;
        // 库存是按物理分店逐个请求的，这里统统加进同一个门店，不再按分店拆行
        const s = ensureStore(storeKey, sname);
        s.stockQty += row.stockQty; s.stockCost += row.costAmount;
        let sc = storeCatMap.get(storeKey);
        if (!sc) { sc = new Map(); storeCatMap.set(storeKey, sc); }
        let cc = sc.get(cname);
        if (!cc) { cc = { name: cname, sale: 0, qty: 0, profit: 0, cost: 0, stockQty: 0, stockCost: 0 }; sc.set(cname, cc); }
        cc.stockQty += row.stockQty; cc.stockCost += row.costAmount;
      }
      if (r.home) {
        totals.customers += r.home.customers || 0;
        // 快通道只有实时数据（大类报表还没回来）时，先用首页统计把总额顶上
        if (!catRowCount) {
          totals.sale += r.home.totalSale || 0;
          totals.profit += r.home.grossProfit || 0;
          totals.cost += r.home.grossCost || 0;
        }
        for (const p of objToPairs(r.home.hourly)) {
          const key = String(p.name).replace(/\D/g, '').padStart(2, '0');
          hourlyMap.set(key, (hourlyMap.get(key) || 0) + p.value);
        }
        items = items.concat(objToPairs(r.home.itemRanking).map(p => ({ name: p.name, value: p.value, tenant: r.tenantCode })));
      }
    }
    // 门店兜底：有的店报表还没出数，只有今日实时数据。
    // 注意 branchRanking 是「物理分店」级别的今日销售额，必须求和后算作这一个门店的数字
    for (const r of okList) {
      if (!r.home) continue;
      const storeKey = String(r.tenantCode);
      const sname = storeNameByKey.get(storeKey) || r.alias || r.tenantName || storeKey;
      let brSum = 0;
      for (const p of objToPairs(r.home.branchRanking)) brSum += p.value;
      const s = ensureStore(storeKey, sname);
      if (!s.sale) s.sale = brSum;
    }

    totals.profitRate = totals.sale > 0 ? (totals.profit / totals.sale * 100) : 0;
    totals.avgPrice = totals.customers > 0 ? (totals.sale / totals.customers) : 0;

    const stores = [...storeMap.values()].sort((a, b) => b.sale - a.sale);
    // 每个门店自带它的大类明细，手机上切到单店时直接取用
    for (const s of stores) {
      const sc = storeCatMap.get(s.key);
      s.cats = sc ? [...sc.values()].sort((a, b) => b.sale - a.sale) : [];
    }
    // 补充「名下合并了几个物理分店」，界面上可以明示这是一个 ID 汇总出来的门店
    const branchCountBy = new Map();
    for (const r of okList) branchCountBy.set(String(r.tenantCode), (r.branches || []).length);
    for (const s of stores) s.branchCount = branchCountBy.get(s.key) || 0;
    const categories = [...catMap.values()].sort((a, b) => b.sale - a.sale);
    const daily = [...dailyMap.entries()].map(([d, v]) => ({ date: d, sale: v })).sort((a, b) => a.date < b.date ? -1 : 1);
    const hourly = [...hourlyMap.entries()].map(([h, v]) => ({ hour: h, sale: v })).sort((a, b) => (a.hour < b.hour ? -1 : 1));
    items.sort((a, b) => b.value - a.value);

    return {
      rangeKey, label: range.label, begin: range.beginStr, end: range.endStr,
      updatedAt: Date.now(), totals, stores, categories,
      daily, hourly, topItems: items.slice(0, 10),
      // partial = 首屏快通道出的数（库存 / 趋势还没补上），界面上要如实提示
      partial: okList.some(r => r.quick),
      errors, okCount: okList.length, allCount: (results || []).length,
    };
  }

  // ---------------- 季节销售与库存 ----------------
  // 口径跟电脑大屏一致：一个商品的季节只认真实档案，认不出来就归「未分类」
  //   1) 款式档案 SeasonName（商品档案的 ItemStyleId / SelfCode 关联）
  //   2) 商品档案 Specification（规格）
  //   3) 商品档案 Memo1 / Memo2（备注，严格匹配「春/夏/秋/冬」）
  const SEASON_LABELS = { spring: '春', summer: '夏', autumn: '秋', winter: '冬', none: '未分类', all: '不分季节' };
  const SEASON_ORDER = ['spring', 'summer', 'autumn', 'winter', 'none'];
  const SEASON_FIELDS = ['sale', 'qty', 'profit', 'cost', 'stockQty', 'stockCost'];
  const zeroSeason = () => ({ sale: 0, qty: 0, profit: 0, cost: 0, stockQty: 0, stockCost: 0 });
  function addSeason(o, src) {
    for (const f of SEASON_FIELDS) o[f] = (Number(o[f]) || 0) + (Number(src && src[f]) || 0);
    return o;
  }
  function rate(o) { o.rate = o.sale > 0 ? o.profit / o.sale * 100 : 0; return o; }

  /**
   * 报表行 / 商品行 → 它所属的**大类名称**（跟电脑大屏 aggregate.js 同一套反查顺序）：
   * 1) 行自带的类别编码取前 3 位；2) 类别名反查编码（库存行只有名字）；3) 回退商品档案的类别。
   * 都没有 → 归到「其他」，免得数据凭空消失。
   */
  function makeGroupResolver(catMap, archive) {
    const l1 = new Map();        // 大类编码(3 位) → 大类名称
    const nameCode = new Map();  // 类别名称 → 类别编码
    for (const [code, o] of (catMap || new Map())) {
      const c = String(code || '').trim();
      if (!c) continue;
      if (c.length <= 3 && !l1.has(c)) l1.set(c, (o && o.name) || c);
      if (o && o.name && !nameCode.has(o.name)) nameCode.set(o.name, c);
    }
    const l1Names = new Set(l1.values());
    const byCode = (code) => l1.get(String(code || '').trim().slice(0, 3)) || '';
    const byName = (nm) => {
      nm = String(nm || '').trim();
      if (!nm) return '';
      if (l1Names.has(nm)) return nm;
      return byCode(nameCode.get(nm));
    };
    return function groupOf(row) {
      const g = byCode(row.categoryCode) || byName(row.categoryName);
      if (g) return g;
      const a = row.itemCode ? archive.get(String(row.itemCode).trim()) : null;
      if (a) { const g2 = byCode(a.categoryCode) || byName(a.categoryName); if (g2) return g2; }
      return '其他';
    };
  }

  // 季节档案（商品档案 + 款式季节）拉一次要几十个请求、几十秒，是季节表慢的根因。
  // 拉到之后在本机存一份「商品 → 季节」的精简索引（24 小时有效），第二次起直接命中，
  // 季节表从「每次 1～3 分钟」变成「几秒钟」（官方 App 也是每类请求都带本地缓存的思路）。
  const SEASON_IDX_TTL = 24 * 3600e3;
  function buildSeasonIndex(archive, styles) {
    const season = {}, self = {}, catc = {}, catn = {};
    for (const [code, a] of archive) {
      let s = '';
      if (a.styleId && styles.byId.get(a.styleId)) s = styles.byId.get(a.styleId);
      else if (a.selfCode && styles.byCode.get(a.selfCode)) s = styles.byCode.get(a.selfCode);
      else s = normSeason(a.spec) || normSeason(a.memo1) || normSeason(a.memo2);
      if (s) { season[code] = s; if (a.selfCode) self[a.selfCode] = s; }
      // 类别优先存**名字**：档案只给 CategoryId（数字主键），名字反而能反查到大类
      if (a.categoryName) catn[code] = a.categoryName;
      else if (a.categoryCode) catc[code] = a.categoryCode;
    }
    return { season, self, catc, catn, count: archive.size };
  }
  /** 取（或复用）季节索引；返回 { season, self, catc, catn, fresh } */
  async function fetchSeasonIndex(ts, onStep) {
    const step = onStep || function () { };
    const key = 'sx:' + ts.acct.tenantCode;
    const hit = cacheGet(key, SEASON_IDX_TTL);
    if (hit && hit.season && hit.count) { step('用本机季节档案'); return Object.assign({ fresh: false }, hit); }
    step('读取商品档案（首次较慢，之后本机缓存）');
    const archive = await fetchItemArchive(ts);
    step('读取款式季节');
    let styles = { byId: new Map(), byCode: new Map() };
    try { styles = await fetchStyleSeasons(ts); } catch (e) { /* 没有款式档案就走规格 / 备注 */ }
    const idx = buildSeasonIndex(archive, styles);
    cacheSet(key, idx);
    return Object.assign({ fresh: true }, idx);
  }

  function normSeason(s) {
    const t = String(s == null ? '' : s).trim();
    if (!t) return '';
    if (/春秋|春款/.test(t)) return 'spring';
    if (t.indexOf('春') >= 0) return 'spring';
    if (t.indexOf('夏') >= 0) return 'summer';
    if (t.indexOf('秋') >= 0) return 'autumn';
    if (t.indexOf('冬') >= 0) return 'winter';
    return '';
  }

  /** 分页拉档案类接口（api/v1/...） */
  async function pullPagedApi(ts, path, extra, maxPages) {
    const out = [];
    const PAGE = 1000;
    const pages = maxPages || 30;
    for (let i = 0; i < pages; i++) {
      const d = await ts.api(path, Object.assign({ PageIndex: i, PageSize: PAGE }, extra || {}));
      const list = (d && (d.Data || d.data)) || (Array.isArray(d) ? d : []);
      if (!Array.isArray(list) || !list.length) break;
      for (const r of list) out.push(r);
      const total = Number((d && (d.TotalCount || d.totalCount || d.Total)) || 0);
      if (total && out.length >= total) break;
      if (list.length < PAGE) break;
      await sleep(180);
    }
    return out;
  }

  /** 分页拉报表（grid） */
  async function pullGridPaged(ts, controller, aq, pageSize, maxPages) {
    const out = [];
    const SIZE = pageSize || 10000;
    const pages = maxPages || 8;
    for (let p = 1; p <= pages; p++) {
      const g = await ts.grid(controller, aq, { pageSize: SIZE, pageIndex: p });
      const rows = g.rows || [];
      if (!rows.length) break;
      for (const r of rows) out.push(r);
      if (rows.length < SIZE) break;
      await sleep(220);
    }
    return out;
  }

  /** 商品档案：code -> 季节相关字段 */
  async function fetchItemArchive(ts) {
    const rows = await pullPagedApi(ts, 'api/v1/item/index');
    const m = new Map();
    for (const r of rows) {
      const code = String(r.Code || r.ItemCode || '').trim();
      if (!code) continue;
      m.set(code, {
        styleId: String(r.ItemStyleId || '').trim(),
        selfCode: String(r.SelfCode || '').trim(),
        spec: String(r.Specification || '').trim(),
        producer: String(r.Producer || '').trim(),
        memo1: String(r.Memo1 || '').trim(),
        memo2: String(r.Memo2 || '').trim(),
        // 注意：商品档案里只有 CategoryId（数字主键）和 CategoryName，没有类别编码，
        // 别把 CategoryId 当编码用（会反查不到大类，整类掉进「其他」）
        categoryCode: String(r.CategoryCode || '').trim(),
        categoryName: String(r.CategoryName || '').trim(),
      });
    }
    return m;
  }

  /** 款式档案：款式 id / 款式码 -> 季节名 */
  async function fetchStyleSeasons(ts) {
    const rows = await pullPagedApi(ts, 'api/v1/ItemStyle/index');
    const byId = new Map(), byCode = new Map();
    for (const r of rows) {
      const season = normSeason(r.SeasonName || r.Season || '');
      if (!season) continue;
      const id = String(r.Id || r.StyleId || '').trim();
      const code = String(r.Code || '').trim();
      if (id) byId.set(id, season);
      if (code) byCode.set(code, season);
    }
    return { byId, byCode };
  }

  /** 商品级销售（含成本毛利） */
  async function fetchSeasonSale(ts, range) {
    const rows = await pullGridPaged(ts, 'RptSaleGrossAnalysis', [
      { Field: 'GroupType', Value: 'item' },
      { Field: 'OperDate', Operator: 'Between', Value: range.beginStr + ',' + range.endStr },
    ]);
    return rows.map(r => ({
      itemCode: String(r.ItemCode || '').trim(),
      selfCode: String(r.SelfCode || '').trim(),
      // 报表本身就有类别（编码 + 名字），直接带上，不用回头查档案
      categoryCode: String(r.CategoryCode || '').trim(),
      categoryName: String(r.CategoryName || '').trim(),
      saleQty: num(r.SaleQty), saleAmount: num(r.SaleAmount),
      costAmount: num(r.CostAmount != null ? r.CostAmount : r.SaleCostAmount),
      grossProfit: num(r.GrossProfit != null ? r.GrossProfit : r.SaleGrossProfit),
    }));
  }

  /**
   * 商品级库存：行数最多（全店 5 万+ 行），第一页拿到后剩下的页两路并发拉，
   * 串行拉要三四分钟，并发后能砍掉一半以上。
   * 字段名跟电脑大屏一致：数量 StockQty、成本 PurcPriceAmount（不是 CostAmount），
   * 负库存属异常数据（先销后入 / 串码），不参与季节分析。
   */
  const SEASON_STOCK_TTL = 12 * 3600e3;   // 季节库存是慢变量，按门店缓存 12 小时
  async function fetchSeasonStock(ts) {
    const PAGE = 10000, MAXP = 8;
    const aq = [{ Field: 'GroupType', Value: 'StockByItem2' }];
    // 血的教训：这里**不能并发**——同一账号并发报表会被思迅判成「操作过于频繁(0002)」，
    // 少拿任何一页库存就会少算一大截（实测并发版少了一半以上的库存）。
    // 老老实实串行翻页，页间留空隙，遇到 0002 退避重试；真机上开了 gzip，单页 0.45MB。
    const out = [];
    const fetchPage = async (pi) => {
      for (let a = 0; a < 3; a++) {
        try {
          const g = await ts.grid('RptStmItems', aq, { pageSize: PAGE, pageIndex: pi });
          return g.rows || [];
        } catch (e) {
          await sleep(a === 0 ? 3000 : 9000);   // 撞限流就退避，别硬冲
        }
      }
      return null;
    };
    for (let p = 1; p <= MAXP; p++) {
      const rows = await fetchPage(p);
      if (rows == null) { out.incomplete = true; break; }   // 少页了要如实标记
      for (const r of rows) out.push(r);
      if (rows.length < PAGE) break;                        // 不满页说明后面没有了
      await sleep(800);
    }
    return out;
  }
  function mapStockRow(r) {
    const q = num(r.StockQty);
    const pos = q > 0;
    return {
      itemCode: String(r.ItemCode || r.SelfCode || '').trim(),
      stockQty: pos ? q : 0,
      stockCost: pos ? num(r.PurcPriceAmount) : 0,
    };
  }

  /**
   * 一个商户的季节汇总：**大类 × 季节**（销售 + 库存）。
   * 每个大类另外记一份「档案季节覆盖权重」，门店维度没覆盖到的大类在界面上合并成一栏「不分季节」。
   */
  async function collectSeason(acct, rangeKey, onStep, onPartial, opts) {
    // 商品级库存是季节表里最慢的一步（全店几万行、要翻好几页）。
    // 默认（opts.withStock=false）只统计销售，几秒就出表；要库存再单独点一次
    // 「含库存统计」，结果按门店缓存 12 小时，之后就不用再等了。
    const wantStock = !(opts && opts.withStock === false);
    const step = onStep || function () { };
    const ts = new Session(acct);
    const range = rangeOf(rangeKey);
    const out = { tenantCode: acct.tenantCode, alias: acct.alias || acct.tenantCode, ok: false, error: '', groups: [], ms: {} };
    const ms = out.ms;
    let t0 = Date.now();
    const lap = (k) => { ms[k] = Date.now() - t0; t0 = Date.now(); };
    try {
      await ts.ensure();
      lap('登录');
      step('读取类别');
      const catMap = await fetchCategories(ts);
      lap('类别');
      // 季节档案：优先用本机索引（24h 内有效），没有才联网拉商品档案 + 款式档案
      const idx = await fetchSeasonIndex(ts, step);
      lap('季节档案');
      step('读取商品级销售');
      const saleRows = await fetchSeasonSale(ts, range);
      lap('商品级销售');
      step('汇总季节');

      // 商品 -> 季节（只认档案，认不出归未分类）
      const seasonOf = (code, selfCode) => {
        if (!code) return 'none';
        return idx.season[code] || (selfCode && idx.self[selfCode]) || 'none';
      };
      // 大类反查的兜底（报表行自带类别时用它，只有缺类别的行才查档案）
      const archive = {
        get: (code) => {
          const c = idx.catc[code], n = idx.catn[code];
          return (c || n) ? { categoryCode: c || '', categoryName: n || '' } : null;
        },
      };
      const groupOf = makeGroupResolver(catMap, archive);

      const gmap = new Map();
      const slotGroup = (name) => {
        let g = gmap.get(name);
        if (!g) { g = { name, rows: new Map(), total: zeroSeason(), stat: { totalW: 0, authW: 0 } }; gmap.set(name, g); }
        return g;
      };
      const slotRow = (g, key) => {
        let o = g.rows.get(key);
        if (!o) { o = Object.assign({ key, season: SEASON_LABELS[key] || key }, zeroSeason()); g.rows.set(key, o); }
        return o;
      };
      const put = (row, season, fields) => {
        const g = slotGroup(groupOf(row));
        const o = slotRow(g, season);
        addSeason(o, fields);
        addSeason(g.total, fields);
        const w = Math.abs(Number(fields.sale) || 0) + Math.abs(Number(fields.stockQty) || 0) * 0.01;
        g.stat.totalW += w;
        if (season !== 'none') g.stat.authW += w;
      };

      for (const r of saleRows) {
        put(r, seasonOf(r.itemCode, r.selfCode), {
          sale: r.saleAmount, qty: r.saleQty, profit: r.grossProfit, cost: r.costAmount,
        });
      }
      lap('销售汇总');
      const snapshot = () => [...gmap.values()].sort((a, b) => b.total.sale - a.total.sale).map(g => ({
        name: g.name,
        total: Object.assign({}, g.total),
        stat: Object.assign({}, g.stat),
        rows: SEASON_ORDER.filter(k => g.rows.has(k)).map(k => Object.assign({}, g.rows.get(k))),
      }));
      if (typeof onPartial === 'function') {
        try { onPartial(snapshot()); } catch (e) { /* 预览失败不影响正式结果 */ }
      }
      // 商品级库存：全店几万行，是季节表最慢的一步（单页 17MB 的 HTML）。
      // 汇总结果（大类 × 季节，只有几十个数）按门店缓存 12 小时，第二次起直接复用。
      const skey = 'ss:' + String(acct.tenantCode);
      let sg = cacheGet(skey, SEASON_STOCK_TTL);
      if (sg && sg.length) {
        step('用本机季节库存');
      } else if (!wantStock) {
        // 只要季节销售：跳过最慢的库存环节，界面上标注「未统计库存」
        step('本次不统计库存');
        sg = null;
        out.stockSkipped = true;
      } else {
        step('读取商品级库存（第一次较慢）');
        let stockRows = [];
        try { stockRows = await fetchSeasonStock(ts); } catch (e) { /* 库存失败不影响销售 */ }
        lap('商品级库存');
        const sm = new Map();
        for (const r of stockRows) {
          const s = mapStockRow(r);
          if (!s.itemCode) continue;
          const name = groupOf({ itemCode: s.itemCode, categoryCode: r.CategoryCode, categoryName: r.CategoryName });
          let g = sm.get(name); if (!g) { g = new Map(); sm.set(name, g); }
          const season = seasonOf(s.itemCode, '');
          let o = g.get(season); if (!o) { o = { key: season, stockQty: 0, stockCost: 0 }; g.set(season, o); }
          o.stockQty += s.stockQty; o.stockCost += s.stockCost;
        }
        sg = [...sm.entries()].map(([name, rows]) => ({ name, rows: [...rows.values()] }));
        // 缺页的库存不完整，别把它缓存成 12 小时「标准答案」
        if (sg.length && !stockRows.incomplete) cacheSet(skey, sg);
        out.stockPartial = !!stockRows.incomplete;
        lap('库存汇总');
      }
      let stockSum = 0;
      for (const g of sg || []) {
        for (const row of g.rows) {
          put({ categoryCode: '', categoryName: g.name }, row.key,
            { stockQty: row.stockQty, stockCost: row.stockCost });
          stockSum += row.stockQty || 0;
        }
      }
      // 库存到底有没有拿到：拿不到就如实告诉界面，别让表里躺着一堆 0 假装成功
      out.stockOk = out.stockSkipped ? false : stockSum > 0;
      out.groups = snapshot();
      out.ok = true;
      out.idxFresh = !!idx.fresh;
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    out.snapshot = ts.snapshot();
    return out;
  }

  // ---------------- 趋势：周 / 月 / 年 ----------------
  // 日趋势用的是当前档位的日报表（已有），周 / 月 / 年需要一年以上的日销售：
  // 每个商户只发 1～2 个请求（去年 1 月 1 日 → 今天），结果按商户缓存在本机（默认 6 小时）。
  async function collectTrend(acct) {
    const ts = new Session(acct);
    const now = new Date();
    const begin = new Date(now.getFullYear() - 1, 0, 1);
    const out = { tenantCode: acct.tenantCode, alias: acct.alias || acct.tenantCode, ok: false, error: '', daily: [] };
    try {
      await ts.ensure();
      const rows = await pullGridPaged(ts, 'RptSaleSummaryAnalysis', [
        { Field: 'GroupType', Value: 'BranchDaily' },
        { Field: 'BranchId', Operator: 'Equals', Value: '0' },
        { Field: 'Branch.Name', Operator: 'Equals', Value: '全部门店' },
        { Field: 'OperDate', Operator: 'Between', Value: fmt(begin) + ',' + fmt(now) },
      ], 5000, 8);
      const map = new Map();
      for (const r of rows) {
        const d = String(r.OperDate || '').slice(0, 10);
        if (!d) continue;
        map.set(d, (map.get(d) || 0) + num(r.SaleAmount));
      }
      out.daily = [...map.entries()].map(([date, sale]) => ({ date, sale })).sort((a, b) => (a.date < b.date ? -1 : 1));
      out.ok = true;
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    out.snapshot = ts.snapshot();
    return out;
  }

  /** 合并成「按天」的一条长序列，周/月/年由界面按同一份数据再聚合 */
  function buildTrend(results) {
    const okList = (results || []).filter(r => r && r.ok);
    const errors = (results || []).filter(r => r && !r.ok)
      .map(r => ({ tenantCode: r.tenantCode, alias: r.alias, error: r.error }));
    const total = new Map();
    const byStore = {};
    for (const r of okList) {
      const sk = String(r.tenantCode);
      const m = byStore[sk] = byStore[sk] || {};
      for (const d of (r.daily || [])) {
        const key = String(d.date || '').slice(0, 10);
        if (!key) continue;
        total.set(key, (total.get(key) || 0) + (Number(d.sale) || 0));
        m[key] = (m[key] || 0) + (Number(d.sale) || 0);
      }
    }
    const daily = [...total.entries()].map(([date, sale]) => ({ date, sale })).sort((a, b) => (a.date < b.date ? -1 : 1));
    return { updatedAt: Date.now(), daily, byStore, errors, okCount: okList.length };
  }

  /** 多个商户的季节汇总合并：一个大类一行组，格子里同时留着各家门店的数（切店时用） */
  function buildSeason(results) {
    const okList = (results || []).filter(r => r && r.ok);
    const errors = (results || []).filter(r => r && !r.ok)
      .map(r => ({ tenantCode: r.tenantCode, alias: r.alias, error: r.error }));
    const gmap = new Map();
    const slotGroup = (name) => {
      let g = gmap.get(name);
      if (!g) {
        g = { name, rows: new Map(), total: Object.assign(zeroSeason(), { byStore: {} }), statByStore: {}, seasonalByStore: {} };
        gmap.set(name, g);
      }
      return g;
    };
    for (const r of okList) {
      const sk = String(r.tenantCode);
      for (const gr of (r.groups || [])) {
        const G = slotGroup(gr.name);
        addSeason(G.total, gr.total);
        G.total.byStore[sk] = addSeason(G.total.byStore[sk] || zeroSeason(), gr.total);
        G.statByStore[sk] = { totalW: (gr.stat && gr.stat.totalW) || 0, authW: (gr.stat && gr.stat.authW) || 0 };
        for (const row of gr.rows) {
          let R = G.rows.get(row.key);
          if (!R) {
            R = Object.assign({ key: row.key, season: SEASON_LABELS[row.key] || row.season || row.key, byStore: {} }, zeroSeason());
            G.rows.set(row.key, R);
          }
          addSeason(R, row);
          R.byStore[sk] = addSeason(R.byStore[sk] || zeroSeason(), row);
        }
      }
    }
    const groups = [...gmap.values()].map(g => {
      g.rows = SEASON_ORDER.filter(k => g.rows.has(k)).map(k => g.rows.get(k));
      for (const [sk, st] of Object.entries(g.statByStore)) g.seasonalByStore[sk] = st.authW > 0;
      return g;
    }).sort((a, b) => b.total.sale - a.total.sale);

    // 全公司合计（同时留一份按门店的，切店时表底「合计」跟着变）
    const total = Object.assign(zeroSeason(), { byStore: {} });
    for (const g of groups) {
      addSeason(total, g.total);
      for (const [sk, v] of Object.entries(g.total.byStore || {})) total.byStore[sk] = addSeason(total.byStore[sk] || zeroSeason(), v);
    }
    // 兼容用途：春夏秋冬（跨大类）合计，用于顶部季节汇总条
    const seasons = SEASON_ORDER.map(k => {
      const o = Object.assign({ key: k, label: SEASON_LABELS[k], byStore: {} }, zeroSeason());
      for (const g of groups) {
        const r = g.rows.find(x => x.key === k);
        if (!r) continue;
        addSeason(o, r);
        for (const [sk, v] of Object.entries(r.byStore || {})) o.byStore[sk] = addSeason(o.byStore[sk] || zeroSeason(), v);
      }
      return rate(o);
    });
    return {
      updatedAt: Date.now(), groups, total, seasons, errors, okCount: okList.length,
      // 任一家门店的商品级库存没取到 → 界面上要说明「库存未统计到」，不能拿 0 充数
      stockOk: okList.length ? okList.every(r => r.stockOk !== false) : false,
      // 本次压根没统计库存（快模式）：界面提示「点『含库存统计』再算一次」
      stockSkipped: okList.length ? okList.some(r => !!r.stockSkipped) : false,
    };
  }

  /**
   * 季节表按门店裁剪（一个商户 ID = 一个门店）：
   * 该门店在这个大类里没录过季节 → 春夏秋冬合并成一栏「不分季节」（跟电脑大屏同一条规则）。
   * storeKey = 'all' 时返回全公司口径。
   */
  function viewSeason(data, storeKey) {
    if (!data || !data.groups) return null;
    const sk = storeKey == null || storeKey === 'all' ? 'all' : String(storeKey);
    const pick = (o) => {
      if (!o) return null;
      if (sk === 'all') return o;
      const b = o.byStore || {};
      return Object.prototype.hasOwnProperty.call(b, sk) ? b[sk] : null;
    };
    const groups = [];
    for (const g of data.groups) {
      const total = Object.assign(zeroSeason(), pick(g.total) || {});
      if (sk !== 'all' && !g.statByStore[sk]) continue;          // 这家门店没有这个大类
      const seasonal = sk === 'all' ? true : !!g.seasonalByStore[sk];
      let rows;
      if (seasonal) {
        rows = g.rows
          .map(r => Object.assign({ key: r.key, season: r.season }, zeroSeason(), pick(r) || {}))
          .filter(r => r.sale || r.qty || r.stockQty || r.stockCost);
      } else {
        const sum = zeroSeason();
        for (const r of g.rows) addSeason(sum, pick(r) || {});
        rows = [Object.assign({ key: 'all', season: SEASON_LABELS.all }, sum)];
      }
      if (!rows.length) continue;
      groups.push({ name: g.name, rows, total: rate(total), merged: !seasonal });
    }
    const total = Object.assign(zeroSeason(), pick(data.total) || {});
    const seasons = SEASON_ORDER.map(k => {
      const src = (data.seasons || []).find(s => s.key === k);
      return Object.assign({ key: k, label: SEASON_LABELS[k] }, zeroSeason(), pick(src) || {});
    }).filter(s => s.sale || s.qty || s.stockQty || s.stockCost).map(rate);
    return { groups, total: rate(total), seasons };
  }

  global.DashCore = {
    md5, login, testAccount, collectAccount, collectQuick, collectTrend, buildTrend, buildMobile, rangeOf,
    setCacheStore,
    // 取数安全：界面用它判断是否处于限流保护期（保护期内不要自动取数）
    status, clearGuard, setRate: (n) => { RL.max = Math.max(4, Math.min(30, Number(n) || RL.max)); },
    _trip: trip,               // 仅供调试：模拟一次厂家限流，验证保护提示
    Session, parseGrid, num, levelOf,
    collectSeason, buildSeason, viewSeason, SEASON_LABELS, SEASON_ORDER,
    fetchItemArchive,            // 诊断用：测商品档案拉取耗时/条数
  };
})(typeof window !== 'undefined' ? window : globalThis);
