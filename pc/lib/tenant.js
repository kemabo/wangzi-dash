'use strict';
// 单商户会话：自动登录、Cookie/票据持久化、失效自动重登
const fs = require('fs');
const path = require('path');
const { login, apiRequest, rawRequest, CookieJar } = require('./session');
const { parseGrid } = require('./grid');

const DATA_DIR = process.env.DASH_DATA_DIR || path.join(__dirname, '..', 'data');

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }

class TenantSession {
  constructor(acct) {
    this.acct = acct;
    this.tenantCode = acct.tenantCode;
    this.file = path.join(DATA_DIR, `session-${acct.tenantCode}.json`);
    this.sess = null;
    this.lastError = null;
    this.relayoutTimer = null;
  }

  /** 从磁盘恢复会话快照 */
  restore() {
    ensureDir();
    if (!fs.existsSync(this.file)) return false;
    try {
      const snap = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!snap.token || !snap.siteHost) return false;
      const jar = new CookieJar(snap.cookies);
      this.sess = {
        tenantCode: snap.tenantCode,
        siteHost: snap.siteHost,
        apiBase: snap.apiBase,
        token: snap.token,
        apptoken: snap.apptoken,
        appKey: snap.appKey,
        tenantId: snap.tenantId,
        tenantName: snap.tenantName,
        branchId: snap.branchId,
        branchName: snap.branchName,
        productType: snap.productType,
        jar,
        loginAt: snap.loginAt,
        cookies: snap.cookies,
      };
      return true;
    } catch (e) { return false; }
  }

  persist() {
    if (!this.sess) return;
    ensureDir();
    try {
      fs.writeFileSync(this.file, JSON.stringify({
        tenantCode: this.sess.tenantCode,
        siteHost: this.sess.siteHost,
        apiBase: this.sess.apiBase,
        token: this.sess.token,
        apptoken: this.sess.apptoken,
        appKey: this.sess.appKey,
        tenantId: this.sess.tenantId,
        tenantName: this.sess.tenantName,
        branchId: this.sess.branchId,
        branchName: this.sess.branchName,
        productType: this.sess.productType,
        loginAt: this.sess.loginAt,
        cookies: this.sess.jar.entries(),
      }, null, 2), 'utf8');
    } catch (e) { /* ignore */ }
  }

  async ensureLogin() {
    if (this.sess) {
      try {
        await this.ping();
        return this.sess;
      } catch (e) { this.sess = null; }
    }
    if (!this.restore() || !(await this.ping().catch(() => null))) {
      this.sess = await login(this.acct);
      this.persist();
    }
    return this.sess;
  }

  /** 轻量心跳：验证会话是否还活着 */
  async ping() {
    const r = await apiRequest(this.sess, 'api/v1/tenant/GetTenantInfo', {}, {}, 'GET');
    if (!r || r.Code !== 0) throw new Error((r && r.Message) || '会话失效');
    return true;
  }

  /** 统一的重登重试包装 */
  async run(fn, retries = 2) {
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
      try {
        await this.ensureLogin();
        return await fn(this.sess);
      } catch (e) {
        lastErr = e;
        const msg = String((e && e.message) || e);
        // 账号/密码不对是确定性错误，重试一万次也是同样结果。
        // 以前照样走完三轮「重登 + 退避等待」，一轮能拖出一百多秒的假卡顿。
        if (/商户ID、账号或密码不对|密码不正确|账号或密码错误|商户不存在/.test(msg)) {
          this.sess = null;
          this.lastError = msg;
          try { if (fs.existsSync(this.file)) fs.unlinkSync(this.file); } catch (_) { }
          throw e;
        }
        if (/登录失败|会话失效|未取到|错误/.test(msg)) {
          this.sess = null;
          try { if (fs.existsSync(this.file)) fs.unlinkSync(this.file); } catch (_) { }
        }
        await new Promise(r => setTimeout(r, 800 * (i + 1)));
      }
    }
    this.lastError = String(lastErr && lastErr.message || lastErr);
    throw lastErr;
  }

  /** JSON API 调用 */
  async api(p, data = {}, query = {}, method = 'POST') {
    return this.run(async (s) => {
      const r = await apiRequest(s, p, data, query, method);
      if (r.__status && r.__status !== 200) throw new Error('HTTP ' + r.__status);
      if (r.Code !== undefined && r.Code !== 0) throw new Error(r.Message || '接口错误 ' + r.Code);
      return r.Data;
    });
  }

  /** MVC 报表网格查询（返回 HTML 片段，解析为结构化数据） */
  async grid(controller, advancedQuery, opts = {}) {
    return this.run(async (s) => {
      const params = new URLSearchParams();
      params.set('{2}t', String(Date.now()));
      params.set('queryaction', 'query');
      params.set('tenantid', String(s.tenantId));
      params.set('pageIndex', String(opts.pageIndex || 1));
      params.set('SortOptions', '');
      params.set('query', '');
      params.set('queryFields', '');
      params.set('queryField', '');
      params.set('advancedQuery', JSON.stringify(advancedQuery));
      if (opts.pageSize) params.set('pageSize', String(opts.pageSize));
      const url = `https://${s.siteHost}/${controller}?${params.toString()}`;
      const r = await rawRequest(url, {
        jar: s.jar, accept: 'text/html,*/*',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `https://${s.siteHost}/${controller}`,
        },
      });
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      return parseGrid(r.body);
    });
  }
}

module.exports = { TenantSession, DATA_DIR };
