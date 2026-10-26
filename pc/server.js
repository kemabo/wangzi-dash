'use strict';
// 门店经营大屏 —— 本地服务（零第三方依赖，Node 原生 http）
// 支持 Node SEA 单文件打包：public 静态资源内嵌 exe，数据目录移到 exe 旁
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execSync, execFileSync, spawn } = require('child_process');

const sea = (() => { try { return require('node:sea'); } catch (e) { return null; } })();
const IS_SEA = !!(sea && sea.isSea());
const saver = require('./lib/saver');

// ---------------- 屏保模式参数（Windows 屏幕保护程序约定） ----------------
//   /s        全屏运行屏保
//   /c        配置（显示说明）
//   /p <hwnd> 预览（不做处理）
// 打包成 exe（SEA）后 argv 是 [exe, 参数...]，而 node server.js 时是 [node, 脚本, 参数...]，
// 两种形态都要能拿到参数 —— 用 slice(2) 会把 exe 模式的第一个参数吃掉（--guard / --apply-update 失效）。
const ARGV = (IS_SEA || String(process.argv[1] || '') === String(process.execPath)
  || /\.exe$/i.test(String(process.argv[1] || ''))
  ? process.argv.slice(1) : process.argv.slice(2)).map(a => String(a));
const SAVER_PREVIEW = ARGV.some(a => a.startsWith('/p') || a.startsWith('/P'));
// Windows 规定屏保要传 /s 启动；个别环境（尤其 SCRNSAVE.EXE 直接指向 exe 时）
// 传参不规范，这时用「工作目录是 System32」兜底识别 —— 用户双击时目录永远不会是它。
const SAVER_CFG = ARGV.some(a => a === '/c' || a === '/C');
const SAVER_FALLBACK = IS_SEA && !ARGV.length && /\\(System32|SysWOW64)$/i.test(String(process.cwd()));
const SAVER_FULL = ARGV.some(a => a === '/s' || a === '/S' || a === '--saver') || SAVER_FALLBACK;
const SAVER_MODE = SAVER_FULL || SAVER_CFG || SAVER_PREVIEW;
// --guard：计划任务守护每 5 分钟调用一次。服务还在就立刻退出（不弹浏览器），
// 服务没了才在后台静默拉起来，保证「随时能拿到数据」。
const GUARD = ARGV.some(a => a === '--guard');
// --apply-update：由更新流程启动的「安装器」。它不启服务，只负责等旧进程退出、
// 把新主程序搬到安装目录、再把新版本拉起来，然后自己退出。
const APPLY_UPDATE = ARGV.some(a => a === '--apply-update');

const { PORT, EXE_DIR, HOME_DIR, VERSION: APP_VERSION, APP_NAME, BUILD } = require('./config');

// 快照重算标记：同版本已经用当前代码算过的快照可以直接复用，
// 只有升级后（版本或构建号变了）才需要重算出新的字段结构
const BUILD_TAG = `${APP_VERSION}|${BUILD}`;
const BASE_PORT = PORT;
let ACTIVE_PORT = PORT;   // 实际监听端口（端口被占用时自动顺延）
// 作为屏保安装到 System32 运行时（.scr），数据仍放回原 exe 旁，避免写到系统目录
if (IS_SEA) {
  try {
    const originFile = path.join(path.dirname(process.execPath), path.basename(process.execPath) + '.origin');
    const dir = fs.readFileSync(originFile, 'utf8').trim();
    if (dir && fs.existsSync(dir)) process.env.DASH_DATA_DIR = path.join(dir, 'data');
  } catch (e) { }
}
// exe 模式：lib 内模块（会话/季节映射）的数据目录统一指向 exe 旁
// 数据与门店配置统一跟 HOME_DIR 走：分发副本会自动共用本机主程序那套，不会多出第二套空数据
if (IS_SEA && HOME_DIR && !process.env.DASH_DATA_DIR) process.env.DASH_DATA_DIR = path.join(HOME_DIR, 'data');
const { RANGES } = require('./lib/dates');
const { collectTenant, probeTenant, collectYearly } = require('./lib/collector');
const { build, buildYearly, seasonCategoryList } = require('./lib/aggregate');
const updater = require('./lib/updater');
const season = require('./lib/season');
const { seasonDetail } = require('./lib/seasondetail');
const { projectStore } = require('./lib/storeview');
// 右下角托盘（PowerShell 图标）已彻底移除：它在这台机器上一直拉不起来，
// 而取数根本不依赖它 ——「开机自启 + 计划任务守护」已能保证随时拿得到数据。
const keeper = require('./lib/keeper');
const fetchPolicy = require('./lib/fetchpolicy');
const branches = require('./lib/branches');
const auth = require('./lib/auth');

// 门店清单不再写死：改界面的「门店」页签或改 exe 旁的 config.json，重启后依然生效
function accounts() { return branches.active(); }

// ---------------- 登录与权限 ----------------
/**
 * 识别当前访问者。三种凭据都认：
 * 1) 浏览器 cookie（PC 大屏，老路径）
 * 2) 网址上的 ?token=（手机 App：跨域且拿不到 cookie 时用）
 * 3) 请求头 x-dash-token（备用）
 */
function authUser(req, url) {
  const t = auth.tokenFromCookie(req.headers.cookie)
    || (url && url.searchParams ? String(url.searchParams.get('token') || '') : '')
    || String(req.headers['x-dash-token'] || '');
  return auth.userOfToken(t);
}
/**
 * 谁能管（增删门店、改设置、看别家店）：
 * - 明确以门店身份登录了 → 一定不是管理员（哪怕还没设口令，他自己也只该看本店）
 * - 没设管理员口令 → 谁都能管（保持原来「双击就出来、随手就能改」的习惯）
 * - 设了口令 → 必须是 admin
 */
function canAdmin(me) {
  if (me && me.role && me.role !== 'admin') return false;
  if (me && me.role === 'admin') return true;
  return !auth.authEnabled();
}
/** 门店账号强制锁本店：就算它改网址加 ?store= 别的店，也只返回自己那家 */
function effectiveStore(me, requested) {
  if (!me) return requested || '';
  if (me.role === 'admin') return requested || '';
  return String(me.storeKey || '') || (requested || '');
}
// remember=false 时只发「会话 cookie」：关掉浏览器就失效，适合公用电脑
function setAuthCookie(res, token, remember) {
  const days = remember ? auth.TOKEN_DAYS * 86400 : null;
  res.setHeader('Set-Cookie', `${auth.COOKIE}=${token}; Path=/${days ? '; Max-Age=' + days : ''}; SameSite=Lax`);
}
function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${auth.COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`);
}

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
// exe 模式：数据存到 exe 所在目录的 data/ 下，随 U 盘/换机迁移不丢
const DATA_DIR = process.env.DASH_DATA_DIR
  || (IS_SEA ? path.join(HOME_DIR || EXE_DIR, 'data') : path.join(ROOT, 'data'));
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }

const REFRESH_MS = Number(process.env.REFRESH_MS || 60000);           // 前端轮询间隔
const TODAY_TTL = Number(process.env.TODAY_TTL || 5 * 60 * 1000);     // 实时数据有效期
const DETAIL_TTL = Number(process.env.DETAIL_TTL || 20 * 60 * 1000);  // 明细数据有效期

// ---------------- 软件更新 ----------------
// 安装目标固定是「主程序目录」（install.json 登记的那份）：分发副本共用一套，
// 装在副本自己的文件夹里没意义。exe 名与 APP_NAME 不同，写死成打包用的那个。
const EXE_NAME = '王子鞋服经营数据大屏.exe';
updater.init({
  dataDir: DATA_DIR,
  home: HOME_DIR || EXE_DIR || ROOT,
  exeName: EXE_NAME,
  version: APP_VERSION,
  build: BUILD,
  isSea: IS_SEA,
});

// 下载 + 解压 + 备份 + 生成替换脚本；最后一步必须让主程序退出，脚本才能覆盖 exe
let updateRunning = false;
function runUpdateInstall(force) {
  if (updateRunning) return;
  updateRunning = true;
  updater.install({ force: !!force }).then((r) => {
    updateRunning = false;
    if (r.ok && r.needExit) {
      log(`更新包 v${r.version} 已就绪，主程序退出，交给安装脚本接管`);
      const a = updater.launchApplier();
      log(a.ok ? `安装脚本已启动（pid ${a.pid}）` : '启动安装脚本失败：' + a.error);
      if (!a.ok) return;
      setTimeout(() => { try { server.close(); } catch (e) { } process.exit(0); }, 800);
    } else if (!r.ok) {
      log('自动更新失败：', r.error);
    } else {
      log('自动更新：已是最新版本');
    }
  }).catch(e => { updateRunning = false; log('自动更新异常：', String(e.message || e)); });
}

const snapshots = new Map();   // snapKey -> {payload, updatedAt, startedAt, status, error}
const inflight = new Map();
// 抓取进度（供前端「启动中」遮罩显示，避免双击 exe 后长时间空白像没反应）
const progress = { range: null, done: 0, deepDone: 0, total: accounts().length, current: '', startedAt: 0, stage: 'idle' };

/**
 * 快照键：默认是整份全店数据（today）；门店账号登录后只拉自己那家，
 * 就落到带后缀的独立快照里（today#10000001），两套互不覆盖。
 * @param {string} rangeKey 档位
 * @param {string} scope 门店账号限定的门店号，空表示全店
 */
function snapKey(rangeKey, scope) { return scope ? `${rangeKey}#${scope}` : rangeKey; }
function cacheFile(key) { return path.join(DATA_DIR, `snapshot-${String(key).replace('#', '-s')}.json`); }

function loadCache(key) {
  try {
    const raw = fs.readFileSync(cacheFile(key), 'utf8');
    const o = JSON.parse(raw);
    if (o && o.payload) return o;
  } catch (e) { }
  return null;
}
function saveCache(key, rec) {
  try { fs.writeFileSync(cacheFile(key), JSON.stringify(rec, null, 2), 'utf8'); } catch (e) { }
}

/**
 * 门店账号登录后只看本店，抓取也就只跑那一家：
 * ① 少了另外两家的往返，快了一截；② 不把别家经营数据拉到门店电脑上来。
 */
function scopeOf(me) {
  return (me && me.role && me.role !== 'admin' && me.storeKey) ? String(me.storeKey) : '';
}

/**
 * 全局采集队列：同一时刻只允许「一个档位」在联网抓取。
 *
 * 早先四个历史档位并发开跑，它们共用同一批商户会话与同一条节流队列，
 * 结果就是谁都拿不到足额配额：实测单店今日从 30 秒被拖到 116 秒，
 * 甚至把登录会话互相挤掉，报出「商户ID、账号或密码不对」的假错。
 * 改成一次只跑一档，整档用完就把队列交给下一档，单档耗时才是真实水平。
 * 「今日」永远插队到最前面 —— 用户第一眼要看的就是它。
 */
const collectQueue = [];
let collectBusy = false;
function scheduleCollect(rangeKey, fn, highPriority) {
  return new Promise((resolve, reject) => {
    const item = { rangeKey, fn, resolve, reject };
    if (highPriority) {
      const at = collectQueue.findIndex(x => x.rangeKey !== rangeKey);
      if (at < 0) collectQueue.push(item); else collectQueue.splice(at, 0, item);
    } else {
      collectQueue.push(item);
    }
    pumpCollect();
  });
}
function pumpCollect() {
  if (collectBusy) return;
  const item = collectQueue.shift();
  if (!item) return;
  collectBusy = true;
  Promise.resolve()
    .then(item.fn)
    .then(item.resolve, item.reject)
    .finally(() => { collectBusy = false; setImmediate(pumpCollect); });
}

async function refresh(rangeKey, force = false, scope = '') {
  const key = snapKey(rangeKey, scope);
  if (inflight.has(key)) return inflight.get(key);
  const cur = snapshots.get(key) || loadCache(key);
  // 有效期按抓取策略：今日 = 营业时段的刷新间隔；历史档 = 一天一次（上月按天）
  const ttl = fetchPolicy.ttlOf(rangeKey);
  // 门店视角不必再单独抓一次：进程里若已有一份新鲜的全店快照，直接从它裁剪出本店
  // 视图（零请求）。门店电脑上本来就没有全店快照，照常只抓自己那一家。
  if (scope && !force) {
    const all = snapshots.get(rangeKey) || loadCache(rangeKey);
    if (all && all.payload && all.status === 'ok' && Date.now() - all.updatedAt < ttl) {
      const rec = {
        payload: projectStore(all.payload, scope), updatedAt: all.updatedAt,
        startedAt: 0, status: 'ok', error: null, builtBy: BUILD_TAG, scope,
      };
      snapshots.set(key, rec);
      saveCache(key, rec);
      return rec;
    }
  }
  if (!force && cur && Date.now() - cur.updatedAt < ttl) {
    // 换了新版本（BUILD_TAG 变了）必须重算：否则会一直沿用旧 exe 算出来的快照，
    // 季节等逻辑改了也看不到效果（典型症状：升级后女装仍显示「不分季节」）。
    if (cur.builtBy === BUILD_TAG) {
      snapshots.set(key, cur);
      return cur;
    }
  }
  const p = (async () => {
    const startedAt = Date.now();
    log('refresh start', rangeKey + (scope ? ` [仅 ${scope}]` : ''));
    const ALL = accounts();
    const ACCTS = scope ? ALL.filter(a => String(a.tenantCode) === String(scope)) : ALL;
    if (!ACCTS.length) throw new Error('没有可采集的门店');
    Object.assign(progress, { range: rangeKey, done: 0, deepDone: 0, total: ACCTS.length, current: '', startedAt, stage: 'login' });
    const raw = new Array(ACCTS.length);
    // 冷启动体感优化：从没有快照开始（第一次装、或换到新电脑）三家全拉完要三四分钟，
    // 页面一直空白就像卡死。改成每拉完一家先把这一家的数据产出给用户看，
    // 剩下的在后面接着补 —— 首屏几十秒内就有数字，而不是干等。
    const hasPrev = !!cur;
    // 阶段一（销售额 / 库存 / 实时看板）一到手就出画面；阶段二（季节 / 供应商 / 小类）
    // 补齐后再刷新一次。冷启动时这一下就把「首屏」从三四分钟压到几十秒。
    const pushPartial = () => {
      if (hasPrev) return;                 // 已经有旧数据了，别拿残缺数据覆盖掉
      const partial = raw.filter(r => r && r.ok);
      if (!partial.length) return;
      try {
        const deepPending = partial.some(r => r.deepPending);
        const payload = build(partial, rangeKey, {
          updatedAt: Date.now(), partial: true, deepPending, seasonMap: season.loadMap(),
        });
        snapshots.set(key, { payload, updatedAt: Date.now(), startedAt, status: deepPending ? 'partial' : 'ok', error: null, builtBy: BUILD_TAG, scope: scope || '' });
        if (!deepPending) saveCache(key, snapshots.get(key));
        log(`  部分就绪 ${rangeKey} ${partial.length}/${ACCTS.length}${deepPending ? '（季节/供应商后台补数中）' : '（已补全）'}`);
      } catch (e) { log('  部分就绪失败', e.message); }
    };
    // 每个商户的会话彼此独立，服务端限流按会话计，同一档内可以并行抓取；
    // 但档位与档位之间必须排队（见 scheduleCollect 注释），不能一起哄抢同一份配额。
    await scheduleCollect(rangeKey, () => Promise.all(ACCTS.map(async (acct, idx) => {
      const t0 = Date.now();
      try {
        progress.stage = 'fetch';
        progress.current = acct.alias || String(acct.tenantCode);
        const r = await collectTenant(acct, rangeKey, {
          onStage: (partial, phase) => {
            // 同一个对象引用：阶段二补齐后这里的数据自动跟着变全，无需再传一次
            raw[idx] = partial;
            progress.stage = phase === 1 ? 'fetch' : 'deep';
            progress.done = raw.filter(x => x && x.ok).length;
            progress.deepDone = raw.filter(x => x && x.ok && !x.deepPending).length;
            pushPartial();
          },
        });
        raw[idx] = r;
        log(`  ${acct.tenantCode} ${r.ok ? 'ok' : 'FAIL ' + r.error} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        raw[idx] = { tenantCode: acct.tenantCode, alias: acct.alias, ok: false, error: String(e.message || e), branches: [], categoryBranch: [], branchDaily: [], categoryTree: [], stock: [], today: null, rangeLabel: rangeKey, begin: null, end: null, fetchedAt: Date.now() };
        log(`  tenant ${acct.tenantCode} EXCEPTION ${e.message}`);
      } finally {
        progress.done = raw.filter(x => x && x.ok).length;
        progress.deepDone = raw.filter(x => x && x.ok && !x.deepPending).length;
        pushPartial();
      }
    })), rangeKey === 'today');
    raw.forEach((r, i) => { if (!r) raw[i] = { tenantCode: ACCTS[i].tenantCode, alias: ACCTS[i].alias, ok: false, error: '未采集', branches: [], categoryBranch: [], branchDaily: [], categoryTree: [], stock: [], today: null, rangeLabel: rangeKey, begin: null, end: null, fetchedAt: Date.now() }; });
    // 全部拉失败时不能把「空快照」当成有效数据写下去：界面会显示一片 0，
    // 比保留上一版旧数据糟糕得多。这种情况宁可什么都不做。
    const okCount = raw.filter(r => r && r.ok).length;
    if (okCount === 0) {
      const reason = raw.map(r => `${r.tenantCode}:${r.error || '失败'}`).join(' / ');
      throw new Error(`全部门店采集失败，保留上一版快照（${reason}）`);
    }
    progress.stage = 'build';
    const tBuild = Date.now();
    const payload = build(raw, rangeKey, {
      updatedAt: Date.now(),
      fetchingSince: null,
      seasonMap: season.loadMap(),
    });
    const rec = { payload, updatedAt: Date.now(), startedAt, status: 'ok', error: null, builtBy: BUILD_TAG, scope: scope || '' };
    snapshots.set(key, rec);
    saveCache(key, rec);
    log(`  build ${rangeKey} ${((Date.now() - tBuild) / 1000).toFixed(1)}s`);
    // 原始存档只记全店口径：它是 rebuildRange 重算快照的唯一输入，
    // 门店账号的局部快照若写进去，会把整份数据覆盖成一家店的
    if (!scope) { try { fs.writeFileSync(path.join(DATA_DIR, `raw-${rangeKey}.json`), JSON.stringify(raw), 'utf8'); } catch (e) { } }
    log(`refresh done ${rangeKey}${scope ? ' [仅 ' + scope + ']' : ''} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    progress.stage = 'idle';
  })().catch(e => {
    log('refresh ERROR', rangeKey, e.message);
    progress.stage = 'idle';
    if (!snapshots.has(key)) {
      snapshots.set(key, { payload: null, updatedAt: 0, startedAt: 0, status: 'error', error: e.message });
    }
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function ensureFresh(rangeKey, force = false, scope = '') {
  return refresh(rangeKey, force, scope).catch(() => { });
}

// 后台定时续刷要知道「这台机器到底是给谁看的」：
// 门店电脑天天只登门店账号，没必要每半分钟去拉三家的数据；总部电脑登的是管理员，才把全店拉齐。
let LAST_STORE_SCOPE = '';
let LAST_ALL_AT = 0;
function scopeForBackground() {
  // 十分钟没来过全店请求 → 认为这是一台纯门店端，后台只续自己那家
  return (Date.now() - LAST_ALL_AT > 10 * 60 * 1000) ? LAST_STORE_SCOPE : '';
}

/**
 * 后台按需求预热其余档位：已有快照且未过期的直接跳过，避免拖慢首屏。
 * 一次只推进一个档位 —— 采集本身就有一道全局串行门（scheduleCollect），
 * 这里再并发提交只会让四个档堆在队列里互相等待，反而谁都慢。
 */
function warmupOtherRanges() {
  const queue = RANGES.filter(k => k !== 'today');
  const worker = async () => {
    while (queue.length) {
      const k = queue.shift();
      try {
        const cur = snapshots.get(k) || loadCache(k);
        if (cur && Date.now() - cur.updatedAt < fetchPolicy.ttlOf(k)) continue;
        await refresh(k, false, scopeForBackground());
      } catch (e) { /* 单个档位失败不影响其他 */ }
    }
  };
  (async () => {
    await worker();
    log('其余档位预热完成');
  })();
}

function snapshotView(rangeKey, storeKey, scope = '') {
  const key = snapKey(rangeKey, scope);
  let rec = snapshots.get(key);
  if (!rec) { const c = loadCache(key); if (c) { snapshots.set(key, c); rec = c; } }
  const payload = rec && rec.payload;
  const view = {
    range: rangeKey,
    store: storeKey || '',
    updatedAt: rec ? rec.updatedAt : 0,
    status: rec ? rec.status : 'empty',
    error: rec ? rec.error : null,
    refreshing: inflight.has(key),
    // 门店视图在服务端裁剪，单店拿到的报文里不含其他门店的数据
    payload: payload ? (storeKey ? projectStore(payload, storeKey) : payload) : emptyPayload(rangeKey, storeKey),
    // 年度月度柱状图：数据独立于当前档位（永远是今年 1 月至今），每天只抓一次
    yearly: yearlyView(String(storeKey || scope || '')),
    serverTime: Date.now(),
    refreshInterval: REFRESH_MS,
    // 版本哨兵：exe 升级（数据抓取逻辑常跟着变）后，浏览器里开着的旧页面会继续跑旧前端，
    // 新逻辑不生效、用户还以为没修。前端每次轮询都比对，发现版本变化就整体重载一次。
    version: APP_VERSION,
    build: BUILD,
  };
  // 总部视角（拿的是全店快照）即便当前只投影到某一家店，也要把全部门店清单带回去：
  // 顶部门店下拉的选项就是从报文里取的，不给全清单的话，管理员切到某店后就再也切不回全公司了。
  // 门店账号用的是自己那一份 scope 快照（scope 非空），里面本来就只有本店，天然不会泄露别家。
  if (!scope && payload) {
    view.allStores = (payload.stores || []).map(s => ({ key: String(s.key), name: s.name, branchCount: s.branchCount || 0 }));
  }
  return view;
}

function emptyPayload(rangeKey, storeKey) {
  const p = build([], rangeKey, { updatedAt: 0 });
  return storeKey ? projectStore(p, storeKey) : p;
}

// ---------------- HTTP ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

// 手机 App 是从 file:// 或另一个端口打开页面的，属于跨域请求，
// 这里统一放开（凭据走 ?token=，不依赖 cookie，所以可以用 * 且不影响安全）
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Dash-Token',
  'Access-Control-Max-Age': '86400',
};
function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
  });
  res.end(body);
}

// exe 模式下内嵌的静态资源清单（sea-config.json assets 的键）
const SEA_ASSETS = new Set([
  'public/index.html', 'public/app.js', 'public/style.css',
  'public/m/index.html', 'public/m/app.js', 'public/m/app.css',
  'public/m/core.js', 'public/m/presets.js', 'public/m/sample-data.js',
]);

function serveStatic(req, res, urlPath) {
  // /m 是手机版入口（手机浏览器打开大屏电脑的 /m 即可，可「添加到主屏幕」当 App 用）
  // 先补上尾斜杠：页面里用的是相对路径 /m/app.css，基准目录必须是 /m/ 而不是 /
  if (urlPath === '/m') {
    res.writeHead(301, { Location: '/m/', 'Cache-Control': 'no-store' });
    return res.end();
  }
  let rel = urlPath === '/' ? '/index.html'
    : (urlPath === '/m' || urlPath === '/m/' ? '/m/index.html' : urlPath);
  const clean = path.normalize(rel).replace(/^([/\\])+/, '').replace(/\\/g, '/');
  if (IS_SEA) {
    const key = 'public/' + clean;
    if (!SEA_ASSETS.has(key)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    try {
      const buf = Buffer.from(sea.getAsset(key));
      const ext = path.extname(key).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(buf);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('asset error');
    }
  }
  const filePath = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

// 运行日志：exe 模式下同时写到 exe 旁的「运行日志.txt」，方便双击无反应时排查
const LOG_FILE = (() => {
  try {
    if (IS_SEA && EXE_DIR) return path.join(EXE_DIR, '运行日志.txt');
    if (!IS_SEA) return path.join(ROOT, 'server-run.log.txt');
  } catch (e) { }
  return null;
})();
function log(...a) {
  const line = `[${new Date().toLocaleTimeString('zh-CN')}] ${a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  // 守护每 5 分钟检查一次，正常运行就不往日志里灌水，只有真出状况才记
  if (GUARD && !/启动|守护|失败|错误|异常|退出/.test(line)) return;
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, line + '\n');
      const st = fs.statSync(LOG_FILE);
      if (st.size > 2 * 1024 * 1024) { // 超过 2MB 保留后半段
        const old = fs.readFileSync(LOG_FILE, 'utf8');
        fs.writeFileSync(LOG_FILE, old.slice(Math.floor(old.length / 2)));
      }
    } catch (e) { }
  }
}

/** 弹一个系统提示框（仅 exe 模式，用于「双击没反应」时给出可见反馈） */
function alertBox(msg, title = '王子鞋服经营数据大屏') {
  log('[弹窗提示]', msg);
  if (!IS_SEA || process.platform !== 'win32') return;
  if (SAVER_FULL) return;   // 屏保运行时不弹窗打扰
  try {
    const safe = String(msg).replace(/'/g, "''").replace(/\r?\n/g, '  ').slice(0, 900);
    const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${safe}','${title}','OK','Information') | Out-Null`;
    execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { windowsHide: true, timeout: 120000 });
  } catch (e) { }
}

/** 用已缓存的原始数据重算单个档位（不重新抓取）。返回 'rebuilt' | 'skipped' | 'none' */
function rebuildRange(k) {
  try {
    const f = path.join(DATA_DIR, `raw-${k}.json`);
    if (!fs.existsSync(f)) return 'none';
    const prev = snapshots.get(k) || loadCache(k);
    // 同一版本已经算过的快照直接复用：只有升级后才需要重算来补齐新字段。
    // 否则每次开机都要把 5 个 20MB 的原始快照重新聚合一遍，白白堵住主线程几十秒。
    if (prev && prev.payload && prev.builtBy === BUILD_TAG) return 'skipped';
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(raw)) return 'none';
    const rec = {
      payload: build(raw, k, { updatedAt: prev ? prev.updatedAt : Date.now(), seasonMap: season.loadMap() }),
      // 注意：这里刻意沿用原来的 updatedAt —— 重算只是换了算法，不等于数据变新了。
      // 早先把它刷成当前时间，会让几小时前抓的旧数据在 TTL 里被当成「刚抓的」，从而挡住真正的刷新。
      updatedAt: prev ? prev.updatedAt : Date.now(),
      startedAt: prev ? prev.startedAt : Date.now(),
      status: 'ok', error: null,
      builtBy: BUILD_TAG,
    };
    snapshots.set(k, rec);
    saveCache(k, rec);
    return 'rebuilt';
  } catch (e) { log('season rebuild ERROR', k, e.message); return 'none'; }
}

/**
 * 用已缓存的原始数据重算各档位（不重新抓取），返回本次同步重算成功的档位。
 * today 必须同步完成，保证首屏立刻有数据；其余档位逐档异步重建并在每档之间让出主线程 ——
 * 早先这里是 5 个 20MB 的原始快照一口气同步聚合，会把主线程堵死近 70 秒，
 * 期间前端拿不到任何响应，表现就是「打开大屏一直加载不出来」。
 */
function rebuildAllRanges() {
  const rebuilt = [];
  if (rebuildRange('today') === 'rebuilt') rebuilt.push('today');
  const rest = RANGES.filter(k => k !== 'today');
  if (rest.length) {
    setImmediate(async () => {
      for (const k of rest) {
        await new Promise(r => setImmediate(r));
        if (rebuildRange(k) === 'rebuilt') rebuilt.push(k);
      }
      log(`快照核对完成：本次重算 ${rebuilt.length} 个档位，其余已是最新版直接复用`);
    });
  }
  return rebuilt;
}

// ---------------- 年度月度数据（年度柱状图专用） ----------------
// 走的是一条独立轻量通道：每家门店只发一次请求，取回今年 1 月 1 日至今的日销售。
// 每天只需要抓一次，白天频繁刷 today 时不会跟着重复联网。
const yearlyState = { payload: null, updatedAt: 0, day: '', busy: false };
const yearlyFile = () => path.join(DATA_DIR, 'yearly.json');

function loadYearly() {
  try {
    const o = JSON.parse(fs.readFileSync(yearlyFile(), 'utf8'));
    if (o && o.payload && Array.isArray(o.payload.months)) {
      yearlyState.payload = o.payload;
      yearlyState.updatedAt = Number(o.updatedAt) || 0;
      yearlyState.day = String(o.day || '');
    }
  } catch (e) { /* 没有就用空 */ }
}

function saveYearly() {
  try {
    fs.writeFileSync(yearlyFile(), JSON.stringify({
      payload: yearlyState.payload, updatedAt: yearlyState.updatedAt, day: yearlyState.day,
    }, null, 2), 'utf8');
  } catch (e) { /* 写盘失败不影响内存里的结果 */ }
}

async function refreshYearly(force = false, scope = '') {
  const today = fetchPolicy.dayStr();
  if (yearlyState.busy) return yearlyState.payload;
  // 同一天已经抓过就直接复用（刷新策略：年度数据每天一次）
  if (!force && yearlyState.payload && yearlyState.day === today) return yearlyState.payload;
  const ALL = accounts();
  const ACCTS = scope ? ALL.filter(a => String(a.tenantCode) === String(scope)) : ALL;
  if (!ACCTS.length) return yearlyState.payload;
  yearlyState.busy = true;
  const t0 = Date.now();
  try {
    const results = await Promise.all(ACCTS.map(a => collectYearly(a)));
    // 跟主快照一个规矩：全军覆没要保留上一次的旧数据，不能把一片 0 当作有效结果写进去
    if (results.some(r => r && r.ok)) {
      yearlyState.payload = buildYearly(results, { updatedAt: Date.now() });
      yearlyState.updatedAt = Date.now();
      yearlyState.day = today;
      saveYearly();
      log(`年度月度数据已更新 ${((Date.now() - t0) / 1000).toFixed(1)}s，累计销售额 ${yearlyState.payload.total.sale}`);
    } else {
      log('年度月度数据抓取全部失败，保留上一次结果');
    }
  } catch (e) {
    log('年度月度数据异常', e.message);
  } finally {
    yearlyState.busy = false;
  }
  return yearlyState.payload;
}

/**
 * 门店账号登录时，年度图也只给这一家店的数据 —— 主报文有 projectStore 裁剪，
 * 年度图是单独拼出来的，这里补同样的裁剪，别在门店电脑上漏出别家的经营数据。
 */
function yearlyView(storeKey) {
  const p = yearlyState.payload;
  if (!p) return null;
  if (!storeKey) return p;
  const months = (p.months || []).map((m) => {
    const v = (m.byStore || {})[String(storeKey)] || { sale: 0, qty: 0, profit: 0 };
    return {
      m: m.m, label: m.label, sale: v.sale, qty: v.qty, profit: v.profit,
      cost: 0, rate: v.sale > 0 ? Number((v.profit / v.sale * 100).toFixed(2)) : 0,
    };
  });
  const t = months.reduce((acc, m) => ({
    sale: acc.sale + m.sale, qty: acc.qty + m.qty, profit: acc.profit + m.profit,
  }), { sale: 0, qty: 0, profit: 0 });
  const used = months.filter(m => m.sale > 0).length;
  return Object.assign({}, p, {
    months, monthCount: used ? months.filter(m => m.sale > 0)[used - 1].m : 0,
    total: {
      sale: Number(t.sale.toFixed(2)), qty: Number(t.qty.toFixed(2)), profit: Number(t.profit.toFixed(2)),
      cost: 0, rate: t.sale > 0 ? Number((t.profit / t.sale * 100).toFixed(2)) : 0,
      avgMonth: used ? Number((t.sale / used).toFixed(2)) : 0,
    },
  });
}

function localIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

// ---------------- 屏保：全屏窗口的启动 / 退出 / 安装 ----------------
const saverState = { pid: 0, browser: '', owned: false, startedAt: 0 };
const registeredPids = new Set();   // 复用已有服务时，由屏保进程注册进来的窗口进程号

function killPid(pid) {
  if (!pid) return;
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch (e) { }
}

function findBrowser() {
  const cands = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  for (const p of cands) if (p && fs.existsSync(p)) return p;
  return '';
}

// ---------------- 环境自检：换到新电脑装不上/跑不起来时，先跑一遍看缺什么 ----------------
// 用法：① 双击 exe 加参数 `--doctor`（命令行窗口会打印报告并存成 环境检测报告.txt）
//      ② 大屏里 设置 → 运行 → 「环境自检」按钮
function psBin() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
function netProbe(host) {
  return new Promise((resolve) => {
    try {
      const https = require('https');
      const req = https.request({ host, port: 443, path: '/', method: 'GET', timeout: 6000 }, (res) => {
        resolve({ ok: true, detail: `${host} 可访问（HTTP ${res.statusCode}）` });
        try { res.resume(); } catch (e) { }
      });
      req.on('timeout', () => { try { req.destroy(); } catch (e) { } resolve({ ok: false, detail: `${host} 连接超时` }); });
      req.on('error', (e) => resolve({ ok: false, detail: `${host} 连不上：${e.message}` }));
      req.end();
    } catch (e) { resolve({ ok: false, detail: `${host} 检测异常：${e.message}` }); }
  });
}
function portFree(port) {
  return new Promise((resolve) => {
    try {
      const net = require('net');
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(port, '127.0.0.1');
    } catch (e) { resolve(false); }
  });
}
async function runDoctor() {
  const items = [];
  const add = (name, ok, detail, fix) => items.push({ name, ok: !!ok, detail: String(detail || ''), fix: String(fix || '') });

  // 1. 系统版本
  const rel = String(os.release());
  const [maj, min] = rel.split('.').map(Number);
  const winOk = process.platform === 'win32' && (maj > 10 || (maj === 10));
  add('操作系统', winOk, `${os.type()} ${rel}（${os.arch()}）`, winOk ? '' : '建议 Windows 10/11；Win7 需自行安装 KB2999226 与 VC++ 运行库');

  // 2. 内置运行时（exe 自带 Node，无需另外安装）
  add('内置运行时', true, `Node ${process.version} 已内嵌在 exe 中（${IS_SEA ? '单文件模式' : '源码模式'}），不需要另外安装 Node`, '');

  // 3. PowerShell（开机自启 / 后台守护依赖它）
  const ps = psBin();
  const psOk = fs.existsSync(ps);
  add('PowerShell', psOk, psOk ? ps : `没找到 ${ps}`, psOk ? '' : 'Windows 自带组件缺失，开机自启与守护会失效（看数据不受影响）');

  // 4. 浏览器（打开界面 / 屏保全屏需要）
  const br = findBrowser();
  add('浏览器', !!br, br || '没找到 Edge 也没有 Chrome', br ? '' : '装 Microsoft Edge 或 Google Chrome；否则只能手动用别的浏览器打开 http://localhost:8765');

  // 5. VC++ 运行库（exe 启动的最常见拦路虎）
  let vcOk = false, vcDetail = '';
  try {
    const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64" /v Installed', { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    vcOk = /0x1/i.test(out);
    vcDetail = vcOk ? 'VC++ 2015-2022 x64 运行库已安装' : '注册表里未标记已安装';
  } catch (e) {
    const sys = process.env.SystemRoot || 'C:\\Windows';
    vcOk = fs.existsSync(path.join(sys, 'System32', 'vcruntime140.dll')) && fs.existsSync(path.join(sys, 'System32', 'ucrtbase.dll'));
    vcDetail = vcOk ? '系统目录已有 vcruntime140.dll / ucrtbase.dll' : '未检测到运行库';
  }
  add('VC++ 运行库', vcOk, vcDetail, vcOk ? '' : '下载安装「Microsoft Visual C++ Redistributable 2015-2022 (x64)」后重启电脑');

  // 6. 数据目录可写
  let wrOk = false, wrDetail = DATA_DIR;
  try {
    const t = path.join(DATA_DIR, '_writetest.tmp');
    fs.writeFileSync(t, 'ok'); fs.unlinkSync(t); wrOk = true;
  } catch (e) { wrDetail = `${DATA_DIR} 不可写：${e.message}`; }
  add('数据目录', wrOk, wrDetail, wrOk ? '' : '把 exe 换到有写权限的文件夹（不要放 C:\\Windows 或 Program Files 里）');

  // 7. 端口
  const free = await portFree(BASE_PORT);
  add('端口', true, free ? `${BASE_PORT} 空闲，可用` : `${BASE_PORT} 已被占用（有可能大屏已经在跑，程序会自动顺延到 8766~8775）`, '');

  // 8. 计划任务（守护）
  let schOk = false, schDetail = '无法确认';
  if (psOk) {
    try {
      const out = execSync(`"${ps}" -NoProfile -NonInteractive -Command "(Get-Module -ListAvailable ScheduledTasks).Name -join ','"`, { windowsHide: true, timeout: 30000, encoding: 'utf8' }).toString();
      schOk = /ScheduledTasks/i.test(out);
      schDetail = schOk ? 'ScheduledTasks 模块可用，开机自启与守护可正常设置' : 'ScheduledTasks 模块不可用';
    } catch (e) { schDetail = '检测失败：' + e.message; }
  }
  add('计划任务', schOk, schDetail, schOk ? '' : '开机自启可能设不上；可手动把 exe 快捷方式放进「启动」文件夹');

  // 9. 外网到零售云平台
  const netR = await netProbe('erp.example.com');
  add('零售云平台服务器', netR.ok, netR.detail, netR.ok ? '' : '检查这台电脑能否上网、是否被防火墙拦了 example.com.cn');

  const bad = items.filter(i => !i.ok);
  return { ok: bad.length === 0, items, version: APP_VERSION, build: BUILD, appName: APP_NAME, dataDir: DATA_DIR, port: ACTIVE_PORT || BASE_PORT };
}
function doctorText(r) {
  const lines = [];
  lines.push(`${APP_NAME}  环境检测报告`);
  lines.push(`版本：v${r.version}（构建 ${r.build}）    检测时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`数据目录：${r.dataDir}`);
  lines.push('');
  for (const i of r.items) {
    lines.push(`[${i.ok ? '正常' : '需处理'}] ${i.name}`);
    lines.push(`        ${i.detail}`);
    if (!i.ok && i.fix) lines.push(`        → 怎么办：${i.fix}`);
  }
  lines.push('');
  lines.push(r.ok ? '结论：环境没问题，可以正常使用。' : `结论：有 ${r.items.filter(i => !i.ok).length} 项需要处理，按上面的「怎么办」处理后重开 exe。`);
  return lines.join('\r\n');
}
async function doctorCli() {
  const r = await runDoctor();
  const txt = doctorText(r);
  console.log(txt);
  try {
    const dir = IS_SEA && EXE_DIR ? EXE_DIR : __dirname;
    fs.writeFileSync(path.join(dir, '环境检测报告.txt'), txt, 'utf8');
    console.log('\r\n报告已保存到：' + path.join(dir, '环境检测报告.txt'));
  } catch (e) { }
  process.exit(r.ok ? 0 : 1);
}
const DOCTOR = ARGV.some(a => a === '--doctor' || a === '-doctor' || a === '/doctor');

/** 用 Edge / Chrome 的「 kiosk 全屏」打开大屏，作为屏保画面 */
function startKiosk(port) {
  const browser = findBrowser();
  if (!browser) return { ok: false, error: '没找到 Edge 或 Chrome 浏览器，无法进入全屏屏保' };
  const url = `http://localhost:${port}/?saver=1`;
  const profile = path.join(os.tmpdir(), 'dash-saver-profile');
  const args = [
    '--kiosk', url, '--edge-kiosk-type=fullscreen',
    '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
    '--disable-features=Translate,TranslateUI', '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profile}`,
  ];
  try {
    const child = spawn(browser, args, { detached: true, stdio: 'ignore' });
    child.unref();
    saverState.pid = child.pid;
    saverState.browser = browser;
    saverState.startedAt = Date.now();
    return { ok: true, pid: child.pid, browser: path.basename(browser), url };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 看门狗：屏保进程被系统终止（Windows 检测到鼠标键盘输入会结束屏保）时，
 * 由它把残留的全屏窗口关掉，避免卡住桌面
 */
function startWatchdog(saverPid, browserPid) {
  if (process.platform !== 'win32' || !browserPid) return;
  const f = path.join(os.tmpdir(), 'dash-saver-watch.ps1');
  const script = [
    `$s = ${saverPid}; $b = ${browserPid}`,
    'while ($true) {',
    '  Start-Sleep -Seconds 2',
    '  $bp = Get-Process -Id $b -ErrorAction SilentlyContinue',
    '  if (-not $bp) { break }',
    '  $sp = Get-Process -Id $s -ErrorAction SilentlyContinue',
    '  if (-not $sp) { Stop-Process -Id $b -Force -ErrorAction SilentlyContinue; break }',
    '}',
  ].join('\r\n');
  try { fs.writeFileSync(f, script, 'utf8'); } catch (e) { return; }
  try {
    spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', f],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) { }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); return res.end(); }
  const me = authUser(req, u);
  // ---------------- 登录 / 账号 ----------------
  if (u.pathname === '/api/auth/state') {
    // 前端第一件事就问这个：要不要登录、当前是谁、能看几家店
    return sendJson(res, {
      ok: true, loginRequired: auth.authEnabled(), locked: !!(me && me.role !== 'admin' && me.storeKey),
      user: me || null,
    });
  }
  if (u.pathname === '/api/auth/login' && req.method === 'POST') {
    readBody(req, 32 * 1024).then(async (s) => {
      let p = {};
      try { p = JSON.parse(s || '{}'); } catch (e) { return sendJson(res, { ok: false, error: '数据格式错误' }, 400); }
      const remember = p.remember !== false;
      // 门店登录：用这家店在零售云平台的账号密码登录 —— 第一次登录就等于把这家店接进大屏
      if (String(p.mode || '') === 'store') {
        const code = String(p.tenantCode || '').trim();
        const userAccount = String(p.userAccount || '9999').trim() || '9999';
        const password = String(p.password || '');
        if (!code) return sendJson(res, { ok: false, error: '请填商户ID（零售云平台的 8 位商户号）' }, 400);
        if (!password) return sendJson(res, { ok: false, error: '请填这家店的零售云平台密码' }, 400);
        const probe = await probeTenant({ tenantCode: code, userAccount, password, alias: '' });
        if (!probe.ok) return sendJson(res, { ok: false, error: probe.error }, 401);
        const alias = String(p.alias || probe.tenantName || code).trim() || code;
        const r = branches.upsert({ tenantCode: code, userAccount, password, alias, enabled: true });
        if (!r.ok) return sendJson(res, r, 400);
        try { const sf = path.join(DATA_DIR, `session-${code}.json`); if (fs.existsSync(sf)) fs.unlinkSync(sf); } catch (e) { }
        adoptBranchChanges(code, r.created ? '登录接入' : '登录更新');
        const user = { username: code, name: alias, role: 'store', storeKey: code };
        auth.upsertUser({ username: code, password, name: alias, role: 'store', storeKey: code }, { role: 'admin' });
        const tok1 = auth.issueToken(user);
        setAuthCookie(res, tok1, remember);
        log(`门店登录：${code} ${alias}（${probe.branchCount} 个分店）`);
        return sendJson(res, { ok: true, user, token: tok1, tenant: { tenantCode: code, alias, branchCount: probe.branchCount } });
      }
      // 管理员登录：没设密码时直接放行 —— 绝不把人锁在大屏外面
      const username = String(p.username || 'admin').trim() || 'admin';
      if (username.toLowerCase() === 'admin' && !auth.authEnabled()) {
        const a = auth.find('admin');
        const user = { username: 'admin', name: (a && a.name) || '管理员', role: 'admin', storeKey: '' };
        const tok2 = auth.issueToken(user);
        setAuthCookie(res, tok2, remember);
        return sendJson(res, { ok: true, user, token: tok2 });
      }
      const r = auth.verify(username, p.password);
      if (!r.ok) return sendJson(res, r, 401);
      const tok3 = auth.issueToken(r.user);
      setAuthCookie(res, tok3, remember);
      log(`登录成功：${r.user.username}（${r.user.role}${r.user.storeKey ? ' / ' + r.user.storeKey : ''}）`);
      return sendJson(res, { ok: true, user: r.user, token: tok3 });
    }).catch(e => sendJson(res, { ok: false, error: String(e.message || e) }, 500));
    return;
  }
  if (u.pathname === '/api/auth/logout' && req.method === 'POST') {
    auth.logout(auth.tokenFromCookie(req.headers.cookie));
    clearAuthCookie(res);
    return sendJson(res, { ok: true });
  }
  if (u.pathname === '/api/auth/users' && req.method === 'GET') {
    if (!canAdmin(me)) return sendJson(res, { ok: false, error: '需要管理员权限' }, 403);
    return sendJson(res, { ok: true, loginRequired: auth.authEnabled(), users: auth.publicUsers() });
  }
  if (u.pathname === '/api/auth/users' && req.method === 'POST') {
    if (!canAdmin(me)) return sendJson(res, { ok: false, error: '需要管理员权限' }, 403);
    readBody(req, 64 * 1024).then((s) => {
      let p = {};
      try { p = JSON.parse(s || '{}'); } catch (e) { return sendJson(res, { ok: false, error: '数据格式错误' }, 400); }
      const r = auth.upsertUser(p, me);
      if (!r.ok) return sendJson(res, r, 400);
      log(`${r.created ? '新增' : '修改'}账号：${p.username}（${p.role || 'store'}${p.storeKey ? ' / ' + p.storeKey : ''}）`);
      return sendJson(res, { ok: true, users: auth.publicUsers() });
    }).catch(e => sendJson(res, { ok: false, error: String(e.message || e) }, 500));
    return;
  }
  if (u.pathname === '/api/auth/users/remove' && req.method === 'POST') {
    if (!canAdmin(me)) return sendJson(res, { ok: false, error: '需要管理员权限' }, 403);
    const r = auth.removeUser(u.searchParams.get('username') || '', me);
    if (!r.ok) return sendJson(res, r, 400);
    log(`删除账号：${u.searchParams.get('username')}`);
    return sendJson(res, { ok: true, users: auth.publicUsers() });
  }
  if (u.pathname === '/api/auth/admin-password' && req.method === 'POST') {
    // 第一次设置不需要登录（否则锁死在外面）；改过之后必须管理员登录才能改
    if (auth.authEnabled() && (!me || me.role !== 'admin')) {
      return sendJson(res, { ok: false, error: '请先用管理员账号登录' }, 403);
    }
    readBody(req, 32 * 1024).then((s) => {
      let p = {};
      try { p = JSON.parse(s || '{}'); } catch (e) { return sendJson(res, { ok: false, error: '数据格式错误' }, 400); }
      const r = auth.setAdminPassword(String(p.password || ''));
      if (!r.ok) return sendJson(res, r, 400);
      log(r.enabled ? '已设置管理员口令：改门店/改设置需登录（看数据仍免登录）' : '已取消管理员口令，打开即可管理和查看');
    if (r.enabled) {
      const a = auth.find('admin');
      const token = auth.issueToken({ username: 'admin', name: (a && a.name) || '管理员', role: 'admin', storeKey: '' });
      setAuthCookie(res, token, true);
    }
      return sendJson(res, { ok: true, loginRequired: r.enabled, users: auth.publicUsers() });
    }).catch(e => sendJson(res, { ok: false, error: String(e.message || e) }, 500));
    return;
  }
  // 忘了管理员口令的本地恢复通道：只认来自大屏机本机的请求，局域网/外网无效
  if (u.pathname === '/api/auth/admin-password/reset' && req.method === 'POST') {
    const ip = String(req.socket.remoteAddress || '');
    const local = /^(127\.|::1$|::ffff:127\.)/.test(ip);
    if (!local) return sendJson(res, { ok: false, error: '只能在大屏这台电脑上操作' }, 403);
    const r = auth.setAdminPassword('');
    log('管理员口令已在本机清除（忘记口令的恢复操作）');
    return sendJson(res, { ok: true, loginRequired: false, users: auth.publicUsers() });
  }
  // 取数接口一律不拦：看数据不该被登录卡住。登录只用来解锁管理功能、锁定门店视图。
  if (auth.authEnabled() && !canAdmin(me) && /^\/api\/(branches|keeper|background|season)/.test(u.pathname)) {
    return sendJson(res, { ok: false, needLogin: true, error: '这些设置需要管理员登录' }, 401);
  }
  if (u.pathname === '/api/data') {
    const rangeKey = RANGES.includes(u.searchParams.get('range')) ? u.searchParams.get('range') : 'today';
    const storeKey = effectiveStore(me, u.searchParams.get('store') || '');
    const peek = u.searchParams.get('peek') === '1';
    // 门店账号：只抓自己那家（页面上的「门店」下拉本来就只有一家，没必要拉满三家）
    const scope = scopeOf(me);
    const force = u.searchParams.get('force') === '1';
    if (scope) LAST_STORE_SCOPE = scope; else LAST_ALL_AT = Date.now();
    if (peek) {
      // 只读模式（自动轮播切档用）：已有快照就直接返回，不触发重新抓取。
      // 否则轮播每 15 秒切一档会把五个档位的重采全部排起来，越刷越慢。
      const rec = snapshots.get(snapKey(rangeKey, scope)) || loadCache(snapKey(rangeKey, scope));
      if (!rec || rec.status !== 'ok') ensureFresh(rangeKey, false, scope);
    } else {
      ensureFresh(rangeKey, force, scope);
    }
    return sendJson(res, snapshotView(rangeKey, storeKey, scope));
  }
  // 大类 × 供应商榜不再有独立接口：它随 /api/data 一起下发（payload.vendorByCat），
  // 顶部选「实时 / 昨天 / 本周…」它就跟着显示哪一档，也不需要额外联网。
  if (u.pathname === '/api/stores') {
    // 门店清单（供顶部下拉使用）：只需要名称，不返回经营数据
    const base = snapshots.get('today') || snapshots.get('thisMonth') || loadCache('today');
    // 门店账号只看到自己那家，连别家店的名字都不给它
    const isAdmin = canAdmin(me);
    const allStores = ((base && base.payload && base.payload.stores) || []).map(s => ({
      key: s.key, name: s.name, branchCount: s.branchCount || 0,
    }));
    const visible = (isAdmin || !me) ? allStores : allStores.filter(s => String(s.key) === String(me.storeKey));
    return sendJson(res, {
      ok: true, stores: visible,
      accounts: isAdmin ? accounts().map(a => ({ tenantCode: String(a.tenantCode), alias: a.alias || String(a.tenantCode) })) : [],
    });
  }
  if (u.pathname === '/api/status') {
    // 门店账号看的是自己的那份快照，进度也要对得上（否则会一直显示「还没数据」）
    const scope = scopeOf(me);
    const r = {};
    for (const k of RANGES) {
      const key = snapKey(k, scope);
      const snap = snapshots.get(key) || loadCache(key);
      r[k] = snap ? { updatedAt: snap.updatedAt, status: snap.status, error: snap.error } : { updatedAt: 0, status: 'empty', error: null };
    }
    return sendJson(res, {
      serverTime: Date.now(),
      version: APP_VERSION,
      build: BUILD,
      accounts: accounts().map(a => ({ tenantCode: a.tenantCode, alias: a.alias })),
      ranges: r,
      refreshing: [...inflight.keys()],
      progress: { ...progress, elapsed: progress.startedAt ? Math.round((Date.now() - progress.startedAt) / 1000) : 0 },
      port: ACTIVE_PORT,
      sea: IS_SEA,
      // 抓取策略与今日请求量：让用户一眼看出「今天向厂家发了多少请求」
      fetch: Object.assign(fetchPolicy.statsView(), {
        open: fetchPolicy.isOpen(new Date()),
        policy: fetchPolicy.load(),
      }),
      appName: APP_NAME,
    });
  }
  if (u.pathname === '/api/refresh' && req.method === 'POST') {
    const rangeKey = RANGES.includes(u.searchParams.get('range')) ? u.searchParams.get('range') : 'today';
    ensureFresh(rangeKey, true, scopeOf(me));
    // 手动刷新顺带把年度柱状图的数据过一遍（今天已经抓过就跳过，不会真的重复联网）
    if (rangeKey === 'today') refreshYearly(false, scopeOf(me)).catch(() => { });
    return sendJson(res, { ok: true, range: rangeKey });
  }
  // ---------------- 手机 App 的门店配置导出 ----------------
  // 新增门店的做法：在大屏上「门店」页把新店配上 → 点这里生成一段文本 →
  // 微信发到手机 → 手机 App「设置 → 粘贴导入配置」粘进去。**不需要重新打包 App。**
  if (u.pathname === '/api/mobile-sync') {
    const withPwd = u.searchParams.get('pwd') === '1';
    const items = branches.list().filter(a => a.enabled !== false);
    // 带密码的导出必须是管理员 —— 这段文本一旦发出去就等于把后台密码给了对方
    if (withPwd && auth.authEnabled() && !canAdmin(me)) {
      return sendJson(res, { ok: false, error: '导出含密码的配置需要管理员登录' }, 403);
    }
    const data = items.map(a => ({
      a: a.alias || a.tenantCode,
      c: String(a.tenantCode),
      u: a.userAccount || '9999',
      p: withPwd ? String(a.password || '') : '',
    }));
    const text = 'WANGZI-DASH-ACCOUNTS:1:' + Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
    log(`生成手机 App 配置：${data.length} 家门店${withPwd ? '（含密码）' : ''}`);
    return sendJson(res, {
      ok: true, text, count: data.length, withPwd,
      readable: items.map(a => `${a.tenantCode},${a.alias || a.tenantCode},${a.userAccount || '9999'}`).join('\n'),
    });
  }

  // 年度月度数据单独刷新（调试与手动补数用）
  if (u.pathname === '/api/yearly') {
    const force = u.searchParams.get('refresh') === '1';
    if (force) {
      refreshYearly(true, scopeOf(me)).catch(() => { });
      return sendJson(res, { ok: true, started: true, updatedAt: yearlyState.updatedAt });
    }
    return sendJson(res, Object.assign({ ok: true, yearly: yearlyView(scopeOf(me) ? String(scopeOf(me)) : '') }));
  }
  // ---------------- 软件更新：Gitee 主源，取不到自动落到 GitHub ----------------
  if (u.pathname === '/api/update/status') {
    return sendJson(res, { ok: true, ...updater.status() });
  }
  if (u.pathname === '/api/update/check' && req.method === 'POST') {
    if (auth.authEnabled() && !canAdmin(me)) return sendJson(res, { ok: false, error: '需要管理员登录' }, 403);
    return updater.checkNow().then((r) => {
      log(r.ok ? (r.hasUpdate ? `检查更新：发现 v${r.latest.version}` : '检查更新：已是最新') : '检查更新失败：' + r.error);
      return sendJson(res, Object.assign({ ok: !!r.ok }, r));
    }).catch(e => sendJson(res, { ok: false, error: String(e.message || e) }));
  }
  if (u.pathname === '/api/update/install' && req.method === 'POST') {
    if (auth.authEnabled() && !canAdmin(me)) return sendJson(res, { ok: false, error: '需要管理员登录' }, 403);
    // 下载 30MB 可能要几十秒，这里只负责起个头，进度让前端轮询 /api/update/status
    runUpdateInstall(u.searchParams.get('force') === '1');
    return sendJson(res, { ok: true, started: true });
  }
  if (u.pathname === '/api/update/rollback' && req.method === 'POST') {
    if (auth.authEnabled() && !canAdmin(me)) return sendJson(res, { ok: false, error: '需要管理员登录' }, 403);
    const r = updater.rollback();
    if (!r.ok) return sendJson(res, r);
    log(`回滚到上一版 v${r.target}，退出主程序由脚本换回旧文件`);
    const a = updater.launchApplier();
    if (!a.ok) return sendJson(res, { ok: false, error: a.error });
    setTimeout(() => { try { server.close(); } catch (e) { } process.exit(0); }, 600);
    return sendJson(res, { ok: true, started: true, target: r.target });
  }
  if (u.pathname === '/api/update/toggle' && req.method === 'POST') {
    if (auth.authEnabled() && !canAdmin(me)) return sendJson(res, { ok: false, error: '需要管理员登录' }, 403);
    const on = u.searchParams.get('on') !== '0';
    updater.setEnabled(on);
    log(on ? '已开启自动检查更新' : '已关闭自动检查更新');
    return sendJson(res, { ok: true, enabled: on });
  }
  if (u.pathname === '/api/shutdown' && req.method === 'POST') {
    sendJson(res, { ok: true });
    log('收到退出指令，正在关闭大屏服务');
    setTimeout(() => { try { server.close(); } catch (e) { } process.exit(0); }, 300);
    return;
  }
  // ---------------- 开机自启 + 后台守护（一个开关统一管理） ----------------
  if (u.pathname === '/api/keeper' && req.method === 'POST') {
    const on = u.searchParams.get('on') !== '0';
    const r = keeper.setKeeper(on, keeperOpt());
    log(on
      ? `已开启开机自启与后台守护（计划任务 ${r.task ? '已建' : '未建'}，启动项 ${r.startup ? '已建' : '未建'}）`
      : '已关闭开机自启与后台守护');
    return sendJson(res, Object.assign({ ok: r.ok }, r));
  }
  if (u.pathname === '/api/keeper') {
    return sendJson(res, keeperStatusCached());
  }
  // 兼容旧前端
  if (u.pathname === '/api/autostart' && req.method === 'POST') {
    const on = u.searchParams.get('on') !== '0';
    const r = keeper.setKeeper(on, keeperOpt());
    return sendJson(res, { ok: r.ok, on: r.on });
  }
  if (u.pathname === '/api/autostart') {
    return sendJson(res, { on: keeperStatusCached().on });
  }
  // ---------------- 门店自助管理（新增门店只填信息，不用改代码） ----------------
  if (u.pathname === '/api/branches' && req.method === 'GET') {
    if (!canAdmin(me)) return sendJson(res, { ok: false, error: '只有管理员能管门店' }, 403);
    return sendJson(res, branchView());
  }
  if (u.pathname === '/api/branches' && req.method === 'POST') {
    if (!canAdmin(me)) return sendJson(res, { ok: false, error: '只有管理员能管门店' }, 403);
    readBody(req, 64 * 1024).then(async (s) => {
      let p = {};
      try { p = JSON.parse(s || '{}'); } catch (e) { return sendJson(res, { ok: false, error: '数据格式错误' }, 400); }
      const r = branches.upsert(p);
      if (!r.ok) return sendJson(res, r, 400);
      log(`${r.created ? '新增门店' : '修改门店'}：${r.item.tenantCode} ${r.item.alias}`);
      // 改的是密码/账号时把旧会话作废，下一次抓取自动用新凭据登录
      try { const sf = path.join(DATA_DIR, `session-${r.item.tenantCode}.json`); if (sf && fs.existsSync(sf)) fs.unlinkSync(sf); } catch (e) { }
      adoptBranchChanges(r.item.tenantCode, r.created ? '新增' : '修改');
      return sendJson(res, Object.assign({ ok: true }, branchView()));
    }).catch(e => sendJson(res, { ok: false, error: String(e.message || e) }, 500));
    return;
  }
  if (u.pathname === '/api/branches/test' && req.method === 'POST') {
    if (!canAdmin(me)) return sendJson(res, { ok: false, error: '只有管理员能管门店' }, 403);
    readBody(req, 64 * 1024).then(async (s) => {
      let p = {};
      try { p = JSON.parse(s || '{}'); } catch (e) { return sendJson(res, { ok: false, error: '数据格式错误' }, 400); }
      const code = String(p.tenantCode || '').trim();
      if (!code) return sendJson(res, { ok: false, error: '请先填商户ID' }, 400);
      let password = String(p.password || '');
      let userAccount = String(p.userAccount || '9999');
      // 密码留空表示沿用已保存的密码
      if (!password) {
        const exist = branches.find(code);
        if (!exist || !exist.password) return sendJson(res, { ok: false, error: '请填写密码后再测试' }, 400);
        password = exist.password;
        userAccount = exist.userAccount || userAccount;
      }
      const r = await probeTenant({ tenantCode: code, userAccount, password, alias: p.alias || code });
      log(`门店连接测试 ${code}：${r.ok ? '通过，' + r.branchCount + ' 个分店' : '失败 ' + r.error}`);
      return sendJson(res, r);
    }).catch(e => sendJson(res, { ok: false, error: String(e.message || e) }, 500));
    return;
  }
  if (u.pathname === '/api/branches/remove' && req.method === 'POST') {
    if (!canAdmin(me)) return sendJson(res, { ok: false, error: '只有管理员能管门店' }, 403);
    const code = String(u.searchParams.get('tenantCode') || '').trim();
    if (!code) return sendJson(res, { ok: false, error: '缺少商户ID' }, 400);
    const r = branches.remove(code);
    if (!r.ok) return sendJson(res, r, 404);
    log(`删除门店：${code}`);
    purgeTenant(code);
    try { writeEntryShortcuts(); } catch (e) { }
    return sendJson(res, Object.assign({ ok: true }, branchView()));
  }
  if (u.pathname === '/api/branches/enable' && req.method === 'POST') {
    if (!canAdmin(me)) return sendJson(res, { ok: false, error: '只有管理员能管门店' }, 403);
    const code = String(u.searchParams.get('tenantCode') || '').trim();
    const on = u.searchParams.get('on') !== '0';
    const r = branches.setEnabled(code, on);
    if (!r.ok) return sendJson(res, r, 404);
    log(`${on ? '启用' : '停用'}门店：${code}`);
    if (!on) purgeTenant(code);
    else adoptBranchChanges(code, '启用');
    return sendJson(res, Object.assign({ ok: true }, branchView()));
  }
  // ---------------- 各门店独立入口 ----------------
  if (u.pathname === '/api/entries') {
    return sendJson(res, entriesView(canAdmin(me) ? null : me));
  }
  if (u.pathname === '/api/entries/shortcut' && req.method === 'POST') {
    if (!canAdmin(me)) return sendJson(res, { ok: false, error: '只有管理员能生成门店入口' }, 403);
    const key = u.searchParams.get('store') || '';
    const to = u.searchParams.get('to') === 'desktop' ? 'desktop' : 'folder';
    const r = createShortcut(key, to);
    return sendJson(res, r);
  }
  // ---------------- 大屏背景图 ----------------
  if (u.pathname === '/api/background' && req.method === 'POST') {
    readBody(req, 12 * 1024 * 1024).then((raw) => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch (e) { return sendJson(res, { ok: false, error: '数据格式错误' }, 400); }
      const dataUrl = String(payload.dataUrl || '');
      const m = /^data:(image\/(png|jpeg|jpg|webp|gif));base64,(.+)$/i.exec(dataUrl);
      if (!m) return sendJson(res, { ok: false, error: '不是有效的图片数据' }, 400);
      const ext = '.' + m[2].toLowerCase().replace('jpg', 'jpg');
      try {
        // 清掉旧图，避免不同扩展名残留
        const old = bgFile();
        if (old) { try { fs.unlinkSync(old); } catch (e) { } }
        const buf = Buffer.from(m[3], 'base64');
        fs.writeFileSync(path.join(DATA_DIR, 'bg' + ext), buf);
        log(`已更新大屏背景图（${(buf.length / 1024).toFixed(0)} KB）`);
        return sendJson(res, { ok: true, url: bgUrl() });
      } catch (e) { return sendJson(res, { ok: false, error: e.message }, 500); }
    }).catch(() => sendJson(res, { ok: false, error: '上传失败' }, 400));
    return;
  }
  if (u.pathname === '/api/background' && req.method === 'DELETE') {
    const f = bgFile();
    if (f) { try { fs.unlinkSync(f); } catch (e) { } }
    log('已移除大屏背景图');
    return sendJson(res, { ok: true });
  }
  if (u.pathname === '/api/background') {
    return sendJson(res, { has: !!bgFile(), url: bgUrl() });
  }
  if (u.pathname === '/api/background/image') {
    const f = bgFile();
    if (!f) { res.writeHead(404); return res.end('no background'); }
    const st = fs.statSync(f);
    res.writeHead(200, {
      'Content-Type': BG_MIME[path.extname(f).toLowerCase()] || 'image/jpeg',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    return res.end(fs.readFileSync(f));
  }
  // ---------------- 季节归类 ----------------
  if (u.pathname === '/api/season-map' && req.method === 'GET') {
    const map = season.loadMap();
    let categories = [];
    for (const k of ['today', 'thisMonth', 'yesterday', 'thisWeek', 'lastMonth']) {
      try {
        const f = path.join(DATA_DIR, `raw-${k}.json`);
        if (!fs.existsSync(f)) continue;
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!Array.isArray(raw) || !raw.some(t => t.ok)) continue;
        categories = seasonCategoryList(raw, map);
        break;
      } catch (e) { }
    }
    return sendJson(res, {
      ok: true, map, categories, rules: season.loadRules(),
      groups: season.SEASON_GROUPS, labels: season.SEASON_LABELS, order: season.RULE_ORDER,
    });
  }
  if (u.pathname === '/api/season-map' && req.method === 'POST') {
    let body = '';
    let over = false;
    req.on('data', (c) => { body += c; if (body.length > 1e6) { over = true; req.destroy(); } });
    req.on('end', () => {
      try {
        if (over) return sendJson(res, { ok: false, error: '请求过大' }, 413);
        const input = JSON.parse(body || '{}');
        const clean = {};
        for (const [k, v] of Object.entries(input.map || {})) {
          const name = String(k).slice(0, 60);
          const sv = String(v || '');
          if (['spring', 'summer', 'autumn', 'winter'].includes(sv)) clean[name] = sv;
          // 其他值（含空串）视为删除该条，跟随自动识别
        }
        season.saveMap(clean);
        // 用已缓存的原始数据立即重算各档位（不重新抓取）
        const rebuilt = rebuildAllRanges();
        log('季节映射已保存，重算档位：', rebuilt.join(',') || '无');
        sendJson(res, { ok: true, rebuilt, map: clean });
      } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }
  // ---------------- 季节关键词规则 ----------------
  if (u.pathname === '/api/season-rules' && req.method === 'GET') {
    return sendJson(res, {
      ok: true, rules: season.loadRules(),
      defaults: season.DEFAULT_RULES, order: season.RULE_ORDER, labels: season.SEASON_LABELS,
    });
  }
  if (u.pathname === '/api/season-rules' && req.method === 'POST') {
    let body = '';
    let over = false;
    req.on('data', (c) => { body += c; if (body.length > 1e6) { over = true; req.destroy(); } });
    req.on('end', () => {
      try {
        if (over) return sendJson(res, { ok: false, error: '请求过大' }, 413);
        const input = JSON.parse(body || '{}');
        const clean = {};
        for (const k of season.RULE_ORDER) {
          const arr = Array.isArray(input.rules ? input.rules[k] : null) ? input.rules[k] : [];
          const seen = new Set();
          clean[k] = arr.map(x => String(x || '').trim()).filter(x => x && !seen.has(x) && seen.add(x));
        }
        season.saveRules(clean);
        const rebuilt = rebuildAllRanges();
        log('季节关键词规则已保存，重算档位：', rebuilt.join(',') || '无');
        sendJson(res, { ok: true, rebuilt, rules: clean });
      } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }
  // ---------------- 季节来源诊断（确认各门店的季节到底取自哪个档案） ----------------
  if (u.pathname === '/api/season-sources') {
    let src = [];
    let mode = null, threshold = null;
    for (const k of ['today', 'thisMonth', 'yesterday', 'thisWeek', 'lastMonth']) {
      const snap = snapshots.get(k) || loadCache(k);
      const meta = snap && snap.payload && snap.payload.seasonTable && snap.payload.seasonTable.meta;
      if (meta && Array.isArray(meta.sources) && meta.sources.length) {
        src = meta.sources; mode = meta.mode; threshold = meta.threshold; break;
      }
    }
    return sendJson(res, {
      ok: true, sources: src, mode, threshold,
      labels: season.SOURCE_LABELS,
      fields: season.loadFields(),
      fieldLabels: season.FIELD_LABELS,
    });
  }
  // ---------------- 季节明细追溯：点表里的数字，看它背后是哪些商品、读了哪个字段 ----------------
  if (u.pathname === '/api/season-detail') {
    const out = seasonDetail(
      u.searchParams.get('range') || 'thisMonth',
      u.searchParams.get('store') || 'all',
      u.searchParams.get('group') || '',
      u.searchParams.get('season') || 'none',
      Math.min(Number(u.searchParams.get('limit')) || 60, 300),
    );
    return sendJson(res, out);
  }
  if (u.pathname === '/api/doctor') {
    return runDoctor().then(r => sendJson(res, Object.assign({ ok: r.ok }, r)));
  }
  // ---------------- 屏保（见 lib/saver.js，免管理员、结果真实） ----------------
  if (u.pathname === '/api/saver/status') {
    const st = saver.state();
    return sendJson(res, {
      ok: true,
      // 兼容旧字段
      installed: st.isOurs, target: st.target, sea: st.sea,
      saverMode: SAVER_MODE, running: saverState.pid > 0,
      enabled: st.isOurs && st.active,
      current: st.current, currentIsOurs: st.isOurs, systemActive: st.active,
      timeoutSec: st.timeoutSec, secure: st.secure, systemCopy: st.systemCopy,
      apply: st.appliedImmediately, error: st.error,
    });
  }
  if (u.pathname === '/api/saver/enable' && req.method === 'POST') {
    readBody(req, 32 * 1024).then((s) => {
      let p = {};
      try { p = JSON.parse(s || '{}'); } catch (e) { p = {}; }
      const r = saver.enable(p.minutes);
      log('屏保：启用', JSON.stringify(r));
      sendJson(res, r.ok ? r : { error: r.error });
    });
    return;
  }
  if (u.pathname === '/api/saver/minutes' && req.method === 'POST') {
    readBody(req, 32 * 1024).then((s) => {
      let p = {};
      try { p = JSON.parse(s || '{}'); } catch (e) { p = {}; }
      const r = saver.setMinutes(p.minutes);
      sendJson(res, r);
    });
    return;
  }
  if (u.pathname === '/api/saver/disable' && req.method === 'POST') {
    const r = saver.disable();
    log('屏保：停用', JSON.stringify(r));
    sendJson(res, r);
    return;
  }
  // 清理旧版本留在 System32 的副本（需要管理员，失败不致命）
  if (u.pathname === '/api/saver/cleanup' && req.method === 'POST') {
    const r = saver.removeSystemCopy();
    log('屏保：清理旧副本', JSON.stringify(r));
    sendJson(res, r);
    return;
  }
  if (u.pathname === '/api/saver/settings' && req.method === 'POST') {
    const r = saver.openSettings();
    sendJson(res, r);
    return;
  }
  if (u.pathname === '/api/saver/start' && req.method === 'POST') {
    const r = startKiosk(ACTIVE_PORT);
    log('屏保：启动全屏窗口', JSON.stringify(r));
    return sendJson(res, r);
  }
  if (u.pathname === '/api/saver/register' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const pid = Number(JSON.parse(body || '{}').pid) || 0;
        if (pid) registeredPids.add(pid);
        sendJson(res, { ok: true, pids: [...registeredPids] });
      } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }
  // 屏保退出：移动鼠标 / 按键时由页面调用，关闭全屏窗口
  if (u.pathname === '/api/saver/exit') {
    const pids = [...registeredPids];
    registeredPids.clear();
    for (const pid of pids) killPid(pid);
    if (saverState.pid) { killPid(saverState.pid); saverState.pid = 0; }
    log('屏保：退出，关闭窗口', JSON.stringify(pids));
    sendJson(res, { ok: true });
    // 本进程是屏保拉起来的服务 → 一起退出；复用已有服务时保持服务运行
    if (saverState.owned) setTimeout(() => process.exit(0), 300);
    return;
  }
  // ---------------- 抓取策略：营业时段 / 刷新频率 / 对外限速 ----------------
  if (u.pathname === '/api/fetch-policy' && req.method === 'GET') {
    const p = fetchPolicy.load();
    return sendJson(res, {
      ok: true, ...p, defaults: fetchPolicy.DEFAULTS,
      stats: fetchPolicy.statsView(), open: fetchPolicy.isOpen(new Date()),
    });
  }
  if (u.pathname === '/api/fetch-policy' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const input = JSON.parse(body || '{}');
        const saved = fetchPolicy.save(input);
        log('抓取策略已保存：', JSON.stringify(saved));
        sendJson(res, { ok: true, ...saved });
      } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }
  // ---------------- 季节判定口径（没有明细季节的大类是否并入未分类） ----------------
  if (u.pathname === '/api/season-mode' && req.method === 'GET') {
    return sendJson(res, { ok: true, ...season.loadMode(), defaults: season.DEFAULT_MODE });
  }
  if (u.pathname === '/api/season-mode' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const input = JSON.parse(body || '{}');
        const saved = season.saveMode(input);
        const rebuilt = rebuildAllRanges();
        log('季节判定口径已保存：', JSON.stringify(saved), '重算档位：', rebuilt.join(',') || '无');
        sendJson(res, { ok: true, ...saved, rebuilt });
      } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }
  // ---------------- 季节字段白名单（只认哪些档案字段里填的季节） ----------------
  if (u.pathname === '/api/season-fields' && req.method === 'GET') {
    return sendJson(res, { ok: true, fields: season.loadFields(), labels: season.FIELD_LABELS, defaults: season.DEFAULT_FIELDS });
  }
  if (u.pathname === '/api/season-fields' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const input = JSON.parse(body || '{}');
        const saved = season.saveFields(input.fields || input);
        const rebuilt = rebuildAllRanges();
        log('季节字段白名单已保存：', JSON.stringify(saved), '重算档位：', rebuilt.join(',') || '无');
        sendJson(res, { ok: true, fields: saved, rebuilt });
      } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }
  serveStatic(req, res, u.pathname);
});

// ---------------- 启动 ----------------
function openBrowser(port) {
  if (process.env.NO_OPEN) return;
  const url = `http://localhost:${port}`;
  const cmd = process.platform === 'win32' ? `start "" ${url}`
    : process.platform === 'darwin' ? `open ${url}`
      : `xdg-open ${url}`;
  exec(cmd, { shell: process.platform === 'win32' ? 'cmd.exe' : undefined }, (e) => {
    if (e) log('打开浏览器失败：', e.message);
  });
}

/** 探测端口上是否已经有本程序在服务 */
function probeExisting(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(!!(JSON.parse(body) && JSON.parse(body).accounts)); } catch (e) { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** 在常用端口区间里找一个「已经在跑」的大屏实例：端口顺延过也能找到，避免反复起新实例 */
async function probeExistingPort() {
  for (let p = BASE_PORT; p < BASE_PORT + 11; p++) {
    if (await probeExisting(p)) return p;
  }
  // 兜底：上次记录的端口
  try {
    const f = path.join(DATA_DIR, 'port.json');
    if (fs.existsSync(f)) {
      const o = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (o && Number(o.port) > 0 && await probeExisting(Number(o.port))) return Number(o.port);
    }
  } catch (e) { }
  return 0;
}

/** 询问已有实例的版本（拿不到就返回 null） */
function askExistingVersion(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 3000 }, (res) => {
      let s = '';
      res.on('data', d => s += d);
      res.on('end', () => { try { const j = JSON.parse(s); resolve({ version: j.version || '', build: j.build || '' }); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (e) { } resolve(null); });
  });
}

/** 让旧实例自己退干净（它有 /api/shutdown，会关服务再退出） */
function askExistingShutdown(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/shutdown', method: 'POST', timeout: 4000 }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', () => resolve());
    req.on('timeout', () => { try { req.destroy(); } catch (e) { } resolve(); });
    req.end();
  });
}

function banner() {
  const line = '='.repeat(52);
  console.log(line);
  console.log('  王子鞋服经营数据大屏  —— 服务已启动');
  console.log('  请勿关闭本窗口，关闭后大屏将无法刷新数据');
  console.log(line);
}

/**
 * 自动抓取的节拍器（每 60 秒评估一次，真正抓不抓由策略说了算）：
 *   ① 闭店时段一律不联网，只呈现最后一份数据
 *   ② 「今日」按营业时段间隔刷新（默认 5 分钟）
 *   ③ 历史档（昨日 / 本周 / 本月）每天只拉一次，上月按策略天数
 * 真正发请求的活儿仍由 collectQueue 串行排队，绝不会几个档一起上。
 */
let lastHistoryDay = '';
function startTimers() {
  setInterval(tickAutoFetch, 60 * 1000);
  tickAutoFetch();
}

function tickAutoFetch() {
  const P = fetchPolicy.load();
  const now = new Date();
  if (!fetchPolicy.autoAllowed(now, P)) return;      // 闭店静默：不碰厂家服务器
  ensureFresh('today', false, scopeForBackground());
  const day = fetchPolicy.dayStr(now);
  if (lastHistoryDay === day) return;                // 历史档今天已经安排过了
  lastHistoryDay = day;
  log(`开始今日历史档抓取（每天一次）：${RANGES.filter(k => k !== 'today').join(' / ')}`);
  // 门店电脑上只续本店，别把别家的经营数据拉到门店机器上来
  const scope = scopeForBackground();
  for (const k of RANGES.filter(x => x !== 'today')) ensureFresh(k, false, scope);
}

function listenWithFallback(port, tries = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 10) {
      log(`端口 ${port} 被其他程序占用，尝试 ${port + 1}`);
      return listenWithFallback(port + 1, tries + 1);
    }
    log('启动失败：', e.code || '', e.message);
    alertBox(`大屏启动失败：${e.message}\n\n请查看 exe 旁的「运行日志.txt」。`, '王子鞋服经营数据大屏');
    process.exit(1);
  });
  // 必须监听 0.0.0.0：单店要用 http://<本机IP>:端口 访问，只绑 127.0.0.1 局域网连不上
  server.listen(port, '0.0.0.0', () => {
    ACTIVE_PORT = port;
    // 记下真实端口：下次启动/守护先按这个端口找，避免重复起实例导致端口一路顺延
    try { fs.writeFileSync(path.join(DATA_DIR, 'port.json'), JSON.stringify({ port, pid: process.pid, at: Date.now() }), 'utf8'); } catch (e) { }
    log('王子鞋服经营数据大屏已启动');
    log(`本机访问： http://localhost:${port}`);
    const ips = localIPs();
    for (const ip of ips) log(`局域网访问： http://${ip}:${port}`);
    log(`门店数：${accounts().length}（配置：${branches.FILE}${branches.fileExists() ? ' 已存在' : ' 暂未生成，界面保存门店后自动创建'}）`);
    log(`数据目录： ${DATA_DIR}`);
    log('取数方式：后台直连零售云平台拉数，无需人工登录零售云平台');
    log(`大屏登录：${auth.authEnabled() ? '已设管理员口令，改设置/门店需登录（看数据始终免登录）' : '未设口令，看数据、改设置都免登录（可在「账号」页签设一个）'}`);
    if (port !== BASE_PORT) log(`注意：默认端口 ${BASE_PORT} 被占用，已改用 ${port}`);
    log('运行方式：后台静默运行，无任务栏窗口、无右下角图标（开机自启 + 计划任务守护保证随时有数据）');
    // 开机自启 + 后台守护：这是「随时能拿到数据」的主要保障
    ensureKeeper();
    writeEntryShortcuts();
    // 用已缓存的原始数据重算一遍：升级后新增的字段（如各门店自己的实时明细）
    // 要靠这一步补上，避免旧快照缺字段导致新页面显示为空
    rebuildAllRanges();
    banner();
    if (IS_SEA && process.platform === 'win32') {
      try { execSync('title 王子鞋服经营数据大屏 - 服务运行中（请勿关闭）', { shell: 'cmd.exe', windowsHide: true }); } catch (e) { }
    }
    // 首屏优先：先把「今日」抓出来给用户看，其余档位在后台慢慢补齐
    // 守护模式（--guard）只负责把服务拉起来，不弹浏览器打扰正在用电脑的人
    if (IS_SEA && !SAVER_FULL && !GUARD) openBrowser(port);
    // 启动不再无条件重抓：只有「从没抓过」才真正联网（页面不能一片空白），
    // 否则直接复用快照先出画面，剩下的交给节拍器按营业时段与每日一次的策略去续。
    const coldStart = !snapshots.get('today');
    const kick = coldStart ? ensureFresh('today', false) : Promise.resolve();
    loadYearly();
    kick.finally(() => {
      startTimers();
      warmupOtherRanges();
      // 年度月度数据跟主档位走独立的轻量通道，放在首屏之后错峰起一次（每天一次）。
      // 早先它是 setImmediate 立即起跑，冷启动时会跟首屏抢限速令牌，拖慢出数。
      refreshYearly(false).catch(() => { });
    });
    // 自动检查更新（每天一次）：放在首屏之后，别跟取数抢启动节奏
    if (!GUARD && !SAVER_FULL) scheduleAutoUpdate();
    // 上次自动更新到底成了没：版本对得上就收尾，对不上就记失败，避免天天重试
    const applied = updater.noteApplied();
    if (applied) log(applied.ok ? `更新完成，当前 v${applied.version}` : '上次更新未完成：' + applied.error);
  });
}

/**
 * 启动后延迟一会儿再查更新：先让首屏数据出来，别跟取数抢网络。
 * 每天只自动查一次；查到新版就走全自动（下载完退出，脚本换文件再拉起）。
 */
function scheduleAutoUpdate() {
  const t = setTimeout(() => {
    updater.autoCheckIfNeeded({ autoInstall: true }).then((r) => {
      if (!r || r.skipped) return;
      if (!r.ok) { log('自动检查更新失败：', r.error || ''); return; }
      if (!r.hasUpdate) { log('自动检查更新：已是最新版本'); return; }
      log(`自动检查更新：发现 v${r.latest.version}（源：${(r.latest || {}).sourceLabel || r.source}）`);
      const ins = r.install || {};
      if (ins.ok && ins.needExit) {
        log(`更新包 v${ins.version} 已就绪，主程序退出，交给安装脚本接管`);
        const a = updater.launchApplier();
        log(a.ok ? `安装脚本已启动（pid ${a.pid}）` : '启动安装脚本失败：' + a.error);
        if (!a.ok) return;
        setTimeout(() => { try { server.close(); } catch (e) { } process.exit(0); }, 800);
      } else if (!ins.ok) {
        log('自动更新失败：', ins.error || '未知原因');
      }
    }).catch(e => log('自动检查更新异常：', String(e.message || e)));
  }, 30000);
  if (t.unref) t.unref();
}

/** 把自己转成一个无窗口的后台进程（优先用 Node 自启，不依赖 PowerShell 策略） */
function relaunchHidden() {
  if (process.platform !== 'win32') return false;
  if (process.env.DASH_HIDDEN === '1') return false;
  const exe = process.execPath;
  const args = IS_SEA ? process.argv.slice(1) : [path.join(ROOT, 'server.js')].concat(GUARD ? ['--guard'] : []);
  const wd = IS_SEA ? path.dirname(exe) : ROOT;
  try {
    const child = spawn(exe, args, {
      detached: true, stdio: 'ignore', windowsHide: true, cwd: wd,
      env: Object.assign({}, process.env, { DASH_HIDDEN: '1' }),
    });
    child.unref();
    return true;
  } catch (e) { log('后台启动失败：', e.message); return false; }
}

// ---------------- 开机自启 + 后台守护 ----------------
// 一个开关管两件事：启动文件夹快捷方式（开机自启）+ 计划任务（崩溃/被关后 5 分钟内自己回来）
function appExe() { return IS_SEA ? process.execPath : path.join(ROOT, '王子鞋服经营数据大屏.exe'); }
function keeperOpt() {
  const exe = appExe();
  return { dataDir: DATA_DIR, exe, wd: path.dirname(exe) };
}
let keeperCache = null, keeperCacheAt = 0;
function keeperStatusCached() {
  // 计划任务查询要走 PowerShell，别让每次刷新页面都去跑一遍
  if (keeperCache && Date.now() - keeperCacheAt < 20000) return keeperCache;
  keeperCache = keeper.keeperStatus(keeperOpt());
  keeperCacheAt = Date.now();
  return keeperCache;
}
function ensureKeeper() {
  if (process.platform !== 'win32') return;
  const cfg = keeper.readCfg(DATA_DIR);
  // 没手动关过就默认开启：这是「随时能拿到数据」的兜底
  if (cfg.on === false) { log('开机自启与后台守护：已由用户关闭'); return; }
  setTimeout(() => {
    try {
      const st = keeperStatusCached();
      if (st.task && st.startup) return;
      const r = keeper.setKeeper(true, keeperOpt());
      keeperCache = r; keeperCacheAt = Date.now();
      log(`已开启开机自启与后台守护（计划任务 ${r.task ? '已建' : '未建'}，启动项 ${r.startup ? '已建' : '未建'}）${r.error ? ' 备注：' + r.error : ''}`);
    } catch (e) { log('设置开机自启/守护失败：', e.message); }
  }, 3000);
}

// ---------------- 门店自助管理（以后新增门店不用改代码） ----------------
// 每个门店的取数状态取自最近一次原始快照，新增门店后不用猜配置对不对
function tenantStatusMap() {
  const m = new Map();
  for (const k of ['today', 'yesterday', 'thisMonth', 'thisWeek', 'lastMonth']) {
    try {
      const f = path.join(DATA_DIR, `raw-${k}.json`);
      if (!fs.existsSync(f)) continue;
      const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!Array.isArray(arr)) continue;
      for (const t of arr) {
        const c = String((t && t.tenantCode) || '');
        if (!c || m.has(c)) continue;
        m.set(c, { ok: !!(t && t.ok), error: String((t && t.error) || ''), updatedAt: Number(t && t.fetchedAt) || 0 });
      }
    } catch (e) { }
  }
  return m;
}
let cfgMtime = 0;
/** 有人直接用记事本改了 exe 旁的 config.json —— 检测文件变化自动接管 */
function autoReloadConfig() {
  try {
    if (!branches.fileExists()) return;
    const m = fs.statSync(branches.FILE).mtimeMs;
    if (!cfgMtime) { cfgMtime = m; return; }
    if (m !== cfgMtime) {
      cfgMtime = m;
      const before = accounts().length;
      branches.reload();
      log(`检测到 config.json 被修改，已重新加载门店：${before} → ${accounts().length}`);
      // 已删掉门店的会话文件顺手清掉，下次加同名门店时不会顶着一个过期会话
      const known = new Set(accounts().map(a => String(a.tenantCode)));
      try {
        for (const n of fs.readdirSync(DATA_DIR)) {
          const mm = /^session-([A-Za-z0-9_-]+)\.json$/.exec(n);
          if (mm && !known.has(mm[1])) { try { fs.unlinkSync(path.join(DATA_DIR, n)); } catch (e) { } }
        }
      } catch (e) { }
      writeEntryShortcuts();
      ensureFresh('today', true);
    }
  } catch (e) { }
}
function branchView() {
  autoReloadConfig();
  const st = tenantStatusMap();
  return { ok: true, file: branches.FILE, exists: branches.fileExists(), items: branches.publicList(c => st.get(String(c))) };
}
/** 门店数量变化后：清理它的会话与旧数据，避免删掉的店还在图上显示 */
function purgeTenant(code) {
  const c = String(code);
  const rebuilt = [];
  for (const k of RANGES) {
    try {
      const f = path.join(DATA_DIR, `raw-${k}.json`);
      let arr = null;
      if (fs.existsSync(f)) {
        arr = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (Array.isArray(arr)) {
          const kept = arr.filter(t => String(t && t.tenantCode) !== c);
          if (kept.length !== arr.length) { arr = kept; fs.writeFileSync(f, JSON.stringify(kept), 'utf8'); }
        }
      }
      if (Array.isArray(arr) && arr.length) {
        const prev = snapshots.get(k) || loadCache(k);
        const rec = {
          payload: build(arr, k, { updatedAt: Date.now(), seasonMap: season.loadMap() }),
          updatedAt: Date.now(), startedAt: prev ? prev.startedAt : Date.now(), status: 'ok', error: null, builtBy: BUILD_TAG,
        };
        snapshots.set(k, rec); saveCache(k, rec); rebuilt.push(k);
      } else {
        snapshots.delete(k);
        try { if (fs.existsSync(cacheFile(k))) fs.unlinkSync(cacheFile(k)); } catch (e) { }
      }
    } catch (e) { log('purge', k, e.message); }
  }
  try { const sf = path.join(DATA_DIR, `session-${c}.json`); if (fs.existsSync(sf)) fs.unlinkSync(sf); } catch (e) { }
  return rebuilt;
}
/** 新增/改配置后立刻补一轮：今日先出，其余档位后台排队 */
function adoptBranchChanges(code, action) {
  log(`门店配置变更：${action} ${code}`);
  try { writeEntryShortcuts(); } catch (e) { }
  ensureFresh('today', true);
  // 其余档位的快照里没有这家新店，标记失效后交给预热重抓
  for (const k of RANGES) {
    if (k === 'today') continue;
    const snap = snapshots.get(k);
    if (snap) snap.updatedAt = 0;
    else { const c = loadCache(k); if (c) { c.updatedAt = 0; snapshots.set(k, c); } }
  }
  ensureFresh('today', true).finally(() => warmupOtherRanges());
}

// ---------------- 各门店独立入口 ----------------
// 总部一个总入口，每个门店一个自己的入口：打开即锁定本店，看不到别家店的数据
function storeEntries() {
  const base = snapshots.get('today') || snapshots.get('thisMonth') || loadCache('today') || loadCache('thisMonth');
  const list = ((base && base.payload && base.payload.stores) || []).map(s => ({ key: String(s.key), name: s.name }));
  if (!list.length) return accounts().map(a => ({ key: String(a.tenantCode), name: a.alias || String(a.tenantCode) }));
  return list;
}
function baseUrls() {
  const port = ACTIVE_PORT || BASE_PORT;
  const ips = localIPs();
  return {
    port,
    local: `http://localhost:${port}/`,
    lan: ips.map(ip => `http://${ip}:${port}/`),
    ips,
  };
}
function urlOf(base, key) { return base + (key ? `?store=${encodeURIComponent(key)}` : ''); }
function entriesView(me) {
  const b = baseUrls();
  const primary = b.lan[0] || b.local;
  const all = [{ key: '', name: '全部门店（总部）' }].concat(storeEntries());
  // 门店账号只给自己的入口；管理员拿到全部
  const scoped = (me && me.role !== 'admin' && me.storeKey)
    ? all.filter(s => String(s.key) === String(me.storeKey))
    : all;
  const entries = scoped.map(s => ({
      key: s.key, name: s.name,
      url: urlOf(primary, s.key),
      local: urlOf(b.local, s.key),
      lan: b.lan.map(u => urlOf(u, s.key)),
    }));
  return { ok: true, port: b.port, ips: b.ips, primary, entries };
}
/** 生成一个 .url 快捷方式（双击直接用默认浏览器打开对应门店的大屏） */
function createShortcut(key, to) {
  const list = storeEntries();
  const s = key === '' ? { key: '', name: '全部门店（总部）' } : list.find(x => String(x.key) === String(key));
  if (!s) return { ok: false, error: '找不到这个门店' };
  const b = baseUrls();
  const url = urlOf(b.lan[0] || b.local, s.key);
  const safe = String(s.name).replace(/[\\/:*?"<>|]/g, '_').trim() || '门店';
  let dir;
  if (to === 'desktop') {
    dir = path.join(os.homedir() || process.env.USERPROFILE || '', 'Desktop');
    if (!dir || !fs.existsSync(dir)) dir = path.join(os.homedir() || '', 'OneDrive', 'Desktop');
    if (!dir || !fs.existsSync(dir)) dir = path.dirname(appExe());
  } else {
    dir = path.join(path.dirname(appExe()), '门店入口');
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: '目录创建失败：' + e.message }; }
  const file = path.join(dir, `大屏-${safe}.url`);
  try {
    fs.writeFileSync(file, `[InternetShortcut]\r\nURL=${url}\r\n`, 'utf8');
    log(`已生成入口快捷方式：${file} → ${url}`);
    return { ok: true, file, url };
  } catch (e) { return { ok: false, error: e.message }; }
}
/** 启动时顺手把「门店入口」目录刷新一遍（局域网 IP 可能变） */
function writeEntryShortcuts() {
  try {
    const v = entriesView();
    const dir = path.join(path.dirname(appExe()), '门店入口');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
    for (const e of v.entries) {
      const safe = String(e.name).replace(/[\\/:*?"<>|]/g, '_').trim() || '门店';
      try { fs.writeFileSync(path.join(dir, `大屏-${safe}.url`), `[InternetShortcut]\r\nURL=${e.url}\r\n`, 'utf8'); } catch (err) { }
    }
    log(`已生成 ${v.entries.length} 个门店入口：${dir}`);
  } catch (e) { }
}

// ---------------- 大屏背景图 ----------------
const BG_RE = /^bg\.(png|jpg|jpeg|webp|gif)$/i;
const BG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
function bgFile() {
  try {
    for (const f of fs.readdirSync(DATA_DIR)) if (BG_RE.test(f)) return path.join(DATA_DIR, f);
  } catch (e) { }
  return '';
}
function bgUrl() {
  const f = bgFile();
  if (!f) return '';
  try { return '/api/background/image?t=' + fs.statSync(f).mtimeMs; } catch (e) { return '/api/background/image'; }
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 屏保：把全屏窗口拉起来，并盯住它，窗口关掉后本进程也退出 */
function runScreensaver(port) {
  const r = startKiosk(port);
  if (!r.ok) { log('屏保启动失败：', r.error); alertBox(`屏保启动失败：${r.error}`, '王子鞋服经营数据大屏'); process.exit(0); return; }
  log('屏保已启动：', r.browser, r.url, 'pid', r.pid);
  startWatchdog(process.pid, r.pid);
  const started = Date.now();
  const timer = setInterval(() => {
    // 兜底：最长运行 8 小时自动退出，避免异常时一直占着屏幕
    if (Date.now() - started > 8 * 3600 * 1000) { killPid(saverState.pid); process.exit(0); }
  }, 60000);
  timer.unref && timer.unref();
}

/**
 * 安装器模式：进程是「刚解压出来的新版本」，运行在 update 临时目录里。
 * 它和安装目录里的旧 exe 是两条不同路径，所以可以直接把旧的那份覆盖掉。
 */
async function runApplyUpdate() {
  const jobFile = process.env.DASH_UPDATE_JOB || path.join(DATA_DIR, 'update', 'job.json');
  let job = null;
  try { job = JSON.parse(fs.readFileSync(jobFile, 'utf8')); } catch (e) {
    log('安装任务读取失败：' + (e.message || e));
    setTimeout(() => process.exit(1), 200);
    return;
  }
  const srcExe = path.join(job.src, job.exeName);
  const dstExe = path.join(job.home, job.exeName);
  log(`安装器启动：v${job.from} → v${job.ver}，目标 ${job.home}`);
  // 1) 等旧实例把端口让出来（它收到交棒后会自己退出）
  for (let i = 0; i < 60; i++) {
    if (!(await probeExistingPort())) break;
    await new Promise(r => setTimeout(r, 500));
  }
  await new Promise(r => setTimeout(r, 900));
  // 2) 换文件：主程序 + 说明文档（不含 config.json / data）
  try {
    fs.copyFileSync(fs.existsSync(srcExe) ? srcExe : process.execPath, dstExe);
    log('主程序已替换');
    for (const f of (job.docs || [])) {
      const s = path.join(job.src, f);
      if (fs.existsSync(s)) { try { fs.copyFileSync(s, path.join(job.home, f)); } catch (e) { } }
    }
  } catch (e) {
    // 换不动就把旧版本留在原地：大屏还是能开，只是没升上去
    log('替换文件失败：' + (e.message || e) + '（当前版本未受影响）');
  }
  // 3) 拉起新版本（清掉安装器专用的环境变量，让它按正常方式启动）
  try {
    const env = Object.assign({}, process.env);
    delete env.DASH_HOME_LOCK;
    delete env.DASH_UPDATE_JOB;
    const c = spawn(dstExe, [], { detached: true, stdio: 'ignore', cwd: job.home, windowsHide: true, env });
    c.unref();
    log('已启动新版本');
  } catch (e) { log('启动新版本失败：' + (e.message || e)); }
  setTimeout(() => process.exit(0), 400);
}

async function main() {
  if (APPLY_UPDATE) { await runApplyUpdate(); return; }
  // --doctor：只做环境自检，不启动服务（换电脑部署时用）
  if (DOCTOR) { await doctorCli(); return; }
  // /c 配置：只弹一个说明框
  if (SAVER_CFG) {
    alertBox('王子鞋服经营数据大屏（屏保）\n\n'
      + '这是本程序的屏保画面，不需要单独配置。\n\n'
      + '· 想改结束时的样子（界面风格、门店范围），双击 exe 正常打开大屏去设置\n'
      + '· 想改等待时间或停用屏保：双击 exe 打开大屏 → 设置 → 运行 → 屏保设置',
      '王子鞋服经营数据大屏 · 屏保');
    setTimeout(() => process.exit(0), 300);
    return;
  }
  if (SAVER_PREVIEW) { setTimeout(() => process.exit(0), 300); return; }

  if (SAVER_FULL) {
    if (relaunchHidden()) { setTimeout(() => process.exit(0), 300); return; }   // 交给隐藏后的子进程
    saverState.owned = true;
    log('以屏保模式启动（全屏）');
  } else if (relaunchHidden()) {
    // 正常双击：把自己转成一个无窗口的后台进程（右下角托盘显示），
    // 任务栏上就不会出现能被随手关掉的黑窗口。
    // 这里必须等到后台进程真的接管了端口才退出自己，否则万一转不起来
    // （组策略限制、权限问题等）就变成双击后毫无反应。
    let up = 0;
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 400));
      up = await probeExistingPort();
      if (up) break;
    }
    if (up) { setTimeout(() => process.exit(0), 200); return; }
    log('后台进程未能接管端口，改为在当前窗口继续运行');
  }

  let existingPort = await probeExistingPort();
  if (existingPort && !GUARD && !SAVER_FULL) {
    // 双击新版时如果端口上还是旧版本在跑，自动让旧版退出、新版接管 ——
    // 否则用户换新 exe 后「打开了但页面还是旧的」，怎么刷新都不对
    const st = await askExistingVersion(existingPort);
    if (st && (st.version !== APP_VERSION || st.build !== BUILD)) {
      log(`端口 ${existingPort} 上是旧版本 v${st.version}/${st.build}，通知它退出，由新版 v${APP_VERSION}/${BUILD} 接管`);
      await askExistingShutdown(existingPort);
      let freed = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (!(await probeExistingPort())) { freed = true; break; }
      }
      if (freed) {
        log('旧实例已退出，新版开始接管端口');
        existingPort = 0;   // 落到下面的正常启动流程
      } else {
        log('旧实例未能退出，继续沿用旧实例');
      }
    }
  }
  if (existingPort) {
    log(`端口 ${existingPort} 上已有大屏在运行，直接复用（不会再开一个新实例）`);
    if (GUARD) {
      // 守护检查：服务好好的，什么都不用做，静默退出（不弹浏览器）
      setTimeout(() => process.exit(0), 200);
      return;
    }
    if (SAVER_FULL) {
      // 复用已有服务：注册窗口进程号，页面退出时由服务关掉窗口
      const r = startKiosk(existingPort);
      if (!r.ok) { log('屏保启动失败：', r.error); process.exit(0); return; }
      try {
        await new Promise((resolve) => {
          const body = JSON.stringify({ pid: r.pid });
          const req = http.request({ host: '127.0.0.1', port: existingPort, path: '/api/saver/register', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', resolve); });
          req.on('error', resolve);
          req.end(body);
        });
      } catch (e) { }
      startWatchdog(process.pid, r.pid);
      log('屏保已启动（复用已有服务）：', r.url);
      // 窗口被关掉后本机屏保进程随之退出
      const watch = setInterval(() => {
        try { execSync(`tasklist /FI "PID eq ${r.pid}" /NH`, { stdio: 'ignore', windowsHide: true }); } catch (e) { }
      }, 30000);
      watch.unref && watch.unref();
      return;
    }
    openBrowser(existingPort);
    setTimeout(() => process.exit(0), 2000);
    return;
  }
  if (SAVER_FULL) {
    // 自己起服务，等服务就绪后拉起全屏窗口
    server.once('listening', () => setTimeout(() => runScreensaver(ACTIVE_PORT), 600));
  }
  listenWithFallback(BASE_PORT);
}

process.on('uncaughtException', (e) => {
  log('未捕获异常：', (e && e.stack) || e);
  if (IS_SEA) alertBox(`程序遇到错误，即将退出：\n${e && e.message}\n\n详情见「运行日志.txt」`, '王子鞋服经营数据大屏');
  process.exit(1);
});
process.on('unhandledRejection', (e) => log('未处理的 Promise 异常：', (e && e.stack) || e));

if (require.main === module) main();
module.exports = { server, refresh, snapshotView };
