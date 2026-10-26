'use strict';
/**
 * 抓取策略与对外限速。
 *
 * 背景：厂家（零售云平台云）对短时间内密集请求有波动告警。大屏这边最费请求的是
 * ①商品档案分页（每页 1000 条，闪电仓 5 万商品 = 单次约 54 个请求）
 * ②今日档高频刷新 ③历史档轮换续刷。
 *
 * 三道闸门：
 *   1. 时段：只在营业时间内自动抓取，闭店后只呈现已有快照
 *   2. 频率：今日档按分钟间隔；历史档「一天一次」
 *   3. 限速：全进程令牌桶，任何路径（含手动刷新）都不得突破
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./tenant');

const FILE = path.join(DATA_DIR, 'fetch-policy.json');

const DEFAULTS = {
  openTime: '09:00',          // 营业开始
  closeTime: '22:30',         // 营业结束（之后不自动联网）
  todayIntervalMin: 5,        // 营业时段内「今日」刷新间隔（分钟）
  historyOncePerDay: true,    // 昨日/本周/本月：每天只拉一次
  lastMonthDays: 7,           // 上月数据已定稿，7 天拉一次即可
  ratePerMinute: 20,          // 硬性限速：每分钟最多对外请求数（宁可慢，也不能把收银挤掉）
  burst: 6,                   // 允许的瞬时突发：令牌桶上限。厂家对「一下子来十几个」最敏感，
                              // 桶里攒 20 个令牌一口气放出去实测会触发 0002，这里压到 6，
                              // 之后就匀速放行（速度靠减少请求数换，不靠突发）。
  masterTtlHours: 24,         // 商品档案 / 款式档案缓存时长
  stockTtlHours: 12,          // 商品级库存缓存时长
  branchStockTtlMin: 30,      // 门店类别库存缓存时长
  quietOutsideHours: true,    // 非营业时段不自动抓取（手动刷新不受限）
};

let cache = null, cacheAt = 0, cacheMtime = 0;

function load() {
  try {
    const st = fs.statSync(FILE);
    if (cache && st.mtimeMs === cacheMtime && Date.now() - cacheAt < 3000) return cache;
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = normalize(o);
    cacheMtime = st.mtimeMs; cacheAt = Date.now();
    return cache;
  } catch (e) {
    if (!cache || Date.now() - cacheAt > 3000) {
      try {
        const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        cache = normalize(o);
      } catch (_) { cache = Object.assign({}, DEFAULTS); }
      cacheAt = Date.now();
    }
    return cache;
  }
}

function normalize(o) {
  const p = Object.assign({}, DEFAULTS, o || {});
  const numv = (v, min, max, dft) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dft;
  };
  p.todayIntervalMin = numv(p.todayIntervalMin, 1, 120, DEFAULTS.todayIntervalMin);
  p.lastMonthDays = numv(p.lastMonthDays, 1, 60, DEFAULTS.lastMonthDays);
  p.ratePerMinute = numv(p.ratePerMinute, 5, 600, DEFAULTS.ratePerMinute);
  p.burst = numv(p.burst, 1, 60, DEFAULTS.burst);
  p.masterTtlHours = numv(p.masterTtlHours, 1, 240, DEFAULTS.masterTtlHours);
  p.stockTtlHours = numv(p.stockTtlHours, 1, 240, DEFAULTS.stockTtlHours);
  p.branchStockTtlMin = numv(p.branchStockTtlMin, 5, 720, DEFAULTS.branchStockTtlMin);
  p.historyOncePerDay = p.historyOncePerDay !== false;
  p.quietOutsideHours = p.quietOutsideHours !== false;
  if (!/^\d{1,2}:\d{2}$/.test(String(p.openTime))) p.openTime = DEFAULTS.openTime;
  if (!/^\d{1,2}:\d{2}$/.test(String(p.closeTime))) p.closeTime = DEFAULTS.closeTime;
  return p;
}

function save(input) {
  const p = normalize(input);
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(p, null, 2), 'utf8');
  } catch (e) { /* 只读环境下也能按内存策略运行 */ }
  cache = p; cacheAt = Date.now(); cacheMtime = 0;
  return p;
}

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 当前是否处于营业时段（时段在同一天内，不做跨天处理） */
function isOpen(now = new Date(), p = load()) {
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur >= minutesOf(p.openTime) && cur <= minutesOf(p.closeTime);
}

/** 营业时段内才自动抓取；闭店后只呈现快照。手动刷新由调用方自行决定 */
function autoAllowed(now = new Date(), p = load()) {
  return !p.quietOutsideHours || isOpen(now, p);
}

/** 各档位的数据有效期：今日按分钟，历史档按「每天一次」，上月按天 */
function ttlOf(rangeKey, p = load()) {
  if (rangeKey === 'today') return p.todayIntervalMin * 60 * 1000;
  if (rangeKey === 'lastMonth') return p.lastMonthDays * 24 * 3600 * 1000;
  return p.historyOncePerDay ? 24 * 3600 * 1000 : 20 * 60 * 1000;
}

// ---------------- 令牌桶：全进程对外请求限速 ----------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------- 熔断器：厂家限流自我保护 ----------------
// 教训：早期实验期没把握好节奏，连续触发服务端「操作过于频繁 (0002)」，
// 把自己关在门外半个多小时。熔断器的职责就是让程序永远不再走到那一步：
//
//   ① 每被限流一次，熔断器下降一个阶梯：
//       速率按 2^n 递减（相对用户配置，最低 1 请求/分），突发桶同步减半；
//       同时进入该阶冷却期，冷却期内新请求先背压等待，不再往服务端撞。
//   ② 冷却期逐级延长：2 分钟 → 5 分钟 → 10 分钟 → 20 分钟，
//       越被限流，冷静得越久，给服务端充分的恢复时间。
//   ③ 自动回升：连续干净时长超过「两倍冷却时长」，回升一个阶梯，
//     避免一次误伤把程序永久摁在低速上。回升是懒检查（每次 gate 时判定）。
//
// 阶梯速率是相对值：L0 = 用户配置的 ratePerMinute / burst，每阶减半。
const BREAKER_COOLDOWN_MS = [0, 120000, 300000, 600000, 1200000]; // 各阶冷却时长
const BREAKER_MAX_LEVEL = BREAKER_COOLDOWN_MS.length - 1;
const breaker = { level: 0, lastHitAt: 0, hits: 0, cooling: false };

function levelRate(p, level) { return Math.max(1, Math.floor(p.ratePerMinute / Math.pow(2, level))); }
function levelBurst(p, level) { return Math.max(1, Math.round(p.burst / Math.pow(2, level))); }
function cooldownOf(level) { return BREAKER_COOLDOWN_MS[Math.min(level, BREAKER_MAX_LEVEL)]; }

/** 被服务端限流一次 → 下降一个阶梯（采集侧 safeGrid 的 0002 分支调用） */
function tripBreaker() {
  breaker.level = Math.min(breaker.level + 1, BREAKER_MAX_LEVEL);
  breaker.lastHitAt = Date.now();
  breaker.hits++;
  breaker.cooling = cooldownOf(breaker.level) > 0;
  limiter.setRate();
}

/** 老名字保留：penalize 现在等价于「熔断下降一阶」 */
function penalize() { tripBreaker(); }

/** 懒检查回升：连续干净超过两倍冷却时长 → 回升一阶 */
function breakerRecover() {
  if (breaker.level === 0) { breaker.cooling = false; return; }
  const cleanFor = Date.now() - breaker.lastHitAt;
  if (cleanFor > cooldownOf(breaker.level) * 2) {
    breaker.level--;
    // 保留一半历史：回升后也要再稳定一段时间才能继续回升
    breaker.lastHitAt = Date.now() - Math.floor(cooldownOf(breaker.level) * 0.5);
    limiter.setRate();
    if (breaker.level === 0) breaker.cooling = false;
  }
}

function breakerView() {
  breakerRecover();
  const cd = cooldownOf(breaker.level);
  const remain = breaker.cooling ? Math.max(0, breaker.lastHitAt + cd - Date.now()) : 0;
  return {
    level: breaker.level, maxLevel: BREAKER_MAX_LEVEL,
    hits: breaker.hits,                       // 本次进程生命周期内累计被限流次数
    cooling: breaker.cooling,                 // 是否处于熔断冷却期
    cooldownRemainSec: Math.round(remain / 1000),
    cooldownTotalSec: Math.round(cd / 1000),
  };
}

function effectiveRate(p) {
  return levelRate(p, breaker.level);
}

class RateLimiter {
  constructor() { this.setRate(); this.tokens = this.burst; this.last = Date.now(); }
  setRate() {
    const p = load();
    this.capacity = Math.max(1, effectiveRate(p));
    this.burst = levelBurst(p, breaker.level);
    this.ratePerMs = this.capacity / 60000;
    if (this.tokens === undefined) this.tokens = this.burst;
    else this.tokens = Math.min(this.tokens, this.burst);
  }
  _refill() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.last) * this.ratePerMs);
    this.last = now;
  }
  /** 取一个令牌；没有就等（返回等待毫秒数，便于日志观察是否被限速） */
  async take() {
    this.setRate();
    this._refill();
    if (this.tokens >= 1) { this.tokens -= 1; return 0; }
    const wait = Math.ceil((1 - this.tokens) / this.ratePerMs);
    this.tokens = 0;
    await sleep(wait);
    this._refill();
    this.tokens = Math.max(0, this.tokens - 1);
    return wait;
  }
}

const limiter = new RateLimiter();

// ---------------- 请求计数：让用户能自查「今天向厂家发了多少请求」 ----------------
const stats = { day: '', count: 0, minute: [], throttledMs: 0 };

function dayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function record(waitMs) {
  const d = dayStr();
  if (stats.day !== d) { stats.day = d; stats.count = 0; stats.minute = []; stats.throttledMs = 0; }
  stats.count++;
  const now = Date.now();
  stats.minute.push(now);
  while (stats.minute.length && now - stats.minute[0] > 60000) stats.minute.shift();
  if (waitMs) stats.throttledMs += waitMs;
}

async function gate() {
  breakerRecover();
  // 熔断冷却期：等到冷却结束再放行（背压）。宁可这一轮慢，也不再撞服务端触发下一轮限流。
  if (breaker.cooling) {
    const until = breaker.lastHitAt + cooldownOf(breaker.level);
    const wait = until - Date.now();
    if (wait > 0) await sleep(wait);
    breaker.cooling = false;
  }
  const wait = await limiter.take();
  record(wait);
  return wait;
}

function statsView(p = load()) {
  const now = Date.now();
  while (stats.minute.length && now - stats.minute[0] > 60000) stats.minute.shift();
  return {
    day: stats.day || dayStr(),
    todayRequests: stats.count,
    lastMinuteRequests: stats.minute.length,
    limitPerMinute: p.ratePerMinute,
    throttledMs: stats.throttledMs,
    breaker: breakerView(),   // 熔断器状态：当前阶梯 / 累计被限流次数 / 冷却剩余
  };
}

module.exports = {
  DEFAULTS, FILE, load, save, normalize, isOpen, autoAllowed, ttlOf, gate, statsView, dayStr, limiter,
  penalize, penaltyView: breakerView, tripBreaker, breakerView,
  __breaker: breaker,   // 诊断/测试钩子：查看与推进熔断器内部状态
};
