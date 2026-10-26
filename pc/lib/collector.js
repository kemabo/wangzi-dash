'use strict';
// 采集调度：全局节流队列 + 单个租户的数据采集
const fs = require('fs');
const path = require('path');
const { TenantSession, DATA_DIR } = require('./tenant');
const { rangeOf, fmt } = require('./dates');
const { num } = require('./grid');
const { SEASON_GROUPS } = require('./season');
// 抓取策略 + 对外限速：所有联网请求都必须先过这里拿令牌
const fetchPolicy = require('./fetchpolicy');
// 零售云平台导出通道：大数据量报表走异步导出任务（一次任务拿全量，替代上千次分页）
const { exportReport } = require('./export');

/** 全局请求节流队列：服务端对高频抓取有限流，串行化并留出间隔 */
class ThrottleQueue {
  /**
   * @param intervalMs 两个请求「发起」之间的最小间隔（服务端限流保护）
   * @param concurrency 同一队列里允许同时在飞的请求数
   */
  constructor(intervalMs = 700, concurrency = 2) {
    this.interval = intervalMs;
    this.concurrency = Math.max(1, concurrency);
    this.pending = [];
    this.activeCount = 0;
    this.lastStart = 0;
    this.timer = null;
  }
  _trySchedule() {
    const now = Date.now();
    while (this.pending.length && this.activeCount < this.concurrency) {
      const wait = this.interval - (now - this.lastStart);
      if (wait > 0) {
        if (!this.timer) {
          // 不能 unref：这个定时器必须保持事件循环，否则只剩节流等待时进程会误判空闲退出
          this.timer = setTimeout(() => { this.timer = null; this._trySchedule(); }, wait);
        }
        return;
      }
      const kick = this.pending.shift();
      this.activeCount++;
      this.lastStart = Date.now();
      kick();
    }
  }
  add(task) {
    return new Promise((resolve, reject) => {
      this.pending.push(async () => {
        try { resolve(await task()); }
        catch (e) { reject(e); }
        finally { this.activeCount--; this._trySchedule(); }
      });
      this._trySchedule();
    });
  }
}

const GRID_INTERVAL = Number(process.env.GRID_INTERVAL_MS || 700);
const API_INTERVAL = Number(process.env.API_INTERVAL_MS || 250);
const GRID_CONCURRENCY = Number(process.env.GRID_CONCURRENCY || 2);
const API_CONCURRENCY = Number(process.env.API_CONCURRENCY || 3);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 导出行字段选取：服务端按自己的列名返回（content 里传的 Title 不生效），
 * 同一语义在不同报表里列名可能不同（金额/销售金额、毛利/毛利金额…）。
 * 按候选名依次取第一个非空值，避免列名猜错时静默变成 0。
 */
function pick(row, names) {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}

/**
 * 队列按「租户」隔离：不同商户是不同的会话与站点，服务端限流也是按会话计，
 * 因此三个商户可以完全并行抓取，只在同一商户内部串行节流。
 * （旧实现是一条全局队列，3 个商户互相排队，这是首屏慢的主因）
 */
function queuesOf(ts) {
  if (!ts.__q) {
    ts.__q = {
      grid: new ThrottleQueue(GRID_INTERVAL, GRID_CONCURRENCY),
      api: new ThrottleQueue(API_INTERVAL, API_CONCURRENCY),
    };
  }
  return ts.__q;
}

/** 带节流的网格请求，并对「操作过于频繁」退避重试 */
async function safeGrid(ts, controller, aq, opts = {}, tries = 5) {
  const q = queuesOf(ts).grid;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await q.add(async () => {
        await fetchPolicy.gate();          // 全进程硬性限速（每分钟上限），慢一点也要稳
        return ts.grid(controller, aq, opts);
      });
    } catch (e) {
      lastErr = e;
      // 厂家限流信号（「操作过于频繁」/ 0002）：熔断器下降一个阶梯
      // （速率减半 + 进入冷却期，gate() 会背压等待），然后重试。
      if (/过于频繁|0002|操作频繁|请求频繁/.test(String(e.message))) {
        fetchPolicy.tripBreaker();
        await sleep(500);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function safeApi(ts, p, data, query, method) {
  return queuesOf(ts).api.add(async () => {
    await fetchPolicy.gate();
    return ts.api(p, data, query, method);
  });
}

// ---------------- 进程内缓存 ----------------
// 主数据（商品档案 64MB / 款式档案）在每一轮里会被 5 个档位 × 3 个商户重复读取，
// 每次 JSON.parse 一遍要 1~2 秒，累积起来非常可观。按文件 mtime 做内存缓存。
const MEM = new Map();
const MEM_ITEM_LIMIT = 300;

function memRemember(key, value) {
  if (MEM.size > MEM_ITEM_LIMIT) MEM.clear();
  MEM.set(key, value);
  return value;
}

const BRANCH_QUERY = {
  PageSize: 10000, PageIndex: 0, FilterBranchTypeArray: [''],
  IsBranchGrant: true, IsSupervision: true, OnlyShowCurrent: false,
  Query: '', RegionId: -1, ShowAllBranchItem: true,
  Sort: [{ Name: 'Code', Direction: true }],
};

async function fetchBranches(ts) {
  const data = await safeApi(ts, 'api/v1/branch/query', BRANCH_QUERY);
  const list = (data && data.Data) || [];
  return list.filter(b => b.Id !== 0).map(b => ({
    id: b.Id, code: b.Code, name: b.Name, type: b.Type || '',
  }));
}

/** 类别主数据（完整层级：大类/中类/小类） */
async function fetchCategories(ts) {
  try {
    const d = await safeApi(ts, 'api/v1/category/query', { PageSize: 5000, PageIndex: 0 });
    const list = (d && d.Data) || [];
    return list.map(c => ({
      id: c.Id, code: c.Code, name: c.Name,
      parentId: c.ParentId || 0, isLeaf: c.IsLeaf === 'Y',
    }));
  } catch (e) { return []; }
}

/** 按商品编码合并（报表按「门店×商品」展开时，同一商品会出现多行） */
function mergeByItemCode(rows, numKeys) {
  const m = new Map();
  rows.forEach((r, i) => {
    const k = r.itemCode ? String(r.itemCode) : `__no_code_${i}`;
    let o = m.get(k);
    if (!o) {
      o = Object.assign({}, r);
      for (const f of numKeys) o[f] = 0;
      m.set(k, o);
    }
    for (const f of numKeys) o[f] = (Number(o[f]) || 0) + (Number(r[f]) || 0);
    for (const f of ['selfCode', 'specification', 'categoryCode', 'categoryName', 'itemName']) {
      if (!o[f] && r[f]) o[f] = r[f];
    }
  });
  return [...m.values()];
}

/**
 * 分页拉取 JSON 接口
 * 单页默认 2000：服务端对请求参数数量有 2100 的上限，PageSize=5000 会直接报
 * 「传入的请求具有过多的参数」，2000 是安全上限。冷启动拉商品档案时，
 * 请求数直接减半（5 万商品 50 页 → 25 页），配合限速闸门就是省下一分多钟。
 */
async function pullPaged(ts, apiPath, body = {}, cap = 200, pageSize = 2000) {
  const out = [];
  let page = 0, total = null;
  while (page < cap) {
    const d = await safeApi(ts, apiPath, Object.assign({ PageSize: pageSize, PageIndex: page }, body));
    const arr = (d && d.Data) || [];
    if (total === null) total = Number(d && (d.Count != null ? d.Count : d.TotalCount)) || 0;
    out.push(...arr);
    if (!arr.length || (total && out.length >= total)) break;
    page++;
  }
  return out;
}

/**
 * 分页拉全 MVC 网格报表（Rpt*）—— 修复「每页只拿第一页」的硬伤。
 *
 * 背景：网格报表服务端每页硬返 50 行，并不兑现 pageSize；老代码用
 * `rows.length < PAGE` 判断还有没有下一页，于是第 2 页以后从未抓过——
 * 商品级销售 / 商品级库存 / 小类树 / 分类库存 / 月度与年度趋势全部只有 50 行，
 * 季节表、库存列、趋势图、供应商榜因此大面积缺数（季节表销售一度只有真实值的 6%）。
 *
 * 终止条件（满足任一即停，四种都防死循环）：
 *   1) 空页：服务端翻完页返回 0 行；
 *   2) 已拿满服务端报告的总数（页脚「共 N 条」）；
 *   3) 整页都是已见过的行：服务端忽略 pageIndex 反复返同一页，立即停，
 *      避免把重复行也 push 进去把合计撑大；
 *   4) 达到 maxPages 安全上限。
 * 第 2 页起出错（如页码越界）不当失败处理：用已拿到的数据收尾，下次刷新再补。
 */
async function fetchGridPaged(ts, controller, aq, opts = {}) {
  const pageSize = opts.pageSize || 2000;
  const maxPages = opts.maxPages || 200;
  const tries = opts.tries == null ? 2 : opts.tries;
  const rows = [];
  const seen = new Set();
  const sig = (r) => { try { return JSON.stringify(r); } catch (e) { return ''; } };
  let total = 0;
  for (let p = 1; p <= maxPages; p++) {
    let g;
    try {
      g = await safeGrid(ts, controller, aq, { pageSize, pageIndex: p }, tries);
    } catch (e) {
      if (p === 1) throw e;   // 第一页就失败：真失败，照旧向上抛
      break;                  // 翻页中途失败：保住已抓到的部分
  }
    const rs = g.rows || [];
    if (!rs.length) break;                          // 1) 空页 = 翻完了
    if (p > 1) {
      let allSeen = true;
      for (const r of rs) { const s = sig(r); if (s && !seen.has(s)) { allSeen = false; break; } }
      if (allSeen) break;                           // 3) 服务端忽略分页，反复返同一页
    }
    for (const r of rs) { rows.push(r); const s = sig(r); if (s) seen.add(s); }
    if (!total) total = Number(g.total) || 0;
    if (total && rows.length >= total) break;       // 2) 服务端给了总数且已拿满
  }
  return { rows, total };
}

/** 商店类别档案的最深层级（编码 3 位一级 / 6 位二级 / 9 位三级…） */
function deepestLevel(master) {
  let lv = 1;
  for (const c of (master || [])) {
    const len = String(c.code || '').length;
    if (len >= 3 && len % 3 === 0) lv = Math.max(lv, len / 3);
  }
  return lv;
}

/** 带本地缓存的主数据（商品档案 / 款式档案），默认 12 小时刷新一次 */
const MASTER_TTL = Number(process.env.MASTER_TTL_MS || 12 * 3600 * 1000);
/**
 * @param opts.swr 陈旧优先（stale-while-revalidate）：本地有旧文件就立刻用，
 *                 同时在后台补拉一次新的，用于「数据量极大、但变化很慢」的商品级库存，
 *                 避免每次冷启动都卡在最重的一步上。
 */
const revalidating = new Set();
function revalidateBackground(p, tenantCode, fetchFn) {
  if (revalidating.has(p)) return;
  revalidating.add(p);
  setTimeout(async () => {
    try {
      const rows = await fetchFn();
      fs.writeFileSync(p, JSON.stringify({ fetchedAt: Date.now(), tenantCode, rows }), 'utf8');
      try { memRemember(`${p}|${fs.statSync(p).mtimeMs}`, { rows }); } catch (e) { }
    } catch (e) { }
    finally { revalidating.delete(p); }
  }, 1500);
}

async function cachedMaster(tenantCode, file, fetchFn, ttl, opts) {
  // 商品档案是最费请求的一步（一次全量上百个分页请求），缓存时长按策略走，默认 24 小时
  const life = ttl || fetchPolicy.load().masterTtlHours * 3600 * 1000;
  const swr = !!(opts && opts.swr);
  let p = '';
  // 记下上一份本地缓存（哪怕已过期），线上重抓失败时回退，避免主数据（商品/款式档案）整块丢失
  let staleRows = null;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    p = path.join(DATA_DIR, file);
    if (fs.existsSync(p)) {
      const st = fs.statSync(p);
      // 先看内存里有没有解析好的（按路径 + 修改时间判定），避免反复 parse 大文件
      const mk = `${p}|${st.mtimeMs}`;
      const hit = MEM.get(mk);
      if (hit && Array.isArray(hit.rows)) { staleRows = hit.rows; return hit.rows; }
      const fresh = Date.now() - st.mtimeMs < life;
      if (fresh || swr) {
        const o = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (o && Array.isArray(o.rows)) {
          memRemember(mk, o);
          staleRows = o.rows;
          if (!fresh && swr) revalidateBackground(p, tenantCode, fetchFn);
          return o.rows;
        }
      } else {
        // 过期了：先留着旧值，等会儿线上重抓失败再回退
        try { const o = JSON.parse(fs.readFileSync(p, 'utf8')); if (o && Array.isArray(o.rows)) staleRows = o.rows; } catch (e) { }
      }
    }
  } catch (e) { }
  try {
    const rows = await fetchFn();
    try { fs.writeFileSync(p, JSON.stringify({ fetchedAt: Date.now(), tenantCode, rows }), 'utf8'); } catch (e) { }
    try {
      const mk2 = `${p}|${fs.statSync(p).mtimeMs}`;
      memRemember(mk2, { rows });
    } catch (e) { }
    return rows;
  } catch (e) {
    // 线上重抓失败（限流 / 超时 / 登录失效）：回退到本地旧缓存，也比整块清空强。
    // 没有旧缓存才真的抛错，交给上层 .catch(() => []) 兜底成空数组。
    if (staleRows && staleRows.length) {
      if (process.env.SEASON_DEBUG) console.log('[cachedMaster]', file, '线上重抓失败，回退本地旧缓存', staleRows.length, '行');
      return staleRows;
    }
    throw e;
  }
}

/**
 * 区间快照缓存（落盘，跨进程复用）
 *
 * 不是所有数据都该每次重启重抓：
 *  - yesterday / lastMonth 的区间已经封死，抓过一次就再也不会变，却因为 TTL 过期被反复重拉；
 *  - thisWeek / thisMonth 当天之内只是在增长，二十分钟拉一次足够；
 *  - 门店库存与今天无关，另行按日期缓存。
 *
 * 所以这里把「销售报表 / 商品级销售 / 门店库存」落到磁盘并按区间标记（tag）校验：
 * tag 由 begin~end 拼成，跨天时标记自然变化，旧数据不会被当成新的。
 * 命中未过期直接返回（几乎零耗时）；过期了但开了 swr 就先返回旧值、后台再补新的，
 * 这样冷启动也不会卡在最重的一步上。
 */
const STORE_REVALIDATING = new Set();
const STORE_PENDING = new Map();

function writeTagFile(p, obj) {
  try { fs.writeFileSync(p, JSON.stringify(obj), 'utf8'); } catch (e) { }
}

function revalidateTag(p, tag, fetchFn, opts) {
  const key = `${p}|${tag}`;
  if (STORE_REVALIDATING.has(key)) return;
  STORE_REVALIDATING.add(key);
  setTimeout(async () => {
    try {
      const value = await fetchFn();
      writeTagFile(p, { fetchedAt: Date.now(), tenantCode: opts.tenantCode, tag, value });
    } catch (e) { }
    finally { STORE_REVALIDATING.delete(key); }
  }, 1200);
}

async function cachedRange(file, tag, ttlMs, fetchFn, opts = {}) {
  const swr = !!opts.swr;
  const p = path.join(DATA_DIR, file);
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(p)) {
      const st = fs.statSync(p);
      const mk = `T|${p}|${st.mtimeMs}`;
      const hit = MEM.get(mk);
      const o = hit || JSON.parse(fs.readFileSync(p, 'utf8'));
      if (o && o.tag === tag && o.value !== undefined && !Array.isArray(o.rows)) {
        memRemember(mk, o);
        if (Date.now() - Number(o.fetchedAt || 0) < ttlMs) return o.value;
        if (swr) { revalidateTag(p, tag, fetchFn, opts); return o.value; }
      }
    }
  } catch (e) { }
  const key = `${p}|${tag}`;
  if (STORE_PENDING.has(key)) return STORE_PENDING.get(key);
  const pend = (async () => {
    const value = await fetchFn();
    writeTagFile(p, { fetchedAt: Date.now(), tenantCode: opts.tenantCode, tag, value });
    return value;
  })().finally(() => STORE_PENDING.delete(key));
  STORE_PENDING.set(key, pend);
  return pend;
}

/**
 * 请求结果级别的进程内缓存：某些数据与查询区间无关（实时看板、门店库存），
 * 但会被 today / yesterday / thisWeek / thisMonth / lastMonth 五个档位各拉一遍，
 * 这里按「商户 + 名称」缓存一段时间，一轮里只真正请求一次。
 */
const RESULT_MEM = new Map();
/** 原始行 → 已裁剪对象的映射缓存（避免同一份大数组被反复 map 成对象） */
const MAP_CACHE = new WeakMap();
function mapCached(rows, mapFn) {
  const hit = MAP_CACHE.get(rows);
  if (hit) return hit;
  const out = mapFn(rows);
  try { MAP_CACHE.set(rows, out); } catch (e) { }
  return out;
}
async function cachedResult(key, ttlMs, fn) {
  const hit = RESULT_MEM.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.value;
  // 同一 key 并发时复用同一个 Promise，避免重复请求
  if (hit && hit.pending) return hit.pending;
  const pend = (async () => fn())();
  RESULT_MEM.set(key, { at: now, pending: pend, value: hit ? hit.value : undefined });
  try {
    const value = await pend;
    RESULT_MEM.set(key, { at: Date.now(), value, pending: null });
    return value;
  } catch (e) {
    RESULT_MEM.delete(key);
    throw e;
  }
}

/**
 * 商品档案（含 SelfCode 款式码 / Specification 规格 / 备注 / 类别 / 供应商）
 * 供应商：零售云平台叫 Vendor（VendorCode / VendorName），商品档案自带，用不着单独拉供应商档案（接口 404）
 * 缓存文件 items3-：加了 vendorName 字段，旧缓存（items2）缺该字段，必须换名让它失效
 */
async function fetchItems(ts) {
  const rows = await cachedMaster(ts.tenantCode, `items3-${ts.tenantCode}.json`, () => pullPaged(ts, 'api/v1/item/index'));
  return mapCached(rows, (list) => list.map(r => ({
    code: String(r.Code || '').trim(),
    name: String(r.Name || '').trim(),
    selfCode: String(r.SelfCode || '').trim(),
    specification: String(r.Specification || '').trim(),
    // 供应商：报表里也有 VendorName，但「大类 × 供应商」只能靠商品档案把两者关联起来
    vendorCode: String(r.VendorCode || '').trim(),
    vendorName: String(r.VendorName || '').trim(),
    // 产地字段：部分门店（如王子鞋服闪电仓）把季节维护在这里
    producer: String(r.Producer || '').trim(),
    memo1: String(r.Memo1 || '').trim(),
    memo2: String(r.Memo2 || '').trim(),
    // 等级字段：不同版本字段名不一，逐级兜底；零售云平台的「特性1~特性10」也一并保留（Property1..10）
    grade: String(r.Grade || r.ItemGrade || r.Level || r.GradeName || r.ItemLevel || '').trim(),
    props: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      .map(i => String(r['Property' + i] || '').trim())
      .filter(Boolean),
    categoryCode: String(r.CategoryCode || r.CategoryId || '').trim(),
    categoryName: String(r.CategoryName || '').trim(),
    itemStyleId: String(r.ItemStyleId || '').trim(),
  })));
}

/** 款式档案：款式码 -> 季节（SeasonName） */
async function fetchStyles(ts) {
  const rows = await cachedMaster(ts.tenantCode, `styles-${ts.tenantCode}.json`, () => pullPaged(ts, 'api/v1/ItemStyle/index'));
  return mapCached(rows, (list) => list.map(r => ({
    id: String(r.Id || '').trim(),
    code: String(r.Code || '').trim(),
    name: String(r.Name || '').trim(),
    season: String(r.SeasonName || '').trim(),
    categoryName: String(r.CategoryName || '').trim(),
  })));
}

/**
 * 商品级销售：RptSaleGrossAnalysis（group-type=item），含成本与毛利
 *
 * 走导出通道：一次异步任务拿全量（本月 4536 行 / 19 秒），
 * 替代原先 91 次「50 行/页」的网格翻页（按限速要跑一分多钟）。
 * 注意导出口径的日期字段是 SheetDate（用 OperDate 服务端直接报错）。
 */
async function fetchItemSale(ts, range) {
  const r = await exportReport(ts, {
    controller: 'RptSaleGrossAnalysis',
    group: 'item',
    advancedQuery: [
      { Field: 'GroupType', Value: 'item' },
      { Field: 'SheetDate', Operator: 'Between', Value: `${range.beginStr},${range.endStr}` },
    ],
    columns: [
      ['rowNum', '序号'], ['ItemCode', '货号'], ['SelfCode', '自编码'], ['ItemName', '品名'],
      ['CategoryCode', '类别编码'], ['CategoryName', '类别'], ['Specification', '规格'],
      ['SaleQty', '销售数量'], ['SaleAmount', '销售金额'], ['CostAmount', '销售成本'], ['GrossProfit', '毛利'],
    ],
  });
  const out = [];
  for (const row of r.rows) {
    out.push({
      itemCode: String(pick(row, ['货号']) || '').trim(),
      selfCode: String(pick(row, ['自编码']) || '').trim(),
      itemName: String(pick(row, ['品名', '商品名称']) || '').trim(),
      categoryCode: String(pick(row, ['类别编码']) || '').trim(),
      categoryName: String(pick(row, ['类别名称', '类别']) || '').trim(),
      specification: String(pick(row, ['规格']) || '').trim(),
      saleQty: num(pick(row, ['销售数量'])), saleAmount: num(pick(row, ['销售金额', '金额'])),
      costAmount: num(pick(row, ['销售成本', '成本金额'])), grossProfit: num(pick(row, ['毛利', '毛利金额'])),
    });
  }
  // 报表实际是「门店 × 商品」粒度，同一商品多行 → 合并成一个商品
  return mergeByItemCode(out, ['saleQty', 'saleAmount', 'costAmount', 'grossProfit']);
}

/**
 * 商品级库存：RptStmItems（group-type=StockByItem2），全门店按商品汇总
 *
 * 走导出通道：一次异步任务拿全量（闪电仓 51985 行 / 27 秒，含 5.2 万 SKU），
 * 替代原先上千次「50 行/页」的网格翻页——那套按 20 请求/分的限速要跑几十分钟，
 * 还只能截断到 5000 行（maxPages 100），季节表库存因此长期缺数。
 * 导出文件自带 供应商/类别/品牌 列，比网格版字段更全。
 * 库存变化慢，本地缓存 12 小时 + 陈旧优先（swr）。
 */
// 缓存文件名带 2：旧版（网格翻页时代）缓存只有 50 行截断数据，必须换名让它失效，
// 否则 12 小时 TTL 内会一直拿旧的残数当天花板（itemstock- 时代的沉疴）。
const stockTtlMs = () => fetchPolicy.load().stockTtlHours * 3600 * 1000;   // 商品级库存
async function fetchItemStock(ts) {
  return cachedMaster(ts.tenantCode, `itemstock2-${ts.tenantCode}.json`, async () => {
    const r = await exportReport(ts, {
      controller: 'RptStmItems',
      group: 'StockByItem2',
      columns: [
        ['rowNum', '序号'], ['ItemCode', '货号'], ['ItemName', '品名'], ['SelfCode', '自编码'],
        ['Specification', '规格'], ['StockQty', '库存数量'], ['VendorName', '供应商'],
        ['CategoryName', '类别'], ['BrandName', '品牌'], ['PurcPriceAmount', '档案进价金额'],
        ['StockSaleAmount', '零售价金额'],
      ],
    });
    const out = [];
    for (const row of r.rows) {
      // 负库存属异常数据（先销后入 / 串码），不参与季节分析
      const q = num(pick(row, ['库存数量']));
      const pos = q > 0;
      out.push({
        itemCode: String(pick(row, ['货号']) || '').trim(),
        selfCode: String(pick(row, ['自编码']) || '').trim(),
        itemName: String(pick(row, ['品名', '商品名称']) || '').trim(),
        categoryName: String(pick(row, ['类别名称', '类别']) || '').trim(),
        specification: String(pick(row, ['规格']) || '').trim(),
        vendorName: String(pick(row, ['供应商', '供应商名称']) || '').trim(),
        stockQty: pos ? q : 0,
        stockCost: pos ? num(pick(row, ['档案进价金额', '库存成本金额'])) : 0,
        stockRetail: pos ? num(pick(row, ['零售价金额', '库存零售金额'])) : 0,
      });
    }
    return mergeByItemCode(out, ['stockQty', 'stockCost', 'stockRetail']);
  }, stockTtlMs(), { swr: true });
}

/** 今日实时看板数据（始终取今天） */
async function fetchHomeStats(ts, dateStr) {
  const d = await safeApi(ts, 'api/v1/Home/QueryHomeStatisticsInfo', {
    BranchId: 0,
    BeginDate: `${dateStr} 00:00:00`,
    EndDate: `${dateStr} 23:59:59.997`,
    DateType: 'today',
    DataTypes: [],
  });
  if (!d) return null;
  const pickStat = (n) => {
    const x = (d.BusinessDatas || []).find(i => i.Name === n);
    return x ? Number(x.Value) || 0 : 0;
  };
  return {
    date: d.OperDate || dateStr,
    dateType: 'today',
    totalSale: pickStat('TotalSale'),
    realAmount: pickStat('RealAmount'),
    grossProfit: pickStat('GrossAmount'),
    grossCost: pickStat('GrossCostAmount'),
    grossRate: pickStat('GrossRate'),
    qty: 0,
    customers: pickStat('CustoromNum'),
    avgPrice: pickStat('CustoromPrice'),
    offline: pickStat('OfflineAmount'),
    online: pickStat('OnlineAmount'),
    memberConsume: pickStat('MemberConsume'),
    memberCount: pickStat('MemberCount'),
    hourly: d.SaleAmount || {},
    category: d.CategoryProportion || {},
    branchRanking: d.BranchRanking || {},
    payment: d.PaymentProportion || {},
    itemRanking: d.ItemRanking || {},
  };
}

function rowsToObjects(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(r => ({
    branchCode: r.BranchCode || '',
    branchName: r.BranchName || '',
    categoryCode: r.CategoryCode || '',
    categoryName: r.CategoryName || '',
    categoryId: r.CategoryId || '',
    date: r.OperDate || '',
    saleQty: num(r.SaleQty),
    saleAmount: num(r.SaleAmount),
    costAmount: num(r.SaleCostAmount),
    grossProfit: num(r.SaleGrossProfit),
    grossRate: /%/.test(r.GrossProfitPercent || '') ? num(r.GrossProfitPercent) : num(r.GrossProfitPercent),
  }));
}

/** 类别层级：编码长度 3/6/9 对应大类/中类/小类 */
function levelOf(code) {
  if (!code) return 0;
  if (code.length <= 3) return 1;
  if (code.length <= 6) return 2;
  return 3;
}

function saleFilters(range) {
  return [
    { Field: 'BranchId', Operator: 'Equals', Value: '0' },
    { Field: 'Branch.Name', Operator: 'Equals', Value: '全部门店' },
    { Field: 'OperDate', Operator: 'Between', Value: `${range.beginStr},${range.endStr}` },
  ];
}

/** 首屏核心销售：大类 × 门店 + 门店 × 日（两张报表，一次并发） */
async function fetchCoreSale(ts, range) {
  const all = saleFilters(range);
  const [cat, daily] = await Promise.all([
    // 大类报表行数本来就少（一级类目 × 门店），一页拿得下；仍走分页助手兜底
    fetchGridPaged(ts, 'RptSaleSummaryAnalysis', [
      { Field: 'GroupType', Value: 'Category' },
      { Field: 'CategoryLevel', Value: '1' },
      ...all,
    ], { pageSize: 2000, maxPages: 50 }),
    // 门店 × 日：一周 ~50 行、一月轻松过百行——老代码只拿第一页，
    // 月度趋势图因此只剩开头几天。翻页拉全。
    fetchGridPaged(ts, 'RptSaleSummaryAnalysis', [
      { Field: 'GroupType', Value: 'BranchDaily' },
      ...all,
    ], { pageSize: 2000, maxPages: 100 }),
  ]);
  return { cat: rowsToObjects(cat.rows), daily: rowsToObjects(daily.rows) };
}

/**
 * 小类层级：只有点开大类下钻才用得到，放到首屏之后再补
 *
 * 走导出通道（18 秒）：网格版服务端会把 1~3 级混在一起返（CategoryLevel 表示
 * 「展示到第几级」而非「只要第几级」），客户端不过滤，于是 244 行要翻 40+ 页、
 * 被 20 请求/分的闸门压到两分多钟；导出一次任务拿全量，行列与网格逐行一致。
 */
async function fetchSubSale(ts, range) {
  const r = await exportReport(ts, {
    controller: 'RptSaleSummaryAnalysis',
    group: 'Category',
    sortOptions: '""',   // 真实报文：SortOptions 是 JSON.stringify('') 后的两个引号
    advancedQuery: [
      { Field: 'GroupType', Value: 'Category' },
      { Field: 'CategoryLevel', Value: '3' },
      { Field: 'OperDate', Operator: 'Between', Value: `${range.beginStr},${range.endStr}` },
    ],
    columns: [
      ['rowNum', '序号'], ['BranchCode', '门店编码'], ['BranchName', '门店名称'],
      ['CategoryCode', '类别编码'], ['CategoryName', '类别名称'],
      ['SaleQty', '销售数量'], ['SaleAmount', '金额'], ['SaleCostAmount', '成本金额'],
      ['SaleGrossProfit', '毛利金额'], ['GrossProfitPercent', '毛利率'],
    ],
  });
  // 服务端按自己的列名返回（content 里传的 Title 不生效），按文件实际表头映射
  return r.rows.map(row => ({
    branchCode: String(pick(row, ['门店编码', '门店编号']) || '').trim(),
    branchName: String(pick(row, ['门店名称', '门店']) || '').trim(),
    categoryCode: String(row['类别编码'] || '').trim(),
    categoryName: String(row['类别名称'] || row['类别'] || '').trim(),
    categoryId: '',
    date: '',
    saleQty: num(pick(row, ['销售数量'])),
    saleAmount: num(pick(row, ['销售金额', '金额'])),
    costAmount: num(pick(row, ['销售成本', '成本金额'])),
    grossProfit: num(pick(row, ['毛利', '毛利金额'])),
    grossRate: num(pick(row, ['毛利率'])),
  }));
}

/**
 * 门店类别库存：**全店一次取**（不带 BranchId），按父子链折算成「自有值」。
 *
 * 老实现按分店逐个请求（闪电仓 6 家就要 6 个请求），冷启动时光库存就占掉十几二十个
 * 请求，全在限速闸门里排队等 —— 这是首屏慢的一大来源。实测不带 BranchId 取全店
 * 与「各分店之和」完全一致（聚合层本来也只按 tenantCode 汇总，用不到 BranchCode），
 * 而请求数从 N 家降到 1 个。
 *
 * 三个老坑一起修：
 * ① 每页 50 行上限——按「分店 × 叶子类目」算，闪电仓真实行数近千，老代码只拿到 50 行，
 *    总览 / 大类的库存数字大幅偏低（17 个大类只有 5 个有库存）；
 * ② 类别层级写死三级——南江只建到二级（中类），按三级查一条库存都取不到。
 *    现在按该店主数据的最深层级逐级查；
 * ③ 行口径与折算——零售云平台分类库存每一行都是「该类别含全部下级」的口径（大类行 = 自有
 *    库存 + 各下级行），老代码只保留叶子行，商品直接挂在大类 / 中类上的库存（闪电仓
 *    约 6.8 万件）整块丢失，大类合计与商品级库存对不上。现在按父子链把每行折算成
 *    「自有值 = 本行 − 直接子类各行之和」，聚合层照常上卷，每一级都与零售云平台报表分项
 *    口径一致（实测大类合计 = 导出文件合计行，分毫不差）。
 *
 * 符号：保留服务端原值。负库存是红字异常（先销后入 / 串码），翻成绝对值会把合计
 * 虚高数倍（闪电仓 |合计| 30.98 万 vs 导出净额 5.40 万），看板上也能直接看见异常。
 */
async function fetchStock(ts, master) {
  const deepest = deepestLevel(master);
  // ---- 父子链：主数据 parentId 优先；主数据缺失的编码按最长存在前缀推断 ----
  const byId = new Map((master || []).map(c => [String(c.id), c]));
  const parentOf = new Map();                    // code -> 父 code
  for (const c of (master || [])) {
    const p = c.parentId ? byId.get(String(c.parentId)) : null;
    if (p) parentOf.set(String(c.code), String(p.code));
  }
  const K = (b, c) => b + '\u0000' + c;
  const cell = new Map();                        // branch\u0000code -> 行值（含全部下级）
  for (let lv = 1; lv <= deepest; lv++) {
    const g = await fetchGridPaged(ts, 'RptStmItems', [
      { Field: 'GroupType', Value: 'StockByCategory' },
      { Field: 'CategoryLevel', Value: String(lv) },
    ], { pageSize: 5000, maxPages: 200, tries: 2 });
    for (const r of (g.rows || [])) {
      const code = String(r.CategoryCode || r.categoryCode || '').trim();
      if (!code) continue;
      const b = String(r.BranchCode || r.branchCode || '').trim();
      const o = cell.get(K(b, code)) || {
        qty: 0, cost: 0, retail: 0, purchase: 0,
        name: String(r.CategoryName || r.categoryName || '').trim(),
        branchName: String(r.BranchName || r.branchName || '').trim(),
      };
      o.qty += num(r.StockQty);
      o.cost += num(r.CostAmount);
      o.retail += num(r.StockSaleAmount);
      o.purchase += num(r.PurcPriceAmount);
      cell.set(K(b, code), o);
    }
  }
  // 主数据里没有的编码：按最长存在前缀推断父类（与聚合层 buildTenantTree 的兜底一致）
  const known = new Set([...parentOf.keys()]);
  for (const k of cell.keys()) known.add(k.slice(k.indexOf('\u0000') + 1));
  for (const code of known) {
    if (parentOf.has(code)) continue;
    for (let kk = code.length - 3; kk >= 3; kk -= 3) {
      const pre = code.slice(0, kk);
      if (known.has(pre)) { parentOf.set(code, pre); break; }
    }
  }
  const kidsOf = new Map();                      // 父 code -> [直接子 code]
  for (const [code, pc] of parentOf) {
    if (!kidsOf.has(pc)) kidsOf.set(pc, []);
    kidsOf.get(pc).push(code);
  }
  // 自有值 = 本行 − 直接子类各行之和（子类行已含更下级，只减直接子类即得净自有）
  const out = [];
  for (const [k, v] of cell) {
    const sep = k.indexOf('\u0000');
    const branch = k.slice(0, sep), code = k.slice(sep + 1);
    let { qty, cost, retail, purchase } = v;
    for (const cc of (kidsOf.get(code) || [])) {
      const cv = cell.get(K(branch, cc));
      if (cv) { qty -= cv.qty; cost -= cv.cost; retail -= cv.retail; purchase -= cv.purchase; }
    }
    out.push({
      branchCode: branch,
      branchName: v.branchName,
      categoryCode: code,
      categoryName: v.name,
      stockQty: Number(qty.toFixed(2)),
      costAmount: Number(cost.toFixed(2)),
      purchaseAmount: Number(purchase.toFixed(2)),
      retailAmount: Number(retail.toFixed(2)),
    });
  }
  return out;
}

/**
 * 采集一个租户的完整数据
 * @param {object} acct 账号配置
 * @param {string} rangeKey 'today' | 'yesterday' | 'thisWeek' | 'thisMonth' | 'lastMonth'
 */
function stepMark() {
  const t0 = Date.now();
  return (label, extra) => {
    const ms = Date.now() - t0;
    try {
      console.log(`      · ${label} ${(ms / 1000).toFixed(1)}s${extra ? ' ' + extra : ''}`);
    } catch (e) { }
  };
}

/**
 * 连接测试：只验证账号能不能登录、有没有门店，不跑全量采集。
 * 新增门店时先用它确认配置没写错，避免白白等一轮完整抓取。
 */
async function probeTenant(acct) {
  const t0 = Date.now();
  const ts = new TenantSession(acct);
  try {
    const sess = await ts.ensureLogin();
    const branches = await fetchBranches(ts);
    return {
      ok: true,
      tenantCode: acct.tenantCode,
      tenantName: (sess && (sess.tenantName || sess.branchName)) || '',
      siteHost: (sess && sess.siteHost) || '',
      branchCount: branches.length,
      branches: branches.slice(0, 8).map(b => b.name),
      elapsed: Math.round((Date.now() - t0) / 100) / 10,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), elapsed: Math.round((Date.now() - t0) / 100) / 10 };
  }
}

/**
 * 同一个门店同一时刻只允许一路采集。
 *
 * 实测踩过坑：门店视图刷新与全店刷新同时请求同一账号时，两个会话互相挤占，
 * 报表偶发返回空报文，整家店被判为采集失败（页面数据瞬间归零）。
 * 按门店排队后，各门店之间依旧并行，只有同一家自己排队，稳定性优先。
 */
const TENANT_GATE = new Map();
function runExclusive(tenantCode, fn) {
  const prev = TENANT_GATE.get(tenantCode) || Promise.resolve();
  const cur = prev.then(fn, fn);
  TENANT_GATE.set(tenantCode, cur.catch(() => { }));
  return cur;
}

async function collectTenant(acct, rangeKey, opts = {}) {
  return runExclusive(String(acct.tenantCode), () => collectTenantInner(acct, rangeKey, opts));
}

async function collectTenantInner(acct, rangeKey, opts = {}) {
  const ts = new TenantSession(acct);
  const now = new Date();
  const range = rangeOf(rangeKey, now);
  const todayStr = fmt(now);
  const P = fetchPolicy.load();
  const HOME_TTL = P.todayIntervalMin * 60 * 1000;          // 实时看板：跟今日刷新间隔一致
  const STOCK_CACHE = P.branchStockTtlMin * 60 * 1000;      // 门店类别库存
  const step = stepMark();
  const result = {
    tenantCode: acct.tenantCode,
    alias: acct.alias || '',
    rangeKey,
    rangeLabel: range.label,
    begin: range.beginStr,
    end: range.endStr,
    ok: false,
    error: null,
    deepPending: true,       // 阶段二（季节 / 供应商 / 小类）是否已补齐
    deepError: null,
    fetchedAt: Date.now(),
  };
  // 两阶段回调：阶段一（首屏数字）一到手就先交给上层出画面，阶段二在后台接着补。
  // 冷启动最重的是商品档案（一家店几十页，全被限速闸门排着队），
  // 让它挡在首屏前面，就是「点开程序三四分钟一片空白」的根因。
  const onStage = typeof opts.onStage === 'function' ? opts.onStage : null;
  const emit = (phase) => { if (onStage) { try { onStage(result, phase); } catch (e) { } } };
  try {
    const branches = await fetchBranches(ts);
    const categories = await fetchCategories(ts);
    step('主数据');
    // 实时看板 / 门店库存只跟「今天」有关，与查询区间无关 —— 五个档位共用一次请求
    const home = await cachedResult(`home:${acct.tenantCode}`, HOME_TTL, () => fetchHomeStats(ts, todayStr));
    step('实时看板');
    // 同一天的区间起止是固定的：把它当作缓存标记，同一份结果当天反复用，
    // 历史区间（昨天/上月）抓过一次就永久命中，不必每次开程序都重新拉一遍二十几秒。
    const RANGE_TAG = `${range.beginStr}~${range.endStr}`;
    // 缓存时长一律跟着抓取策略走：今日按营业时段间隔，历史区间「一天一次」，上月按天
    const SALE_TTL = fetchPolicy.ttlOf(rangeKey);
    const code = acct.tenantCode;
    const [sale, stock] = await Promise.all([
      cachedRange(`rsale2-${code}.json`, RANGE_TAG, SALE_TTL, () => fetchCoreSale(ts, range), { swr: true, tenantCode: code }),
      cachedRange(`rstock2-${code}.json`, todayStr, STOCK_CACHE, () => fetchStock(ts, categories), { swr: true, tenantCode: code }),
    ]);
    step('销售+库存');
    // ---------- 阶段一完成：销售额 / 库存 / 实时看板全部就位，可以先出画面 ----------
    Object.assign(result, {
      ok: true,
      tenantId: ts.sess && ts.sess.tenantId,
      tenantName: (ts.sess && ts.sess.tenantName) || acct.alias || acct.tenantCode,
      siteHost: ts.sess && ts.sess.siteHost,
      branches, categories, today: home,
      categoryBranch: sale.cat,
      branchDaily: sale.daily,
      categoryTree: [],
      stock,
      items: [], styles: [], itemSale: [], itemStock: [],
    });
    emit(1);
    // ---------- 阶段二：季节表 / 供应商榜 / 小类下钻 ----------
    try {
      const [items, styles] = await Promise.all([
        fetchItems(ts).catch(() => []),
        fetchStyles(ts).catch(() => []),
      ]);
      step('商品档案', `${items.length}/${styles.length}`);
      const [sub, itemSale] = await Promise.all([
        cachedRange(`rsub-${code}.json`, RANGE_TAG, SALE_TTL, () => fetchSubSale(ts, range), { swr: true, tenantCode: code }).catch(() => []),
        // 缓存名带 2：旧版（网格翻页时代）只有 50 行截断数据，换名失效，别让 TTL 内的残数当天花板
        cachedRange(`risale2-${code}.json`, RANGE_TAG, SALE_TTL, () => fetchItemSale(ts, range), { swr: true, tenantCode: code }).catch(() => []),
      ]);
      step('小类+商品级销售', `${sub.length}/${itemSale.length}行`);
      // 商品级库存改为导出一次性全量抓取（5.2 万行 / 27 秒）：按大类逐个请求要十几次往返，
      // 反而比一次拉全量慢得多。库存变化慢，跨档位复用同一份缓存。
      const itemStock = await cachedResult(`itemstock:${acct.tenantCode}`, stockTtlMs(),
        () => fetchItemStock(ts)).catch(() => []);
      step('商品级库存', `${itemStock.length}行`);
      Object.assign(result, { categoryTree: sub, items, styles, itemSale, itemStock, deepPending: false });
    } catch (e) {
      // 阶段二挂了不能连累阶段一：首屏数字照常展示，只是季节 / 供应商缺一块
      result.deepError = String((e && e.message) || e);
      result.deepPending = false;
      step('阶段二失败', result.deepError);
    }
    emit(2);
  } catch (e) {
    result.error = String(e && e.message || e);
    result.deepPending = false;
    // 打印调用栈前几行：光有一句 undefined 不好判断是哪个请求断了
    try {
      const stack = String((e && e.stack) || '').split('\n').slice(1, 4).map(s => s.trim()).join(' | ');
      console.log(`      × ${acct.tenantCode} 采集失败：${result.error}  ${stack}`);
    } catch (_) { }
  }
  return result;
}

// ---------------- 年度月度数据（轻量通道，只供给看板的「年度柱状图」） ----------------
/**
 * 取「今年 1 月 1 日 ~ 今天」的日销售，前端按月汇总成柱状图（销售额 + 毛利）。
 *
 * 走导出通道（约 20 秒）：网格版一年的「门店 × 日」有 700+ 行，按 50 行/页
 * 要翻 15 页，被限速闸门压到一分钟上下；导出一次任务拿全量。
 *
 * 为什么单独走一条通道而不是加一个 year 档位：
 * 全年数据的商品级销售 / 季节 / 库存都是几万行级别的报文，全量拉会把启动拖到几分钟，
 * 还容易触发厂家限流；而这块图只需要每个月的销售额和毛利，
 * 一张「门店 × 日」的报表（几百行）完全够用，每家店只发一次任务。
 */
async function collectYearly(acct) {
  const now = new Date();
  const year = now.getFullYear();
  const beginStr = `${year}-01-01`;
  const endStr = fmt(now);
  const out = {
    tenantCode: acct.tenantCode, alias: acct.alias || '', year,
    ok: false, error: null, daily: [], fetchedAt: Date.now(),
  };
  try {
    const ts = new TenantSession(acct);
    const r = await exportReport(ts, {
      controller: 'RptSaleSummaryAnalysis',
      group: 'BranchDaily',
      sortOptions: '""',
      advancedQuery: [
        { Field: 'GroupType', Value: 'BranchDaily' },
        { Field: 'BranchId', Operator: 'Equals', Value: '0' },
        { Field: 'Branch.Name', Operator: 'Equals', Value: '全部门店' },
        { Field: 'OperDate', Operator: 'Between', Value: `${beginStr},${endStr}` },
      ],
      columns: [
        ['rowNum', '序号'], ['BranchCode', '门店编码'], ['BranchName', '门店名称'], ['OperDate', '日期'],
        ['SaleQty', '销售数量'], ['SaleAmount', '金额'], ['SaleCostAmount', '成本金额'],
        ['SaleGrossProfit', '毛利金额'], ['GrossProfitPercent', '毛利率'],
      ],
    });
    out.daily = r.rows.map(row => ({
      branchCode: String(pick(row, ['门店编码', '门店编号']) || '').trim(),
      branchName: String(pick(row, ['门店名称', '门店']) || '').trim(),
      categoryCode: '',
      categoryName: '',
      categoryId: '',
      date: String(pick(row, ['日期', '经营日期', 'OperDate']) || '').trim(),
      saleQty: num(pick(row, ['销售数量'])),
      saleAmount: num(pick(row, ['销售金额', '金额'])),
      costAmount: num(pick(row, ['销售成本', '成本金额'])),
      grossProfit: num(pick(row, ['毛利', '毛利金额'])),
      grossRate: num(pick(row, ['毛利率'])),
    }));
    out.ok = true;
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

module.exports = { collectTenant, probeTenant, collectYearly, ThrottleQueue, levelOf, safeGrid, safeApi, fetchItemSale, fetchStock };
