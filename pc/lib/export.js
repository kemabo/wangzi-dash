'use strict';
// 零售云平台报表导出客户端：纯 HTTP 复刻网页版「导出」按钮的异步任务链路，无需浏览器。
//
// 链路（抓包自习迅前端 bundle 还原）：
//   ① POST /{Controller}/Export            multipart 触发导出（服务端异步生成 xlsx）
//   ② POST /BaseDataExport/GetCreateTaskRequest   取待登记的任务请求
//   ③ POST infoimport/api/export/CreateTask       登记任务（infoimport 主机，web appToken 签名）
//   ④ POST /BaseDataExport/ClearCreateTasksCache  清掉本地待登记缓存
//   ⑤ 轮询 infoimport/api/export/GetTaskList      TaskStatus=2 即完成，取 FilePath
//   ⑥ 下载 FilePath（erp.example.com CDN，免鉴权）→ 解析 xlsx
//
// 为什么要这条路：MVC 网格报表服务端每页硬返 50 行，商品级库存 5.2 万行要拉一千多次
// （按限速约 50 分钟），而导出是一次任务、27 秒出全量文件 —— 提速约两个数量级。
//
// 两个主机、两套签名：
//   - 业务主机（star.*）用 MVC 登录会话（cookie + cloudtokenid）
//   - infoimport 主机用 GET /Home/GetAppToken 动态获取的 web appToken 签名（与 API 的 apptoken 不同）
const { rawRequest, rawBinary, buildSign } = require('./session');
const { xlsxToObjects } = require('./xlsx');
const fetchPolicy = require('./fetchpolicy');

const INFOIMPORT = 'https://infoimport.erp.example.com';
const APPKEY = 'YOUR_APPKEY';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const POLL_INTERVAL_MS = Number(process.env.EXPORT_POLL_MS || 8000);   // 轮询间隔
const TASK_TIMEOUT_MS = Number(process.env.EXPORT_TASK_TIMEOUT_MS || 5 * 60 * 1000); // 单任务最长等待
const TRIGGER_GAP_MS = Number(process.env.EXPORT_TRIGGER_MS || 5000);  // 两次导出触发的最小间隔（实测 <4s 会报 0002）
const MAX_TRIGGER_TRIES = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- web appToken 缓存（按主机，10 分钟）----
const APP_TOKEN_CACHE = new Map();
async function getWebAppToken(sess) {
  const host = sess.siteHost;
  const hit = APP_TOKEN_CACHE.get(host);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.token;
  const r = await rawRequest(`https://${host}/Home/GetAppToken`, {
    jar: sess.jar, accept: 'application/json',
    headers: { 'User-Agent': UA, Referer: `https://${host}/Subsite` },
  });
  let token = '';
  try { token = JSON.parse(r.body).data || ''; } catch (e) { }
  if (!token) throw new Error('获取 web appToken 失败');
  APP_TOKEN_CACHE.set(host, { token, at: Date.now() });
  return token;
}

/** infoimport 主机的签名请求头（算法与 MVC 相同：排序 k=v 拼 MD5 大写） */
function infoHeaders(appToken, sess, data) {
  const s = buildSign({ apptoken: appToken, appKey: APPKEY, token: sess.token }, data, {});
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json;charset=UTF-8',
    'Origin': `https://${sess.siteHost}`,
    'Referer': `https://${sess.siteHost}/BaseDataExport`,
    'User-Agent': UA,
    'apptoken': appToken,
    'appkey': APPKEY,
    'cloudtokenid': sess.token,
    'noncestr': s.noncestr,
    'timestamp': s.timestamp,
    'sign': s.sign,
    'TenantId': String(sess.tenantId || ''),
  };
}

function multipart(fields) {
  const b = '----WB' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    parts.push(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  parts.push(`--${b}--\r\n`);
  return { body: parts.join(''), contentType: `multipart/form-data; boundary=${b}` };
}

/**
 * 触发导出。
 * 用 rawBinary 发请求：响应既可能是 JSON（任务制），也可能是文件本体（直返），
 * 二进制安全读取后再按内容判别，一次请求覆盖两种形态。
 * @returns {{kind:'file', buf:Buffer} | {kind:'task', raw:string}}
 */
async function triggerExport(sess, spec) {
  const cols = spec.columns.map(c => Array.isArray(c) ? { Name: c[0], Title: c[1] } : c);
  const group = spec.group;
  const advancedQuery = spec.advancedQuery || [{ Field: 'GroupType', Value: group }];
  const content = JSON.stringify(cols.map(c => ({
    Name: c.Name, Title: c.Title || c.Name, Width: c.Width || 80, Show: 1, Printable: 1,
  })));
  const m = multipart({
    pageIndex: '1',
    SortOptions: spec.sortOptions || '',
    query: '',
    queryFields: cols.map(c => c.Name).join(','),
    queryField: cols[0].Name,
    advancedQuery: JSON.stringify(advancedQuery),
    CustomGrid: `${spec.controller}Index${group}`,
    content,
  });
  const r = await rawBinary(`https://${sess.siteHost}/${spec.controller}/Export`, {
    jar: sess.jar, method: 'POST', accept: '*/*',
    headers: {
      'Content-Type': m.contentType,
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `https://${sess.siteHost}/${spec.controller}`,
      'User-Agent': UA,
    },
    body: m.body,
    maxBytes: 128 * 1024 * 1024,
  });
  if (r.status !== 200) throw new Error('导出触发 HTTP ' + r.status);
  const buf = r.body;
  // zip 魔数 PK\x03\x04 → 服务端直返了文件
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) return { kind: 'file', buf };
  const text = buf.toString('utf8');
  let j = null;
  try { j = JSON.parse(text); } catch (e) { }
  if (j && j.status === 'success') return { kind: 'task', raw: text };
  throw new Error('导出触发失败: ' + text.slice(0, 200));
}

/** 轮询任务列表，拿到已完成任务的 FilePath */
async function pollTask(sess, appToken, taskNos, deadline) {
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    await fetchPolicy.gate();
    const data = { PageIndex: 1, PageSize: 10000 };
    const r = await rawRequest(`${INFOIMPORT}/api/export/GetTaskList`, {
      jar: sess.jar, method: 'POST',
      headers: infoHeaders(appToken, sess, data),
      body: JSON.stringify(data),
    });
    let list = [];
    try { list = (JSON.parse(r.body).Data) || []; } catch (e) { }
    const mine = list.filter(x => taskNos.has(x.TaskNo)).sort((a, b) => b.Id - a.Id)[0];
    if (!mine) continue;
    if (mine.TaskStatus === 2 && mine.FilePath) return mine.FilePath;
    if (mine.TaskStatus >= 3) throw new Error('导出任务失败: ' + (mine.ErrorInfo || 'TaskStatus=' + mine.TaskStatus));
  }
  throw new Error('导出任务轮询超时');
}

/** 二进制下载（CDN，跟随 302，最多 3 跳） */
async function downloadFile(url) {
  let u = url;
  for (let i = 0; i < 3; i++) {
    const r = await rawBinary(u, { accept: '*/*', maxBytes: 128 * 1024 * 1024 });
    if (r.location) { u = new URL(r.location, u).toString(); continue; }
    if (r.status !== 200) throw new Error('下载 HTTP ' + r.status);
    if (!(r.body.length > 4 && r.body[0] === 0x50 && r.body[1] === 0x4b)) throw new Error('下载内容不是 xlsx（zip）');
    return r.body;
  }
  throw new Error('下载重定向次数过多');
}

// ---- 导出触发全进程串行 + 最小间隔（服务端对密集导出报 0002）----
let triggerChain = Promise.resolve();
let lastTriggerAt = 0;
function enqueueTrigger(fn) {
  const run = async () => {
    const gap = TRIGGER_GAP_MS - (Date.now() - lastTriggerAt);
    if (gap > 0) await sleep(gap);
    lastTriggerAt = Date.now();
    return fn();
  };
  const p = triggerChain.then(run, run);
  triggerChain = p.catch(() => { });
  return p;
}

/**
 * 导出一张报表并解析为对象数组
 * @param {object} ts   TenantSession（内部 ensureLogin）
 * @param {object} spec { controller, group, columns:[[Name,Title]...], advancedQuery?, keyCols?, headerRow? }
 * @returns {{header:string[], rows:object[]}}
 */
async function exportReport(ts, spec) {
  const sess = await ts.ensureLogin();
  const appToken = await getWebAppToken(sess);
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_TRIGGER_TRIES; attempt++) {
    try {
      const trig = await enqueueTrigger(async () => {
        await fetchPolicy.gate();
        return triggerExport(sess, spec);
      });
      if (trig.kind === 'file') {
        return xlsxToObjects(trig.buf, { keyCols: spec.keyCols, headerRow: spec.headerRow });
      }
      // 任务制：登记 → 轮询 → 下载
      await fetchPolicy.gate();
      const r2 = await rawRequest(`https://${sess.siteHost}/BaseDataExport/GetCreateTaskRequest`, {
        jar: sess.jar, method: 'POST', accept: 'application/json',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `https://${sess.siteHost}/${spec.controller}`,
          'User-Agent': UA,
        },
        body: '',
      });
      let taskReq = null;
      try { const j2 = JSON.parse(r2.body); if (j2.status == 1 && j2.data) taskReq = j2.data; } catch (e) { }
      if (!taskReq || !taskReq.length) throw new Error('导出任务登记失败（GetCreateTaskRequest 无数据）');
      await fetchPolicy.gate();
      const ct = await rawRequest(`${INFOIMPORT}/api/export/CreateTask`, {
        jar: sess.jar, method: 'POST',
        headers: infoHeaders(appToken, sess, { TaskList: taskReq }),
        body: JSON.stringify({ TaskList: taskReq }),
      });
      try { const jc = JSON.parse(ct.body); if (jc.Code !== 0) throw new Error('CreateTask: ' + (jc.Message || jc.Code)); } catch (e) {
        if (/CreateTask/.test(e.message)) throw e;
      }
      await fetchPolicy.gate();
      await rawRequest(`https://${sess.siteHost}/BaseDataExport/ClearCreateTasksCache`, {
        jar: sess.jar, method: 'POST', accept: 'application/json',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': UA,
        },
        body: '',
      });
      const taskNos = new Set(taskReq.map(x => x.TaskNo));
      const filePath = await pollTask(sess, appToken, taskNos, Date.now() + TASK_TIMEOUT_MS);
      const buf = await downloadFile(filePath);
      return xlsxToObjects(buf, { keyCols: spec.keyCols, headerRow: spec.headerRow });
    } catch (e) {
      lastErr = e;
      // 厂家限流信号：熔断器下降一阶（gate() 随后会背压等待），退避后重试
      if (/过于频繁|0002|操作频繁|请求频繁/.test(String(e.message))) {
        fetchPolicy.tripBreaker();
        await sleep(8000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

module.exports = { exportReport, INFOIMPORT };
