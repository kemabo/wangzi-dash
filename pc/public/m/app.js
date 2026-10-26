'use strict';
/* 王子鞋服经营数据 · 手机版 v1.7.0
 * 取数：手机自己直连零售云平台云（与零售云平台官方 App 同一套登录与签名），不经过大屏电脑。
 * 登录：一个门店账号 = 一家门店，登录谁就看谁；全部门店都登录后，才解锁「全部门店」。
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const K = {
    acct: 'dm.accounts', snap: 'dm.snapshots', theme: 'dm.theme', range: 'dm.range',
    store: 'dm.store', catTab: 'dm.catTab', trendTab: 'dm.trendTab', trend: 'dm.trend',
    vendorTab: 'dm.vendorTab', fold: 'dm.fold', cacheVer: 'dm.cacheVer', rate: 'dm.rate',
    cache: 'dm.view.', season: 'dm.season.', vendor: 'dm.vendor.',
  };
  const CACHE_VER = 4;          // 缓存口径版本：升级后作废旧缓存
  const TREND_TTL = 6 * 3600e3;
  const SEASON_TTL = { today: 30 * 60e3, _: 6 * 3600e3 };
  const RANGES = [
    { key: 'today', name: '今日' }, { key: 'yesterday', name: '昨日' },
    { key: 'thisWeek', name: '本周' }, { key: 'thisMonth', name: '本月' }, { key: 'lastMonth', name: '上月' },
  ];
  const S = {
    page: 'login', range: 'today', store: 'all', view: null, loading: false,
    catTab: 'sale', trendTab: 'week', trend: null, trendLoading: false,
    season: null, seasonLoading: false, vendor: null, vendorLoading: false, vendorTab: 'today',
    fold: {}, guardTimer: 0, openCat: {}, openVendor: {},
  };

  // ---------- 存储 ----------
  function load(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  const accounts = () => load(K.acct, []);
  const saveAccts = (list) => save(K.acct, list);
  const snapshots = () => load(K.snap, {});
  // 已登录 = 登录校验通过过（密码在、且拿到过票据）
  const loggedAccts = () => accounts().filter(a => a.logged && a.password);

  // ---------- 格式化 ----------
  function money(v) {
    const n = Number(v) || 0;
    if (Math.abs(n) >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function moneyFull(v) { return Math.round(Number(v) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function int(v) { return Math.round(Number(v) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function pct(v) { return (Number(v) || 0).toFixed(1) + '%'; }
  function timeStr(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // 核心取数模块可以用本机缓存（分店清单 / 类别 / 库存这些慢变量）
  if (window.DashCore && window.DashCore.setCacheStore) {
    window.DashCore.setCacheStore({ get: (k) => load('dm.rc.' + k, null), set: (k, v) => save('dm.rc.' + k, v) });
  }
  function migrateCache() {
    const ver = Number(load(K.cacheVer, 0)) || 0;
    if (ver >= CACHE_VER) return;
    try {
      const dead = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.indexOf('dm.rc.s') === 0 || k.indexOf('dm.season.') === 0)) dead.push(k);
      }
      dead.forEach(k => localStorage.removeItem(k));
    } catch (e) { }
    save(K.cacheVer, CACHE_VER);
  }

  // =====================================================================
  // 登录页：门店账号（登录谁看谁）
  // =====================================================================
  function seedPresets() {
    const list = accounts();
    const presets = window.DASH_PRESETS || [];
    if (!presets.length) return list;
    let changed = false;
    for (const p of presets) {
      if (!list.some(a => String(a.tenantCode) === String(p.tenantCode))) {
        list.push({ alias: p.alias || p.tenantCode, tenantCode: String(p.tenantCode), userAccount: p.userAccount || '9999', password: '', logged: false, tenantName: '' });
        changed = true;
      }
    }
    if (changed) saveAccts(list);
    return list;
  }

  function loginStats() {
    const all = accounts();
    const ok = all.filter(a => a.logged && a.password);
    return { all: all.length, ok: ok.length, full: all.length > 0 && ok.length === all.length };
  }

  function renderLogin() {
    const list = accounts();
    const openIdx = S.openAcct;
    $('acctList').innerHTML = list.map((a, i) => {
      const ok = !!(a.logged && a.password);
      const head = '<div class="acct ' + (ok ? 'ok' : 'wait') + '" data-acct="' + i + '">'
        + '<div class="r1"><span class="nm">' + esc(a.alias || a.tenantCode) + '</span>'
        + '<span class="st">' + (ok ? '已登录' : '待登录') + '</span></div>'
        + '<div class="r2"><span>' + esc(a.tenantCode) + ' / ' + esc(a.userAccount || '9999')
        + (a.tenantName ? ' · ' + esc(a.tenantName) : '') + '</span>'
        + '<span>' + (ok ? '<b>' + esc(a.alias) + '</b> 已可查看' : '点击输入密码') + '</span></div></div>';
      if (openIdx !== i) return head;
      return head + '<div class="acct-form" data-form="' + i + '">'
        + '<div class="field"><label>门店名称</label><input data-f="alias" value="' + esc(a.alias || '') + '" /></div>'
        + '<div class="mini"><div class="field"><label>商户ID</label><input data-f="tenantCode" inputmode="numeric" value="' + esc(a.tenantCode) + '" /></div>'
        + '<div class="field"><label>账号</label><input data-f="userAccount" value="' + esc(a.userAccount || '9999') + '" /></div></div>'
        + '<div class="field"><label>密码（零售云平台后台登录密码）</label><input data-f="password" type="password" value="' + esc(a.password || '') + '" /></div>'
        + '<div class="btnrow"><button class="btn sm primary" data-act="login" data-i="' + i + '">登录并保存</button>'
        + '<button class="btn sm ghost" data-act="cancel" data-i="' + i + '">取消</button>'
        + (ok ? '<button class="btn sm ghost" data-act="logout" data-i="' + i + '">退出</button>' : '<button class="btn sm ghost" data-act="del" data-i="' + i + '">删除</button>')
        + '</div></div>';
    }).join('') || '<div class="empty">还没有门店账号，点下面「添加门店账号」</div>';

    const st = loginStats();
    const bar = $('loginBar');
    bar.className = 'lg-bar' + (st.full ? ' full' : '');
    bar.innerHTML = st.full
      ? '已登录 <b>' + st.ok + '/' + st.all + '</b> 家 · 已解锁「全部门店」（可看汇总与跨店对比）'
      : '已登录 <b>' + st.ok + '/' + st.all + '</b> 家 · 还有 <b>' + (st.all - st.ok) + '</b> 家没登录，登录后才能看「全部门店」';
    $('btnEnter').disabled = st.ok === 0;
    $('btnEnter').textContent = st.ok ? '进入数据（' + st.ok + ' 家）' : '先登录至少一家门店';
  }

  async function doLogin(i) {
    const form = document.querySelector('[data-form="' + i + '"]');
    const list = accounts();
    const a = Object.assign({}, list[i]);
    if (form) {
      form.querySelectorAll('input[data-f]').forEach(el => { a[el.getAttribute('data-f')] = el.value.trim(); });
    }
    if (!a.tenantCode || !a.password) { toast('请填商户ID和密码'); return; }
    const btn = form && form.querySelector('[data-act="login"]');
    if (btn) { btn.disabled = true; btn.textContent = '登录中…'; }
    try {
      const r = await window.DashCore.testAccount(a);
      a.logged = true;
      a.tenantName = r.tenantName || a.tenantCode;
      a.branchCount = (r.branches || []).length;
      list[i] = a; saveAccts(list);
      const snaps = snapshots(); snaps[a.tenantCode] = r.snapshot; save(K.snap, snaps);
      S.openAcct = null;
      renderLogin();
      toast('已登录：' + (a.tenantName || a.alias) + (a.branchCount ? '（含 ' + a.branchCount + ' 个分店）' : ''));
    } catch (e) {
      toast('登录失败：' + String((e && e.message) || e));
      if (btn) { btn.disabled = false; btn.textContent = '登录并保存'; }
    }
  }

  async function loginOthersWithSamePwd() {
    const list = accounts();
    const src = list.find(a => a.logged && a.password);
    if (!src) { toast('先登录一家门店，再用这个密码登录其余门店'); return; }
    const todo = list.filter(a => !a.logged);
    if (!todo.length) { toast('所有门店都已登录'); return; }
    $('btnSamePwd').disabled = true;
    for (const a of todo) {
      const i = accounts().findIndex(x => String(x.tenantCode) === String(a.tenantCode));
      if (i < 0) continue;
      const cur = accounts(); const t = Object.assign({}, cur[i], { password: src.password });
      try {
        const r = await window.DashCore.testAccount(t);
        t.logged = true; t.tenantName = r.tenantName || t.tenantCode; t.branchCount = (r.branches || []).length;
        cur[i] = t; saveAccts(cur);
        const snaps = snapshots(); snaps[t.tenantCode] = r.snapshot; save(K.snap, snaps);
      } catch (e) {
        t.logged = false; cur[i] = t; saveAccts(cur);
        toast((t.alias || t.tenantCode) + ' 登录失败：' + String((e && e.message) || e));
        break;
      }
      renderLogin();
    }
    $('btnSamePwd').disabled = false;
    renderLogin();
  }

  function addAcct() {
    const list = accounts();
    list.push({ alias: '新门店', tenantCode: '', userAccount: '9999', password: '', logged: false, tenantName: '' });
    saveAccts(list);
    S.openAcct = list.length - 1;
    renderLogin();
  }

  function logoutAcct(i) {
    const list = accounts();
    const a = list[i];
    a.logged = false; a.password = ''; a.tenantName = '';
    saveAccts(list);
    const snaps = snapshots(); delete snaps[a.tenantCode]; save(K.snap, snaps);
    if (String(S.store) === String(a.tenantCode)) { S.store = 'all'; save(K.store, 'all'); }
    S.openAcct = null; renderLogin();
    toast('已退出 ' + (a.alias || a.tenantCode));
  }

  function delAcct(i) {
    const list = accounts();
    const a = list[i];
    list.splice(i, 1); saveAccts(list);
    const snaps = snapshots(); delete snaps[a.tenantCode]; save(K.snap, snaps);
    S.openAcct = null; renderLogin();
  }

  // =====================================================================
  // 主界面
  // =====================================================================
  function showPage(p) {
    S.page = p;
    $('loginPage').classList.toggle('on', p === 'login');
    $('mainPage').classList.toggle('on', p === 'main');
    if (p === 'main') { renderChips(); if (!S.view) refresh(false); }
  }

  function curAccts() {
    const ok = loggedAccts();
    if (S.store === 'all') return ok;
    return ok.filter(a => String(a.tenantCode) === String(S.store));
  }
  function storeKeyOf() { return S.store === 'all' ? 'all' : String(S.store); }

  function renderChips() {
    $('rangeChips').innerHTML = RANGES.map(r =>
      '<div class="chip' + (r.key === S.range ? ' on' : '') + '" data-range="' + r.key + '">' + r.name + '</div>').join('');
    const ok = loggedAccts();
    const st = loginStats();
    const allLocked = !st.full;
    let html = '<div class="chip' + (S.store === 'all' ? ' on' : '') + (allLocked ? ' lock' : '') + '" data-store="all">全部门店'
      + (allLocked ? ' 🔒' : '') + '</div>';
    html += ok.map(a => '<div class="chip' + (String(S.store) === String(a.tenantCode) ? ' on' : '') + '" data-store="'
      + esc(a.tenantCode) + '">' + esc(a.alias || a.tenantCode) + '</div>').join('');
    $('storeChips').innerHTML = html;
    const name = S.store === 'all' ? '全部门店' : ((ok.find(a => String(a.tenantCode) === String(S.store)) || {}).alias || S.store);
    $('topStore').textContent = name;
    if (S.store === 'all' && allLocked) {
      // 没登录齐：不允许看全部，直接落到第一家已登录门店
      if (ok.length) { S.store = String(ok[0].tenantCode); save(K.store, S.store); renderChips(); return; }
    }
  }

  function progress(p, text) {
    const bar = $('pg');
    bar.classList.toggle('on', p < 1);
    bar.firstElementChild.style.width = Math.round(p * 100) + '%';
    if (text) $('topUpd').textContent = text;
  }
  function toast(msg) {
    const el = $('errBox');
    el.innerHTML = '<div class="err">' + esc(msg) + '</div>';
    setTimeout(() => { if (el.firstChild) el.innerHTML = ''; }, 5000);
  }

  async function runAll(accts, fn) {
    const snaps = snapshots();
    return Promise.all(accts.map(async (a) => {
      const acct = Object.assign({}, a, { snapshot: snaps[a.tenantCode] || null });
      try {
        const r = await fn(acct, a);
        if (r && r.snapshot) { snaps[a.tenantCode] = r.snapshot; save(K.snap, snaps); }
        return r;
      } catch (e) {
        return { tenantCode: a.tenantCode, alias: a.alias, ok: false, error: String((e && e.message) || e) };
      }
    }));
  }
  function guardBlocked() {
    if (!window.DashCore || !window.DashCore.status) return false;
    const st = window.DashCore.status();
    if (!st.limited) return false;
    progress(1, '限流保护中 ' + st.waitSec + 's');
    if (!S.guardTimer) {
      S.guardTimer = setInterval(() => {
        renderGuard();
        const s = window.DashCore.status();
        if (!s.limited) { clearInterval(S.guardTimer); S.guardTimer = 0; refresh(false); }
      }, 2000);
    }
    return true;
  }
  function renderGuard() {
    const el = $('guardBox');
    if (!el || !window.DashCore || !window.DashCore.status) return;
    const st = window.DashCore.status();
    if (!st.limited) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.textContent = '厂家限流保护中：已暂停取数，' + st.waitSec + ' 秒后自动恢复（不影响门店收银）' + (st.reason ? ' · ' + st.reason : '');
  }

  async function refresh(manual) {
    if (S.loading) return;
    renderGuard();
    if (guardBlocked()) return;
    const accts = curAccts();
    if (!accts.length) { showPage('login'); return; }
    S.loading = true;
    $('btnRefresh').classList.add('spin');
    progress(0.1, '取数中…');
    // ① 快通道：每店 1~2 个请求，先出实时销售额
    const quick = await runAll(accts, (a) => window.DashCore.collectQuick(a, S.range));
    const qv = window.DashCore.buildMobile(quick, S.range);
    if (qv.okCount) { S.view = qv; save(K.cache + S.range + '.' + storeKeyOf(), S.view); render(); }
    // ② 后台补齐库存等慢数据，复用快通道结果
    progress(0.45, '补齐库存…');
    const results = await runAll(accts, (a) => {
      const q = quick.find(x => x && String(x.tenantCode) === String(a.tenantCode)) || {};
      return window.DashCore.collectAccount(a, S.range, null, { home: q.home, cat: q.cat, daily: q.daily });
    });
    const built = window.DashCore.buildMobile(results, S.range);
    const prev = S.view;
    const had = prev && prev.totals && (Number(prev.totals.sale) || Number(prev.totals.qty));
    if (!built.okCount && had) { built.errors = (prev.errors || []).concat(built.errors || []); S.view = prev; }
    else { S.view = built; save(K.cache + S.range + '.' + storeKeyOf(), S.view); }
    S.loading = false;
    $('btnRefresh').classList.remove('spin');
    progress(1, '');
    render();
    renderGuard();
    if ((built.errors || []).length) toast('部分门店取数失败：' + built.errors.map(e => (e.alias || e.tenantCode) + ' ' + e.error).join('；'));
    setTimeout(() => loadTrend(false), 300);
  }

  // ---------- 取当前视图的数据 ----------
  function curTotals() {
    const v = S.view || {};
    const sk = storeKeyOf();
    if (sk === 'all') return v.totals || {};
    const s = (v.stores || []).find(x => String(x.key) === sk);
    if (!s) return v.totals || {};
    return {
      sale: s.sale, qty: s.qty, profit: s.profit, stockQty: s.stockQty, stockCost: s.stockCost,
      customers: (v.totals || {}).customers, avgPrice: (v.totals || {}).avgPrice,
      profitRate: s.sale > 0 ? s.profit / s.sale * 100 : 0,
    };
  }
  function curCats() {
    const v = S.view || {};
    const sk = storeKeyOf();
    if (sk === 'all') return (v.categories || []).slice();
    const s = (v.stores || []).find(x => String(x.key) === sk);
    return s ? (s.cats || []).slice() : [];
  }

  function barRow(name, val, max, sub, idx) {
    return '<div class="bar' + (idx ? ' rank' : '') + '"><div class="t">'
      + '<span class="n">' + (idx ? '<b>' + idx + '</b>' : '') + esc(name) + (sub ? '<span class="x">' + sub + '</span>' : '') + '</span>'
      + '<span class="v">' + moneyFull(val) + '</span></div>'
      + '<div class="track"><i style="width:' + Math.max(2, Math.round(val / (max || 1) * 100)) + '%"></i></div></div>';
  }

  function render() {
    const v = S.view;
    if (!v || !v.totals) { $('empty').style.display = ''; return; }
    $('empty').style.display = 'none';
    const t = curTotals();
    $('heroLab').textContent = (v.label || '') + '销售额';
    $('heroSale').textContent = '¥' + moneyFull(t.sale);
    $('heroProfit').textContent = money(t.profit);
    $('heroRate').textContent = pct(t.profitRate);
    $('heroQty').textContent = int(t.qty);
    $('heroStock').textContent = int(t.stockQty);
    $('kCust').textContent = int(t.customers || 0);
    $('kAvg').textContent = money(t.avgPrice || 0);
    $('kStockC').textContent = money(t.stockCost || 0);
    $('kMisc').textContent = int(t.qty || 0);
    $('topUpd').textContent = '更新 ' + timeStr(v.updatedAt);

    renderStore();
    renderCat();
    renderItem();
    renderHour();
    renderTrend();
    applyFold();
  }

  function renderStore() {
    const v = S.view || {};
    const sk = storeKeyOf();
    const list = (v.stores || []).slice().sort((a, b) => b.sale - a.sale);
    const box = $('storeBars');
    $('storeCount').textContent = list.length ? list.length + ' 家' : '';
    if (sk !== 'all' || list.length < 2) {
      $('storeBars').parentNode.parentNode.classList.add('fold');
      return;
    }
    const max = Math.max.apply(null, list.map(s => s.sale).concat([1]));
    box.innerHTML = list.map((s, i) => barRow(s.name, s.sale, max,
      '销量 ' + int(s.qty) + ' · 毛利 ' + money(s.profit) + ' · 库存 ' + int(s.stockQty) + (s.branchCount ? ' · ' + s.branchCount + '分店' : ''), i + 1)).join('');
  }

  function renderCat() {
    const cats = curCats().sort((a, b) => b.sale - a.sale);
    const tab = S.catTab;
    $('catCount').textContent = cats.length ? cats.length + ' 类' : '';
    if (!cats.length) { $('catBody').innerHTML = '<div class="empty">暂无大类数据</div>'; return; }
    const key = tab === 'stock' ? 'stockQty' : 'sale';
    const max = Math.max.apply(null, cats.map(c => Number(c[key]) || 0).concat([1]));
    const sk = storeKeyOf();
    const stores = (S.view.stores || []);
    $('catBody').innerHTML = cats.map((c, i) => {
      const main = Number(c[key]) || 0;
      const sub = S.catTab === 'mix'
        ? '销 ' + money(c.sale) + ' · 存 ' + int(c.stockQty)
        : (S.catTab === 'stock' ? '成本 ' + money(c.stockCost) : '量 ' + int(c.qty) + ' · 毛利 ' + money(c.profit));
      let bd = '';
      if (sk === 'all') {
        bd = stores.map(s => {
          const cc = (s.cats || []).find(x => x.name === c.name);
          return '<div class="sv"><span>' + esc(s.name) + '</span><b>' + moneyFull(cc ? cc.sale : 0) + '</b></div>';
        }).join('');
      } else {
        bd = '<div class="sv"><span>销量</span><b>' + int(c.qty) + ' 件</b></div>'
          + '<div class="sv"><span>销售额</span><b>' + moneyFull(c.sale) + '</b></div>'
          + '<div class="sv"><span>毛利 / 毛利率</span><b>' + money(c.profit) + ' · ' + pct(c.sale ? c.profit / c.sale * 100 : 0) + '</b></div>'
          + '<div class="sv"><span>库存 / 成本</span><b>' + int(c.stockQty) + ' 件 · ' + money(c.stockCost) + '</b></div>';
      }
      return '<div class="cat' + (S.openCat[c.name] ? ' open' : '') + '" data-cat="' + esc(c.name) + '">'
        + '<div class="hd"><span class="idx">' + (i + 1) + '</span><span class="nm">' + esc(c.name)
        + '<span class="x" style="color:var(--dim2);font-size:11px"> ' + sub + '</span></span>'
        + '<span class="amt">' + (key === 'stockQty' ? int(main) : moneyFull(main)) + '</span><span class="ar">▸</span></div>'
        + '<div class="bd">' + bd + '</div></div>';
    }).join('');
  }

  function renderItem() {
    const items = (S.view.topItems || []).slice(0, 15);
    $('itemCount').textContent = items.length ? 'Top' + items.length : '';
    if (!items.length) { $('itemBody').innerHTML = '<div class="empty">仅今日实时有商品榜</div>'; return; }
    const max = Math.max.apply(null, items.map(x => x.value).concat([1]));
    $('itemBody').innerHTML = items.map((x, i) => barRow(x.name, x.value, max, '', i + 1)).join('');
  }

  function renderHour() {
    const hs = (S.view.hourly || []).slice();
    $('hourCount').textContent = hs.length ? hs.length + ' 段' : '';
    if (!hs.length) { $('hourBody').innerHTML = '<div class="empty">仅今日实时有分小时数据</div>'; return; }
    const max = Math.max.apply(null, hs.map(x => x.sale).concat([1]));
    $('hourBody').innerHTML = hs.map(x => barRow(x.hour + ':00', x.sale, max, '')).join('');
  }

  // ---------- 趋势 ----------
  async function loadTrend(force) {
    if (S.trendLoading) return;
    if (!force && S.trend && Date.now() - (S.trend.updatedAt || 0) < TREND_TTL) { renderTrend(); return; }
    if (guardBlocked()) return;
    S.trendLoading = true;
    try {
      const res = await runAll(loggedAccts(), (a) => window.DashCore.collectTrend(a));
      S.trend = window.DashCore.buildTrend(res);
      save(K.trend, S.trend);
    } catch (e) { /* 趋势失败不影响主数据 */ }
    S.trendLoading = false;
    renderTrend();
  }
  function trendList() {
    const tr = S.trend;
    if (!tr || !tr.daily) return [];
    const sk = storeKeyOf();
    if (sk !== 'all' && tr.byStore && tr.byStore[sk]) {
      return Object.keys(tr.byStore[sk]).map(d => ({ date: d, sale: tr.byStore[sk][d] })).sort((a, b) => a.date < b.date ? -1 : 1);
    }
    return tr.daily || [];
  }
  function renderTrend() {
    const all = trendList();
    if (!all.length) { $('trendBars').innerHTML = '<div class="empty">趋势数据加载中…</div>'; return; }
    const now = new Date();
    let list = all;
    if (S.trendTab === 'week') {
      const wk = new Date(now); wk.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      list = all.filter(d => d.date >= fmtDate(wk));
    } else if (S.trendTab === 'month') {
      list = all.filter(d => d.date >= fmtDate(new Date(now.getFullYear(), now.getMonth(), 1)));
    } else {
      const map = new Map();
      for (const d of all) { const k = d.date.slice(0, 7); map.set(k, (map.get(k) || 0) + d.sale); }
      list = [...map.entries()].map(([k, v]) => ({ date: k, sale: v }));
    }
    const max = Math.max.apply(null, list.map(x => x.sale).concat([1]));
    $('trendCount').textContent = list.length + ' 期';
    $('trendBars').innerHTML = list.slice(-31).map(x => barRow(x.date.slice(5), x.sale, max, '')).join('');
  }
  function fmtDate(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  // ---------- 季节 ----------
  function seasonKey() { return K.season + S.range; }
  async function loadSeason(force, withStock) {
    if (S.seasonLoading) return;
    if (guardBlocked()) return;
    const cached = load(seasonKey(), null);
    const ttl = SEASON_TTL[S.range] || SEASON_TTL._;
    if (!force && cached && Date.now() - (cached.updatedAt || 0) < ttl) { S.season = cached; renderSeason(); return; }
    S.seasonLoading = true;
    $('seaTable').innerHTML = '<div class="empty">统计中…（首次较慢，之后用本机缓存）</div>';
    try {
      const res = await runAll(curAccts(), (a) => window.DashCore.collectSeason(a, S.range, null, null, { withStock: !!withStock }));
      const built = window.DashCore.buildSeason(res);
      S.season = built; save(seasonKey(), built);
    } catch (e) { S.season = null; }
    S.seasonLoading = false;
    renderSeason();
  }
  function renderSeason() {
    if (!S.season) { $('seaTable').innerHTML = '<div class="empty">点「统计季节」开始（首次较慢）</div>'; return; }
    const v = window.DashCore.viewSeason(S.season, storeKeyOf());
    if (!v || !v.groups) { $('seaTable').innerHTML = '<div class="empty">暂无季节数据</div>'; return; }
    $('seaCount').textContent = v.groups.length + ' 类';
    $('seaSum').innerHTML = (v.seasons || []).map(s =>
      '<span class="it s-' + s.key + '">' + esc(s.label) + '<b>' + money(s.sale) + '</b></span>').join('');
    $('seaTable').innerHTML = v.groups.map(g =>
      '<div style="margin:6px 0 2px;font-weight:600">' + esc(g.name) + '</div>'
      + '<div class="scroll-x"><table class="tbl"><thead><tr><th>季节</th><th>销售额</th><th>销量</th><th>库存</th><th>成本</th></tr></thead><tbody>'
      + g.rows.map(r => '<tr><td>' + esc(r.season) + '</td><td>' + moneyFull(r.sale) + '</td><td>' + int(r.qty)
        + '</td><td>' + int(r.stockQty) + '</td><td>' + money(r.stockCost) + '</td></tr>').join('')
      + '<tr class="sum"><td>小计</td><td>' + moneyFull(g.total.sale) + '</td><td>' + int(g.total.qty)
      + '</td><td>' + int(g.total.stockQty) + '</td><td>' + money(g.total.stockCost) + '</td></tr>'
      + '</tbody></table></div>').join('');
  }

  // ---------- 供应商 ----------
  function vendorKey() { return K.vendor + S.range + '.' + S.vendorTab + '.' + storeKeyOf(); }
  async function loadVendor(force) {
    if (S.vendorLoading) return;
    if (guardBlocked()) return;
    const cached = load(vendorKey(), null);
    if (!force && cached && Date.now() - (cached.updatedAt || 0) < (S.vendorTab === 'today' ? 30 * 60e3 : 6 * 3600e3)) {
      S.vendor = cached; renderVendor(); return;
    }
    S.vendorLoading = true;
    $('vendorTable').innerHTML = '<div class="empty">统计中…</div>';
    try {
      const res = await runAll(curAccts(), (a) => window.DashCore.collectVendor(a, S.vendorTab, null, null));
      const built = window.DashCore.buildVendor(res);
      S.vendor = built; save(vendorKey(), built);
    } catch (e) { S.vendor = null; }
    S.vendorLoading = false;
    renderVendor();
  }
  function renderVendor() {
    if (!S.vendor || !S.vendor.groups) { $('vendorTable').innerHTML = '<div class="empty">点「统计供应商」开始</div>'; return; }
    const g = S.vendor.groups.slice(0, 30);
    $('vendorCount').textContent = g.length + ' 类';
    $('vendorTable').innerHTML = g.map((x, i) =>
      '<div class="cat' + (S.openVendor[x.name] ? ' open' : '') + '" data-vendor="' + esc(x.name) + '">'
      + '<div class="hd"><span class="idx">' + (i + 1) + '</span><span class="nm">' + esc(x.name)
      + '<span class="x" style="color:var(--dim2);font-size:11px"> ' + x.vendorCount + ' 家 · 销 ' + int(x.qty) + ' 件</span></span>'
      + '<span class="amt">' + moneyFull(x.sale) + '</span><span class="ar">▸</span></div>'
      + '<div class="bd">' + (x.vendors || []).slice(0, 20).map((v, k) =>
        '<div class="sv"><span>' + (k + 1) + '. ' + esc(v.name) + '</span><b>' + moneyFull(v.sale) + ' · ' + int(v.qty) + '件 · 存' + int(v.stockQty) + '</b></div>').join('')
      + '</div></div>').join('');
  }

  // ---------- 折叠 ----------
  function applyFold() {
    document.querySelectorAll('.mod').forEach(sec => {
      const key = sec.getAttribute('data-mod');
      if (key) sec.classList.toggle('fold', !!S.fold[key]);
    });
  }

  // =====================================================================
  // 配置导入 / 导出
  // =====================================================================
  const IO_PREFIX = 'WANGZI-DASH-ACCOUNTS:1:';
  function b64enc(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = ''; bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }
  function b64dec(b64) {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  function buildExportText(withPassword) {
    const list = accounts().map(a => ({ a: a.alias || a.tenantCode, c: String(a.tenantCode), u: a.userAccount || '9999', p: withPassword ? (a.password || '') : '' }));
    return IO_PREFIX + b64enc(JSON.stringify(list));
  }
  function doImport(text) {
    const t = String(text || '').trim();
    if (t.indexOf(IO_PREFIX) !== 0) { toast('这段文本不是门店配置'); return; }
    try {
      const arr = JSON.parse(b64dec(t.slice(IO_PREFIX.length)));
      const merged = accounts().slice();
      for (const o of arr) {
        const code = String(o.c || o.tenantCode || '').trim();
        if (!code) continue;
        const i = merged.findIndex(x => String(x.tenantCode) === code);
        const item = { alias: o.a || o.alias || code, tenantCode: code, userAccount: o.u || o.userAccount || '9999', password: o.p || '', logged: false, tenantName: '' };
        if (i >= 0) merged[i] = Object.assign({}, merged[i], { alias: item.alias, userAccount: item.userAccount, password: item.password || merged[i].password });
        else merged.push(item);
      }
      saveAccts(merged);
      renderLogin();
      toast('已导入 ' + arr.length + ' 家门店配置');
    } catch (e) { toast('解析失败：' + String(e.message || e)); }
  }

  // =====================================================================
  // 事件绑定
  // =====================================================================
  function bind() {
    // ---- 登录页 ----
    $('acctList').addEventListener('click', (e) => {
      const card = e.target.closest('[data-acct]');
      const act = e.target.closest('[data-act]');
      if (act) {
        const i = Number(act.getAttribute('data-i'));
        const a = act.getAttribute('data-act');
        e.stopPropagation();
        if (a === 'login') doLogin(i);
        else if (a === 'cancel') { S.openAcct = null; renderLogin(); }
        else if (a === 'logout') logoutAcct(i);
        else if (a === 'del') delAcct(i);
        return;
      }
      if (!card) return;
      const i = Number(card.getAttribute('data-acct'));
      S.openAcct = S.openAcct === i ? null : i;
      renderLogin();
    });
    $('btnAddAcct').onclick = addAcct;
    $('btnSamePwd').onclick = loginOthersWithSamePwd;
    $('btnEnter').onclick = () => { showPage('main'); refresh(false); };

    // ---- 主界面 ----
    $('storeChips').addEventListener('click', (e) => {
      const c = e.target.closest('[data-store]');
      if (!c) return;
      const key = c.getAttribute('data-store');
      if (key === 'all' && !loginStats().full) { toast('还有门店没登录，登录全部后才能看「全部门店」'); showPage('login'); return; }
      S.store = key; save(K.store, key);
      renderChips(); refresh(false);
    });
    $('rangeChips').addEventListener('click', (e) => {
      const c = e.target.closest('[data-range]');
      if (!c) return;
      S.range = c.getAttribute('data-range'); save(K.range, S.range);
      S.view = load(K.cache + S.range + '.' + storeKeyOf(), null);
      renderChips(); refresh(false);
    });
    $('btnRefresh').onclick = () => refresh(true);
    $('btnAcct').onclick = () => showPage('login');
    $('btnSetup').onclick = () => { $('setupMask').classList.add('on'); };
    $('btnCloseSetup').onclick = () => { $('setupMask').classList.remove('on'); };
    $('setupMask').addEventListener('click', (e) => { if (e.target === $('setupMask')) $('setupMask').classList.remove('on'); });

    document.querySelectorAll('.mod-hd').forEach(hd => {
      hd.onclick = () => {
        const key = hd.parentNode.getAttribute('data-mod');
        S.fold[key] = !S.fold[key]; save(K.fold, S.fold);
        applyFold();
      };
    });
    $('catTabs').addEventListener('click', (e) => {
      const i = e.target.closest('[data-cat]'); if (!i) return;
      $('catTabs').querySelectorAll('.sg-i').forEach(x => x.classList.remove('on'));
      i.classList.add('on'); S.catTab = i.getAttribute('data-cat'); save(K.catTab, S.catTab); renderCat();
    });
    $('trendTabs').addEventListener('click', (e) => {
      const i = e.target.closest('[data-tr]'); if (!i) return;
      $('trendTabs').querySelectorAll('.sg-i').forEach(x => x.classList.remove('on'));
      i.classList.add('on'); S.trendTab = i.getAttribute('data-tr'); save(K.trendTab, S.trendTab); renderTrend();
    });
    $('vendorTabs').addEventListener('click', (e) => {
      const i = e.target.closest('[data-vr]'); if (!i) return;
      $('vendorTabs').querySelectorAll('.sg-i').forEach(x => x.classList.remove('on'));
      i.classList.add('on'); S.vendorTab = i.getAttribute('data-vr'); save(K.vendorTab, S.vendorTab);
      S.vendor = null; renderVendor();
    });
    $('catBody').addEventListener('click', (e) => {
      const h = e.target.closest('.cat .hd'); if (!h) return;
      const box = h.parentNode; const name = box.getAttribute('data-cat');
      S.openCat[name] = !S.openCat[name];
      box.classList.toggle('open', !!S.openCat[name]);
    });
    $('vendorTable').addEventListener('click', (e) => {
      const h = e.target.closest('.cat .hd'); if (!h) return;
      const box = h.parentNode; const name = box.getAttribute('data-vendor');
      S.openVendor[name] = !S.openVendor[name];
      box.classList.toggle('open', !!S.openVendor[name]);
    });
    $('btnSeason').onclick = () => loadSeason(true, false);
    $('btnSeasonStock').onclick = () => loadSeason(true, true);
    $('btnVendor').onclick = () => loadVendor(true);

    // ---- 设置 ----
    $('fTheme').onchange = () => {
      document.documentElement.setAttribute('data-theme', $('fTheme').value);
      save(K.theme, $('fTheme').value);
    };
    $('fRate').onchange = () => {
      const n = Number($('fRate').value) || 6;
      save(K.rate, n);
      if (window.DashCore && window.DashCore.setRate) window.DashCore.setRate(n);
    };
    $('btnExport').onclick = () => {
      $('ioBox').style.display = '';
      $('ioText').value = buildExportText($('ioWithPwd').checked);
    };
    $('ioWithPwd').onchange = () => { $('ioText').value = buildExportText($('ioWithPwd').checked); };
    $('btnImport').onclick = () => { $('ioBox').style.display = ''; $('ioText').value = ''; $('ioText').focus(); };
    $('btnDoImport').onclick = () => doImport($('ioText').value);
    $('btnCopyIO').onclick = () => {
      $('ioText').select();
      try { document.execCommand('copy'); toast('已复制'); } catch (e) { toast('请长按文本框手动复制'); }
    };
  }

  // =====================================================================
  // 启动
  // =====================================================================
  function init() {
    migrateCache();
    S.theme = load(K.theme, 'dark');
    document.documentElement.setAttribute('data-theme', S.theme);
    $('fTheme').value = S.theme;
    S.range = load(K.range, 'today');
    S.store = load(K.store, 'all');
    S.catTab = load(K.catTab, 'sale');
    S.trendTab = load(K.trendTab, 'week');
    S.vendorTab = load(K.vendorTab, 'today');
    S.fold = load(K.fold, { sea: true, vendor: true, trend: true, hour: true });
    S.trend = load(K.trend, null);
    const rate = Number(load(K.rate, 6)) || 6;
    $('fRate').value = String(rate);
    if (window.DashCore && window.DashCore.setRate) window.DashCore.setRate(rate);
    $('catTabs').querySelectorAll('.sg-i').forEach(x => x.classList.toggle('on', x.getAttribute('data-cat') === S.catTab));
    $('trendTabs').querySelectorAll('.sg-i').forEach(x => x.classList.toggle('on', x.getAttribute('data-tr') === S.trendTab));
    $('vendorTabs').querySelectorAll('.sg-i').forEach(x => x.classList.toggle('on', x.getAttribute('data-vr') === S.vendorTab));

    seedPresets();
    bind();
    renderLogin();

    // 演示模式（?demo=1）：加载离线样例数据渲染界面，用于开发期截图 / 无账号预览
    if (location.search.indexOf('demo=1') >= 0 && window.DEMO_VIEW) {
      const list = accounts().map(a => Object.assign({}, a, { logged: true, password: 'demo' }));
      saveAccts(list);
      S.view = window.DEMO_VIEW;
      renderLogin();
      showPage('main');
      render();
      return;
    }
    const st = loginStats();
    if (st.full || (st.ok > 0 && load('dm.autoEnter', '0') === '1')) {
      showPage('main');
      save('dm.autoEnter', '1');
      refresh(false);
    }
    $('loginVer').textContent = 'v1.7.0 · 直连零售云平台云 · 已配置 ' + st.all + ' 家门店';
    // 今日档每分钟静默刷新一次（只读取数，不会触发重新登录）
    setInterval(() => {
      if (S.page !== 'main' || document.hidden) return;
      if (S.range === 'today' && !S.loading) refresh(false);
    }, 60000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
