'use strict';
// 王子鞋服经营数据大屏前端
const state = {
  range: 'today',
  data: null,
  payload: null,
  countdown: 60,
  seasonStore: 'all', // 季节表门店选择：'all' = 所有门店汇总
  catStore: 'all',    // 大类数量表门店选择
  // 查看范围：'' = 总部看全部；否则为某个门店 key（单店只看自己）
  store: '',
  storeOptions: [],
  // 自动轮播：实时 → 昨天 → 本周 → 本月 → 上月（默认关闭，需要无人值守时再在界面设置里开）
  auto: false,
  autoIdx: 0,
  autoLeft: 15,
  // 表头排序（点击列头切换升/降序，默认从多到少）
  matrixSort: { col: 'total', dir: 'desc' },
  catSort: { col: 'sale', dir: 'desc' },
  // 登录信息：null=未登录（或未设密码的游客），{username,name,role,storeKey}
  me: null,
  loginRequired: false,
};

const RANGE_CYCLE = ['today', 'yesterday', 'thisWeek', 'thisMonth', 'lastMonth'];
const AUTO_SEC = 15; // 每档停留秒数
const AUTO_KEY = 'dash-auto'; // 自动轮播开关（默认关，开了会记住）

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });

function money(v) { return nf.format(Number(v) || 0); }
function moneyShort(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 10000) return (n / 10000).toFixed(2) + '万';
  return nf.format(n);
}
function num0(v) { return nf0.format(Number(v) || 0); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function tickClock() {
  const d = new Date();
  $('clockTime').textContent = d.toLocaleTimeString('zh-CN', { hour12: false });
  $('clockDate').textContent = d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
}
setInterval(tickClock, 1000); tickClock();

// ---------------- 登录：设了管理员密码才需要；登录一次本机记住 ----------------
function isAdmin() { return !state.me || state.me.role === 'admin'; }
function apiUrl(p) { return p; } // fetch 同源请求自动带 cookie，无需手工拼 token
async function loadAuthState() {
  try { return await fetch('/api/auth/state', { cache: 'no-store' }).then(r => r.json()); }
  catch (e) { return null; }
}
function renderAuthBtn() {
  const b = $('btnAuth');
  if (!b) return;
  if (state.me) {
    const nm = state.me.role === 'admin' ? '管理员' : (state.me.name || state.me.username);
    b.textContent = nm + ' · 退出';
    b.title = '点此退出登录';
  } else {
    b.textContent = '登录';
    b.title = '门店登录＝接入新店；管理员＝管理全部门店（看数据本来就不需要登录）';
  }
}
let loginMode = 'store';
function switchLoginMode(m) {
  loginMode = m;
  const s = $('lgPaneStore'), a = $('lgPaneAdmin');
  if (s) s.style.display = m === 'store' ? '' : 'none';
  if (a) a.style.display = m === 'admin' ? '' : 'none';
  for (const b of document.querySelectorAll('#loginModal .tab-btn')) {
    b.classList.toggle('active', b.getAttribute('data-lgmode') === m);
  }
  const t = $('lgTip'); if (t) t.textContent = '';
}
function openLogin(msg, mode) {
  const m = $('loginModal');
  if (!m) return;
  m.style.display = 'flex';
  switchLoginMode(mode || (state.me && state.me.role === 'admin' ? 'admin' : 'store'));
  const t = $('lgTip'); if (t) t.textContent = msg || '';
  const first = loginMode === 'store' ? $('lgTenant') : $('lgAdminPass');
  if (first) setTimeout(() => first.focus(), 50);
}
function closeLogin() { const m = $('loginModal'); if (m) m.style.display = 'none'; }
async function doLogin() {
  const tip = $('lgTip');
  const remember = !$('lgRemember') || $('lgRemember').checked;   // 不勾则关掉浏览器就要重新登录
  let body;
  if (loginMode === 'store') {
    const tenantCode = (($('lgTenant') || {}).value || '').trim();
    const userAccount = (($('lgAccount') || {}).value || '').trim() || '9999';
    const password = (($('lgPass') || {}).value || '');
    if (!tenantCode) { if (tip) tip.textContent = '请填这家店的商户ID'; return; }
    if (!password) { if (tip) tip.textContent = '请填零售云平台密码'; return; }
    body = { mode: 'store', tenantCode, userAccount, password, remember };
    if (tip) tip.textContent = '正在用零售云平台账号验证这家店…';
  } else {
    const username = (($('lgUser') || {}).value || '').trim() || 'admin';
    const password = (($('lgAdminPass') || {}).value || '');
    body = { username, password, remember };
    if (tip) tip.textContent = '正在登录…';
  }
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({ ok: false, error: '服务器返回异常' }));
    if (!j.ok) { if (tip) tip.textContent = '登录失败：' + (j.error || '未知'); return; }
    state.me = j.user;
    // 管理员就是总部视角：登录后回到「全部门店」，别被本机上次选的单店卡住
    // （门店入口链接 ?store=xxx 显式指定的除外，那种场合本来就是想看这一家）
    if (state.me && state.me.role === 'admin' && !state.storeFromUrl && state.store) {
      state.store = '';
      try { localStorage.removeItem(STORE_KEY); } catch (err) { }
    }
    renderAuthBtn();
    applyRoleScope();
    closeLogin();
    load(!!j.tenant);   // 新接入的门店要立刻抓一次
  } catch (e) { if (tip) tip.textContent = '登录失败：' + e.message; }
}
async function doLogout() {
  if (!confirm('退出后这台电脑不再自动登录。\n\n看数据不受影响，仍然打开即看；只是接入门店、改设置要重新登录。\n\n确定退出吗？')) return;
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) { }
  state.me = null;
  renderAuthBtn();
  applyRoleScope();
  load(false);
}
/** 门店账号自动锁定本店，并藏掉管理员才能用的入口 */
function applyRoleScope() {
  const admin = isAdmin();
  if (!admin && state.me && state.me.storeKey) {
    state.store = String(state.me.storeKey);
    try { localStorage.setItem(STORE_KEY, state.store); } catch (e) { }
  }
  syncPanelStores();   // 登录的是哪家店，三大块就跟着看哪家店
  const sel = $('hdrStore'); if (sel) sel.disabled = !admin;
  for (const id of ['btnEntries']) { const el = $(id); if (el) el.style.display = admin ? '' : 'none'; }
  syncuiStoreTabs();
}
/**
 * 界面设置的六个页签（风格 / 屏幕适配 / 背景 / 运行 / 门店 / 账号）一律可见，
 * 登录与否都能打开 —— 屏保、自启、背景这些都是本机设置，不该被登录状态挡住。
 * 真正需要管理员的是「增删门店、改口令、管员工账号」这几个动作，做成按钮级禁用。
 */
function syncuiStoreTabs() {
  for (const t of document.querySelectorAll('#uiModal .tab-btn')) t.style.display = '';
  const admin = isAdmin();
  const gate = (id) => {
    const el = $(id); if (!el) return;
    el.disabled = !admin;
    el.title = admin ? '' : '需要管理员权限：请用管理员账号登录后再操作';
    el.style.opacity = admin ? '' : '.45';
    el.style.cursor = admin ? '' : 'not-allowed';
  };
  ['brSave', 'admSave', 'admReset', 'usSave'].forEach(gate);
  for (const id of ['admPass', 'brCode', 'brUser', 'brPass', 'brAlias', 'usName', 'usDisp', 'usPass', 'usStore']) {
    const el = $(id); if (!el) continue;
    el.disabled = !admin;
    el.style.opacity = admin ? '' : '.6';
  }
  const hint = $('uiRoleHint');
  if (hint) hint.style.display = admin ? 'none' : '';
  // 门店列表里的编辑/停用/删除按钮同样只给管理员
  const bl = $('branchList');
  if (bl) bl.querySelectorAll('button[data-bact]').forEach(b => {
    b.disabled = !admin; b.style.opacity = admin ? '' : '.45';
  });
  const ul = $('userList');
  if (ul) ul.querySelectorAll('button[data-uact]').forEach(b => {
    b.disabled = !admin; b.style.opacity = admin ? '' : '.45';
  });
}
function needAdmin() {
  if (isAdmin()) return true;
  alert('这个操作需要管理员权限。\n\n请点右上角「登录」，用管理员账号登录后重试。');
  return false;
}

// ---------------- 数据加载 ----------------
let loading = false;
let pendingRange = null; // 加载中切换档位时挂起，加载完立即补拉
// peek=1 表示「只读已有快照」，不会让服务端重新抓取（自动轮播切档时使用）
// 版本哨兵：exe 升级（抓取逻辑常跟着变）后，浏览器里开着的旧页面会继续跑旧前端，
// 新逻辑不生效、用户还以为没修（v1.1.15 就遇到过：服务器已是新逻辑，旧页面照显示春夏秋冬）。
// /api/data 每轮都带当前版本，发现和本页加载时的版本不一致，就整体重载一次。
let PAGE_VERSION = null;
let versionReloading = false;
function checkVersion(v) {
  if (!v) return;
  if (PAGE_VERSION === null) { PAGE_VERSION = v; return; }
  if (v !== PAGE_VERSION && !versionReloading) {
    versionReloading = true;
    setStatus('busy', '检测到新版本，正在刷新页面…');
    setTimeout(() => { try { location.reload(); } catch (e) { } }, 800);
  }
}

async function load(force, peek) {
  if (loading) { pendingRange = state.range; return; }
  loading = true;
  setStatus('busy', '同步中…');
  try {
    const qs = ['range=' + state.range]
      .concat(force ? ['force=1'] : [])
      .concat(peek ? ['peek=1'] : [])
      .concat(state.store ? ['store=' + encodeURIComponent(state.store)] : []);
    const res = await fetch('/api/data?' + qs.join('&'), { cache: 'no-store' });
    state.data = await res.json();
    checkVersion(state.data && state.data.version);
    if (state.data && state.data.needLogin) {
      // 看数据不该被登录卡住：这里只提示，数据照常显示
      state.loginRequired = true;
      state.me = null;
      renderAuthBtn();
    }
    state.payload = state.data.payload;
    syncStoreOptions(state.payload);
    render();
    // 'partial' = 冷启动过程中已有一部分门店的数据，先给页面看，别让用户干等白屏
    const st = state.data && state.data.status;
    const ready = !!((st === 'ok' || st === 'partial') && state.data.payload && !state.data.refreshing);
    if (ready) hideBoot();
    const t = new Date(state.data.updatedAt || state.data.serverTime);
    const isPartial = st === 'partial';
    // 阶段一（销售 / 库存 / 实时）已出、阶段二（季节 / 供应商）还在补：说清楚，别让人以为坏了
    const deepPending = !!(state.payload && state.payload.deepPending);
    setStatus(state.data.refreshing || isPartial ? 'busy' : 'ok',
      '数据更新于 ' + (state.data.updatedAt ? t.toLocaleString('zh-CN', { hour12: false }) : '尚未获取')
      + (isPartial ? (deepPending ? '（销售与库存已出，季节 / 供应商后台补数中）' : '（已有门店先出数，其余加载中）') : ''));
    // 该档位还在后台抓取（多半是刚切到还没抓过的档位）：别干等到下一轮 60 秒，
    // 马上起一个短轮询，抓完就自动刷出来。季节 / 供应商后台补数时同理。
    if (!ready || deepPending) startWaitRefresh(); else stopWaitRefresh();
    // 后台自动更新时（下载完会重启一次）要让页面跟着提示，顺便刷新设置面板的更新状态
    upWatch();
  } catch (e) {
    setStatus('err', '无法连接本机服务：' + e.message);
  } finally {
    loading = false;
    state.countdown = Math.round((state.data && state.data.refreshInterval || 60000) / 1000);
    if (pendingRange) { pendingRange = null; load(false); }
  }
}

// 后台抓取中的短轮询：抓完自动补一次渲染（最多等 3 分钟）
let waitTimer = null;
let waitTries = 0;
function startWaitRefresh() {
  if (waitTimer) return;
  waitTries = 0;
  waitTimer = setInterval(() => {
    if (loading) return;
    waitTries++;
    if (waitTries > 72) { stopWaitRefresh(); return; }  // 3 分钟还没好就交回常规轮询
    load(false);
  }, 2500);
}
function stopWaitRefresh() {
  if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
}

// ---------------- 查看范围（总部看全部 / 单店只看自己） ----------------
// 优先级：网址上的 store 参数 > 本机上次选择 > 全部
// 给单店电脑发一个带 ?store=xxx 的链接，打开即锁定本店，报文里不会再出现其他门店的数据
const STORE_KEY = 'dash-store';
function initStore() {
  const q = new URLSearchParams(location.search);
  const fromUrl = q.get('store');
  // 网址里显式带 ?store= 的（门店入口快捷方式）才算「被链接锁定」；
  // 只是本机上次选过的门店不算，管理员登录时可以放它回总部视角
  state.storeFromUrl = fromUrl !== null && !!fromUrl;
  if (fromUrl !== null) {
    state.store = fromUrl;
    try { if (fromUrl) localStorage.setItem(STORE_KEY, fromUrl); else localStorage.removeItem(STORE_KEY); } catch (e) { }
  } else {
    try { state.store = localStorage.getItem(STORE_KEY) || ''; } catch (e) { state.store = ''; }
  }
  syncPanelStores();
}
/**
 * 三大数据块（季节销售与库存 / 各大类销售数量与库存 / 大类×门店矩阵）跟随「当前查看的门店」：
 * 顶部切到哪家店（或登录后锁定到哪家店），这三块就只显示那家店的数据；
 * 切回「全部门店」则回到汇总。避免顶部选了 A 店、表里还是全公司的口径。
 */
function syncPanelStores() {
  const v = state.store ? String(state.store) : 'all';
  state.seasonStore = v;
  state.catStore = v;
}
/**
 * 刷新顶部门店下拉。
 * 管理员视角下服务端会额外给一份「全部门店清单」（allStores），
 * 用它来出选项 —— 否则当前只看某家店时报文里只剩那一家，下拉就再也选不到别的店了。
 * 门店账号没有 allStores，只有自己那一家，符合「分店只能看自己」。
 */
function syncStoreOptions(payload) {
  const all = (state.data && state.data.allStores) || [];
  const list = all.length ? all : ((payload && payload.stores) || []);
  if (!list.length) return;
  const has = list.some(s => String(s.key) === String(state.store));
  // 单店视图下报文里只剩本店，此时把「全部」那一支保留下来供总部切回
  let options = state.storeOptions.length ? state.storeOptions : list.map(s => ({ key: s.key, name: s.name }));
  if (all.length) options = all.map(s => ({ key: s.key, name: s.name }));
  if (state.store && !has) options = options.concat([{ key: state.store, name: (payload && payload.storeName) || state.store }]);
  state.storeOptions = options;
  renderStoreSelect();
}
function renderStoreSelect() {
  const sel = $('hdrStore');
  if (!sel) return;
  const opts = [{ key: '', name: '全部门店（总部）' }].concat(state.storeOptions.map(s => ({ key: s.key, name: s.name })));
  const cur = opts.some(o => String(o.key) === String(state.store)) ? String(state.store) : '';
  sel.innerHTML = opts.map(o => `<option value="${esc(o.key)}"${String(o.key) === cur ? ' selected' : ''}>${esc(o.name)}</option>`).join('');
  // 管理员可自由切换；门店账号锁死在自己那家（服务端也只给它本店的数据）
  const locked = !!(state.me && state.me.role && state.me.role !== 'admin' && state.me.storeKey);
  sel.disabled = locked;
  sel.title = locked ? '门店账号只能看本店数据' : '切换查看的门店';
}

function setStatus(kind, txt) {
  const dot = $('dot');
  dot.className = 'dot' + (kind === 'ok' ? '' : kind === 'busy' ? ' busy' : ' err');
  $('statusTxt').textContent = txt;
}

// ---------------- 渲染 ----------------
function render() {
  const p = state.payload || {};
  const k = p.kpi || {};
  const rangeLabel = (p.range && p.range.label) || '今日实时';
  const beg = p.range && p.range.begin, end = p.range && p.range.end;

  $('rangeTip').textContent = `${rangeLabel}${beg ? '（' + beg + ' 至 ' + end + '）' : ''}`;
  $('kTotal').textContent = money(k.saleAmount);
  $('kQty').textContent = num0(k.saleQty);
  $('kGross').textContent = money(k.grossProfit);
  $('kRate').textContent = (k.grossRate || 0).toFixed(2) + '%';
  $('kCust').textContent = num0(k.customers);
  $('kAvg').textContent = money(k.avgPrice);
  $('kStock').textContent = moneyShort(k.stockCost);
  $('kStores').textContent = num0(k.storeCount);
  $('kOffline').textContent = money(k.offline);
  $('kOnline').textContent = money(k.online);
  $('kMember').textContent = num0(p.realtime && p.realtime.memberCount);

  renderStores(p);

  const rt = p.realtime && p.realtime.updatedAt ? new Date(p.realtime.updatedAt) : null;
  $('rtTip').textContent = rt && !isNaN(rt.getTime()) ? '后台刷新 ' + rt.toLocaleTimeString('zh-CN', { hour12: false }) : '';

  renderMatrix(p);
  fillStoreSelects(p);
  renderSeason(p);
  renderCatQty(p);
  renderYearChart(state.data && state.data.yearly);

  const names = (p.stores || []).map(s => s.name).join(' · ');
  const branchTotal = (p.stores || []).reduce((s, x) => s + (x.branchCount || 0), 0);
  const failed = (p.tenants || []).filter(t => !t.ok);
  const head = state.store ? `【${p.storeName || names}】${names} 的数据` : `${names} · ${(p.stores || []).length} 个门店（含 ${branchTotal} 个分店）`;
  $('subTitle').textContent = head + '自动同步'
    + (failed.length ? ' · ' + failed.length + ' 个账号获取失败' : '');
}

/**
 * 年度月度柱状图（中列底部）：横轴固定 1~12 月（每年从 1 月开始）。
 * 一个月只用一根柱子：整柱高度 = 当月销售额，柱内下段绿色 = 毛利、上段浅蓝 = 成本，
 * 一根柱子同时看出卖了多少钱、赚了多少。
 * 数据来自服务端独立的年度轻量通道，与当前选择的档位无关，换档位时这块图不变。
 */
function renderYearChart(y) {
  const el = $('yearChart');
  if (!el) return;
  const tip = $('yearTip'), sum = $('yearSum');
  if (!y || !Array.isArray(y.months) || !y.months.length) {
    $('yearTitle').textContent = '年度月度销售与毛利';
    if (tip) tip.textContent = '数据整理中';
    if (sum) sum.textContent = '';
    el.innerHTML = '<div class="empty">年度数据整理中，稍后自动出现</div>';
    return;
  }
  const months = y.months;
  const curMonth = new Date().getMonth() + 1;
  const max = months.reduce((mx, m) => Math.max(mx, m.sale || 0), 0) || 1;
  $('yearTitle').textContent = `${y.year} 年月度销售与毛利`;
  if (tip) {
    tip.textContent = y.updatedAt
      ? `${y.year}-01-01 至今 · 更新 ${new Date(y.updatedAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
      : `${y.year}-01-01 至今`;
  }
  if (sum) {
    sum.innerHTML = '累计 <b>' + moneyShort(y.total.sale) + '</b>'
      + ' · 毛利 <b>' + moneyShort(y.total.profit) + '</b>'
      + ' · 毛利率 <b>' + (y.total.rate || 0).toFixed(1) + '%</b>';
  }
  // 柱高最多占 88%，给柱顶的金额标签留出空间
  const TOP = 88;
  el.innerHTML = months.map((m) => {
    const sale = m.sale || 0, profit = m.profit || 0;
    const h = sale > 0 ? Math.min(TOP, Math.max(2, sale / max * TOP)) : 0;
    // 毛利段占整柱的比例（成本段自动吃掉剩下的高度）
    const ratio = sale > 0 ? Math.min(100, Math.max(0, profit / sale * 100)) : 0;
    const cls = m.m === curMonth ? ' cur' : (m.m > curMonth ? ' future' : '');
    const title = [
      `${y.year}年${m.m}月`,
      `销售额 ¥${money(sale)}`,
      `毛利 ¥${money(profit)}（占比 ${ratio.toFixed(1)}%）`,
      `成本 ¥${money(sale - profit)}`,
      `毛利率 ${(m.rate || 0).toFixed(1)}%`,
      m.qty ? `数量 ${num0(m.qty)} 件` : '',
    ].filter(Boolean).join('\n');
    const val = sale >= 10000 ? (sale / 10000).toFixed(1) + '万' : (sale ? String(Math.round(sale)) : '');
    return `<div class="m${cls}" title="${esc(title)}">`
      + '<div class="bars"><div class="bw">'
      + (val ? `<div class="val" style="bottom:calc(${h.toFixed(1)}% + 3px)">${esc(val)}</div>` : '')
      + `<div class="bar" style="height:${h.toFixed(1)}%">`
      + '<div class="seg cost"></div>'
      + `<div class="seg profit" style="height:${ratio.toFixed(1)}%"></div>`
      + '</div></div></div>'
      + `<div class="lbl">${m.m}月</div></div>`;
  }).join('');
}

// 门店口径：一个商户账号 = 一个门店，其下全部分店数据已汇总
function storeLabel(s) { return s.name; }

// 填充两个门店下拉（保留当前选择）
function fillStoreSelects(p) {
  // 总部视角：服务端额外给了全部门店清单，两个小下拉就用它出选项 ——
  // 管理员切到某一家店后，依然能在表里直接切到别的店或「所有门店汇总」。
  // 门店账号没有这份清单（服务端只给它本店那份快照），下拉只有自己那一家。
  const all = (state.data && state.data.allStores) || [];
  const stores = all.length ? all : (p.stores || []);
  // 只有门店账号才锁死到本店；总部视角不锁
  const forced = (!all.length && p.storeKey) ? String(p.storeKey) : '';
  for (const [id, cur] of [['seasonStore', state.seasonStore], ['catStore', state.catStore]]) {
    const el = $(id);
    if (!el) continue;
    const v = forced || cur;
    if (id === 'seasonStore') state.seasonStore = v; else state.catStore = v;
    const html = (forced ? '' : `<option value="all">所有门店汇总</option>`)
      + stores.map(s => `<option value="${esc(s.key)}"${String(v) === String(s.key) ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
    if (el.innerHTML !== html) el.innerHTML = html;
  }
}

// 取某行在所选门店下的数值（'all' = 全部汇总）
function pickStore(r, sk) {
  if (sk === 'all' || !r) return r;
  return (r.byStore || r.stockByStore || {})[sk] || null;
}

// 各门店在本期口径下的销售额（由大类×门店矩阵汇总，保证与总览一致）
function storeAmountMap(p) {
  const m = {};
  for (const c of (p.categories || [])) {
    for (const [k, v] of Object.entries(c.byStore || {})) {
      m[k] = (m[k] || 0) + (v.amount || 0);
    }
  }
  return m;
}

function renderStores(p) {
  const el = $('storeCards');
  const rtMap = new Map((p.realtime && p.realtime.stores || []).map(s => [s.key, s]));
  const amt = storeAmountMap(p);
  const list = (p.stores || []).map(s => {
    const rt = rtMap.get(s.key) || {};
    return {
      key: s.key, name: s.name, branchCount: s.branchCount || 0,
      amount: amt[s.key] || 0, today: rt.today || 0, customers: rt.customers || 0,
    };
  }); // 与大类矩阵保持同一门店顺序
  const failMap = new Map((p.tenants || []).filter(t => !t.ok).map(t => [String(t.tenantCode), t.error || '获取失败']));
  if (!list.length) { el.innerHTML = '<div class="empty">暂无门店数据</div>'; return; }
  el.innerHTML = list.map(s => {
    const err = failMap.get(s.key);
    const sub = err
      ? `<span class="muted">${esc(err)}</span>`
      : `<span>今日 ¥${money(s.today)}</span><span>客流 ${num0(s.customers)}</span>`;
    return `
      <div class="sc">
        <div class="sn" title="${esc(s.name)}（${s.branchCount} 个分店）">${esc(s.name)}</div>
        <div class="sv">¥${money(s.amount)}</div>
        <div class="sm">${sub}</div>
      </div>`;
  }).join('');
}

// 表头箭头：当前排序列显示 ▼(从多到少) / ▲(从少到多)
function arrow(col, sort) {
  if (sort.col !== col) return '<i class="arw"></i>';
  return `<i class="arw on">${sort.dir === 'desc' ? '▼' : '▲'}</i>`;
}

function renderMatrix(p) {
  const cats = p.categories || [];
  const stores = p.stores || [];
  const wrap = $('matrixWrap');
  if (!cats.length) { wrap.innerHTML = '<div class="empty">暂无大类数据</div>'; $('matrixTip').textContent = ''; return; }
  const cols = stores; // 门店数已收敛为账号数，全部展示
  const total = cats.reduce((s, c) => s + (c.saleAmount || 0), 0);
  // categories 本身不带小类，用 tree（同名大类）补上，用于点大类行展开
  const treeByName = new Map((p.tree || []).map(n => [n.name, n]));
  const rows = cats.map(c => ({
    name: c.name,
    cells: cols.map(s => (((c.byStore || {})[s.key] || {}).amount) || 0),
    total: c.saleAmount || 0,
    pct: total ? (c.saleAmount / total * 100) : 0,
    kids: ((treeByName.get(c.name) || {}).children) || [],
  }));
  // 排序：点击表头切换，默认「大类合计」从多到少
  const { col, dir } = state.matrixSort;
  const valOf = (r) => {
    if (col === 'name') return r.name;
    if (col === 'total') return r.total;
    if (col === 'pct') return r.pct;
    const i = cols.findIndex(s => s.key === col);
    return i < 0 ? 0 : r.cells[i];
  };
  rows.sort((a, b) => {
    const va = valOf(a), vb = valOf(b);
    const d = (typeof va === 'string') ? String(va).localeCompare(String(vb), 'zh-CN') : (va - vb);
    return dir === 'desc' ? -d : d;
  });
  const maxRow = Math.max(...rows.map(r => r.total), 1);
  // 单店视图下「门店列」与「大类合计」是完全同一个数，合计列不再重复渲染
  const single = cols.length === 1;
  // 列宽固定（百分比），主表与展开子表共用同一组宽度，保证列对齐成一条直线
  const pcolPct = 9, tcolPct = single ? 0 : 14, namePct = single ? 26 : 22;
  const storePct = (100 - namePct - tcolPct - pcolPct) / cols.length;
  const cg = `<colgroup><col style="width:${namePct}%">`
    + cols.map(() => `<col style="width:${storePct.toFixed(2)}%">`).join('')
    + (single ? '' : `<col style="width:${tcolPct}%">`)
    + `<col style="width:${pcolPct}%"></colgroup>`;
  const head = `<thead><tr>
    <th class="l sortable" data-c="name">大类${arrow('name', state.matrixSort)}</th>
    ${cols.map((s, i) => `<th class="sortable s${i % 4}" data-c="${esc(s.key)}">${esc(storeLabel(s))}${arrow(s.key, state.matrixSort)}</th>`).join('')}
    ${single ? '' : `<th class="sortable tcol" data-c="total">大类合计${arrow('total', state.matrixSort)}</th>`}
    <th class="sortable pcol" data-c="pct">占比${arrow('pct', state.matrixSort)}</th>
  </tr></thead>`;
  // 大类行可点开：展开后看该大类下各小类在各门店的销售（与中列「各大类销售数量与库存」同一套展开方式）
  const mOpen = state.matrixOpen || (state.matrixOpen = {});
  const body = rows.map((r, i) => {
    const kids = r.kids || [];
    const hasSub = kids.length > 0;
    const isOpen = !!mOpen[r.name];
    let html = `<tr class="z${i % 2} mc${isOpen ? ' open' : ''}" data-mcat="${esc(r.name)}">`
      + `<td class="name">${hasSub ? `<i class="car">${isOpen ? '▾' : '▸'}</i>` : '<i class="car flat">•</i>'}${esc(r.name)}`
      + (hasSub ? `<span class="scnt">${kids.length} 小类</span>` : '')
      + `</td>`
      + `${r.cells.map((a, ci) => `<td class="s${ci % 4}${a ? '' : ' zero'}">${a ? money(a) : '-'}</td>`).join('')}`
      + (single ? '' : `<td class="bar tcol"><i style="width:${(r.total / maxRow * 100).toFixed(1)}%"></i><span>${money(r.total)}</span></td>`)
      + `<td class="pcol">${r.pct.toFixed(1)}%</td>`
      + `</tr>`;
    if (!isOpen || !hasSub) return html;
    const sub = kids.map(ch => {
      // 门店列用「含子孙」口径（byStoreAll）：byStore 只有本节点自有值，
      // 有下级的类目会出现 门店列 ≠ 合计 的假差异
      const cells = cols.map(s => {
        const b = ((ch.byStoreAll || {})[s.key]) || ((ch.byStore || {})[s.key]) || {};
        return Number(b.saleAmount) || 0;
      });
      const tt = cells.reduce((a, b) => a + b, 0) || ch.saleAmountAll || 0;
      return { name: ch.name, cells, total: tt };
    }).filter(x => x.total || x.cells.some(v => v)).sort((a, b) => b.total - a.total);
    const mxSub = Math.max(...sub.map(x => x.total), 1);
    html += `<tr class="mw-wrap" data-mcat="${esc(r.name)}"><td colspan="${cols.length + (single ? 1 : 2) + 1}">`
      + '<table class="msub">' + cg + '<tbody>';
    if (!sub.length) {
      html += '<tr class="mv"><td class="l">'
        + (p.deepPending ? '小类数据后台补数中…' : '本档位这个类没有销售记录') + '</td></tr>';
    } else {
      sub.forEach((x, k) => {
        html += `<tr class="mv">`
          + `<td class="l"><span class="rk">${k + 1}</span>${esc(x.name)}</td>`
          + x.cells.map((a, ci) => `<td class="s${ci % 4}${a ? '' : ' zero'}">${a ? money(a) : '-'}</td>`).join('')
          + (single ? '' : `<td class="bar tcol"><i style="width:${(x.total / mxSub * 100).toFixed(1)}%"></i><span>${money(x.total)}</span></td>`)
          + `<td class="pcol">${r.total ? (x.total / r.total * 100).toFixed(1) : '0.0'}%</td>`
          + `</tr>`;
      });
    }
    html += '</tbody></table></td></tr>';
    return html;
  }).join('');
  const foot = `<tr style="font-weight:700;background:var(--accent-soft)">
    <td class="name">合计</td>
    ${cols.map((s, i) => `<td>${money(rows.reduce((a, r) => a + r.cells[i], 0))}</td>`).join('')}
    ${single ? '' : `<td>¥${money(total)}</td>`}<td>100%</td></tr>`;
  wrap.innerHTML = `<table>${cg}${head}<tbody>${body}${foot}</tbody></table>`;
  const sortName = col === 'name' ? '大类名称' : col === 'total' ? '大类合计' : col === 'pct' ? '占比'
    : ((p.stores || []).find(s => s.key === col) || {}).name || col;
  $('matrixTip').textContent = `${rows.length} 个大类 × ${cols.length} 个门店 · 按「${sortName}」${dir === 'desc' ? '从多到少' : '从少到多'} · 点表头可切换 · 点大类行展开小类`;
}

// ---------------- 季节销售与库存总表（纵向完整版，可按门店筛选） ----------------
// all = 该大类没有季节属性，春夏秋冬+未分类合并成的一整栏
const SEASON_ROW_CLASS = { spring: 's-spring', summer: 's-summer', autumn: 's-autumn', winter: 's-winter', none: 's-none', all: 's-all' };
const ZERO_ROW = { saleAmount: 0, saleQty: 0, costAmount: 0, grossProfit: 0, stockQty: 0, stockCost: 0 };

function renderSeason(p) {
  const st = p.seasonTable;
  const wrap = $('seasonWrap');
  const sk = state.seasonStore;
  if (!st || !st.groups || !st.groups.length) {
    wrap.innerHTML = '<div class="empty">' + (p.deepPending ? '季节数据后台补数中…（销售与库存已正常显示）' : '暂无季节数据') + '</div>';
    $('seasonTip').textContent = '';
    return;
  }
  const storeName = sk === 'all' ? '所有门店' : ((p.stores || []).find(s => s.key === sk) || {}).name || sk;
  const head = `<thead><tr>
    <th class="l" style="width:56px">大类</th><th style="width:48px">季节</th>
    <th style="width:92px">销售金额</th><th style="width:58px">销售数量</th><th style="width:82px">成本金额</th><th style="width:82px">毛利</th><th style="width:48px">毛利率</th><th style="width:66px">库存数量</th><th style="width:92px">库存金额</th>
  </tr></thead>`;
  const val = (o) => ({ ...ZERO_ROW, ...(pickStore(o, sk) || {}) });
  // 按当前查看的门店，判断这个大类在该店到底有没有季节属性：
  // 有 → 春夏秋冬 + 未分类；没有（档案里根本没录季节）→ 直接合并成一栏「不分季节」
  const rowsOf = (g) => {
    const rows = g.rows || [];
    if (rows.length <= 1) return rows;
    // 当前视图下这个大类有没有季节特性：汇总视图看全局判定（seasonal），单店视图看该店判定（seasonalByStore）
    const m = g.seasonalByStore || {};
    const seasonal = sk === 'all'
      ? (Object.prototype.hasOwnProperty.call(g, 'seasonal') ? !!g.seasonal : true)
      : (Object.prototype.hasOwnProperty.call(m, sk) ? !!m[sk] : !!g.seasonal);
    if (seasonal) return rows;
    // 没有季节特性 → 春夏秋冬+未分类合并成一栏「不分季节」，不再拆出一堆 0 行
    const sum = { ...ZERO_ROW };
    for (const r of rows) { const v = val(r); for (const f of Object.keys(sum)) sum[f] += Number(v[f]) || 0; }
    return [{ key: 'all', season: '不分季节', ...sum, byStore: { [sk]: sum } }];
  };
  const rowHtml = (g, r, mode, rowspan, gi, isFirst) => {
    const v = val(r);
    const chip = mode === 'total' ? '<span class="chip total">总计</span>'
      : mode === 'sub' ? '<span class="chip total">小计</span>'
        : `<span class="chip ${SEASON_ROW_CLASS[r.key] || ''}">${esc(r.season)}</span>`;
    const zc = (x) => (x ? '' : 'zero');
    return `
    <tr class="${mode ? 'total-row' : SEASON_ROW_CLASS[r.key] || ''}${isFirst ? ' g-first' : ''}${gi >= 0 ? ' gg' + (gi % 4) : ''}">
      ${rowspan ? `<td class="name g${gi}" rowspan="${rowspan}">${esc(g.name)}</td>` : ''}
      <td class="season-cell">${chip}</td>
      <td class="${zc(v.saleAmount)}${v.saleAmount ? ' sd-link' : ''}"${v.saleAmount ? ` data-sd-g="${esc(g.name)}" data-sd-s="${esc(r.key)}" title="点击查看构成这个数字的商品"` : ''}>${money(v.saleAmount)}</td>
      <td class="${zc(v.saleQty)}">${num0(v.saleQty)}</td>
      <td class="${zc(v.costAmount)}">${money(v.costAmount)}</td>
      <td class="${zc(v.grossProfit)} ${v.grossProfit < 0 ? 'neg' : ''}">${money(v.grossProfit)}</td>
      <td class="gm ${v.saleAmount ? '' : 'zero'}">${v.saleAmount ? (v.grossProfit / v.saleAmount * 100).toFixed(1) + '%' : '—'}</td>
      <td class="${zc(v.stockQty)} stock-q ${v.stockQty < 0 ? 'neg' : ''}">${num0(v.stockQty)}</td>
      <td class="${zc(v.stockCost)}">${money(v.stockCost)}</td>
    </tr>`;
  };
  // 每个大类先看「当前门店下要显示哪几行」，再据此渲染（小计 / 汇总都跟着同一份口径走）
  const viewGroups = st.groups.map(g => ({ g, rows: rowsOf(g) }));
  const body = viewGroups.map(({ g, rows }, gi) => {
    // 只有拆了季节的大类才需要小计行；合并成一栏的大类本身就是一行
    const needSub = rows.length > 1;
    const sub = needSub
      ? rowHtml(g, { key: 'sub', season: '小计', ...(g.total || {}), byStore: g.totalByStore || {} }, 'sub', 0, gi, false)
      : '';
    return rows.map((r, i) => rowHtml(g, r, '', i === 0 ? rows.length + (needSub ? 1 : 0) : 0, gi, i === 0)).join('') + sub;
  }).join('');
  // grand 行直接传 st.total（含 byStore），由 rowHtml 内的 val/pickStore 统一取数
  const grand = `<tr class="grand-row">${rowHtml({ name: '' }, { key: '', season: '', ...st.total }, 'total', 0).replace(/^\s*<tr[^>]*>/, '')}</tr>`;
  // 底部汇总条：春夏秋冬 + 未分类 各自跨大类的合计（一眼看到季节结构）
  const sumBy = {};
  for (const { rows } of viewGroups) {
    for (const r of rows) {
      const v = val(r);
      const o = sumBy[r.key] = sumBy[r.key] || { ...ZERO_ROW, label: r.season };
      for (const f of Object.keys(ZERO_ROW)) o[f] += Number(v[f]) || 0;
    }
  }
  const sumHtml = `<div class="season-sum">` + ['spring', 'summer', 'autumn', 'winter', 'none', 'all']
    .filter(k => sumBy[k])
    .map(k => {
      const o = sumBy[k];
      const cls = SEASON_ROW_CLASS[k] || '';
      return `<span class="it ${cls}"><span class="chip ${cls}">${esc(o.label)}</span>`
        + `<b>${money(o.saleAmount)}</b><i>库存 ${num0(o.stockQty)}</i>`
        + `<i>数量 ${num0(o.saleQty)}</i></span>`;
    }).join('') + `</div>`;
  wrap.innerHTML = `<table>${head}<tbody>${body}${grand}</tbody></table>${sumHtml}`;
  // 点金额 → 追溯这个数字背后是哪些商品、季节读了哪个档案字段
  wrap.querySelectorAll('.sd-link').forEach(el => {
    el.style.cursor = 'pointer';
    el.onclick = () => openSeasonDetail(el.getAttribute('data-sd-g'), el.getAttribute('data-sd-s'));
  });
  const hasNone = viewGroups.some(({ rows }) => {
    const v = val(rows.find(r => r.key === 'none') || ZERO_ROW);
    return v.saleAmount || v.stockQty;
  });
  const meta = st.meta || {};
  let tipTxt = sk === 'all' ? '' : '单店视图：仅看「' + storeName + '」· 切到「所有门店汇总」可合并全部门店。';
  if (meta.mode === 'loose') tipTxt += ' · 含关键词推断的季节（门店未录入也会显示）';
  else if (meta.mode === 'auto') tipTxt += ' · 仅采用档案里录入的季节，覆盖率过低的大类整类合并为一栏（不分季节）';
  else tipTxt += ' · 仅采用门店系统里录入的季节（款式档案/规格/产地/备注/手工指派），未录入的一律未分类。点表里的金额可查看构成它的商品';
  // 在这个门店下没有季节属性、合并成一栏显示的大类
  const flatGroups = viewGroups.filter(({ rows }) => rows.length === 1 && rows[0].key === 'all').map(({ g }) => g.name);
  if (flatGroups.length) tipTxt += ' · 无季节属性的大类合并为一栏：' + flatGroups.join('、');
  // 大库门店商品级库存抓不全：差额已按权威分类库存补进未分类，说清楚，别让人以为库存算错
  if (meta.stockPatched) tipTxt += ' · 商品级库存未抓全的 ' + meta.stockPatched + ' 个「大类×门店」已按权威分类库存补差（计入未分类）';
  const merged = (meta.merged || []).filter(x => state.seasonStore === 'all' || x.tenantCode === state.seasonStore);
  const labelOf = (x) => (state.seasonStore === 'all' ? x.store + '·' : '') + x.group + ' ' + x.authRatio + '%';
  if (merged.length) {
    const uniq = [];
    const seen = new Set();
    for (const x of merged) {
      const l = labelOf(x);
      if (!seen.has(l)) { seen.add(l); uniq.push(l); }
    }
    tipTxt += ' · 档案季节覆盖率过低，已合并为一栏（不分季节）：' + uniq.join('、');
  } else if (meta.weak && meta.weak.length) {
    // 严格口径不整类合并，但仍要告知：这些大类的商品基本没录入季节，表里主要落在未分类
    const uniq = [];
    const seen = new Set();
    for (const x of meta.weak) {
      const l = labelOf(x);
      if (!seen.has(l)) { seen.add(l); uniq.push(l); }
    }
    tipTxt += ' · 基本未录入季节（计入未分类）：' + uniq.join('、');
  }
  if (hasNone) tipTxt += ' · 含未归类商品';
  // 款式档案没抓到 → 女装等纯靠款式档案的大类会全落未分类，明确提示根因（而不是静默显示「不分季节」）
  const srcArr = meta.sources || [];
  const checkSrc = state.seasonStore === 'all' ? srcArr : srcArr.filter(s => s.tenantCode === state.seasonStore);
  const noStyle = checkSrc.filter(s => s.archive && s.archive.total > 0 && (!s.counts || !s.counts.style));
  if (noStyle.length) {
    const names = noStyle.map(s => state.seasonStore === 'all' ? s.store : '本店').join('、');
    tipTxt += ' ⚠️ ' + names + ' 未取到「特性·款式档案」季节（女装等纯靠款式档案的大类会全部归入未分类）。多为线上抓取被限流/超时，稍后自动重试即可；若长期如此请检查网络或账号权限';
  }
  $('seasonTip').textContent = tipTxt;
}

// ---------------- 季节明细追溯 ----------------
async function openSeasonDetail(group, skey) {
  const m = $('sdModal');
  if (!m) return;
  m.style.display = 'flex';
  $('sdTitle').textContent = `${state.seasonStore === 'all' ? '所有门店' : (((state.payload || {}).stores || []).find(s => s.key === state.seasonStore) || {}).name || state.seasonStore} · ${group} · ${({ spring: '春', summer: '夏', autumn: '秋', winter: '冬', none: '未分类', all: '不分季节' })[skey] || skey}`;
  $('sdTip').textContent = '加载中…';
  $('sdBody').innerHTML = '<div class="empty">加载中…</div>';
  let j;
  try {
    j = await fetch(`/api/season-detail?range=${encodeURIComponent(state.range)}&store=${encodeURIComponent(state.seasonStore)}&group=${encodeURIComponent(group)}&season=${encodeURIComponent(skey)}&limit=60`, { cache: 'no-store' }).then(r => r.json());
  } catch (e) {
    $('sdBody').innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; return;
  }
  if (!j.ok) { $('sdBody').innerHTML = '<div class="empty">' + esc(j.error || '无数据') + '</div>'; return; }
  const head = `<thead><tr>
    <th class="l">商品编码</th><th class="l">商品名称</th><th class="l">类别</th>
    <th class="l">季节来源</th><th class="l">档案里的值</th><th>销售额</th><th>数量</th>
  </tr></thead>`;
  const srcCls = (s) => (['style', 'spec', 'producer', 'memo', 'manual'].includes(s) ? 'ok' : 'zero');
  const valOf = (r) => {
    if (r.source === 'style') return '款式档案季节 = ' + (r.styleSeason || '-');
    if (r.source === 'spec') return '规格 = ' + (r.spec || '-');
    if (r.source === 'producer') return '产地 = ' + (r.producer || '-');
    if (r.source === 'memo') return '备注 = ' + [r.memo1, r.memo2].filter(Boolean).join(' / ');
    if (r.source === 'manual') return '手工指派';
    return '—（未识别，属未分类）';
  };
  const body = (j.rows || []).map(r => `<tr>
    <td class="l"><b>${esc(r.code)}</b></td>
    <td class="l">${esc(r.name)}${r.placeholder ? ' <span style="color:#c0392b;font-size:11px;border:1px solid #c0392b;padding:0 3px;border-radius:3px;margin-left:4px">系统占位</span>' : ''}</td>
    <td class="l">${esc(r.category)}</td>
    <td class="l ${srcCls(r.source)}">${esc(r.sourceLabel)}</td>
    <td class="l">${esc(valOf(r))}</td>
    <td>${money(r.amount)}</td>
    <td>${num0(r.qty)}</td>
  </tr>`).join('');
  $('sdBody').innerHTML = `
    <div class="sg-hint">该大类「${esc(group)}」本月销售 <b>${money(j.groupTotal)}</b>，其中能追溯到档案季节的 <b>${money(j.covered)}</b>（<b>${j.coverRatio}%</b>）。
      共 ${j.matched} 个商品归入「${esc(j.seasonLabel)}」，下面列出销售额最高的 ${(j.rows || []).length} 个。
      <br>拿「商品编码」去系统商品档案里核对第五列的字段——若那里其实没有季节，说明该字段被误判，可到「季节设置 → 季节口径」里把这个字段取消勾选。</div>
    <div class="tbl-wrap" style="max-height:52vh"><table class="mini-tbl">${head}<tbody>${body || '<tr><td colspan="7" class="empty">没有商品</td></tr>'}</tbody></table></div>`;
  $('sdTip').textContent = `共 ${j.matched} 个商品` + (j.matched > (j.rows || []).length ? `，仅显示前 ${(j.rows || []).length} 个` : '');
}

// ---------------- 季节归类设置弹窗 ----------------
function switchSeasonTab(tab) {
  for (const b of document.querySelectorAll('#seasonModal .tab-btn')) {
    b.classList.toggle('active', b.getAttribute('data-tab') === tab);
  }
  $('seasonRules').style.display = tab === 'rule' ? '' : 'none';
  $('seasonList').style.display = tab === 'cat' ? '' : 'none';
  $('seasonMode').style.display = tab === 'mode' ? '' : 'none';
  $('seasonSrc').style.display = tab === 'src' ? '' : 'none';
  if (tab === 'src') loadSeasonSources();
}

// 季节来源诊断：确认每个门店的季节到底取自哪个档案
let seasonSrcLoaded = false;
async function loadSeasonSources() {
  const box = $('seasonSrc');
  if (seasonSrcLoaded) return;
  box.innerHTML = '<div class="empty">加载中…</div>';
  let j = null;
  try { j = await fetch('/api/season-sources', { cache: 'no-store' }).then(r => r.json()); } catch (e) {
    box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; return;
  }
  const src = (j && j.sources) || [];
  if (!src.length) { box.innerHTML = '<div class="empty">还没有季节数据，请等数据同步完再来看</div>'; return; }
  const L = (j && j.labels) || {};
  const modeText = j.mode === 'loose' ? '宽松（含关键词推断）' : (j.mode === 'auto' ? '自动' : '严格');
  // 推断来源在「严格/自动」口径下不进季节明细，只进未分类 —— 表头直接标出来，免得看表的人以为它生效
  const guessed = (j.mode === 'loose') ? new Set() : new Set(['rule', 'name']);
  const ORDER = ['style', 'spec', 'producer', 'memo', 'manual', 'rule', 'name', 'none'];
  const head = `<tr><th class="l">门店</th>${ORDER.map(k => `<th>${esc(L[k] || k)}${guessed.has(k) ? '<div class="sm-desc">未采用</div>' : ''}</th>`).join('')}<th>档案季节覆盖</th></tr>`;
  const rows = src.map(s => {
    const c = s.counts || {};
    const mainSource = (() => {
      let best = '', bv = 0;
      for (const k of ['style', 'spec', 'producer', 'memo']) if ((c[k] || 0) > bv) { bv = c[k]; best = k; }
      return best;
    })();
    const tip = mainSource ? `主用「${L[mainSource] || mainSource}」` : '几乎没有档案季节，主要靠关键词推断';
    return `<tr>
      <td class="l"><b>${esc(s.store)}</b><div class="sm-desc">${esc(tip)}</div></td>
      ${ORDER.map(k => `<td class="${(c[k] || 0) ? '' : 'zero'}">${num0(c[k] || 0)}</td>`).join('')}
      <td>${(s.archive && s.archive.ratio != null) ? s.archive.ratio + '%' : '-'}</td>
    </tr>`;
  }).join('');
  // 各大类的档案季节覆盖率（决定该大类是否展示明细）
  const cov = [];
  for (const s of src) for (const g of (s.groups || [])) cov.push({ store: s.store, group: g.group, ratio: g.authRatio, keep: g.keep });
  let covHtml = '';
  if (cov.length) {
    const byGroup = {};
    for (const x of cov) (byGroup[x.group] = byGroup[x.group] || []).push(`${esc(x.store)} ${x.ratio}%${x.keep ? '' : '（并入未分类）'}`);
    covHtml = '<div class="sg-hint">各大类里「档案季节」覆盖到的销售/库存占比：' +
      Object.entries(byGroup).map(([g, arr]) => `<b style="color:var(--accent)">${esc(g)}</b>：${arr.join('、')}`).join('　') +
      '<br>占比越低说明该大类越没维护季节；「自动」口径下低于阈值的大类会整类并入未分类。</div>';
  }
  const fld = (j && j.fields) || {};
  const fldHtml = Object.keys(fld).filter(k => fld[k] === false)
    .map(k => (j.fieldLabels && j.fieldLabels[k]) || k).join('、');
  box.innerHTML = `
    <div class="sg-hint">季节只从两处取：<b>特性·款式档案</b>（基础资料里的季节）与 <b>商品档案</b>
      （规格 / 产地 / 备注1 / 备注2 里填的季节）。当前口径 <b>${esc(modeText)}</b>：
      只有这些档案字段里<b>真正录入</b>的季节才进春夏秋冬，
      <b>关键词规则推断</b>与<b>名称识别</b>一律计入「未分类」——门店没录季节就不会凭空出现季节数据。
      ${fldHtml ? '<br>已停用的字段：<b>' + esc(fldHtml) + '</b>（即使里面有季节也不采用）' : ''}</div>
    <div class="tbl-wrap" style="max-height:300px"><table class="mini-tbl"><thead>${head}</thead><tbody>${rows}</tbody></table></div>
    ${covHtml}`;
  seasonSrcLoaded = true;
}

function renderSeasonMode(j, fj) {
  const m = j.mode || 'strict';
  const th = Number(j.threshold) || 20;
  const meta = (state.payload && state.payload.seasonTable && state.payload.seasonTable.meta) || {};
  // 季节字段白名单：只有勾选的档案字段里填的季节才算数，其余一律未分类
  const fld = (fj && fj.fields) || meta.fields || {};
  const fldLabels = (fj && fj.labels) || {};
  const FLD_ORDER = ['style', 'spec', 'producer', 'memo', 'manual'];
  const fldHtml2 = `<div class="sg-title">季节取自哪些档案字段</div>
    <div class="sf-grid">${FLD_ORDER.map(k => `<label class="ui-sw">
      <input type="checkbox" class="sf-chk" data-k="${k}"${fld[k] === false ? '' : ' checked'} />
      <span>${esc(fldLabels[k] || k)}${k === 'manual' ? '<span class="sm-desc">在下面「类别指派」里手工指定的季节</span>' : ''}</span>
    </label>`).join('')}</div>
    <div class="sg-hint">只有勾选的字段里<b>真正填了季节</b>才归类；这些地方都没填的商品，一律计入<b>未分类</b>，
      系统不会按商品名或关键词去猜。若某家店把产地/备注用来填厂商名而非季节，把对应字段取消勾选即可。</div>`;
  const merged = meta.merged || [];
  let mergedHtml = '';
  if (merged.length) {
    const byGroup = {};
    for (const x of merged) (byGroup[x.group] = byGroup[x.group] || []).push(`${esc(x.store)} ${x.authRatio}%`);
    mergedHtml = '<div class="sg-hint">当前已整类并入「未分类」：<br>' +
      Object.entries(byGroup).map(([g, arr]) => `<b style="color:var(--accent)">${esc(g)}</b>（${arr.join('、')}）`).join('&nbsp;&nbsp;') +
      '<br>括号内为该类在系统档案里真正维护了季节的占比。</div>';
  }
  const radio = (v, label, desc) => `<label class="sm-row">
      <input type="radio" name="smode" value="${v}"${m === v ? ' checked' : ''} />
      <span><b>${esc(label)}</b><span class="sm-desc">${esc(desc)}</span></span>
    </label>`;
  $('seasonMode').innerHTML = `
    <div class="sg-hint"><b>默认「严格」</b>：门店系统里没录入季节的商品，一律算「未分类」，
      <b>不会</b>靠关键词去猜一个季节填进去。只有下面这几处真正录入的季节才算数：
      特性·款式档案的款式季节、商品档案的 规格 / 产地 / 等级 / 备注1 / 备注2、以及你在「类别指派」里手工指定的季节。</div>
    ${fldHtml2}
    ${radio('strict', '严格（推荐）', '只认门店系统里录入的季节（款式档案 / 规格 / 产地 / 备注 / 手工指派）；没录入的全部进未分类')}
    ${radio('auto', '自动（更保守）', '在严格的基础上，某「门店 × 大类」档案季节占比低于阈值时，把整类（含真实的那部分）并入未分类')}
    <div class="ru-row"><span class="ru-tag" style="background:var(--accent)">阈值</span>
      <input class="ru-inp" id="seasonThreshold" type="number" min="0" max="100" value="${th}" style="flex:0 0 90px" />
      <span class="sg-hint" style="margin:0">%　仅「自动」模式用到：低于该占比就整类并入未分类（填 0 = 不并入）。各店实际占比见「季节来源」页签</span>
    </div>
    ${radio('loose', '宽松（不推荐）', '关键词推测出来的季节也算数 —— 会出现「门店没录季节但表里有季节数据」的情况')}
    ${mergedHtml}`;
}

function renderSeasonRules(j) {
  const rules = j.rules || {};
  const order = j.order || ['winter', 'summer', 'autumn', 'spring'];
  const labels = j.labels || {};
  let html = '<div class="sg-hint">门店档案里没有季节时，用这里的关键词语识别：' +
    '先查「小类名」，再查「中类名」，最后查「商品名」。命中顺序为 冬 → 夏 → 秋 → 春，多个关键词用逗号分隔。</div>';
  for (const k of order) {
    html += `<div class="ru-row">
      <span class="ru-tag ru-${k}">${esc(labels[k] || k)}</span>
      <input class="ru-inp" data-k="${k}" value="${esc((rules[k] || []).join('，'))}" placeholder="留空表示不识别" />
    </div>`;
  }
  html += '<div class="sg-hint">例：冬 = 棉，加绒，羽绒，打底　　夏 = 凉，网，短袖，裙　　秋 = 单，外套，卫衣</div>';
  $('seasonRules').innerHTML = html;
}

function collectSeasonRules() {
  const out = {};
  for (const inp of document.querySelectorAll('#seasonRules .ru-inp')) {
    const k = inp.getAttribute('data-k');
    out[k] = inp.value.split(/[，,、\s]+/).map(s => s.trim()).filter(Boolean);
  }
  return out;
}

async function openSeasonModal() {
  const modal = $('seasonModal');
  modal.style.display = 'flex';
  $('seasonSaveTip').textContent = '';
  const list = $('seasonList');
  list.innerHTML = '<div class="empty">加载中…</div>';
  $('seasonRules').innerHTML = '<div class="empty">加载中…</div>';
  seasonSrcLoaded = false;
  switchSeasonTab('rule');
  try {
    const j = await fetch('/api/season-map', { cache: 'no-store' }).then(r => r.json());
    renderSeasonRules(j);
    try {
      const [mj, fj] = await Promise.all([
        fetch('/api/season-mode', { cache: 'no-store' }).then(r => r.json()),
        fetch('/api/season-fields', { cache: 'no-store' }).then(r => r.json()).catch(() => null),
      ]);
      renderSeasonMode(mj, fj);
    } catch (e) { }
    const cats = j.categories || [];
    if (!cats.length) { list.innerHTML = '<div class="empty">暂无类别数据，请等数据同步后再试</div>'; return; }
    const opt = (v, label, cur) => `<option value="${v}"${cur === v ? ' selected' : ''}>${label}</option>`;
    let html = '';
    let lastGroup = null, lastMid = null;
    for (const c of cats) {
      if (c.group !== lastGroup) {
        lastGroup = c.group; lastMid = null;
        html += `<div class="sg-title">${esc(c.group)}</div>`;
      }
      if (c.mid !== lastMid) { lastMid = c.mid; if (c.mid) html += `<div class="sg-mid">${esc(c.mid)}</div>`; }
      const effective = j.map[c.name] || 'auto';
      html += `<div class="sg-row" data-name="${esc(c.name)}">
        <span class="sg-name" title="${esc(c.mid ? c.mid + ' / ' : '')}${esc(c.name)}">${esc(c.name)}</span>
        <select class="sg-sel">
          ${opt('auto', '自动识别' + (effective === 'auto' && c.current !== 'none' ? '（' + (j.labels ? j.labels[c.current] || '' : '') + '）' : ''), effective)}
          ${opt('spring', '春', effective)}
          ${opt('summer', '夏', effective)}
          ${opt('autumn', '秋', effective)}
          ${opt('winter', '冬', effective)}
        </select>
      </div>`;
    }
    list.innerHTML = html;
  } catch (e) {
    list.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>';
  }
}

async function saveSeasonMap() {
  const rows = [...document.querySelectorAll('#seasonList .sg-row')];
  const map = {};
  for (const r of rows) {
    const name = r.getAttribute('data-name');
    const v = r.querySelector('select').value;
    if (v === 'auto') continue;          // 跟随自动识别 → 不写显式映射
    map[name] = v;
  }
  const btn = $('seasonSave');
  btn.disabled = true;
  $('seasonSaveTip').textContent = '保存并重算中…';
  try {
    const rj = await fetch('/api/season-rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: collectSeasonRules() }),
    }).then(r => r.json());
    if (!rj.ok) throw new Error(rj.error || '规则保存失败');
    // 季节判定口径（未分类策略）
    const md = document.querySelector('#seasonMode input[name="smode"]:checked');
    const thv = Number(($('seasonThreshold') || {}).value);
    try {
      const rk = await fetch('/api/season-mode', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: md ? md.value : 'strict', threshold: Number.isFinite(thv) ? thv : 20 }),
      }).then(r => r.json());
      if (!rk.ok) throw new Error(rk.error || '口径保存失败');
    } catch (e) { throw new Error(e.message); }
    // 季节字段白名单（哪些档案字段里填的季节才算数）
    const fields = {};
    for (const cb of document.querySelectorAll('#seasonMode .sf-chk')) fields[cb.getAttribute('data-k')] = !!cb.checked;
    try {
      const rf = await fetch('/api/season-fields', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      }).then(r => r.json());
      if (!rf.ok) throw new Error(rf.error || '字段设置保存失败');
    } catch (e) { throw new Error(e.message); }
    const j = await fetch('/api/season-map', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ map }),
    }).then(r => r.json());
    if (!j.ok) throw new Error(j.error || '保存失败');
    $('seasonSaveTip').textContent = '已保存并重算：' + (j.rebuilt || []).join('、');
    await load(true);
    setTimeout(() => { $('seasonModal').style.display = 'none'; }, 900);
  } catch (e) {
    $('seasonSaveTip').textContent = '失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function resetSeasonRules() {
  $('seasonSaveTip').textContent = '恢复默认规则…';
  try {
    const j = await fetch('/api/season-rules', { cache: 'no-store' }).then(r => r.json());
    renderSeasonRules({ rules: j.defaults || {}, order: j.order, labels: j.labels });
    $('seasonSaveTip').textContent = '已填入默认规则，点「保存并重算」生效';
  } catch (e) {
    $('seasonSaveTip').textContent = '失败：' + e.message;
  }
}

// ---------------- 各大类销售数量与库存（可按门店筛选） ----------------
// 数据源：树一级节点（库存全时存在）+ 大类报表（销售数量权威口径）
// 点任意大类行，会在它下面展开「这个大类里各供应商的销量 / 销售额 / 库存」。
// 时间档跟随顶部那排（实时 / 昨天 / 本周 / 本月 / 上月），吃的是同一份快照，不额外联网。
const VENDOR_TOP = 8;   // 每个大类默认显示前几名（供应商动辄几百家，全铺开会卡）
const VENDOR_NONE = '未填供应商';
/**
 * 供应商榜排序：销售数量从多到少，金额只做件数相同时的次序。
 * 必须在这里再排一次——后端给的是全店口径的顺序，
 * 而单店视角下显示的是本店数值，沿用全店顺序会出现「数字看着乱序」。
 */
function sortVendors(list) {
  return list.slice().sort((a, b) =>
    (a.name === VENDOR_NONE ? 1 : 0) - (b.name === VENDOR_NONE ? 1 : 0)
    || b.saleQty - a.saleQty || b.saleAmount - a.saleAmount || (a.name < b.name ? -1 : 1));
}
/** 供应商行按当前查看的门店取数：全店看合并数，单店只看那家店 */
function pickVendorStore(v, sk) {
  const z = (x) => Number(x) || 0;
  if (sk && sk !== 'all') {
    const b = (v.byStore || {})[sk] || {};
    return { name: v.name, saleQty: z(b.saleQty), saleAmount: z(b.saleAmount), stockQty: z(b.stockQty), stockCost: z(b.stockCost) };
  }
  return v;
}
function renderCatQty(p) {
  const wrap = $('catQtyWrap');
  const sk = state.catStore;
  const catByName = new Map((p.categories || []).map(c => [c.name, c]));
  const treeL1 = p.tree || [];
  if (!treeL1.length) { wrap.innerHTML = '<div class="empty">暂无大类数据</div>'; $('catQtyTip').textContent = ''; return; }
  const rows = treeL1.map(n => {
    const c = catByName.get(n.name);
    let saleQty = 0, stockQty = 0, saleAmt = 0;
    if (sk === 'all') {
      saleQty = c ? (c.saleQty || 0) : (n.saleQtyAll || 0);
      saleAmt = c ? (c.saleAmount || 0) : (n.saleAmountAll || 0);
      stockQty = n.stockQtyAll || 0;
    } else {
      const b = c && ((c.byStore || {})[sk] || {});
      saleQty = b ? (b.qty || 0) : 0;
      saleAmt = b ? (b.amount || 0) : 0;
      stockQty = ((n.stockByStore || {})[sk] || {}).stockQty || 0;
    }
    return { name: n.name, saleQty, saleAmt, stockQty, node: n };
  }).sort((a, b) => (b.saleQty - a.saleQty) || (b.stockQty - a.stockQty));
  // 排序：点击表头切换，默认「销售数量」从多到少
  const { col, dir } = state.catSort;
  const cval = (r) => (col === 'name' ? r.name : col === 'stock' ? r.stockQty : col === 'amt' ? r.saleAmt : r.saleQty);
  rows.sort((a, b) => {
    const va = cval(a), vb = cval(b);
    const d = (typeof va === 'string') ? String(va).localeCompare(String(vb), 'zh-CN') : (va - vb);
    return dir === 'desc' ? -d : d;
  });
  const maxSale = Math.max(...rows.map(r => r.saleQty), 1);
  const maxAmt = Math.max(...rows.map(r => r.saleAmt), 1);
  const maxStock = Math.max(...rows.map(r => r.stockQty), 1);
  const head = `<thead><tr>
    <th class="l sortable" data-c="name">大类${arrow('name', state.catSort)}</th>
    <th class="sortable" data-c="sale" style="width:24%">销售数量${arrow('sale', state.catSort)}</th>
    <th class="sortable" data-c="amt" style="width:24%">销售金额${arrow('amt', state.catSort)}</th>
    <th class="sortable" data-c="stock" style="width:24%">库存数量${arrow('stock', state.catSort)}</th>
  </tr></thead>`;
  // 大类行可点开：默认看「小类」销售构成，可切到「供应商」排名；展开状态 / 子视图 / 供应商展开全部都记住
  const open = state.catVendorOpen || (state.catVendorOpen = {});
  const subView = state.catSubView || (state.catSubView = {});
  const more = state.catVendorMore || (state.catVendorMore = {});
  const vmap = ((p.vendorByCat || {}).byCat) || {};
  const body = rows.map((r, i) => {
    const node = r.node;
    const kids = (node && node.children) || [];
    const g = vmap[r.name];
    const vcnt = g ? (g.vendorCount || 0) : 0;
    const hasSub = kids.length > 0;
    const hasVend = vcnt > 0;
    const isOpen = !!open[r.name];
    const view = subView[r.name] || (hasSub ? 'sub' : 'vendor'); // 默认小类，无小类兜底到供应商
    let html = `<tr class="z${i % 2} cq${isOpen ? ' open' : ''}" data-cat="${esc(r.name)}">`
      + `<td class="name">${(hasSub || hasVend) ? `<i class="car">${isOpen ? '▾' : '▸'}</i>` : '<i class="car flat">•</i>'}${esc(r.name)}</td>`
      + `<td class="bar${r.saleQty ? '' : ' zero'}"><i style="width:${(r.saleQty / maxSale * 100).toFixed(1)}%"></i><span>${num0(r.saleQty)}</span></td>`
      + `<td class="n sale${r.saleAmt ? '' : ' zero'}">${money(r.saleAmt)}</td>`
      + `<td class="bar stock${r.stockQty ? '' : ' zero'}"><i style="width:${(r.stockQty / maxStock * 100).toFixed(1)}%"></i><span>${num0(r.stockQty)}</span></td>`
      + `</tr>`;
    if (!isOpen) return html;
    const tab = (v) => `<button class="cv-tab${view === v ? ' on' : ''}" data-sub="${v}"${v === 'sub' && !hasSub ? ' disabled' : ''}>${v === 'sub' ? '小类' : '供应商'}</button>`;
    html += '<tr class="vv-wrap" data-cat="' + esc(r.name) + '"><td colspan="4"><div class="cv-tabs">' + tab('sub') + tab('vendor') + '</div>';
    if (view === 'sub') {
      const sub = kids.map(ch => {
        let sq = 0, sa = 0, stq = 0, stc = 0;
        if (sk === 'all') { sq = ch.saleQtyAll || 0; sa = ch.saleAmountAll || 0; stq = ch.stockQtyAll || 0; stc = ch.stockCostAll || 0; }
        else { const b = (ch.byStore || {})[sk] || {}; sq = b.saleQty || 0; sa = b.saleAmount || 0; stq = b.stockQty || 0; stc = b.stockCost || 0; }
        return { name: ch.name, saleQty: sq, saleAmount: sa, stockQty: stq, stockCost: stc };
      }).filter(x => x.saleQty || x.stockQty || x.saleAmount || x.stockCost)
        .sort((a, b) => (b.saleQty - a.saleQty) || (b.saleAmount - a.saleAmount));
      const mxS = Math.max(...sub.map(x => x.saleQty), 1);
      const mxK = Math.max(...sub.map(x => x.stockQty), 1);
      html += '<table class="st"><tbody>'
        + '<tr class="vh"><td class="l">小类</td><td>销量</td><td>销售额</td><td>库存</td></tr>';
      if (!sub.length) {
        html += '<tr class="vv"><td class="l">' + (p.deepPending ? '小类数据后台补数中…' : '本档位这个类没有销售记录') + '</td></tr>';
      } else {
        sub.forEach((x, k) => {
          html += `<tr class="vv">`
            + `<td class="l"><span class="rk">${k + 1}</span>${esc(x.name)}</td>`
            + `<td class="bar${x.saleQty ? '' : ' zero'}"><i style="width:${(x.saleQty / mxS * 100).toFixed(1)}%"></i><span>${num0(x.saleQty)}</span></td>`
            + `<td class="n sale">${money(x.saleAmount)}</td>`
            + `<td class="bar stock${x.stockQty ? '' : ' zero'}"><i style="width:${(x.stockQty / mxK * 100).toFixed(1)}%"></i><span>${num0(x.stockQty)}</span></td>`
            + `</tr>`;
        });
      }
      html += '</tbody></table>';
    } else {
      const list = sortVendors((g.vendors || []).map(v => pickVendorStore(v, sk))
        .filter(x => x.saleQty || x.stockQty || x.saleAmount || x.stockCost));
      const showAll = !!more[r.name];
      const shown = showAll ? list : list.slice(0, VENDOR_TOP);
      html += '<table class="vt"><tbody>'
        + '<tr class="vh"><td class="l">供应商</td><td>销量</td><td>销售额</td><td>库存</td></tr>';
      if (!shown.length) {
        html += '<tr class="vv"><td class="l">'
          + (p.deepPending ? '供应商数据后台补数中…' : '本档位这个类没有销售记录') + '</td></tr>';
      } else {
        shown.forEach((v, k) => {
          html += `<tr class="vv">`
            + `<td class="l"><span class="rk">${k + 1}</span>${esc(v.name)}</td>`
            + `<td class="n">${num0(v.saleQty)}</td>`
            + `<td class="n sale">${money(v.saleAmount)}</td>`
            + `<td class="n">${num0(v.stockQty)}</td>`
            + `</tr>`;
        });
      }
      if (list.length > VENDOR_TOP) {
        html += `<tr class="vmore" data-more="${esc(r.name)}"><td colspan="4">`
          + (showAll ? `收起（只看前 ${VENDOR_TOP} 名）` : `展开全部 ${list.length} 家供应商`) + '</td></tr>';
      }
      html += '</tbody></table>';
    }
    html += '</td></tr>';
    return html;
  }).join('');
  const foot = `<tr class="grand-row">
    <td class="name">合计</td>
    <td class="bar"><i style="width:100%"></i><span>${num0(rows.reduce((a, r) => a + r.saleQty, 0))}</span></td>
    <td class="n sale"><b>${money(rows.reduce((a, r) => a + r.saleAmt, 0))}</b></td>
    <td class="bar stock"><i style="width:100%"></i><span>${num0(rows.reduce((a, r) => a + r.stockQty, 0))}</span></td>
  </tr>`;
  wrap.innerHTML = `<table>${head}<tbody>${body}${foot}</tbody></table>`;
  const storeName = sk === 'all' ? '所有门店' : ((p.stores || []).find(s => s.key === sk) || {}).name || sk;
  const rangeLabel = (p.range && p.range.label) || '';
  const sortName = col === 'name' ? '大类名称' : col === 'stock' ? '库存数量' : '销售数量';
  $('catQtyTip').textContent = storeName + (rangeLabel ? ' · ' + rangeLabel : '')
    + ` · 按「${sortName}」${dir === 'desc' ? '从多到少' : '从少到多'}`
    + ' · 点大类行展开看小类 / 供应商明细';
}

// ---------------- 事件 ----------------
function setRange(r, manual, peek) {
  state.range = r;
  [...$('rangeTabs').children].forEach(x => x.classList.toggle('on', x.getAttribute('data-r') === r));
  if (manual) setAuto(false); // 手动选择时暂停轮播，避免被自动切走
  load(false, peek);
}

function setAuto(on) {
  state.auto = !!on;
  state.autoLeft = AUTO_SEC;
  const i = RANGE_CYCLE.indexOf(state.range);
  state.autoIdx = i < 0 ? 0 : i;
  try { localStorage.setItem(AUTO_KEY, state.auto ? '1' : '0'); } catch (e) { }
  refreshAutoBtn();
}
/** 自动轮播默认关；用户开过就记住 */
function initAuto() {
  try {
    const v = localStorage.getItem(AUTO_KEY);
    state.auto = v === '1';
  } catch (e) { state.auto = false; }
  refreshAutoBtn();
}
function refreshAutoBtn() {
  const b = $('btnAuto');
  if (b) {
    b.textContent = state.auto ? `自动轮播：开 · ${state.autoLeft}s` : '自动轮播：关';
    b.classList.toggle('on', state.auto);
  }
  const cb = $('uiAuto');
  if (cb && cb.checked !== !!state.auto) cb.checked = !!state.auto;
}

$('rangeTabs').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  setRange(b.getAttribute('data-r'), true);
};
// ---------------- 屏幕自适应（任意分辨率都看得清） ----------------
// 大屏按 1920×1080 设计，三种铺开方式：
//   contain 等比适配：整屏等比缩放居中，任何分辨率版式都不乱
//   fill    铺满全屏：横纵分别拉伸填满；屏幕比例与 16:9 差太多时自动限制拉伸，字不会被拉扁
//   flow    流式：不缩放，随窗口宽度自动折行，适合小窗口 / 多屏并排
//
// 关键：所有字号都乘一个全局倍率 --fs-scale。
//   「自动」= 反向补偿缩放，保证屏幕上的字永远不小于设计稿（小屏自动放大，最多 1.35 倍）；
//   也可以拖滑杆手动固定一个倍率（80%~160%）。
const BASE_W = 1920, BASE_H = 1080;
const BASE_FONT = 14;              // 设计稿表格正文字号，用来换算「屏幕上实际多少 px」
const FIT_KEY = 'dash-fit';
const SCALE_KEY = 'dash-uiscale';  // 'auto' 或 0.8~1.6 的数字
const SCALE_AUTO_MIN = 0.95;       // 自动下限：大屏上字已经够大，不主动缩小
const SCALE_AUTO_MAX = 1.35;       // 自动上限：小屏补偿到此为止，避免撑破版式
const FITS = [
  { id: 'contain', name: '等比适配', desc: '整屏等比缩放居中，4K / 2K / 1366 版式都不乱（最通用）', w: 100, h: 56 },
  { id: 'fill', name: '铺满全屏', desc: '横竖分别拉伸填满屏幕；比例与 16:9 差太多时自动限制拉伸，字不会变形', w: 100, h: 56 },
  { id: 'flow', name: '流式布局', desc: '不缩放，随窗口宽度自动折行，适合小窗口或多屏并排', w: 92, h: 62 },
];
function currentFit() {
  try { const v = localStorage.getItem(FIT_KEY); return FITS.some(f => f.id === v) ? v : 'contain'; } catch (e) { return 'contain'; }
}
function currentScalePref() {
  try {
    const v = localStorage.getItem(SCALE_KEY);
    if (v === 'auto' || v == null || v === '') return 'auto';
    const n = parseFloat(v);
    return (isFinite(n) && n >= 0.8 && n <= 1.6) ? n : 'auto';
  } catch (e) { return 'auto'; }
}
function setScalePref(v) { try { localStorage.setItem(SCALE_KEY, String(v)); } catch (e) { } }
/** 当前模式把设计稿缩到了多少倍（flow 不缩放，恒为 1） */
function fitScaleOf(mode) {
  const vw = window.innerWidth || BASE_W, vh = window.innerHeight || BASE_H;
  if (mode === 'flow') return 1;
  const s = Math.min(vw / BASE_W, vh / BASE_H);
  return s > 0.05 ? s : 1;
}
/** 自动字号：把「被缩放吃掉的字号」补回来，保证屏幕上的字不小于设计稿 */
function resolveScale(mode) {
  const pref = currentScalePref();
  if (pref !== 'auto') return pref;
  const f = fitScaleOf(mode) || 1;
  return Math.min(SCALE_AUTO_MAX, Math.max(SCALE_AUTO_MIN, 1 / f));
}
/** 按当前屏幕比例推荐一种铺法 */
function recommendFit() {
  const vw = window.innerWidth || BASE_W, vh = window.innerHeight || BASE_H;
  if (vw < 1500 || vh < 780) return 'flow';
  const ar = vw / vh, base = BASE_W / BASE_H;
  if (Math.abs(ar - base) / base < 0.06) return 'fill';
  return 'contain';
}
function applyFit(mode) {
  const m = FITS.some(f => f.id === mode) ? mode : 'contain';
  try { localStorage.setItem(FIT_KEY, m); } catch (e) { }
  const b = document.body;
  b.classList.remove('fit-contain', 'fit-fill', 'fit-flow');
  b.classList.add('fit-' + m);
  const wrap = document.querySelector('.wrap');
  if (!wrap) return;
  if (m === 'flow') {
    wrap.style.width = ''; wrap.style.height = ''; wrap.style.transform = '';
    b.style.overflow = '';
  } else {
    const vw = window.innerWidth, vh = window.innerHeight;
    let sx, sy;
    if (m === 'fill') {
      sx = vw / BASE_W; sy = vh / BASE_H;
      // 超宽屏 / 竖屏比例差太多时，纵向缩放限制在横向的 ±20%，宁可留一点边也不把字拉变形
      sy = Math.min(Math.max(sy, sx * 0.8), sx * 1.2);
    } else {
      const s = Math.min(vw / BASE_W, vh / BASE_H); sx = s; sy = s;
    }
    const x = (vw - BASE_W * sx) / 2, y = (vh - BASE_H * sy) / 2;
    wrap.style.width = BASE_W + 'px';
    wrap.style.height = BASE_H + 'px';
    wrap.style.transform = `translate(${x}px, ${y}px) scale(${sx}, ${sy})`;
    b.style.overflow = 'hidden';
  }
  // 字号倍率：统一写在 <html> 上，全站 font-size 都是 calc(Npx * var(--fs-scale))
  const sc = resolveScale(m);
  document.documentElement.style.setProperty('--fs-scale', String(sc));
  syncScaleUI(sc);
  renderFitGrid();
}
function syncScaleUI(sc) {
  const sl = $('uiScale'); if (sl) sl.value = String(Math.round(sc * 100));
  const val = $('uiScaleVal'); if (val) val.textContent = Math.round(sc * 100) + '%';
  const auto = $('uiScaleAuto'); if (auto) auto.checked = currentScalePref() === 'auto';
  const hint = $('uiScaleHint');
  if (hint) {
    const f = fitScaleOf(currentFit());
    const px = BASE_FONT * f * sc;
    hint.innerHTML = `表格正文在屏幕上约 <b>${px.toFixed(1)} px</b>（标题 ${(21 * f * sc).toFixed(0)} px、大号数字 ${(52 * f * sc).toFixed(0)} px）。`
      + `拖滑杆可手动微调；取消勾选「自动」就按你设的值固定，换电脑也不变。`;
  }
}
function renderFitGrid() {
  const wrap = $('fitGrid');
  if (!wrap) return;
  const cur = currentFit();
  const rec = recommendFit();
  if ($('fitSize')) $('fitSize').textContent = `${window.innerWidth} × ${window.innerHeight}`;
  wrap.innerHTML = FITS.map(f => `
    <button class="fit-card${f.id === cur ? ' on' : ''}" data-f="${f.id}">
      <div class="f-box"><span style="width:${f.w}%;height:${f.h}%">1920 × 1080</span></div>
      <div class="f-n">${esc(f.name)}<span class="ok">${f.id === cur ? '当前' : (f.id === rec ? '推荐' : '')}</span></div>
      <div class="f-d">${esc(f.desc)}</div>
    </button>`).join('');
}
window.addEventListener('resize', () => applyFit(currentFit()));

// ---------------- 大屏背景 ----------------
const BG_KEY = 'dash.bg.v1';
const PRESET_BG = [
  { id: 'star', name: '深蓝星辰', css: 'linear-gradient(160deg,#0b1730 0%,#0e2340 45%,#081428 100%)' },
  { id: 'graphite', name: '极简石墨', css: 'linear-gradient(160deg,#1a1b26 0%,#252737 50%,#12131a 100%)' },
  { id: 'titanium', name: '苹果钛金', css: 'linear-gradient(160deg,#08090a 0%,#1c1c1e 50%,#0d0d10 100%)' },
  { id: 'neon', name: '霓虹夜行', css: 'linear-gradient(160deg,#0d0a16 0%,#2c1042 50%,#06131a 100%)' },
  { id: 'hyper', name: '澎湃橙青', css: 'linear-gradient(160deg,#08090b 0%,#2a1606 45%,#05222c 100%)' },
  { id: 'mint', name: '青竹薄荷', css: 'linear-gradient(160deg,#062018 0%,#0b3a2c 50%,#04121a 100%)' },
];
let bgState = { kind: 'none', preset: 'star', mask: 55, blur: 0, fit: 'cover' };
let bgServer = { has: false, url: '' };

function loadBg() {
  try {
    const s = JSON.parse(localStorage.getItem(BG_KEY) || 'null');
    if (s && typeof s === 'object') bgState = Object.assign(bgState, s);
  } catch (e) { }
  const MIG = { light: 'titanium', warm: 'hyper', violet: 'star' };
  if (MIG[bgState.preset]) bgState.preset = MIG[bgState.preset];
}
function saveBg() { try { localStorage.setItem(BG_KEY, JSON.stringify(bgState)); } catch (e) { } }

function applyBg() {
  const r = document.documentElement.style;
  if (bgState.kind === 'custom' && bgServer.url) {
    r.setProperty('--bg-img', `url("${bgServer.url}")`);
  } else if (bgState.kind === 'preset') {
    const p = PRESET_BG.find(x => x.id === bgState.preset) || PRESET_BG[0];
    r.setProperty('--bg-img', p.css);
  } else {
    r.setProperty('--bg-img', 'none');
  }
  r.setProperty('--bg-mask', String((Number(bgState.mask) || 0) / 100));
  r.setProperty('--bg-blur', (Number(bgState.blur) || 0) + 'px');
  r.setProperty('--bg-fit', bgState.fit === 'contain' ? 'contain' : 'cover');
  document.body.classList.toggle('has-bg', bgState.kind !== 'none');
}

async function refreshBgFromServer() {
  try {
    const r = await fetch('/api/background');
    const j = await r.json();
    bgServer = { has: !!j.has, url: j.url || '' };
    if (!bgServer.has && bgState.kind === 'custom') bgState.kind = 'none';
  } catch (e) { bgServer = { has: false, url: '' }; }
  applyBg();
}

/** 把选中的图片压到长边 1920 并转 jpeg，避免几 MB 的原图拖慢上传和渲染 */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1920;
        let w = img.width, h = img.height;
        const scale = Math.min(1, max / Math.max(w, h));
        w = Math.round(w * scale); h = Math.round(h * scale);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('图片无法读取'));
      img.src = String(fr.result);
    };
    fr.onerror = () => reject(new Error('文件读取失败'));
    fr.readAsDataURL(file);
  });
}

function renderBgGrid() {
  const grid = $('bgGrid');
  if (!grid) return;
  const cur = bgState.kind === 'preset' ? bgState.preset : '';
  const noneCard = `
    <button class="th-card${bgState.kind === 'none' ? ' on' : ''}" data-p="__none">
      <div class="th-prev" style="background:linear-gradient(160deg,#2a2f3a,#1b1f28)">
        <span class="bg-none-tip">不显示底图</span>
      </div>
      <div class="th-name">无背景<span class="ok">${bgState.kind === 'none' ? '当前' : '默认'}</span></div>
      <div class="th-desc">只用主题自带的纯色底色</div>
    </button>`;
  grid.innerHTML = noneCard + PRESET_BG.map(p => `
    <button class="th-card${p.id === cur ? ' on' : ''}" data-p="${p.id}">
      <div class="th-prev" style="background:${p.css}"><span class="bg-none-tip"></span></div>
      <div class="th-name">${esc(p.name)}<span class="ok">${p.id === cur ? '当前' : '内置'}</span></div>
    </button>`).join('')
    + `<button class="th-card${bgState.kind === 'custom' ? ' on' : ''}" data-p="__custom">
        <div class="th-prev" style="${bgServer.url ? `background-image:url('${bgServer.url}');background-size:cover;background-position:center` : ''}">
          ${bgServer.url ? '' : '<span class="bg-none-tip">未上传</span>'}
        </div>
        <div class="th-name">我的图片<span class="ok">${bgState.kind === 'custom' ? '当前' : '上传'}</span></div>
        <div class="th-desc">点下方「上传我的图片…」选一张本机图片（照片、海报都行）</div>
      </button>`;
}

/** 背景现在是「界面设置」里的一个分页，这里只负责把控件同步成当前状态 */
function refreshBgPane() {
  renderBgGrid();
  const m = $('bgMask'); if (m) m.value = bgState.mask;
  const b = $('bgBlur'); if (b) b.value = bgState.blur;
  const f = $('bgFit'); if (f) f.value = bgState.fit || 'cover';
}
function initBg() {
  loadBg();
  bindBgEvents();
  refreshBgFromServer();
}

async function uploadBg(file) {
  const tip = $('uiTip');
  if (!file) return;
  tip.textContent = '正在处理图片…';
  try {
    const dataUrl = await compressImage(file);
    tip.textContent = `正在上传（${(dataUrl.length / 1024 / 1024).toFixed(2)} MB）…`;
    const r = await fetch('/api/background', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '上传失败');
    bgState.kind = 'custom';
    saveBg();
    bgServer = { has: true, url: j.url };
    applyBg();
    renderBgGrid();
    tip.textContent = '背景已更新。若觉得盖住数据看不清，把下面的「压暗程度」调大。';
  } catch (e) {
    tip.textContent = '上传失败：' + e.message;
  }
}

function bindBgEvents() {
  const grid = $('bgGrid');
  if (grid) {
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('button[data-p]');
      if (!card) return;
      const p = card.getAttribute('data-p');
      if (p === '__none') {
        bgState.kind = 'none';
      } else if (p === '__custom') {
        if (!bgServer.has) { if ($('uiTip')) $('uiTip').textContent = '请先点「上传我的图片…」选择一张本机图片'; return; }
        bgState.kind = 'custom';
      } else {
        bgState.kind = 'preset';
        bgState.preset = p;
      }
      saveBg(); applyBg(); renderBgGrid();
    });
  }
  const file = $('bgFile');
  if (file) file.addEventListener('change', () => { uploadBg(file.files && file.files[0]); file.value = ''; });
  const up = $('bgUpload');
  if (up && file) up.onclick = () => file.click();
  const del = $('bgRemove');
  if (del) del.onclick = async () => {
    try { await fetch('/api/background', { method: 'DELETE' }); } catch (e) { }
    bgState.kind = 'none'; bgServer = { has: false, url: '' };
    saveBg(); applyBg(); renderBgGrid();
    if ($('uiTip')) $('uiTip').textContent = '已移除上传的图片，恢复主题底色。';
  };
  const mask = $('bgMask');
  if (mask) mask.oninput = () => { bgState.mask = Number(mask.value); saveBg(); applyBg(); };
  const blur = $('bgBlur');
  if (blur) blur.oninput = () => { bgState.blur = Number(blur.value); saveBg(); applyBg(); };
  const fit = $('bgFit');
  if (fit) fit.onchange = () => { bgState.fit = fit.value; saveBg(); applyBg(); };
}

// ---------------- 界面风格（主题） ----------------
const THEMES = [
  { id: '', name: '深蓝星辰', kind: '经典', desc: '沉稳专业，长时间盯屏也不刺眼（默认）', c: ['#38bdf8', '#22d3ee', '#0ea5e9', '#7dd3fc'] },
  { id: 'graphite', name: '极简石墨', kind: '简约', desc: '低饱和冷灰，几乎没有装饰，看着最安静', c: ['#7aa2f7', '#7dcfff', '#9ece6a', '#e0af68'] },
  { id: 'titanium', name: '苹果钛金', kind: '时尚', desc: '钛金属灰阶 + 系统蓝青，克制高级的果味高级感', c: ['#2997ff', '#64d2ff', '#ffd60a', '#ff375f'] },
  { id: 'neon', name: '霓虹夜行', kind: '时尚', desc: '近黑底 + 撞色霓虹，潮流感强', c: ['#ff2d95', '#00e5ff', '#ffd166', '#86efac'] },
  { id: 'hyper', name: '澎湃橙青', kind: '时尚', desc: '小米风：黑底品牌橙撞湖蓝，年轻有冲劲', c: ['#ff6900', '#00c6ff', '#ffb302', '#00d26a'] },
  { id: 'mint', name: '青竹薄荷', kind: '清爽', desc: '青绿清爽，看得久也不累', c: ['#2dd4bf', '#34d399', '#14b8a6', '#fde047'] },
];
const THEME_KEY = 'dash-theme';

function currentTheme() {
  let v = '';
  try { v = localStorage.getItem(THEME_KEY) || ''; } catch (e) { }
  // 旧版已下架的主题自动迁移：晨曦浅昼→苹果钛金，暖阳橙金→澎湃橙青
  const MIGRATE = { light: 'titanium', warm: 'hyper', violet: 'graphite' };
  if (MIGRATE[v]) { v = MIGRATE[v]; try { localStorage.setItem(THEME_KEY, v); } catch (e) { } }
  return v;
}
function applyTheme(id) {
  const t = THEMES.find(x => x.id === id) ? id : '';
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem(THEME_KEY, t); } catch (e) { }
  if ($('uiTip')) $('uiTip').textContent = '已应用：' + (THEMES.find(x => x.id === t) || THEMES[0]).name;
  renderThemeGrid();
}
function renderThemeGrid() {
  const wrap = $('themeGrid');
  if (!wrap) return;
  const cur = currentTheme();
  const PREV_BG = { '': '#0b1730', graphite: '#1a1b26', titanium: '#0a0a0c', neon: '#0d0a16', hyper: '#0d0f12', mint: '#062018' };
  wrap.innerHTML = THEMES.map(t => `
    <button class="th-card${t.id === cur ? ' on' : ''}" data-t="${t.id}">
      <div class="th-prev" style="background:${PREV_BG[t.id] || '#0b1730'}">
        ${t.c.map(c => `<i style="background:${c}"></i>`).join('')}
      </div>
      <div class="th-name">${esc(t.name)}<span class="ok">${t.id === cur ? '当前' : esc(t.kind)}</span></div>
      <div class="th-desc">${esc(t.desc)}</div>
    </button>`).join('');
}
// ---------------- 界面设置（风格 / 屏幕适配 / 背景 / 运行） ----------------
const UI_PANES = { theme: 'uiPaneTheme', fit: 'uiPaneFit', bg: 'uiPaneBg', run: 'uiPaneRun', store: 'uiPaneStore', account: 'uiPaneAccount', update: 'uiPaneUpdate' };
function switchUiTab(name) {
  for (const [k, id] of Object.entries(UI_PANES)) {
    const el = $(id);
    if (el) el.style.display = k === name ? '' : 'none';
  }
  for (const b of document.querySelectorAll('#uiModal .tab-btn')) {
    b.classList.toggle('active', b.getAttribute('data-uitab') === name);
  }
  if (name === 'bg') refreshBgPane();
  if (name === 'run') refreshKeeper();
  if (name === 'store') refreshBranches();
  if (name === 'account') { refreshAccounts(); syncuiStoreTabs(); }
  if (name === 'update') refreshUpdate();
}
function openUiModal() {
  renderThemeGrid();
  renderFitGrid();
  refreshBgPane();
  const sz = $('fitSize');
  if (sz) sz.textContent = `${window.screen.width} × ${window.screen.height}`;
  const cb = $('uiAuto');
  if (cb) cb.checked = !!state.auto;
  if ($('uiTip')) $('uiTip').textContent = '';
  $('uiModal').style.display = 'flex';
  switchUiTab('theme');
  refreshKeeper();
  refreshFetchPolicy();
}

// ---------------- 抓取策略：营业时段 / 刷新频率 / 对外限速 ----------------
async function refreshFetchPolicy() {
  try {
    const j = await fetch('/api/fetch-policy', { cache: 'no-store' }).then(r => r.json());
    if (!j || !j.ok) return;
    if ($('fpOpen')) $('fpOpen').value = j.openTime;
    if ($('fpClose')) $('fpClose').value = j.closeTime;
    if ($('fpToday')) $('fpToday').value = j.todayIntervalMin;
    if ($('fpRate')) $('fpRate').value = j.ratePerMinute;
    if ($('fpHistory')) $('fpHistory').checked = !!j.historyOncePerDay;
    if ($('fpQuiet')) $('fpQuiet').checked = !!j.quietOutsideHours;
    const tag = $('fetchTag');
    if (tag) {
      tag.textContent = j.open ? '营业中·自动取数' : '闭店中·不联网';
      tag.className = 'run-tag ' + (j.open ? 'ok' : 'warn');
    }
    const st = $('fpStat');
    if (st && j.stats) {
      let txt = `今天已向厂家发起 ${j.stats.todayRequests} 个请求（上限 ${j.stats.limitPerMinute}/分钟）`;
      const b = j.stats.breaker;
      if (b && (b.level > 0 || b.cooling)) {
        txt += ` · ⚠ 已被限流 ${b.hits} 次，熔断器降至 L${b.level}`;
        if (b.cooling && b.cooldownRemainSec > 0) txt += `（冷却中，${b.cooldownRemainSec} 秒后放行）`;
        st.style.color = '#ff7d00';
      } else {
        st.style.color = '';
      }
      st.textContent = txt;
    }
  } catch (e) { /* 读不到就保持默认显示 */ }
}
async function saveFetchPolicy() {
  const tip = $('fpStat');
  const body = {
    openTime: ($('fpOpen') && $('fpOpen').value) || '09:00',
    closeTime: ($('fpClose') && $('fpClose').value) || '22:30',
    todayIntervalMin: Number($('fpToday') && $('fpToday').value) || 5,
    ratePerMinute: Number($('fpRate') && $('fpRate').value) || 30,
    historyOncePerDay: !$('fpHistory') || $('fpHistory').checked,
    quietOutsideHours: !$('fpQuiet') || $('fpQuiet').checked,
  };
  if (tip) tip.textContent = '保存中…';
  try {
    const j = await fetch('/api/fetch-policy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(r => r.json());
    if (j && j.ok) { if (tip) tip.textContent = '已保存，立即生效'; refreshFetchPolicy(); }
    else if (tip) tip.textContent = '保存失败：' + ((j && j.error) || '未知错误');
  } catch (e) { if (tip) tip.textContent = '保存失败：' + e.message; }
}

// ---------------- 运行：开机自启 + 后台守护（取代原来的右下角托盘） ----------------
let keeperState = null;
async function refreshKeeper() {
  const tag = $('runTag');
  if (tag) { tag.textContent = '检查中…'; tag.className = 'run-tag'; }
  try {
    keeperState = await fetch('/api/keeper', { cache: 'no-store' }).then(r => r.json());
  } catch (e) { keeperState = null; }
  const k = keeperState || {};
  if (tag) {
    const on = !!k.on;
    tag.textContent = on ? '已开启' : '未开启';
    tag.className = 'run-tag ' + (on ? 'ok' : 'warn');
  }
  const boot = $('uiBoot'); if (boot) boot.checked = !!k.on;
}
async function setKeeperOn(on) {
  const tip = $('uiTip');
  if (tip) tip.textContent = on ? '正在开启开机自启与后台守护…' : '正在关闭…';
  try {
    const j = await fetch('/api/keeper?on=' + (on ? '1' : '0'), { method: 'POST' }).then(r => r.json());
    await refreshKeeper();
    if (tip) {
      tip.textContent = j.ok
        ? (on ? '已开启：开机自动启动，被关掉后最多 5 分钟自动拉回来' : '已关闭：程序关掉后不会再自己启动')
        : ('设置失败：' + (j.error || '没有权限，可手动把 exe 快捷方式放进「启动」文件夹'));
    }
  } catch (e) { if (tip) tip.textContent = '设置失败：' + e.message; }
}
// ---------------- 软件更新：自动检查 / 安装 / 回滚 ----------------
let upState = null;
let upTimer = null;
let updating = false;      // 已经进入「下载→替换→重启」流程

function upTip(t) { const e = $('upTip'); if (e) e.textContent = t || ''; }

/** 重启期间服务会短暂失联：复用启动遮罩告诉用户别慌，回来后自动刷新页面 */
function showUpdatingMask(step) {
  const b = $('boot');
  if (!b) return;
  b.style.display = 'flex';
  const logo = b.querySelector('.logo');
  if (logo) logo.textContent = '正在安装更新';
  const s = $('bootStep'); if (s) s.textContent = step || '正在下载更新包…';
  const h = $('bootHint');
  if (h) h.textContent = '程序会自动换文件并重新启动，大约半分钟，期间不用操作，本页会自动回到大屏。';
}

async function refreshUpdate() {
  let j = null, offline = false;
  try {
    j = await fetch('/api/update/status', { cache: 'no-store' }).then(r => r.json());
  } catch (e) { offline = true; }
  if (offline || !j || !j.ok) {
    if (updating) {
      showUpdatingMask('程序正在重启…');
      clearTimeout(upTimer);
      upTimer = setTimeout(refreshUpdate, 2500);
    } else {
      upTip('读取更新状态失败');
    }
    return;
  }
  upState = j;
  const tag = $('upTag');
  if (tag) { tag.textContent = j.enabled ? '已开启' : '未开启'; tag.className = 'run-tag ' + (j.enabled ? 'ok' : 'warn'); }
  const auto = $('upAuto'); if (auto) auto.checked = !!j.enabled;
  const ver = $('upVer');
  if (ver) ver.textContent = 'v' + (j.current && j.current.version) + (j.current && j.current.build ? '（' + j.current.build + '）' : '');
  const last = $('upLast');
  if (last) {
    last.textContent = j.lastCheckAt
      ? new Date(j.lastCheckAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      + (j.source ? ' · 源 ' + j.source : '')
      : '还没检查过';
  }
  const log = $('upLog');
  if (log) {
    const lv = j.latest ? ('v' + j.latest.version + (j.latest.build ? '（' + j.latest.build + '）' : '')) : '';
    if (j.hasUpdate && j.latest) {
      log.textContent = '发现新版本 ' + lv + '\n\n' + (j.latest.changelog || '（这次没有写更新说明）');
    } else if (j.latest) {
      log.textContent = '已是最新版本 ' + lv + '\n\n' + (j.latest.changelog || '');
    } else {
      log.textContent = '还没检查过更新';
    }
  }
  const err = $('upErr');
  if (err) err.textContent = j.lastError ? '上次失败：' + j.lastError : '';
  const rb = $('upRollback');
  if (rb) {
    rb.style.display = j.backup && j.backup.version ? '' : 'none';
    rb.textContent = `回滚到 v${j.backup.version}`;
  }
  const instBtn = $('upInstall');
  if (instBtn) instBtn.style.display = j.hasUpdate ? '' : 'none';

  // 进度
  const pw = $('upProgress'), bar = $('upBar'), ph = $('upPhase');
  if (j.installing) {
    updating = true;
    if (pw) pw.style.display = '';
    if (bar) bar.style.width = (j.installing.percent || 0) + '%';
    if (ph) ph.textContent = j.installing.phase + '…' + (j.installing.version ? '（v' + j.installing.version + '）' : '');
    showUpdatingMask(j.installing.phase === '等待重启' ? '正在替换文件并重启…' : (j.installing.phase + '…'));
    clearTimeout(upTimer);
    upTimer = setTimeout(refreshUpdate, 2000);
  } else {
    if (pw) pw.style.display = 'none';
    if (updating) {
      // 安装流程结束（成功重启或失败），刷新页面回到干净状态
      updating = false;
      location.reload();
      return;
    }
  }
}

/** 主循环里顺带看一眼更新状态：自动安装时会自己弹出进度遮罩 */
let upWatchAt = 0;
function upWatch() {
  const now = Date.now();
  if (now - upWatchAt < 20000) return;   // 最多 20 秒一次，别把本机请求刷得太密
  upWatchAt = now;
  refreshUpdate();
}

async function upCheckNow() {
  upTip('正在检查…');
  try {
    const j = await fetch('/api/update/check', { method: 'POST' }).then(r => r.json());
    await refreshUpdate();
    upTip(j.ok ? (j.hasUpdate ? `发现新版本 v${j.latest.version}，正在自动安装` : '已是最新版本') : ('检查失败：' + (j.error || '')));
  } catch (e) { upTip('检查失败：' + e.message); }
}
async function upInstallNow() {
  if (!confirm('现在安装更新？\n\n程序会下载新版本、自动替换并重启一次（约半分钟），期间大屏会短暂中断。\n当前这版会先备份，可在同一位置「回滚」。')) return;
  updating = true;
  showUpdatingMask('正在下载更新包…');
  try {
    await fetch('/api/update/install?force=1', { method: 'POST' }).then(r => r.json());
  } catch (e) { }
  clearTimeout(upTimer);
  upTimer = setTimeout(refreshUpdate, 2000);
}
async function upRollbackNow() {
  if (!upState || !upState.backup) return;
  if (!confirm(`回滚到上一版 v${upState.backup.version}？\n\n程序会换回旧版本并重启一次。`)) return;
  updating = true;
  showUpdatingMask('正在换回上一版…');
  try { await fetch('/api/update/rollback', { method: 'POST' }).then(r => r.json()); } catch (e) { }
  clearTimeout(upTimer);
  upTimer = setTimeout(refreshUpdate, 2000);
}
async function upToggle(on) {
  try {
    await fetch('/api/update/toggle?on=' + (on ? '1' : '0'), { method: 'POST' }).then(r => r.json());
    await refreshUpdate();
    upTip(on ? '已开启：每天打开大屏时自动检查并更新' : '已关闭：只在手动点「立即检查更新」时才查');
  } catch (e) { upTip('设置失败：' + e.message); }
}

// ---------------- 账号：谁能看这块屏（仅管理员） ----------------
let userData = null;
let userEditing = '';
function userTip(msg) { const t = $('usTip'); if (t) t.textContent = msg || ''; }
async function refreshAccounts() {
  const box = $('userList');
  if (box) box.innerHTML = '<div class="run-item"><div class="run-t">读取中…</div></div>';
  try {
    userData = await fetch('/api/auth/users', { cache: 'no-store' }).then(r => r.json());
  } catch (e) { userData = null; }
  renderAccounts();
}
function renderAccounts() {
  const box = $('userList');
  if (!box || !userData || !userData.users) return;
  const tag = $('admTag');
  if (tag) {
    const on = !!userData.loginRequired;
    tag.textContent = on ? '已设置' : '未设置';
    tag.className = 'run-tag ' + (on ? 'ok' : 'warn');
  }
  const storeName = (k) => {
    if (!k) return '全部门店';
    const s = ((state.payload && state.payload.stores) || []).find(x => String(x.key) === String(k));
    return s ? s.name : k;
  };
  if (!userData.users.length) {
    box.innerHTML = '<div class="run-item"><div class="run-t">还没有员工账号</div></div>';
  } else {
    box.innerHTML = userData.users.map(u => `
      <div class="run-item">
        <div class="run-t">${esc(u.name || u.username)}<span class="run-tag ${u.role === 'admin' ? 'ok' : ''}">${u.role === 'admin' ? '管理员' : '门店账号'}</span></div>
        <div class="run-d">账号 ${esc(u.username)}　可看：${esc(storeName(u.storeKey))}　${u.hasPassword ? '' : '<b style="color:var(--up)">未设密码，无法登录</b>'}</div>
        <div class="ui-row">
          ${u.username === 'admin' ? '' : `<button class="btn btn-sm" data-uact="edit" data-n="${esc(u.username)}">编辑</button>
          <button class="btn btn-sm" data-uact="del" data-n="${esc(u.username)}">删除</button>`}
        </div>
      </div>`).join('');
  }
  const sel = $('usStore');
  if (sel) {
    const stores = (state.payload && state.payload.stores) || [];
    sel.innerHTML = '<option value="">全部门店（等同管理员权限）</option>'
      + stores.map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join('');
  }
}
function fillUserForm(username) {
  const u = ((userData && userData.users) || []).find(x => x.username === username);
  userEditing = username;
  if ($('usName')) { $('usName').value = username; $('usName').disabled = true; }
  if ($('usDisp')) $('usDisp').value = u ? (u.name || '') : '';
  if ($('usPass')) $('usPass').value = '';
  const sel = $('usStore'); if (sel) sel.value = u ? (u.storeKey || '') : '';
  const t = $('userFormTitle'); if (t) t.textContent = '修改账号：' + username + '（密码留空表示不改）';
  const c = $('usCancel'); if (c) c.style.display = '';
  userTip('');
}
function resetUserForm() {
  userEditing = '';
  for (const id of ['usName', 'usDisp', 'usPass']) if ($(id)) $(id).value = '';
  if ($('usName')) $('usName').disabled = false;
  const sel = $('usStore'); if (sel) sel.value = '';
  const t = $('userFormTitle'); if (t) t.textContent = '新增账号';
  const c = $('usCancel'); if (c) c.style.display = 'none';
  userTip('');
}
async function saveUser() {
  if (!needAdmin()) return;
  const username = (userEditing || (($('usName') || {}).value || '')).trim();
  const password = (($('usPass') || {}).value || '');
  const name = (($('usDisp') || {}).value || '').trim();
  const storeKey = (($('usStore') || {}).value || '');
  if (!username) { userTip('请填账号'); return; }
  if (!userEditing && !password) { userTip('新账号请设密码'); return; }
  userTip('保存中…');
  try {
    const res = await fetch('/api/auth/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, name, storeKey }),
    });
    const j = await res.json().catch(() => ({ ok: false, error: '服务器返回异常' }));
    if (!j.ok) { userTip('保存失败：' + (j.error || '未知')); return; }
    userData = j;
    renderAccounts();
    resetUserForm();
    userTip('已保存。把账号密码发给门店，登录后就只能看到自己那家店。');
  } catch (e) { userTip('保存失败：' + e.message); }
}
async function saveAdminPassword() {
  if (!needAdmin()) return;
  const password = (($('admPass') || {}).value || '');
  const ok = password
    ? confirm('设置管理员口令后，增删门店、改设置需要先用 admin 登录。\n\n（看数据不受影响，仍然打开即看）\n\n确定设置吗？')
    : confirm('取消口令后，打开的人都能改门店和设置。\n\n确定取消吗？');
  if (!ok) return;
  try {
    const j = await fetch('/api/auth/admin-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }).then(r => r.json());
    if (!j.ok) { alert('设置失败：' + (j.error || '未知')); return; }
    if ($('admPass')) $('admPass').value = '';
    state.loginRequired = !!j.loginRequired;
    if (j.loginRequired) { state.me = { username: 'admin', name: '管理员', role: 'admin', storeKey: '' }; renderAuthBtn(); applyRoleScope(); }
    userData = j;
    renderAccounts();
    alert(j.loginRequired ? '已设置管理员口令：改门店/改设置要登录，这台电脑已自动登录，下次免登录。' : '已取消管理员口令。');
  } catch (e) { alert('设置失败：' + e.message); }
}
async function userAction(act, username) {
  if (!needAdmin()) return;
  if (act === 'edit') { fillUserForm(username); return; }
  if (act === 'del') {
    if (!confirm('删除账号 ' + username + '？该账号将不能再登录。')) return;
    const j = await fetch('/api/auth/users/remove?username=' + encodeURIComponent(username), { method: 'POST' }).then(r => r.json());
    if (!j.ok) { userTip('删除失败：' + (j.error || '未知')); return; }
    userData = j; renderAccounts(); resetUserForm();
  }
}

// ---------------- 门店自助管理：以后开新店只在界面上填一次 ----------------
let branchData = null;
let branchEditing = '';
function branchTip(msg) { const t = $('brTip'); if (t) t.textContent = msg || ''; }
async function refreshBranches() {
  const box = $('branchList');
  if (box) box.innerHTML = '<div class="run-item"><div class="run-t">读取中…</div></div>';
  try { branchData = await fetch('/api/branches', { cache: 'no-store' }).then(r => r.json()); }
  catch (e) { branchData = null; }
  renderBranches();
}
function renderBranches() {
  const box = $('branchList');
  if (!box || !branchData || !branchData.items) return;
  const items = branchData.items;
  if (!items.length) {
    box.innerHTML = '<div class="run-item"><div class="run-t">还没有配置门店</div>'
      + '<div class="run-d">在下面填入商户ID、账号、密码和显示名，点「测试连接并保存」即可。</div></div>';
  } else {
    box.innerHTML = items.map(b => {
      const st = b.lastOk === null ? ['', '未取数'] : (b.lastOk ? ['ok', '取数正常'] : ['warn', '取数失败']);
      const err = b.lastOk === false && b.lastError ? `<div class="run-d" style="color:var(--up)">${esc(b.lastError)}</div>` : '';
      return `<div class="run-item">
        <div class="run-t">${esc(b.alias)}<span class="run-tag ${st[0]}">${st[1]}</span></div>
        <div class="run-d">商户ID ${esc(b.tenantCode)}　账号 ${esc(b.userAccount)}　${b.hasPassword ? '密码已保存' : '<b style="color:var(--up)">密码未填写</b>'}</div>
        ${err}
        <div class="ui-row">
          <button class="btn btn-sm" data-bact="edit" data-c="${esc(b.tenantCode)}">编辑</button>
          <button class="btn btn-sm" data-bact="toggle" data-c="${esc(b.tenantCode)}" data-on="${b.enabled ? '0' : '1'}">${b.enabled ? '停用' : '启用'}</button>
          <button class="btn btn-sm" data-bact="del" data-c="${esc(b.tenantCode)}">删除</button>
        </div>
      </div>`;
    }).join('');
  }
  const f = $('brFile');
  if (f) f.textContent = `配置保存在：${branchData.file}${branchData.exists ? '' : '（保存第一个门店后自动生成）'}　也可以直接用记事本改这个文件。`;
  const ms = $('msCount');
  if (ms) ms.textContent = items.length ? `当前 ${items.length} 家门店会被导出。` : '';
}
function fillBranchForm(code) {
  const b = (branchData && branchData.items || []).find(x => x.tenantCode === code);
  branchEditing = code;
  if ($('brCode')) { $('brCode').value = code; $('brCode').disabled = true; }
  if ($('brUser')) $('brUser').value = b ? b.userAccount : '9999';
  if ($('brPass')) $('brPass').value = '';
  if ($('brAlias')) $('brAlias').value = b ? b.alias : '';
  const t = $('branchFormTitle'); if (t) t.textContent = '修改门店：' + code + '（密码留空表示沿用原来的）';
  const c = $('brCancel'); if (c) c.style.display = '';
  branchTip('');
}
function resetBranchForm() {
  branchEditing = '';
  for (const id of ['brCode', 'brPass', 'brAlias']) if ($(id)) $(id).value = '';
  if ($('brCode')) $('brCode').disabled = false;
  if ($('brUser')) $('brUser').value = '9999';
  const t = $('branchFormTitle'); if (t) t.textContent = '新增门店';
  const c = $('brCancel'); if (c) c.style.display = 'none';
  branchTip('');
}
async function testBranch() {
  const code = ($('brCode') || {}).value || '';
  const password = ($('brPass') || {}).value || '';
  const userAccount = ($('brUser') || {}).value || '9999';
  if (!code.trim()) { branchTip('请先填商户ID'); return false; }
  if (!branchEditing && !password.trim()) { branchTip('新门店请先填密码'); return false; }
  branchTip('正在测试连接…');
  try {
    const j = await fetch('/api/branches/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantCode: code.trim(), password, userAccount }),
    }).then(r => r.json());
    if (!j.ok) { branchTip('连接失败：' + (j.error || '未知')); return false; }
    branchTip(`连接成功：${j.tenantName || ''} 共 ${j.branchCount} 个分店（${j.elapsed}s）`);
    return true;
  } catch (e) { branchTip('连接失败：' + e.message); return false; }
}
async function saveBranch() {
  if (!needAdmin()) return;
  if (!(await testBranch())) return;
  const code = branchEditing || (($('brCode') || {}).value || '').trim();
  const body = {
    tenantCode: code,
    userAccount: (($('brUser') || {}).value || '9999').trim(),
    password: ($('brPass') || {}).value || '',
    alias: (($('brAlias') || {}).value || '').trim(),
  };
  if (!body.alias) body.alias = code;
  branchTip('保存中…');
  try {
    const j = await fetch('/api/branches', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(r => r.json());
    if (!j.ok) { branchTip('保存失败：' + (j.error || '未知')); return; }
    branchData = j;
    renderBranches();
    resetBranchForm();
    branchTip('已保存，正在开始抓取这家店的数据…');
    load(false);
  } catch (e) { branchTip('保存失败：' + e.message); }
}
async function branchAction(act, code, extra) {
  if (act === 'edit') { fillBranchForm(code); return; }
  if (act === 'toggle') {
    if (!confirm(code + ' 的取数要' + (extra === '1' ? '启用' : '停用') + '，继续吗？')) return;
    await fetch('/api/branches/enable?tenantCode=' + encodeURIComponent(code) + '&on=' + extra, { method: 'POST' });
    await refreshBranches(); load(false);
    return;
  }
  if (act === 'del') {
    if (!confirm('确定删除门店 ' + code + '？删除后大屏上不再显示它的数据。')) return;
    const j = await fetch('/api/branches/remove?tenantCode=' + encodeURIComponent(code), { method: 'POST' }).then(r => r.json());
    if (j && !j.ok) { branchTip('删除失败：' + (j.error || '未知')); return; }
    if (j) branchData = j;
    renderBranches();
    resetBranchForm();
    branchTip('已删除，正在重算数据…');
    load(false);
  }
}

// ---------------- 门店入口：一个门店一个网址 ----------------
async function openEntries() {
  $('entryModal').style.display = 'flex';
  $('entryTip').textContent = '';
  $('entryHint').textContent = '加载中…';
  $('entryList').innerHTML = '';
  let j = null;
  try { j = await fetch('/api/entries', { cache: 'no-store' }).then(r => r.json()); } catch (e) { }
  if (!j || !j.entries) { $('entryHint').textContent = '取不到入口信息，请刷新页面重试。'; return; }
  const base = j.primary || '';
  $('entryHint').innerHTML = `本机房大屏地址：<b>${esc(base.replace(/\/$/, ''))}</b>（端口 ${esc(String(j.port))}）。`
    + '把对应门店的网址发给门店电脑收藏，打开后只会看到本店数据。';
  $('entryList').innerHTML = j.entries.map(e => `
    <div class="entry-row">
      <div class="entry-n">${esc(e.name)}</div>
      <input class="entry-u" readonly value="${esc(e.url)}" data-url="${esc(e.url)}" />
      <div class="entry-b">
        <button class="btn btn-sm" data-act="copy" data-u="${esc(e.url)}">复制网址</button>
        <button class="btn btn-sm" data-act="open" data-u="${esc(e.url)}">打开</button>
        <button class="btn btn-sm" data-act="desk" data-s="${esc(e.key)}">桌面快捷方式</button>
      </div>
    </div>`).join('');
}
async function entryAction(act, u, s) {
  const tip = $('entryTip');
  if (act === 'open') { window.open(u, '_blank'); return; }
  if (act === 'copy') {
    try { await navigator.clipboard.writeText(u); tip.textContent = '已复制：' + u; }
    catch (e) { tip.textContent = '复制失败，请手动选中网址复制'; }
    return;
  }
  if (act === 'desk') {
    tip.textContent = '正在创建桌面快捷方式…';
    try {
      const j = await fetch('/api/entries/shortcut?to=desktop&store=' + encodeURIComponent(s || ''), { method: 'POST' }).then(r => r.json());
      tip.textContent = j.ok ? ('已创建：' + j.file) : ('创建失败：' + (j.error || '未知'));
    } catch (e) { tip.textContent = '创建失败：' + e.message; }
  }
}

// ---------------- 屏保 ----------------
let saverInfo = null;
const MIN_CHOICES = [1, 3, 5, 10, 15, 30, 60];

async function openSaverModal() {
  $('saverModal').style.display = 'flex';
  $('saverTip').textContent = '';
  $('saverBody').innerHTML = '<div class="empty">读取本机屏保设置…</div>';
  try { saverInfo = await fetch('/api/saver/status', { cache: 'no-store' }).then(r => r.json()); } catch (e) { saverInfo = null; }
  renderSaverBody();
}

function curMinutes() {
  const j = saverInfo || {};
  if (j.timeoutSec) return Math.max(1, Math.round(j.timeoutSec / 60));
  return Number(localStorage.getItem('dash-idle-min') || 10);
}

function renderSaverBody() {
  const j = saverInfo || {};
  const on = !!j.currentIsOurs && !!j.systemActive;
  const mins = curMinutes();
  const idleOn = localStorage.getItem('dash-idle') !== '0';   // 默认开：没碰过设置就是自动全屏
  const idleMin = Number(localStorage.getItem('dash-idle-min') || 10);
  const sea = j.sea !== false;

  const badge = on
    ? '<div class="sg-hint" style="color:var(--accent);font-size:calc(14px * var(--fs-scale))">● 已设为这台电脑的屏保：闲置 ' + mins + ' 分钟后自动全屏</div>'
    : (sea
      ? '<div class="sg-hint" style="color:var(--warn,#e8a33d);font-size:calc(14px * var(--fs-scale))">○ 还没设为系统屏保</div>'
      : '<div class="sg-hint">当前是源码开发模式，系统屏保请用打包出来的 exe 打开后再设置</div>');

  const opts = MIN_CHOICES.map(m => `<option value="${m}" ${m === mins ? 'selected' : ''}>${m} 分钟</option>`).join('');
  const idleOpts = MIN_CHOICES.map(m => `<option value="${m}" ${m === idleMin ? 'selected' : ''}>${m} 分钟</option>`).join('');

  const html = badge + `
  <div class="sm-row" style="margin-top:10px">
    <span><b>方案一：空闲自动全屏（推荐，不用动系统设置）</b>
      <span class="sm-desc">大屏页面没人操作超过设定时间，自动铺满全屏当屏保；动一下鼠标或按任意键立刻回到界面。<b>不需要管理员权限</b>，一定能生效。</span>
    </span>
  </div>
  <div class="ui-row" style="margin-top:8px;align-items:center">
    <label class="mini-switch"><input type="checkbox" id="idleOn" ${idleOn ? 'checked' : ''}><span>启用</span></label>
    <span class="sg-hint" style="margin:0">闲置</span>
    <select id="idleMin" class="sel" style="width:auto">${idleOpts}</select>
    <button class="btn btn-sm" id="idleTry">现在试一下</button>
  </div>

  <div class="sm-row" style="margin-top:14px">
    <span><b>方案二：接入 Windows 系统屏保</b>
      <span class="sm-desc">把系统屏保直接指向本程序，写入当前用户注册表，不需要管理员、也不用去下拉里选。<b>注意：部分机器（如 Win11 IoT / 数字标牌模式、被策略管理的电脑）系统本身会禁用屏保，此时请用方案一。</b></span>
    </span>
  </div>
  <div class="ui-row" style="margin-top:8px;align-items:center">
    <span class="sg-hint" style="margin:0">等待</span>
    <select id="svMin" class="sel" style="width:auto">${opts}</select>
    <button class="btn ${on ? '' : 'btn-primary'}" id="svToggle">${on ? '停用系统屏保' : '一键设为系统屏保'}</button>
    <button class="btn btn-sm" id="svOpen">Windows 屏保设置…</button>
  </div>
  <div class="sg-hint" style="margin:6px 0 0">
    当前系统屏保：<b>${esc(j.current || '（未设置）')}</b>${j.systemCopy ? '<br>检测到旧版本留在系统目录的副本，建议点右侧「清理旧副本」删掉，避免版本过期' : ''}
  </div>

  <div class="ui-row" style="margin-top:12px">
    <button class="btn btn-sm" id="svFull">立即全屏体验</button>
    ${j.systemCopy ? '<button class="btn btn-sm" id="svClean">清理旧副本</button>' : ''}
    <span class="tip" style="margin-left:6px">全屏后动一下鼠标即退出</span>
  </div>`;

  $('saverBody').innerHTML = html;

  const bind = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };

  bind('idleOn', 'change', (e) => {
    localStorage.setItem('dash-idle', e.target.checked ? '1' : '0');
    setupIdleFullscreen();
    tip('已' + (e.target.checked ? '开启' : '关闭') + '空闲自动全屏');
  });
  bind('idleMin', 'change', (e) => {
    localStorage.setItem('dash-idle-min', e.target.value);
    setupIdleFullscreen();
    tip('空闲 ' + e.target.value + ' 分钟后自动全屏');
  });
  bind('idleTry', 'click', () => enterIdleFullscreen(true));
  bind('svMin', 'change', async (e) => {
    const r = await fetch('/api/saver/minutes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes: Number(e.target.value) }),
    }).then(r => r.json()).catch(() => ({}));
    tip(r.ok ? '等待时间已改为 ' + e.target.value + ' 分钟' : ('修改失败：' + (r.error || '未知')));
    if (r.ok) { await openSaverModal(); }
  });
  bind('svToggle', 'click', async () => {
    if (on) {
      const r = await fetch('/api/saver/disable', { method: 'POST' }).then(r => r.json()).catch(() => ({}));
      tip(r.ok ? '已停用系统屏保' : ('停用失败：' + (r.error || '未知')));
    } else {
      const mins2 = Number(($('svMin') || {}).value || 10);
      const r = await fetch('/api/saver/enable', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes: mins2 }),
      }).then(r => r.json()).catch(() => ({}));
      if (!r.ok) { tip('设置失败：' + (r.error || '未知')); return; }
      tip(r.IMMEDIATE === '1'
        ? '已设为系统屏保，立即生效（闲置 ' + mins2 + ' 分钟自动全屏）'
        : '已写入设置。这台机器不允许即时刷新，注销或重启一次后生效');
    }
    await openSaverModal();
  });
  bind('svOpen', 'click', async () => {
    await fetch('/api/saver/settings', { method: 'POST' }).catch(() => { });
    tip('已打开 Windows 屏保设置（本程序不再需要在这里手工选择）');
  });
  bind('svFull', 'click', async () => {
    tip('正在打开全屏窗口…');
    try {
      const r = await fetch('/api/saver/start', { method: 'POST' }).then(r => r.json());
      tip(r.ok ? '已全屏，动一下鼠标退出' : ('启动失败：' + (r.error || '未知')));
    } catch (e) { tip('启动失败：' + e.message); }
  });
  bind('svClean', 'click', async () => {
    const r = await fetch('/api/saver/cleanup', { method: 'POST' }).then(r => r.json()).catch(() => ({}));
    tip(r.ok ? '旧副本已清理' : ('清理失败：' + (r.error || '需要管理员权限')));
    if (r.ok) await openSaverModal();
  });

  function tip(t) { $('saverTip').textContent = t; }
}

// -------- 空闲自动全屏：不依赖 Windows 任何设置，权限受限的机器上也能当屏保用 --------
const idle = { timer: null, active: false, last: 0 };
function idleMinutes() {
  return Number(localStorage.getItem('dash-idle-min') || 10);
}
async function enterIdleFullscreen(manual) {
  if (idle.active && !manual) return;
  idle.active = true;
  document.body.classList.add('saver');
  document.body.classList.add('idle-fullscreen');
  // 先试浏览器自带全屏（无手势时多半会被拒绝），不行就让服务端开一个真正的全屏窗口
  let got = false;
  const el = document.documentElement;
  if (el.requestFullscreen) {
    try { await el.requestFullscreen(); got = !!document.fullscreenElement; } catch (e) { }
  }
  if (!got) {
    try { await fetch('/api/saver/start', { method: 'POST' }); } catch (e) { }
  }
}

async function exitIdleFullscreen() {
  if (!idle.active) return;
  idle.active = false;
  document.body.classList.remove('idle-fullscreen');
  if (document.fullscreenElement && document.exitFullscreen) {
    try { document.exitFullscreen(); } catch (e) { }
  }
  // 关掉服务端开出来的全屏窗口（普通数据服务不会被这条请求关停）
  try { await fetch('/api/saver/exit', { cache: 'no-store' }); } catch (e) { }
}
function setupIdleFullscreen() {
  // 已经是系统屏保画面时不要再叠加自动全屏
  if (new URLSearchParams(location.search).get('saver') === '1') return;
  const on = localStorage.getItem('dash-idle') !== '0';   // 同上，默认开
  const ms = Math.max(1, idleMinutes()) * 60 * 1000;
  if (idle.timer) { clearInterval(idle.timer); idle.timer = null; }
  if (!on) { exitIdleFullscreen(); return; }
  idle.last = Date.now();
  idle.timer = setInterval(() => {
    if (idle.active) return;
    if (Date.now() - idle.last > ms) enterIdleFullscreen(false);
  }, 15000);
}
function initIdleWatch() {
  const kick = () => { idle.last = Date.now(); if (idle.active) setTimeout(exitIdleFullscreen, 0); };
  for (const ev of ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'input']) {
    window.addEventListener(ev, kick, { passive: true });
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) idle.last = Date.now(); });
  setupIdleFullscreen();
}

// ---------------- 屏保画面：鼠标一动 / 按任意键就退出 ----------------
function initSaverMode() {
  const q = new URLSearchParams(location.search);
  if (q.get('saver') !== '1') return;
  document.body.classList.add('saver');
  let fired = false;
  let lastX = null, lastY = null;
  const exit = () => {
    if (fired) return;
    fired = true;
    fetch('/api/saver/exit', { cache: 'no-store' }).catch(() => { });
    // 兜底：万一服务没来得及关窗口，自己也尝试关闭
    setTimeout(() => { try { window.close(); } catch (e) { } }, 800);
  };
  const onMove = (e) => {
    const x = e.clientX, y = e.clientY;
    if (lastX === null) { lastX = x; lastY = y; return; }
    if (Math.abs(x - lastX) + Math.abs(y - lastY) > 40) exit();
  };
  window.addEventListener('mousemove', onMove, { passive: true });
  window.addEventListener('mousedown', exit);
  window.addEventListener('keydown', exit);
  window.addEventListener('wheel', exit, { passive: true });
  window.addEventListener('touchstart', exit, { passive: true });
  // 键盘 F11/ESC 也可直接关窗口
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { try { window.close(); } catch (err) { } } });
}

// ---------------- 启动遮罩 ----------------
const boot = { done: false, timer: null, tries: 0 };
async function bootTick() {
  if (boot.done) return;
  boot.tries++;
  let j = null;
  try { j = await fetch('/api/status', { cache: 'no-store' }).then(r => r.json()); } catch (e) { }
  if (!j) {
    $('bootStep').textContent = '正在连接本机服务…';
    if (boot.tries > 20) $('bootHint').textContent = '连不上本机服务。若是双击 exe 打开的，请查看 exe 旁的「运行日志.txt」；也可以重新双击一次 exe。';
    return;
  }
  const vl = $('verLine');
  if (vl && j.version) vl.textContent = `${j.appName || '门店经营数据大屏'} v${j.version}（构建 ${j.build || '-'}）· 本机端口 ${j.port || 8765}`;
  const pr = j.progress || {};
  const tot = pr.total || 3, dn = pr.done || 0;
  // 只要本机已经存着一份今日数据就先放人进去（哪怕它已经过期，后台会接着刷新），
  // 第一次安装、数据库里还没有任何快照时才需要等它抓完。
  const rt = j.ranges && j.ranges.today;
  // partial 也要放行：阶段一（销售 / 库存 / 实时）一好就该让人进大屏，
  // 季节与供应商在页面里继续补。以前只认 ok，等于要把商品档案全拉完才揭遮罩。
  const done = !!rt && (rt.status === 'ok' || rt.status === 'error' || rt.status === 'partial');
  if (done) {
    $('bootStep').textContent = '数据已就绪，正在进入大屏…';
    $('bootBar').style.width = '100%';
    await load(false);
    hideBoot();
    return;
  }
  const pct = pr.stage && pr.stage !== 'idle' ? Math.min(92, Math.round((dn / tot) * 92)) : 6;
  $('bootBar').style.width = pct + '%';
  const label = !pr.stage || pr.stage === 'idle' ? '正在启动服务…'
    : pr.stage === 'login' ? '正在登录 ' + (pr.current || '') + '…'
      : pr.stage === 'fetch' ? `正在抓取「${pr.current || ''}」的销售与库存（${dn + 1}/${tot}）`
        : pr.stage === 'deep' ? `销售与库存已就绪，正在后台补季节 / 供应商（${pr.deepDone || 0}/${tot}）`
          : '正在汇总计算…';
  $('bootStep').textContent = label + (pr.elapsed ? `  已用 ${pr.elapsed}s` : '');
  if (boot.tries > 100) $('bootHint').textContent = '抓取比平时慢，可能是后台接口限流。请继续等待，或查看 exe 旁的「运行日志.txt」。';
}
function hideBoot() {
  if (boot.done) return;
  boot.done = true;
  if (boot.timer) clearInterval(boot.timer);
  const el = $('boot');
  el.classList.add('hide');
  setTimeout(() => { el.style.display = 'none'; }, 500);
}

$('btnRefresh').onclick = () => load(true);
$('btnUi').onclick = openUiModal;
$('uiClose').onclick = () => { $('uiModal').style.display = 'none'; };
$('uiModal').onclick = (e) => { if (e.target === $('uiModal')) $('uiModal').style.display = 'none'; };
for (const b of document.querySelectorAll('#uiModal .tab-btn')) {
  b.onclick = () => switchUiTab(b.getAttribute('data-uitab'));
}
$('uiAuto').onchange = (e) => setAuto(e.target.checked);
// 软件更新
if ($('upAuto')) $('upAuto').onchange = (e) => upToggle(e.target.checked);
if ($('upCheck')) $('upCheck').onclick = upCheckNow;
if ($('upInstall')) $('upInstall').onclick = upInstallNow;
if ($('upRollback')) $('upRollback').onclick = upRollbackNow;
$('uiBoot').onchange = (e) => setKeeperOn(e.target.checked);
if ($('fpSave')) $('fpSave').onclick = saveFetchPolicy;
// 字号：拖滑杆即改为手动；勾回「自动」交还给系统按屏幕补偿
$('uiScale').oninput = (e) => {
  setScalePref(Number(e.target.value) / 100);
  applyFit(currentFit());
};
$('uiScaleAuto').onchange = (e) => {
  if (e.target.checked) setScalePref('auto');
  else setScalePref(Math.round(resolveScale(currentFit()) * 100) / 100);
  applyFit(currentFit());
};
$('uiSaver').onclick = () => { openSaverModal(); };
// 环境自检：换电脑部署后先按一下，看缺什么（浏览器 / VC++ 运行库 / PowerShell / 网络 …）
$('uiDoctor').onclick = async () => {
  const box = $('doctorBox');
  if (!box) return;
  box.style.display = '';
  box.innerHTML = '<div class="run-item"><div class="run-t">正在检测…</div><div class="run-d">会检查系统、浏览器、运行库、PowerShell、端口和零售云平台服务器连通性。</div></div>';
  let j = null;
  try { j = await fetch('/api/doctor', { cache: 'no-store' }).then(r => r.json()); } catch (e) { j = null; }
  if (!j) { box.innerHTML = '<div class="run-item"><div class="run-t" style="color:var(--warn)">检测失败</div><div class="run-d">连不上本机服务，请重新双击 exe。</div></div>'; return; }
  const rows = (j.items || []).map(i => (
    `<div class="run-item">
       <div class="run-t">${i.ok ? '正常' : '需处理'} · ${i.name}</div>
       <div class="run-d">${i.detail || ''}${i.fix ? '<br><span style="color:var(--accent)">→ ' + i.fix + '</span>' : ''}</div>
     </div>`
  )).join('');
  box.innerHTML = `<div class="run-item"><div class="run-t">${j.ok ? '环境正常' : '有 ' + (j.items || []).filter(i => !i.ok).length + ' 项需要处理'}</div><div class="run-d">版本 v${j.version || '-'}（构建 ${j.build || '-'}）　数据目录：${j.dataDir || '-'}</div></div>` + rows;
};
$('uiQuit').onclick = async () => {
  if (!confirm('退出后大屏停止取数（守护会在 5 分钟内把它拉回来）。确定退出吗？')) return;
  try { await fetch('/api/shutdown', { method: 'POST' }); } catch (e) { }
  const t = $('uiTip'); if (t) t.textContent = '已退出，3 秒后可关闭本页。';
};
// 门店入口
$('btnEntries').onclick = openEntries;
$('entryClose').onclick = () => { $('entryModal').style.display = 'none'; };
$('entryDone').onclick = () => { $('entryModal').style.display = 'none'; };
$('entryModal').onclick = (e) => { if (e.target === $('entryModal')) $('entryModal').style.display = 'none'; };
$('entryList').onclick = (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  entryAction(b.getAttribute('data-act'), b.getAttribute('data-u') || '', b.getAttribute('data-s') || '');
};
$('entryFolder').onclick = async () => {
  const tip = $('entryTip');
  tip.textContent = '正在生成…';
  try {
    const j = await fetch('/api/entries/shortcut?to=folder&store=', { method: 'POST' }).then(r => r.json());
    tip.textContent = j.ok ? ('已生成：' + j.file) : ('生成失败：' + (j.error || '未知'));
  } catch (e) { tip.textContent = '生成失败：' + e.message; }
};
$('hdrStore').onchange = (e) => {
  const v = e.target.value || '';
  state.store = v;
  try { if (v) localStorage.setItem(STORE_KEY, v); else localStorage.removeItem(STORE_KEY); } catch (err) { }
  syncPanelStores();
  // 换门店只是换「看哪一家」，数据已经在服务端手里了，不用重新抓取（以前这里会全量重抓一次）
  load(false);
};
$('saverClose').onclick = () => { $('saverModal').style.display = 'none'; };
$('saverModal').onclick = (e) => { if (e.target === $('saverModal')) $('saverModal').style.display = 'none'; };
$('fitGrid').onclick = (e) => {
  const card = e.target.closest('.fit-card');
  if (!card) return;
  applyFit(card.getAttribute('data-f'));
};
$('themeGrid').onclick = (e) => {
  const card = e.target.closest('.th-card');
  if (!card) return;
  applyTheme(card.getAttribute('data-t'));
};
// 账号（仅管理员可见）
// 同步到手机 App：把本机配置的门店清单做成一段文本，发到手机上粘贴导入
async function genMobileSync(withPwd) {
  const tip = $('msTip'), box = $('msText');
  if (!box) return;
  try {
    const r = await fetch('/api/mobile-sync' + (withPwd ? '?pwd=1' : ''), { cache: 'no-store' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '生成失败');
    box.value = j.text;
    if (tip) {
      tip.textContent = `已生成 ${j.count} 家门店的配置`
        + (j.withPwd ? '（含密码，请勿发给外人）' : '（不含密码，导入后在手机上补一次密码）')
        + '：点「复制文本」后发到微信，手机 App 里「设置 → 粘贴导入配置」粘进去即可。';
    }
  } catch (e) {
    if (tip) tip.textContent = '生成失败：' + (e.message || e);
  }
}
if ($('msGen')) $('msGen').onclick = () => genMobileSync(false);
if ($('msGenPwd')) $('msGenPwd').onclick = () => genMobileSync(true);
if ($('msCopy')) $('msCopy').onclick = () => {
  const box = $('msText'), tip = $('msTip');
  if (!box || !box.value) { if (tip) tip.textContent = '先点上面的按钮生成配置文本。'; return; }
  try {
    box.select(); box.setSelectionRange(0, 999999);
    const ok = document.execCommand('copy');
    if (tip) tip.textContent = ok ? '已复制，到微信里粘贴发送即可。' : '自动复制失败，请手动选中文本框里的全部内容复制。';
  } catch (e) { if (tip) tip.textContent = '请手动选中文本框里的全部内容复制。'; }
};

$('brSave').onclick = saveBranch;
$('brCancel').onclick = resetBranchForm;
$('branchList').onclick = (e) => {
  const b = e.target.closest('button[data-bact]');
  if (!b) return;
  branchAction(b.getAttribute('data-bact'), b.getAttribute('data-c') || '', b.getAttribute('data-on') || '');
};
// 登录
$('btnAuth').onclick = () => {
  if (state.me) return doLogout();
  openLogin('', state.me && state.me.role === 'admin' ? 'admin' : 'store');
};
$('lgGo').onclick = doLogin;
$('loginModal').onclick = (e) => { if (e.target === $('loginModal')) closeLogin(); };
for (const b of document.querySelectorAll('#loginModal .tab-btn')) {
  b.onclick = () => switchLoginMode(b.getAttribute('data-lgmode'));
}
for (const id of ['lgPass', 'lgUser', 'lgAdminPass', 'lgTenant', 'lgAccount']) {
  const el = $(id);
  if (el) el.onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
}
// 账号管理
$('admSave').onclick = saveAdminPassword;
if ($('admReset')) $('admReset').onclick = async () => {
  if (!needAdmin()) return;
  if (!confirm('清除管理员口令？\n\n清除后，在这台电脑上打开的人都能改门店和设置（看数据本来就不需要登录）。')) return;
  try {
    const j = await fetch('/api/auth/admin-password/reset', { method: 'POST' }).then(r => r.json());
    if (!j.ok) { alert('清除失败：' + (j.error || '未知')); return; }
    state.loginRequired = false; state.me = null;
    renderAuthBtn(); applyRoleScope();
    userData = j; renderAccounts();
    alert('已清除管理员口令。');
  } catch (e) { alert('清除失败：' + e.message); }
};
$('usSave').onclick = saveUser;
$('usCancel').onclick = resetUserForm;
$('userList').onclick = (e) => {
  const b = e.target.closest('button[data-uact]');
  if (!b) return;
  userAction(b.getAttribute('data-uact'), b.getAttribute('data-n') || '');
};

// 表头点击排序（从多到少 ⇄ 从少到多）
$('matrixWrap').onclick = (e) => {
  const th = e.target.closest('th[data-c]');
  if (th) {
    const c = th.getAttribute('data-c');
    const s = state.matrixSort;
    if (s.col === c) s.dir = s.dir === 'desc' ? 'asc' : 'desc';
    else { s.col = c; s.dir = 'desc'; }
    renderMatrix(state.payload || {});
    return;
  }
  // 点大类行：展开 / 收起该大类下的小类（与中列「各大类销售数量与库存」同一套交互）
  const tr = e.target.closest('tr.mc[data-mcat]');
  if (tr) {
    const name = tr.getAttribute('data-mcat');
    state.matrixOpen = state.matrixOpen || {};
    if (state.matrixOpen[name]) delete state.matrixOpen[name]; else state.matrixOpen[name] = 1;
    renderMatrix(state.payload || {});
  }
};
$('catQtyWrap').onclick = (e) => {
  // 子视图切换：小类 / 供应商（必须先判断，避免和行展开冲突）
  const tab = e.target.closest('[data-sub]');
  if (tab && !tab.disabled) {
    const prow = tab.closest('tr[data-cat]');
    const name = prow && prow.getAttribute('data-cat');
    if (name) {
      state.catSubView = state.catSubView || {};
      state.catSubView[name] = tab.getAttribute('data-sub');
      renderCatQty(state.payload || {});
    }
    return;
  }
  const th = e.target.closest('th[data-c]');
  if (th) {
    const c = th.getAttribute('data-c');
    const s = state.catSort;
    if (s.col === c) s.dir = s.dir === 'desc' ? 'asc' : 'desc';
    else { s.col = c; s.dir = 'desc'; }
    renderCatQty(state.payload || {});
    return;
  }
  // 点大类行：展开 / 收起这个大类（下面默认显示小类，可切供应商）
  const tr = e.target.closest('tr.cq[data-cat]');
  if (tr) {
    const name = tr.getAttribute('data-cat');
    state.catVendorOpen = state.catVendorOpen || {};
    if (state.catVendorOpen[name]) delete state.catVendorOpen[name]; else state.catVendorOpen[name] = 1;
    renderCatQty(state.payload || {});
    return;
  }
  // 「展开全部 / 收起」（供应商榜）
  const m = e.target.closest('[data-more]');
  if (m) {
    const name = m.getAttribute('data-more');
    state.catVendorMore = state.catVendorMore || {};
    if (state.catVendorMore[name]) delete state.catVendorMore[name]; else state.catVendorMore[name] = 1;
    renderCatQty(state.payload || {});
  }
};
$('seasonStore').onchange = (e) => { state.seasonStore = e.target.value; renderSeason(state.payload || {}); };

// 供应商榜：切档（本日 / 本周 / 本年）
if ($('sdClose')) $('sdClose').onclick = () => { $('sdModal').style.display = 'none'; };
if ($('sdModal')) $('sdModal').onclick = (e) => { if (e.target === $('sdModal')) $('sdModal').style.display = 'none'; };
$('catStore').onchange = (e) => { state.catStore = e.target.value; renderCatQty(state.payload || {}); };
$('btnSeason').onclick = openSeasonModal;
$('seasonClose').onclick = () => { $('seasonModal').style.display = 'none'; };
$('seasonModal').onclick = (e) => { if (e.target === $('seasonModal')) $('seasonModal').style.display = 'none'; };
$('seasonSave').onclick = saveSeasonMap;
$('seasonReset').onclick = resetSeasonRules;
for (const b of document.querySelectorAll('#seasonModal .tab-btn')) {
  b.onclick = () => switchSeasonTab(b.getAttribute('data-tab'));
}
setInterval(() => {
  if (loading) return;
  // 页面在后台（切了标签页/最小化）时不轮询：这时没人看，白白让服务端去判定刷新
  if (document.hidden) return;
  state.countdown -= 1;
  if (state.countdown <= 0) { state.countdown = 9999; load(false); }

  // 自动轮播：实时 → 昨天 → 本周 → 本月 → 上月，每 15 秒切一档
  // 首屏还没出数据时先不轮播，避免切到空档位触发一串重新抓取
  if (!state.auto || !boot.done) return;
  state.autoLeft -= 1;
  if (state.autoLeft <= 0) {
    state.autoIdx = (state.autoIdx + 1) % RANGE_CYCLE.length;
    setRange(RANGE_CYCLE[state.autoIdx], false, true);
    state.autoLeft = AUTO_SEC;
  }
  refreshAutoBtn();
}, 1000);

applyTheme(currentTheme());
applyFit(currentFit());
initAuto();
initBg();
initSaverMode();
initIdleWatch();
renderStoreSelect();
refreshAutoBtn();
// 先看要不要登录：登录过就免登录直接进（cookie 自动带上）
(async () => {
  const st = await loadAuthState();
  if (st) {
    state.loginRequired = !!st.loginRequired;
    state.me = st.user || null;
  }
  renderAuthBtn();
  syncuiStoreTabs();
  initStore();
  applyRoleScope();
  bootTick();
  boot.timer = setInterval(bootTick, 1500);
  load(false);
  // 网址带 ?login=1 直接弹出登录框：可以把这个链接发给新门店，让它自己接进来
  if (/[?&]login=1\b/.test(location.search)) setTimeout(() => openLogin('', 'store'), 400);
  // 注意：看数据永远不需要登录，所以这里不弹登录框。
  // 登录只用于「接入新门店」和「获得管理员权限」，要用的人自己点右上角。
})();
setTimeout(() => { if (!boot.done) load(false); }, 600);   // 兜底：即便 status 异常也开始渲染
