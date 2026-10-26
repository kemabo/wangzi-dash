/**
 * 移动端零售云平台直连客户端（基于移动端接口协议）
 * ------------------------------------------------------------------
 * 用途：作为「大屏电脑不可达」时的兜底取数通道。
 *       手机/服务端可直接向零售云平台云取核心 KPI，无需经过大屏电脑。
 *
 * 与网页版通道（lib/session.js）的区别：
 *   - 网页版：erp 表单登录 + Cookie，调 api/Report/* 重型报表端点
 *   - 移动端：api-auth 取 apptoken + tdtool/WXTDTool/Login，调
 *             api/v1/Home/QueryHomeStatisticsInfo 等轻量聚合端点
 *             端点自带 cacheTime/cachelevel 缓存语义，防限流更友好
 *
 * 关键凭据（由本地配置提供，appKey 以 base62 三字符编码混淆存储）：
 *   appId  = YOUR_MOBILE_APPID
 *   appKey = YOUR_MOBILE_APPKEY
 *
 * 防限流约定：
 *   - apptoken 有效期 7200s，模块内缓存复用，避免频繁换取
 *   - 所有请求经 MIN_INTERVAL_MS 节流，默认 1200ms
 * ------------------------------------------------------------------
 */
const crypto = require('crypto');
const https = require('https');

// ===== 常量（移动端协议常量）=====
const APP_ID = 'YOUR_MOBILE_APPID';
const APP_KEY = 'YOUR_MOBILE_APPKEY';

const HOST = {
  erp: 'https://erp.example.com/',          // RootType.auth
  platform: 'https://erp.example.com/',      // RootType.platform
  starCommon: 'https://erp.example.com/',       // RootType.star + isUseCommomApi
  starStore: 'https://erp.example.com/', // RootType.star
};

const PATH = {
  token: 'Token',                                   // GET  auth
  login: 'tdtool/WXTDTool/Login',                   // POST starStore
  home: 'api/v1/Home/QueryHomeStatisticsInfo',      // POST starCommon
};

const MIN_INTERVAL_MS = 1200;   // 请求最小间隔，防限流
let lastReqAt = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 请求节流：保证两次请求间隔 >= MIN_INTERVAL_MS */
async function throttle() {
  const wait = lastReqAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastReqAt = Date.now();
}

/**
 * 签名：键名升序 -> "k=v" 用 & 连接（对象走 JSON.stringify，跳过 undefined/空串）-> MD5 大写
 * 协议分析自 APK bll/parameter.js 的 I(e)
 */
function sign(obj) {
  const keys = Object.keys(obj).sort();
  const parts = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') { parts.push(k + '=' + JSON.stringify(v)); continue; }
    if (String(v).trim() !== '') parts.push(k + '=' + v);
  }
  return crypto.createHash('md5').update(parts.join('&'), 'utf8').digest('hex').toUpperCase();
}

function request(url, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const buf = body ? Buffer.from(body, 'utf8') : null;
    const r = https.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: Object.assign(
        { 'User-Agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/100 Mobile' },
        buf ? { 'Content-Type': 'application/json', 'Content-Length': buf.length } : {},
        headers
      ),
      timeout: 40000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('非 JSON 响应: ' + text.slice(0, 160))); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('请求超时')); });
    if (buf) r.write(buf);
    r.end();
  });
}

// ===== apptoken 缓存（有效期 7200s，提前 300s 续期）=====
let _apptoken = null;
let _apptokenExpireAt = 0;

async function getAppToken({ force = false } = {}) {
  if (!force && _apptoken && Date.now() < _apptokenExpireAt) return _apptoken;
  await throttle();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const noncestr = Math.random().toString().substring(2);
  const p = { appid: APP_ID, appkey: APP_KEY, noncestr, timestamp };
  const sg = sign(p);
  delete p.appkey;
  p.sign = sg;
  const qs = Object.keys(p).map(k => k + '=' + encodeURIComponent(p[k])).join('&');
  const j = await request(HOST.auth + PATH.token + '?' + qs);
  if (j.Code !== 0 || !j.Data || !j.Data.Token) {
    throw new Error('获取 apptoken 失败: Code=' + j.Code + ' ' + (j.Message || ''));
  }
  _apptoken = j.Data.Token;
  _apptokenExpireAt = Date.now() + ((j.Data.ExpireIn || 7200) - 300) * 1000;
  return _apptoken;
}

/**
 * 移动端登录
 * @param {string} tenantCode   商户号，如 10000001
 * @param {string} userAccount  操作员号，如 9999
 * @param {string} password     明文密码（服务端不需要 sha1 加盐）
 * @returns {Promise<object>} TdTenantInfo（TenantId/BranchId/OperatorId 等）
 */
async function login(tenantCode, userAccount, password) {
  // apptoken 是一次性的：一旦用于登录即失效，因此每次登录都强制重新获取
  const apptoken = await getAppToken({ force: true });
  await throttle();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const noncestr = Math.random().toString().substring(2);
  const params = {
    LoginType: 1,                      // 1=普通登录；0=快捷登录（无商户号）
    Code: 'erpcloud_app_code',
    TenantCode: tenantCode,
    UserAccountN: userAccount,
    PasswordN: password,
  };
  const sg = sign(Object.assign({ apptoken, appkey: APP_KEY, noncestr, timestamp }, params));
  const j = await request(HOST.starStore + PATH.login, {
    method: 'POST',
    body: JSON.stringify(params),
    headers: { 'content-type': 'application/json', apptoken, timestamp, noncestr, sign: sg },
  });
  if (j.Code !== 0) throw new Error('登录失败: ' + (j.Message || 'Code=' + j.Code));
  return {
    apptoken,
    appKey: APP_KEY,
    tenant: j.TdTenantInfo || {},
    raw: j,
  };
}

/**
 * 通用业务请求（已登录会话）
 * @param {object} sess   login() 的返回值
 * @param {string} path   相对路径，如 api/v1/Home/QueryHomeStatisticsInfo
 * @param {object} params 业务参数（会并入签名）
 * @param {string} hostKey HOST 的键，默认 starCommon
 */
async function api(sess, path, params = {}, hostKey = 'starCommon') {
  await throttle();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const noncestr = Math.random().toString().substring(2);
  const sg = sign(Object.assign(
    { apptoken: sess.apptoken, appkey: sess.appKey, noncestr, timestamp },
    params
  ));
  const headers = {
    'content-type': 'application/json',
    apptoken: sess.apptoken,
    timestamp,
    noncestr,
    sign: sg,
  };
  if (sess.tenant && sess.tenant.TenantId) headers.TenantId = String(sess.tenant.TenantId);
  const j = await request(HOST[hostKey] + path, { method: 'POST', body: JSON.stringify(params), headers });
  if (j.Code !== 0) throw new Error('业务请求失败: ' + (j.Message || 'Code=' + j.Code));
  return j;
}

/**
 * 首页营业汇总（核心 KPI）
 * @param {object} sess
 * @param {object} opt { branchId, dateType: today|yesterday|week|lastWeek|month|lastMonth, begin, end }
 * @returns {Promise<object>} { amount, customers, avgPrice, grossProfit, grossRate, memberNew, online, offline, returns, raw }
 */
async function home(sess, opt = {}) {
  const branchId = opt.branchId || (sess.tenant && sess.tenant.BranchId);
  const now = new Date();
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const begin = opt.begin || ymd(now);
  const end = opt.end || ymd(now);

  const j = await api(sess, PATH.home, {
    BranchId: branchId,
    DateType: opt.dateType || 'today',
    BeginDate: begin,
    EndDate: end + ' 23:59:59.997',
    Type: 1,
    DataTypes: ['BusinessDatas'],
    Shopid: sess.tenant.TenantId,
    OperatorId: sess.tenant.OperatorId,
    PackageName: 'StoreManage',
  });

  const list = ((j.Data || {}).BusinessDatas) || [];
  const get = (name, dflt = 0) => {
    const it = list.find(x => x.Name === name);
    return it && it.Value !== undefined ? it.Value : dflt;
  };
  return {
    amount: get('TotalSale'),
    realAmount: get('RealAmount'),
    customers: get('CustoromNum'),
    avgPrice: get('CustoromPrice'),
    grossProfit: get('SalesGrossProfit'),
    grossRate: get('GrossRate'),
    returns: get('TotalReturn'),
    online: get('OnlineAmount'),
    offline: get('OfflineAmount'),
    memberConsume: get('MemberConsume'),
    memberNew: get('CreateMember'),
    memberNewSaving: get('MemberNewSavingAmount'),
    memberTraffic: get('MemberTraffic'),
    operDate: (j.Data || {}).OperDate,
    raw: j,
  };
}

module.exports = { APP_ID, APP_KEY, HOST, PATH, sign, getAppToken, login, api, home };

// ===== CLI 自测：node lib/mobile-erp.js =====
if (require.main === module) {
  (async () => {
    const cfgPath = require('path').join(__dirname, '../config.json');
    let acc;
    try {
      const cfg = JSON.parse(require('fs').readFileSync(cfgPath, 'utf8'));
      acc = (cfg.accounts || [])[0];
    } catch (e) { console.error('读取 config.json 失败:', e.message); process.exit(1); }
    if (!acc) { console.error('config.json 无门店账号'); process.exit(1); }

    console.log('门店:', acc.alias, '| 商户号:', acc.tenantCode, '| 操作员:', acc.userAccount);
    try {
      const sess = await login(acc.tenantCode, acc.userAccount, acc.password);
      console.log('✅ 登录成功 TenantId=%s BranchId=%s (%s/%s)',
        sess.tenant.TenantId, sess.tenant.BranchId, sess.tenant.BranchName, sess.tenant.OperatorName);
      const h = await home(sess);
      console.log();
      console.log('今日营业汇总:');
      console.log('  销售额      %s', h.amount);
      console.log('  实收        %s', h.realAmount);
      console.log('  客流        %s', h.customers);
      console.log('  客单价      %s', h.avgPrice);
      console.log('  毛利        %s', h.grossProfit);
      console.log('  新增会员    %s', h.memberNew);
      console.log('  线上/线下   %s / %s', h.online, h.offline);
    } catch (e) {
      console.error('❌', e.message);
      process.exit(1);
    }
  })();
}
