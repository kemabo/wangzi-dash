'use strict';
/* 手机版界面：第一屏看关键指标，往下拉看门店 / 大类 / 库存 / 趋势 */
(function () {
  const $ = (id) => document.getElementById(id);
  const K = {
    acct: 'dm.accounts',       // 门店账号（只存本机）
    snap: 'dm.snapshots',      // 登录票据快照，避免每次重新登录
    cache: 'dm.cache.',        // 每个档位最后一次数据
    theme: 'dm.theme',
    range: 'dm.range',
    store: 'dm.store',
    catTab: 'dm.catTab',
    trendTab: 'dm.trendTab',
    trend: 'dm.trend',      // 周/月/年趋势（长周期日销售）
    seasonTab: 'dm.seasonOn',
    fold: 'dm.fold',        // 各模块折叠状态
    cacheVer: 'dm.cacheVer',// 缓存结构版本：升级后作废旧脏缓存
  };
  const CACHE_VER = 3;      // v1.5.1：库存改全店口径，旧的分店库存/季节库存缓存作废
  const TREND_TTL = 6 * 3600 * 1000;
  const RANGES = [
    { key: 'today', name: '今日' },
    { key: 'yesterday', name: '昨天' },
    { key: 'thisWeek', name: '本周' },
    { key: 'thisMonth', name: '本月' },
    { key: 'lastMonth', name: '上月' },
  ];
  const S = {
    range: 'today', store: 'all', view: null, loading: false,
    catTab: 'sale',        // 大类模块：sale 销售 / mix 销售库存 / stock 剩余库存
    trendTab: 'week',      // 趋势：week 本周 / month 本月 / year 本年
    trend: null, trendLoading: false,
    season: null, seasonLoading: false, seasonStatus: '', seasonErr: '', seasonOn: false,
    vendor: null, vendorLoading: false, vendorStatus: '', vendorErr: '', vendorTab: 'today',
    vendorOpen: {}, vendorMore: {},   // 大类展开 / 「展开全部供应商」
    fold: {},       // 模块折叠：{store:true,...}
    trPath: '',      // 趋势下钻路径：'week:2026-09-28>day:2026-09-30' 这样用 > 串起来
  };
  // 季节数据要拉商品档案 + 商品级销售 + 商品级库存（几万行），比主界面慢得多：
  // 主界面先出数，季节放后台慢慢补，结果按档位缓存（今日 30 分钟，历史档 6 小时）
  const SEASON_TTL = { today: 30 * 60 * 1000, _: 6 * 3600 * 1000 };

  // ---------- 存储 ----------
  function load(key, def) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { } }
  const accounts = () => load(K.acct, []);
  const snapshots = () => load(K.snap, {});

  // ---------- 格式化 ----------
  function money(v) {
    const n = Number(v) || 0;
    if (Math.abs(n) >= 10000) return (n / 10000).toFixed(1) + '万';
    return n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function moneyFull(v) { return (Number(v) || 0).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function int(v) { return String(Math.round(Number(v) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function pct(v) { return (Number(v) || 0).toFixed(1) + '%'; }
  function timeStr(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // 让取数核心也能用本机缓存：分店清单、类别、库存这些慢变量缓存下来，
  // 第二次打开（以及切换档位）就不用重新联网，数据基本是秒出（官方 App 也是这个做法）
  if (window.DashCore && window.DashCore.setCacheStore) {
    window.DashCore.setCacheStore({
      get: (k) => load('dm.rc.' + k, null),
      set: (k, v) => save('dm.rc.' + k, v),
    });
  }

  /**
   * 版本升级后，旧的本机缓存可能是错的口径（例如库存从「按分店逐个取」改成「全店一次取」：
   * 分店请求被限流时少算一大截，还会被缓存 30 分钟）。这里按版本号清一次，别让旧数字赖在手机上。
   */
  function migrateCache() {
    const ver = Number(load(K.cacheVer, 0)) || 0;
    if (ver >= CACHE_VER) return;
    let n = 0;
    try {
      const dead = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (k.indexOf('dm.rc.sk:') === 0 || k.indexOf('dm.rc.ss:') === 0 || k.indexOf('dm.season.') === 0) dead.push(k);
      }
      for (const k of dead) { localStorage.removeItem(k); n++; }
    } catch (e) { /* 清不掉就算了 */ }
    save(K.cacheVer, CACHE_VER);
    if (n) console.log('[dash] 已清理旧口径缓存 ' + n + ' 条');
  }

  // ---------- 模块折叠（点标题收起 / 展开，页面更紧凑） ----------
  function applyFold() {
    for (const sec of document.querySelectorAll('.mod')) {
      const key = sec.querySelector('[data-fold]');
      if (!key) continue;
      sec.classList.toggle('folded', !!S.fold[key.getAttribute('data-fold')]);
    }
  }

  // ---------- 渲染 ----------
  function bars(container, list, opts) {
    const o = opts || {};
    if (!list || !list.length) { container.innerHTML = '<div class="empty">暂无数据</div>'; return; }
    const max = Math.max.apply(null, list.map(x => Math.abs(Number(o.value ? o.value(x) : x.value) || 0))) || 1;
    container.innerHTML = list.map((x) => {
      const v = Number(o.value ? o.value(x) : x.value) || 0;
      const sub = o.sub ? o.sub(x) : '';
      const cls = typeof o.cls === 'function' ? o.cls(x) : (o.cls || '');
      return '<div class="bar' + (cls ? ' ' + cls : '') + '">'
        + '<div class="row"><span class="n">' + esc(o.name ? o.name(x) : x.name) + '</span>'
        + '<span class="v">' + (o.fmt ? o.fmt(v) : money(v)) + (sub ? '<i>' + sub + '</i>' : '') + '</span></div>'
        + '<div class="track"><div class="fill" style="width:' + Math.max(2, Math.abs(v) / max * 100).toFixed(1) + '%"></div></div>'
        + '</div>';
    }).join('');
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // 门店口径：S.store 里存的是**商户 ID**（一个 ID 一个门店），显示名要去 stores 里查。
  // 旧版本存的是门店名，这里顺带兼容一下。
  function storeOf(v, key) {
    return (v.stores || []).find(s => s.key === key || s.name === key) || null;
  }
  // 门店列表以**本机配置里的门店**为准（不是本次取到数的门店）：
  // 这样新加的门店、取数失败或还没填密码的门店都能在顶部选到，不会出现「少了几家店」。
  function storeOptions() {
    const v = S.view || {};
    const withData = new Set((v.stores || []).map(s => String(s.key)));
    return accounts().map(a => ({
      key: String(a.tenantCode),
      name: a.alias || String(a.tenantCode),
      pwd: !!a.password,
      hasData: withData.has(String(a.tenantCode)),
    }));
  }
  function storeLabel(v, key) {
    const s = storeOf(v, key); if (s) return s.name;
    const a = accounts().find(x => String(x.tenantCode) === String(key));
    return a ? (a.alias || String(a.tenantCode)) : String(key);
  }

  // 取当前视图（按门店筛选后的数据）
  function scoped() {
    const v = S.view;
    if (!v) return null;
    if (S.store === 'all') return { totals: v.totals, cats: v.categories, stores: v.stores, daily: v.daily };
    const st = storeOf(v, S.store);
    // 选中的门店这次没取到数（取数失败 / 刚加上还没刷过）：如实显示空白，绝不悄悄退回全公司口径
    if (!st) return { totals: {}, cats: [], stores: [], daily: [], missing: true };
    const cats = (st.cats || []).map(c => ({
      name: c.name, sale: c.sale, qty: c.qty, profit: c.profit || 0, cost: c.cost || 0,
      stockQty: c.stockQty, stockCost: c.stockCost,
    })).sort((a, b) => b.sale - a.sale);
    const t = {
      sale: st.sale, qty: st.qty, profit: st.profit,
      profitRate: st.sale > 0 ? st.profit / st.sale * 100 : 0,
      customers: 0, avgPrice: 0, stockQty: st.stockQty, stockCost: st.stockCost,
    };
    return { totals: t, cats, stores: [st], daily: [] };
  }

  function render() {
    const v = S.view;
    if (!v) { $('empty').style.display = ''; return; }
    $('empty').style.display = 'none';
    const sc = scoped();
    if (sc.missing) { renderMissing(v); return; }
    const t = sc.totals;

    $('heroLab').textContent = (S.store === 'all' ? '' : esc(storeLabel(v, S.store)) + ' · ') + v.label + '销售额'
      + (v.partial ? ' · 明细补充中' : '');
    $('heroSale').textContent = '¥' + moneyFull(t.sale);
    $('heroProfit').textContent = '¥' + money(t.profit);
    $('heroRate').textContent = pct(t.profitRate);
    $('heroQty').textContent = int(t.qty);
    $('heroUpd').textContent = '更新 ' + timeStr(v.updatedAt);

    $('kCust').textContent = t.customers ? int(t.customers) : '—';
    $('kCustX').textContent = v.rangeKey === 'today' ? '实时客流人次' : '该档位无客流数据';
    $('kAvg').textContent = t.avgPrice ? moneyFull(t.avgPrice) : '—';
    $('kAvgX').textContent = v.rangeKey === 'today' ? '销售额 ÷ 客流' : '该档位无客流数据';
    // 首屏快通道还没补齐库存时，别拿 0 糊弄——标成「补充中」
    const partial = !!v.partial;
    $('kStockQ').textContent = partial ? '…' : int(t.stockQty);
    $('kStockQX').textContent = partial ? '库存补充中' : (S.store === 'all' ? '全部门店合计' : esc(storeLabel(v, S.store)));
    $('kStockC').textContent = partial ? '…' : money(t.stockCost);
    $('kStockCX').textContent = '约 ' + money(t.stockCost) + ' 元';

    $('storeCount').textContent = sc.stores.length + ' 个';
    bars($('storeBars'), sc.stores, {
      value: (x) => x.sale, fmt: (x) => '¥' + money(x),
      // 一个 ID 下的多个物理分店已经并成一行，这里明示合并了几家
      sub: (x) => (x.branchCount > 1 ? '含 ' + x.branchCount + ' 个分店 · ' : '') + int(x.qty) + ' 件',
    });

    renderCategory();
    renderTrend();
    renderSeason();
    renderVendor();

    // 错误提示
    const errs = v.errors || [];
    $('errBox').innerHTML = errs.length
      ? errs.map(e => '<div class="err">' + esc(e.alias || e.tenantCode) + '：' + esc(e.error) + '</div>').join('')
      : '';
  }

  // ---------- 大类销售与库存 ----------
  // sale = 只看销售（销售额 / 销量 / 毛利）
  // mix  = 销售与库存对照：销售额 + 销量 + 剩余库存件数/金额 + 存销比（原「大类剩余库存」并进来了）
  function renderCategory() {
    const box = $('catBody');
    if (!box) return;
    const sc = scoped();
    if (!sc) return;
    for (const el of document.querySelectorAll('#catTabs .sg-i')) {
      el.classList.toggle('on', el.getAttribute('data-cat') === S.catTab);
    }
    const partial = !!(S.view && S.view.partial);
    const cats = sc.cats || [];
    if (!cats.length) { $('catCount').textContent = ''; box.innerHTML = '<div class="empty">这个档位没有大类数据</div>'; return; }

    // 大类**全部列出**（以前截断成 15 个，看着像「类别不全」）
    const list = cats.slice(0).sort((a, b) => b.sale - a.sale);
    $('catCount').textContent = list.length + ' 个大类';
    if (S.catTab === 'sale') {
      bars(box, list, {
        value: (x) => x.sale, fmt: (x) => '¥' + money(x),
        sub: (x) => int(x.qty) + ' 件 · 毛利 ¥' + money(x.profit || 0),
      });
      return;
    }
    // 销售 + 剩余库存一张表看完：库存没数的排最后，整体没取到时顶部写明
    const withStock = list.filter(x => (x.stockQty || 0) > 0);
    const noStock = list.filter(x => !(x.stockQty > 0));
    const ordered = withStock.concat(noStock);
    const head = partial
      ? '<div class="hd-sub"><span>库存正在补齐，先显示已取到的部分</span></div>'
      : (!withStock.length ? '<div class="hd-sub"><span>库存尚未取到（可下拉刷新重试）</span></div>' : '');
    const body = document.createElement('div');
    box.innerHTML = head;
    box.appendChild(body);
    bars(body, ordered, {
      value: (x) => x.sale, fmt: (x) => '¥' + money(x),
      sub: (x) => '销 ' + int(x.qty) + ' 件 · 存 ' + int(x.stockQty || 0) + ' 件'
        + (x.stockCost ? ' / ¥' + money(x.stockCost) : '')
        + (x.qty > 0 && x.stockQty > 0 ? ' · 存销比 ' + (x.stockQty / x.qty).toFixed(1) : ''),
    });
  }

  // ---------- 销售趋势：本周 / 本月 / 本年 ----------
  // 三档都用同一份长周期日销售（去年 1 月 1 日至今，每店 1 个请求，本机缓存 6 小时）切窗口：
  //   本周 = 最近 7 天，一根柱一天，点柱子看各家门店
  //   本月 = 最近 30 天，一根柱一天，点柱子看各家门店
  //   本年 = 最近 12 个月，一根柱一个月，点柱子看那个月各周
  // 窗口内的日期按天补齐（没营业的日子补 0），柱子数固定，不会出现「第一根和后面不一样」。
  function pad2(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function weekStart(s) {
    const d = new Date(String(s).slice(0, 10) + 'T00:00:00');
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));   // 周一为一周之始
    return ymd(d);
  }
  function trendMap() {
    if (!S.trend) return null;
    if (S.store === 'all') {
      const m = new Map();
      for (const d of (S.trend.daily || [])) m.set(d.date, (m.get(d.date) || 0) + (Number(d.sale) || 0));
      return m;
    }
    const b = (S.trend.byStore || {})[String(S.store)];
    return b ? new Map(Object.entries(b)) : null;
  }
  const TREND_GRAIN = {
    week: ['day', 'store'],
    month: ['day', 'store'],
    year: ['month', 'week'],
  };
  const TREND_DAYS = { week: 7, month: 30 };
  /** 按窗口切出 items（本周 7 天 / 本月 30 天 / 本年 12 个月内的全部日） */
  function trendItems() {
    const m = trendMap();
    if (!m) return null;                       // 需要长周期数据（会自动拉一次）
    if (S.trendTab === 'year') {
      const out = [];
      const now = new Date();
      const y = now.getFullYear(), mo = now.getMonth();
      for (let i = 11; i >= 0; i--) {          // 最近 12 个月，按月补齐
        const d = new Date(y, mo - i, 1);
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        for (let dd = 1; dd <= last; dd++) {
          const k = ymd(new Date(d.getFullYear(), d.getMonth(), dd));
          if (k > ymd(now)) break;
          out.push({ date: k, sale: Number(m.get(k)) || 0 });
        }
      }
      return out;
    }
    const n = TREND_DAYS[S.trendTab] || 7;
    const out = [];
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const k = ymd(d);
      out.push({ date: k, sale: Number(m.get(k)) || 0 });
    }
    return out;
  }
  function grainKey(g, date) {
    if (g === 'week') return weekStart(date);
    if (g === 'month') return date.slice(0, 7);
    if (g === 'year') return date.slice(0, 4);
    return date;
  }
  function grainLabel(g, key) {
    if (g === 'year') return key + ' 年';
    if (g === 'month') {
      const p = key.split('-');
      return (p[0] === String(new Date().getFullYear()) ? Number(p[1]) + ' 月' : p[0].slice(2) + ' 年 ' + Number(p[1]) + ' 月');
    }
    if (g === 'week') return key.slice(5).replace('-', '/') + ' 周';
    const d = key.slice(5).replace('-', '/');
    return Number(key.slice(8)) + ' 日';
  }
  /** 柱子底部的短日期标签：日=9，周=9/28，月=9月，年=2026（柱子窄，写全称会挤） */
  function shortLabel(g, key) {
    if (g === 'year') return String(key);
    if (g === 'month') return Number(key.split('-')[1]) + '月';
    if (g === 'week') return Number(key.slice(5, 7)) + '/' + Number(key.slice(8, 10));
    return String(Number(key.slice(8, 10)));
  }
  /** 某一天各门店的销售额（长周期数据里带门店维度） */
  function storeBreak(date) {
    if (S.store !== 'all' || !S.trend || !S.trend.byStore) return [];
    const out = [];
    for (const [key, m] of Object.entries(S.trend.byStore)) {
      const v = m && m[date];
      if (v) out.push({ name: storeLabel(S.view || {}, key), sale: v });
    }
    return out.sort((a, b) => b.sale - a.sale);
  }
  function buildLevel(grains, gi, items) {
    if (!items || !items.length) return [];
    const g = grains[gi];
    if (g === 'store') {
      const kids = storeBreak(items[0].date);
      const mx = Math.max.apply(null, kids.map(k => k.sale).concat([1]));
      return kids.map(k => ({
        id: 'st:' + items[0].date + ':' + k.name, label: k.name, short: k.name, sale: k.sale,
        pct: k.sale / mx * 100, prev: 0, child: null,
      }));
    }
    const m = new Map();
    for (const it of items) {
      const k = grainKey(g, it.date);
      let o = m.get(k);
      if (!o) { o = { key: k, sale: 0, items: [] }; m.set(k, o); }
      o.sale += it.sale; o.items.push(it);
    }
    // 顶层窗口由 trendItems() 定死（本周 7 天 / 本月 30 天 / 本年 12 个月），
    // 这里不再二次裁剪，免得把最前面那一段切掉一半、看着像「第一根柱不对」
    let list = [...m.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
    const mx = Math.max.apply(null, list.map(x => x.sale).concat([1]));
    const next = gi + 1 < grains.length ? grains[gi + 1] : null;
    return list.map((o, i) => ({
      id: g + ':' + o.key, label: grainLabel(g, o.key), short: shortLabel(g, o.key), sale: o.sale,
      pct: o.sale / mx * 100, prev: i > 0 ? list[i - 1].sale : 0,
      child: next ? (() => buildLevel(grains, gi + 1, o.items)) : null,
    }));
  }
  /** 环比箭标：涨 ▲ / 跌 ▼ */
  function deltaHtml(n, cls) {
    if (!n.prev) return '';
    const d = (n.sale - n.prev) / Math.abs(n.prev) * 100;
    return '<span class="' + cls + ' ' + (d >= 0 ? 'up' : 'down') + '">'
      + (d >= 0 ? '▲' : '▼') + Math.abs(d).toFixed(0) + '%</span>';
  }
  /** 一根竖柱：柱顶金额 / 中间柱条 / 底部日期 / 环比
   *  柱子多（本月 30 根）时只在选中的那根上标金额和环比，整排都写会挤成一团 */
  function colHtml(n, lv, sel, sparse) {
    const kids = n.child ? (n.child() || []) : [];
    // 柱子多时只标「选中的」和「最高的」那两根，其余留白，图才干净
    const show = !sparse || sel || n.pct >= 99.5;
    return '<div class="bc' + (sel ? ' on' : '') + '" data-tn="' + esc(n.id) + '" data-lv="' + lv + '"'
      + (kids.length ? ' data-kid="1"' : '') + '>'
      + '<span class="bv">' + (show ? esc(money(n.sale)) : '') + '</span>'
      + '<div class="bst"><i class="bb" style="height:' + Math.max(3, n.pct).toFixed(1) + '%"></i></div>'
      + '<span class="bl">' + esc(n.short || n.label) + '</span>'
      + '<span class="bw">' + (show ? deltaHtml(n, 'bd') : '') + '</span>'
      + '</div>';
  }
  /** 最底一层（门店明细）用紧凑行，比再画一排柱子好认 */
  function rowHtml(n, lv, sel) {
    return '<div class="tn' + (sel ? ' open' : '') + '" data-tn="' + esc(n.id) + '" data-lv="' + lv + '"'
      + ' style="--w:' + Math.max(4, n.pct).toFixed(1) + '%;--d:0">'
      + '<i class="bg"></i>'
      + '<span class="nm">' + esc(n.label) + '</span>'
      + '<span class="vv">¥' + money(n.sale) + '</span>'
      + '<span class="dl">' + deltaHtml(n, 'dd') + '</span>'
      + '</div>';
  }
  /** 沿 S.trPath（> 分隔的 id 路径）把下钻经过的每一层都算出来 */
  function trendLevels(items) {
    const grains = TREND_GRAIN[S.trendTab] || TREND_GRAIN.week;
    const chain = String(S.trPath || '').split('>').filter(Boolean);
    const out = [];
    const roots = buildLevel(grains, 0, items);
    if (!roots.length) return out;
    out.push({ lv: 0, grains, nodes: roots, sel: chain[0] || '', path: [], title: null });
    for (let i = 0; i < chain.length; i++) {
      const cur = out[out.length - 1];
      const hit = cur.nodes.filter(n => n.id === chain[i])[0];
      if (!hit || !hit.child) break;
      const kids = hit.child();
      if (!kids.length) break;
      out.push({ lv: out.length, grains, nodes: kids, sel: chain[i + 1] || '', path: cur.path.concat([hit.id]), title: hit });
    }
    return out;
  }
  function levelHtml(lvObj) {
    const depth = lvObj.lv;
    const g = (lvObj.grains || [])[depth] || '';
    // 门店明细（名字长）和第三层起不再画柱子，直接列成紧凑行
    if (depth >= 2 || g === 'store') {
      return '<div class="tree">' + lvObj.nodes.map(n => rowHtml(n, depth, n.id === lvObj.sel)).join('') + '</div>';
    }
    let head = '';
    if (depth > 0 && lvObj.title) {
      const dt = lvObj.title;
      const dHtml = dt.prev ? deltaHtml(dt, 'dt2') : '';
      head = '<div class="dbar"><span class="dt">' + esc(dt.label) + ' · <b>¥' + money(dt.sale) + '</b>' + (dHtml ? ' ' + dHtml : '') + '</span>'
        + '<span class="db" data-back="' + depth + '">返回上一层</span></div>';
    }
    const sparse = lvObj.nodes.length > 12;
    const body = '<div class="bchart' + (depth ? ' sub' : '') + '">'
      + lvObj.nodes.map(n => colHtml(n, depth, n.id === lvObj.sel, sparse)).join('') + '</div>';
    return head + body;
  }
  function renderTrend() {
    const box = $('trendBars');
    if (!box) return;
    for (const el of document.querySelectorAll('#trendTabs .sg-i')) {
      el.classList.toggle('on', el.getAttribute('data-tr') === S.trendTab);
    }
    const sc = scoped();
    if (!sc) { $('secTrend').style.display = 'none'; return; }
    $('secTrend').style.display = '';   // 注意：不要去动 main，也别用 parentElement 隐藏
    const items = trendItems();
    if (items === null) {
      $('trendCount').textContent = '';
      box.innerHTML = '<div class="empty sm">'
        + (S.trendLoading ? '正在读取每日销售（每家店 1 个请求）…' : '正在准备趋势数据…') + '</div>';
      if (!S.trendLoading) loadTrend(false);
      return;
    }
    if (!items.length) {
      $('trendCount').textContent = '';
      box.innerHTML = '<div class="empty sm">这段时间还没有销售数据</div>';
      return;
    }
    const sum = items.reduce((a, b) => a + (Number(b.sale) || 0), 0);
    $('trendCount').textContent = '合计 ¥' + money(sum);
    const html = trendLevels(items).map(levelHtml).join('');
    box.innerHTML = html || '<div class="empty sm">没有可显示的趋势数据</div>';
  }

  async function loadTrend(force) {
    if (S.trendLoading) return;
    if (guardBlocked()) { renderTrend(); return; }
    const cached = load(K.trend, null);
    if (!force && cached && Date.now() - cached.updatedAt < TREND_TTL) { S.trend = cached; renderTrend(); return; }
    const accts = accounts().filter(a => a.password);
    if (!accts.length) { renderTrend(); return; }
    S.trendLoading = true;
    renderTrend();
    try {
      const results = await runAll(accts, (acct) => window.DashCore.collectTrend(acct));
      const built = window.DashCore.buildTrend(results);
      if (built.okCount && built.daily.length) { S.trend = built; save(K.trend, built); }
      else if (cached) S.trend = cached;
    } catch (e) {
      S.trend = cached || null;
    }
    S.trendLoading = false;
    renderTrend();
  }

  // ---------- 季节销售与库存（大类 × 春夏秋冬，跟电脑大屏同一张表） ----------
  function seasonView() {
    if (!S.season || !S.season.groups) return null;
    try { return window.DashCore.viewSeason(S.season, S.store); } catch (e) { return null; }
  }
  function cell(v, fmt) { return (v ? fmt(v) : '·'); }
  function renderSeason() {
    const box = $('seaTable'), sumBox = $('seaSum'), tip = $('seaTip');
    if (!box) return;
    const view = seasonView();
    // 加载按钮：加载中给状态，已加载变成「重新统计」
    const btn = $('btnSeason');
    if (btn) btn.textContent = S.seasonLoading ? '加载中…' : (S.season ? '重新统计季节' : '加载季节数据');
    if (!S.season) {
      if (sumBox) sumBox.innerHTML = '';
      box.innerHTML = '<div class="empty">'
        + (S.seasonLoading
          ? '季节数据加载中…<div class="st2">' + esc(S.seasonStatus || '准备中') + '</div>'
          : (S.seasonErr ? '季节数据加载失败：' + esc(S.seasonErr) : '未加载（要按商品档案逐条归类，滚到这里会自动加载，也可以点下面按钮）'))
        + '</div>';
      if (tip) tip.textContent = '';
      $('seaCount').textContent = '';
      return;
    }
    if (!view || !view.groups.length) {
      if (sumBox) sumBox.innerHTML = '';
      box.innerHTML = '<div class="empty">'
        + (S.season.groups ? '这个档位 / 这家门店没有季节数据' : '季节统计已升级为大类×季节，重新统计一次即可')
        + (S.seasonErr ? '<div class="st2">' + esc(S.seasonErr) + '</div>' : '') + '</div>';
      if (tip) tip.textContent = '';
      $('seaCount').textContent = '';
      return;
    }
    $('seaCount').textContent = view.groups.length + ' 个大类';
    if (tip) {
      tip.textContent = (S.season.stockPending ? '库存统计中 · ' : '')
        + (S.season.stockOk === false ? '库存未取到 · ' : '')
        + (S.season.updatedAt ? '更新 ' + timeStr(S.season.updatedAt) + ' · ' : '')
        + (S.store !== 'all' ? storeLabel(S.view || {}, S.store) : '全部门店');
    }
    // 库存那一列没统计到时，别让表里的 0 看着像「真的没有库存」
    if (!S.season.stockPending && S.season.stockOk === false) {
      box.insertAdjacentHTML('beforeend', '<div class="empty sm">'
        + (S.season.stockSkipped
          ? '本次只统计了销售（没算库存，那样要慢很多）。点「含库存统计」再算一次，结果会缓存 12 小时。'
          : '库存没统计到（商品级库存量大，可能被限流中断），点「重新统计」再试一次')
        + '</div>');
    }
    // 顶部一条：春夏秋冬（跨大类）合计，先看清季节结构
    if (sumBox) {
      sumBox.innerHTML = view.seasons.map(s =>
        '<div class="s-chip s-' + s.key + '"><i></i><span class="sl">' + esc(s.label) + '</span>'
        + '<b>¥' + money(s.sale) + '</b><em>' + int(s.stockQty) + ' 件</em></div>').join('');
    }
    box.innerHTML = view.groups.map(g => {
      const rows = g.rows.map(r =>
        '<tr class="s-' + r.key + '"><td class="sn"><i></i>' + esc(r.season) + '</td>'
        + '<td>' + cell(r.sale, (x) => '¥' + money(x)) + '</td>'
        + '<td>' + cell(r.qty, int) + '</td>'
        + '<td>' + cell(r.stockQty, int) + '</td>'
        + '<td>' + cell(r.stockCost, (x) => '¥' + money(x)) + '</td></tr>').join('');
      const sub = '<tr class="sub"><td class="sn">小计</td><td>¥' + money(g.total.sale) + '</td>'
        + '<td>' + int(g.total.qty) + '</td><td>' + int(g.total.stockQty) + '</td>'
        + '<td>¥' + money(g.total.stockCost) + '</td></tr>';
      return '<div class="sg">'
        + '<div class="sg-hd"><span class="nm">' + esc(g.name) + '</span>'
        + '<span class="tt">销售 ¥' + money(g.total.sale) + ' · 库存 ' + int(g.total.stockQty) + ' 件</span></div>'
        + '<table class="st"><thead><tr><th>季节</th><th>销售额</th><th>销量</th><th>库存</th><th>库存金额</th></tr></thead>'
        + '<tbody>' + rows + sub + '</tbody></table></div>';
    }).join('');
  }

  // 选中的门店本次没取到数：如实留白，别拿全公司数据糊弄
  function renderMissing(v) {
    const name = storeLabel(v, S.store);
    $('heroLab').textContent = name + ' · 本次没取到数据';
    $('heroSale').textContent = '—';
    $('heroProfit').textContent = '—'; $('heroRate').textContent = '—'; $('heroQty').textContent = '—';
    $('heroUpd').textContent = '更新 ' + timeStr(v.updatedAt);
    $('kCust').textContent = '—'; $('kAvg').textContent = '—';
    $('kStockQ').textContent = '—'; $('kStockC').textContent = '—';
    $('secTrend').style.display = 'none';
    $('storeCount').textContent = '0 个'; $('catCount').textContent = '0 个'; $('trendCount').textContent = '';
    bars($('storeBars'), []); bars($('catBody'), []);
    $('errBox').innerHTML = '<div class="err">' + esc(name) + '：本次没取到数据（新加的门店刷一次就有；一直如此就检查账号密码）</div>';
    renderSeason();
  }

  /**
   * 季节表：数据量大（商品档案 + 商品级销售 + 商品级库存），不跟着首屏抢网络。
   * 滚到季节那一块、或点「加载季节数据」才拉；商品档案本机缓存 24 小时，第二次起只要十几秒。
   */
  async function loadSeason(force, withStock) {
    if (S.seasonLoading) return;
    if (guardBlocked()) { renderSeason(); return; }
    const key = 'dm.season.' + S.range;
    const cached = load(key, null);
    const ttl = SEASON_TTL[S.range] || SEASON_TTL._;
    // 快模式（只算销售）不会去覆盖已经算好的带库存结果
    if (!force && cached && Date.now() - cached.updatedAt < ttl
      && (!withStock || cached.stockOk)) { S.season = cached; renderSeason(); return; }
    const accts = accounts().filter(a => a.password);
    if (!accts.length) { renderSeason(); return; }
    S.seasonLoading = true;
    S.seasonErr = '';
    if (cached) S.season = cached;
    const t0 = Date.now();
    const tick = (msg) => {
      S.seasonStatus = msg + ' · 已用 ' + Math.round((Date.now() - t0) / 1000) + 's';
      renderSeason();
    };
    tick('准备中');
    // 分两步给界面看：每家店销售汇总完（约 5～10 秒）先回传一次「只有销售」的表，
    // 商品级库存那几十秒在后台慢慢补——用户不用干等库存，季节表先出内容。
    const partial = new Map();
    const onPartial = (tenantCode, alias, groups) => {
      partial.set(String(tenantCode), { tenantCode, alias, ok: true, groups });
      try {
        S.season = window.DashCore.buildSeason([...partial.values()]);
        S.season.stockPending = true;
        renderSeason();
      } catch (e) { /* 预览失败就算了，等完整结果 */ }
    };
    try {
      const snaps = snapshots();
      const out = [];
      let i = 0;
      for (const a of accts) {
        i++;
        const tag = '(' + i + '/' + accts.length + ') ' + (a.alias || a.tenantCode) + ' ';
        try {
          const r = await window.DashCore.collectSeason(
            Object.assign({}, a, { snapshot: snaps[a.tenantCode] || null }), S.range,
            (s) => tick(tag + s),
            (g) => onPartial(a.tenantCode, a.alias, g),
            { withStock: !!withStock });
          if (r.snapshot) { snaps[a.tenantCode] = r.snapshot; save(K.snap, snaps); }
          out.push(r);
        } catch (e) {
          out.push({ tenantCode: a.tenantCode, alias: a.alias, ok: false, error: String(e.message || e) });
        }
      }
      const built = window.DashCore.buildSeason(out);
      built.stockPending = false;
      const errs = (built.errors || []).map(e => (e.alias || e.tenantCode) + '：' + e.error).join('；');
      S.seasonErr = errs && !built.okCount ? errs : '';
      // 全店失败就别把空结果盖掉旧数据（跟主快照一个规矩）
      if (built.okCount || !cached) { S.season = built; save(key, built); }
      else if (withStock && built.stockOk) { S.season = built; save(key, built); }
      else S.season = cached;
    } catch (e) {
      S.season = cached || S.season;
      S.seasonErr = String((e && e.message) || e);
    }
    S.seasonLoading = false;
    S.seasonStatus = '';
    renderSeason();
  }

  // ---------- 大类 × 供应商 ----------
  const VENDOR_TTL = { today: 30 * 60 * 1000, _: 6 * 3600 * 1000 };
  const VENDOR_LABEL = { today: '本日', thisWeek: '本周', thisYear: '本年' };
  const VENDOR_TOP = 8;

  function vendorKey() { return 'dm.vendor.' + S.store + '.' + S.vendorTab; }

  async function loadVendor(force) {
    if (S.vendorLoading) return;
    if (guardBlocked()) { renderVendor(); return; }
    const key = vendorKey();
    const cached = load(key, null);
    const ttl = VENDOR_TTL[S.vendorTab] || VENDOR_TTL._;
    if (!force && cached && Date.now() - cached.updatedAt < ttl) { S.vendor = cached; renderVendor(); return; }
    const all = accounts().filter(a => a.password);
    const accts = S.store === 'all' ? all : all.filter(a => String(a.tenantCode) === String(S.store));
    if (!accts.length) { renderVendor(); return; }
    S.vendorLoading = true; S.vendorErr = '';
    const t0 = Date.now();
    const tick = (m) => { S.vendorStatus = m + ' · 已用 ' + Math.round((Date.now() - t0) / 1000) + 's'; renderVendor(); };
    tick('准备中');
    try {
      const snaps = snapshots();
      const out = [];
      let i = 0;
      for (const a of accts) {
        i++;
        const tag = '(' + i + '/' + accts.length + ') ' + (a.alias || a.tenantCode) + ' ';
        try {
          const r = await window.DashCore.collectVendor(
            Object.assign({}, a, { snapshot: snaps[a.tenantCode] || null }),
            S.vendorTab, (s) => tick(tag + s));
          if (r && r.snapshot) { snaps[a.tenantCode] = r.snapshot; save(K.snap, snaps); }
          out.push(r);
        } catch (e) {
          out.push({ tenantCode: a.tenantCode, alias: a.alias, ok: false, error: String(e.message || e) });
        }
      }
      const built = window.DashCore.buildVendor(out);
      S.vendorErr = built.okCount ? '' : (built.errors || []).join('；');
      // 全店失败就别把空表盖掉旧数据（跟主快照一个规矩）
      if (built.okCount || !cached) { S.vendor = built; save(key, built); }
      else S.vendor = cached;
    } catch (e) {
      S.vendor = cached || S.vendor;
      S.vendorErr = String((e && e.message) || e);
    }
    S.vendorLoading = false; S.vendorStatus = '';
    renderVendor();
  }

  function renderVendor() {
    const box = $('vendorTable');
    if (!box) return;
    const btn = $('btnVendor');
    if (btn) btn.textContent = S.vendorLoading ? '统计中…' : (S.vendor ? '重新统计' : '统计供应商排名');
    for (const el of document.querySelectorAll('#vendorTabs .sg-i')) {
      el.classList.toggle('on', el.getAttribute('data-vr') === S.vendorTab);
    }
    const tip = $('vendorTip');
    const cnt = $('vendorCount');
    if (S.vendorLoading) {
      tip.textContent = S.vendorStatus || '统计中…';
      box.innerHTML = '<div class="empty sm">正在按商品档案归类供应商（首次较慢，之后用本机缓存）…</div>';
      return;
    }
    const d = S.vendor;
    if (!d || !(d.groups || []).length) {
      tip.textContent = S.vendorErr ? ('失败：' + S.vendorErr) : '按商品档案里的供应商归类';
      if (cnt) cnt.textContent = '';
      box.innerHTML = '<div class="empty sm">' + (S.vendorErr ? esc(S.vendorErr) : '点上面按钮统计（首次较慢，之后用本机缓存）') + '</div>';
      return;
    }
    if (cnt) cnt.textContent = d.groups.length + ' 个大类';
    tip.textContent = VENDOR_LABEL[S.vendorTab] + ' · 更新 ' + timeStr(d.updatedAt);
    const open = S.vendorOpen || (S.vendorOpen = {});
    if (!d.groups.some(g => open[g.name])) open[d.groups[0].name] = 1;

    const rows = [];
    for (const g of d.groups) {
      const isOpen = !!open[g.name];
      rows.push('<div class="vg' + (isOpen ? ' open' : '') + '" data-vg="' + esc(g.name) + '">'
        + '<i class="car">' + (isOpen ? '▾' : '▸') + '</i><span class="nm">' + esc(g.name) + '</span>'
        + '<span class="vv2">¥' + money(g.sale) + '</span>'
        + '<span class="vq">' + int(g.qty) + ' 件</span>'
        + '<span class="vs">存 ' + int(g.stockQty) + '</span></div>');
      if (!isOpen) continue;
      const list = g.vendors || [];
      const showAll = !!(S.vendorMore || (S.vendorMore = {}))[g.name];
      const shown = showAll ? list : list.slice(0, VENDOR_TOP);
      shown.forEach((v, i) => {
        rows.push('<div class="vv-row"><span class="rk">' + (i + 1) + '</span>'
          + '<span class="nm">' + esc(v.name) + '</span>'
          + '<span class="vv2">¥' + money(v.sale) + '</span>'
          + '<span class="vq">' + int(v.qty) + ' 件</span>'
          + '<span class="vs">存 ' + int(v.stockQty) + '</span></div>');
      });
      if (list.length > VENDOR_TOP) {
        rows.push('<div class="vmore" data-vmore="' + esc(g.name) + '">'
          + (showAll ? '收起（只看前 ' + VENDOR_TOP + ' 名）' : '展开全部 ' + list.length + ' 家') + '</div>');
      }
      if (!list.length) rows.push('<div class="vv-row"><span class="nm">本档位没有销售</span></div>');
    }
    box.innerHTML = rows.join('');
  }

  function renderChips() {
    $('ranges').innerHTML = RANGES.map(r =>
      '<div class="chip' + (r.key === S.range ? ' on' : '') + '" data-range="' + r.key + '">' + r.name + '</div>').join('');
    // 选项取自配置里的门店（含新加的、还没数据的），而不是本次报文里出现的门店
    // 选中的那家排到最左边：门店多了以后不用在一条里来回找
    const opts = storeOptions();
    const cur = S.store === 'all' ? null : opts.filter(s => String(s.key) === String(S.store))[0];
    const rest = cur ? opts.filter(s => String(s.key) !== String(S.store)) : opts;
    const chip = (s) => {
      const cls = ['chip'];
      if (S.store === s.key) cls.push('on');
      else if (S.view && !s.hasData) cls.push('nodata');
      return '<div class="' + cls.join(' ') + '" data-store="' + esc(s.key) + '">' + esc(s.name) + '</div>';
    };
    const all = '<div class="chip' + (S.store === 'all' ? ' on' : '') + '" data-store="all">全部门店</div>';
    $('storeChips').innerHTML = (cur ? all + chip(cur) : all) + rest.map(chip).join('');
    $('storeChips').style.display = opts.length > 1 ? '' : 'none';
  }

  // ---------- 取数 ----------
  function progress(p, text) {
    $('pg').firstElementChild.style.width = Math.round(p * 100) + '%';
    if (text) $('heroUpd').textContent = text;
  }

  /** 多门店并行取数（每家门店自己的请求仍串行，避免同一账号互相挤掉会话） */
  async function runAll(accts, fn) {
    const snaps = snapshots();
    const jobs = accts.map(async (a) => {
      const acct = Object.assign({}, a, { snapshot: snaps[a.tenantCode] || null });
      try {
        const r = await fn(acct, a);
        if (r && r.snapshot) { snaps[a.tenantCode] = r.snapshot; save(K.snap, snaps); }
        return r;
      } catch (e) {
        return { tenantCode: a.tenantCode, alias: a.alias, ok: false, error: String((e && e.message) || e) };
      }
    });
    return Promise.all(jobs);
  }

  async function refresh(manual) {
    if (S.loading) return;
    // 保护期（厂家限流 / 登录异常）：一个请求都不发，等它自己恢复，绝不硬冲
    if (guardBlocked()) { renderGuard(); return; }
    renderGuard();
    // 没填密码的账号先跳过（预置进来的只有商户编号，密码要在手机上补一次）
    const accts = accounts().filter((a) => a.password);
    if (!accts.length) {
      openSetup();
      $('setupTip').textContent = accounts().length
        ? '已预置门店编号，点每条右边的「补密码」，填一次就好（密码只存在这台手机里）。'
        : '先添加一个门店账号（商户ID + 账号 + 密码），之后每次打开自动取数。';
      return;
    }
    S.loading = true;
    // ① 快通道：每家店只发 1～2 个请求，先把实时销售额/门店排行跑出来（约 1～2 秒）
    progress(0.1, '正在取实时数据…');
    const quick = await runAll(accts, (acct) => window.DashCore.collectQuick(acct, S.range));
    const qv = window.DashCore.buildMobile(quick, S.range);
    if (qv.okCount) {
      S.view = qv;
      save(K.cache + S.range, S.view);
      if (S.store !== 'all' && !accounts().some(a => String(a.tenantCode) === String(S.store))) S.store = 'all';
      renderChips(); render();
    }
    // ② 后台补齐大类库存 / 趋势（慢的部分），复用快通道已取到的数据，不重复请求
    progress(0.4, '正在补齐库存与趋势…');
    const results = await runAll(accts, (acct, a) => {
      const q = quick.find(x => x && String(x.tenantCode) === String(a.tenantCode)) || {};
      return window.DashCore.collectAccount(
        Object.assign({}, acct, { snapshot: q.snapshot || acct.snapshot }),
        S.range,
        null,
        { home: q.home, cat: q.cat, daily: q.daily });
    });
    // 空快照防护（跟电脑大屏同一规矩）：全部门店都失败时，不拿全 0 的数据
    // 把上一份有效结果冲掉，只追加错误提示
    const prev = S.view;
    const built = window.DashCore.buildMobile(results, S.range);
    const hadData = prev && prev.rangeKey === built.rangeKey && prev.totals
      && (Number(prev.totals.sale) || Number(prev.totals.qty) || (prev.stores || []).length);
    if (!built.okCount && hadData) {
      built.errors = (prev.errors || []).concat(built.errors || []);
      S.view = prev;               // 沿用上一份数据
    } else {
      S.view = built;
      save(K.cache + S.range, S.view);
    }
    S.loading = false;
    progress(1, '');
    setTimeout(() => { $('pg').firstElementChild.style.width = '0'; }, 400);
    if (S.store !== 'all' && !accounts().some(a => String(a.tenantCode) === String(S.store))) S.store = 'all';
    save(K.store, S.store);
    renderChips();
    render();
    renderGuard();
    // 长周期趋势（本周/本月/本年）：每店 1 个请求，本机缓存 6 小时，放主数据之后补
    setTimeout(() => loadTrend(false), 200);
    // 季节：主数据出完 8 秒后在后台慢慢预热（只算销售，不算库存），
    // 这样用户翻到季节那一块时基本已经好了；限速闸门挡着，不会跟首屏抢网络。
    if (!S.season) setTimeout(() => { if (!S.season && !S.seasonLoading) loadSeason(false, false); }, 8000);
    else if (S.seasonOn) setTimeout(() => loadSeason(!!manual, false), 400);
    if (manual && navigator.vibrate) navigator.vibrate(12);
  }

  /**
   * 取数安全提示条：厂家返回「操作过于频繁(0002)」或登录异常时，
   * 取数会整体暂停（指数退避），这里把它如实显示出来 —— 看板停一会儿没关系，
   * 绝不能为了刷数据把门店收银挤掉。
   */
  function renderGuard() {
    const el = $('guardBox');
    if (!el || !window.DashCore || !window.DashCore.status) return;
    const st = window.DashCore.status();
    if (!st.limited) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = '<span class="gi">⏸</span><span>厂家限流保护中：已暂停自动取数，'
      + st.waitSec + ' 秒后恢复（不影响门店收银）。' + esc(st.reason || '') + '</span>';
  }
  /** 取数前先问一句：还在保护期就别发请求了 */
  function guardBlocked() {
    if (!window.DashCore || !window.DashCore.status) return false;
    const st = window.DashCore.status();
    if (!st.limited) return false;
    progress(1, '限流保护中，' + st.waitSec + ' 秒后自动恢复');
    setTimeout(() => { $('pg').firstElementChild.style.width = '0'; }, 600);
    // 保护期内每 2 秒刷新提示，到期后自动恢复一次取数（不用手动再来一次）
    if (!S.guardTimer) {
      S.guardTimer = setInterval(() => {
        renderGuard();
        const s = window.DashCore.status();
        if (!s.limited) { clearInterval(S.guardTimer); S.guardTimer = 0; refresh(false); }
      }, 2000);
    }
    return true;
  }

  // ---------- 下拉刷新 ----------
  function initPullToRefresh() {
    let startY = 0, pulling = false, dist = 0;
    document.addEventListener('touchstart', (e) => {
      if (window.scrollY <= 0) { startY = e.touches[0].clientY; pulling = true; dist = 0; }
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (!pulling) return;
      dist = e.touches[0].clientY - startY;
      if (dist > 0 && window.scrollY <= 0) {
        $('ptr').style.height = Math.min(60, dist * 0.5) + 'px';
        $('ptr').textContent = dist > 110 ? '松手刷新' : '下拉刷新…';
      }
    }, { passive: true });
    document.addEventListener('touchend', () => {
      if (!pulling) return;
      pulling = false;
      $('ptr').style.height = '0';
      if (dist > 110) refresh(true);
      dist = 0;
    });
  }

  /** demo 用的长周期假数据：方便在电脑上看「周 / 月 / 年」长什么样（App 里不会走到） */
  function demoTrend() {
    const byStore = {}; const total = new Map();
    const today = new Date();
    for (const s of ((S.view && S.view.stores) || [])) {
      const m = {}; byStore[s.key] = m;
      for (let i = 400; i >= 0; i--) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        const k = ymd(d);
        const v = Math.round((s.sale || 60000) / 30 * (0.65 + 0.7 * Math.abs(Math.sin(i / 6.7))));
        m[k] = v;
        total.set(k, (total.get(k) || 0) + v);
      }
    }
    return {
      updatedAt: Date.now(),
      daily: [...total.entries()].map(([date, sale]) => ({ date, sale })).sort((a, b) => (a.date < b.date ? -1 : 1)),
      byStore, errors: [], okCount: ((S.view && S.view.stores) || []).length,
    };
  }

  /** 季节表要拉商品档案（几万行），打开 App 时不自动拉：滚到那一块再开始（或点按钮） */
  function initSeasonLazy() {
    const el = $('seaTable');
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.disconnect();
        S.seasonOn = true; save(K.seasonTab, true);
        loadSeason(false);
      }
    }, { rootMargin: '240px' });
    io.observe(el);
  }

  // ---------- 设置：账号 ----------
  function renderAccts() {
    const list = accounts();
    $('acctList').innerHTML = list.length
      ? list.map((a, i) => '<div class="acct"><span class="nm">' + esc(a.alias || a.tenantCode) + '<br><span style="color:var(--dim);font-size:12px">'
        + esc(a.tenantCode) + ' / ' + esc(a.userAccount) + (a.password ? '' : ' · <b style="color:#ffb020">待填密码</b>')
        + '</span></span><span class="del" data-edit="' + i + '">' + (a.password ? '改' : '补密码') + '</span>'
        + '<span class="del" data-del="' + i + '">删除</span></div>').join('')
      : '<div class="empty">还没有账号，点下面「添加门店账号」</div>';
  }
  function openSetup() { renderAccts(); $('setupMask').classList.add('on'); }
  // 直接定位到某一家门店的「补密码 / 改」表单
  function openSetupFor(code) {
    const a = accounts().find(x => String(x.tenantCode) === String(code));
    openSetup();
    if (!a) return;
    $('fAlias').value = a.alias || ''; $('fCode').value = a.tenantCode || '';
    $('fUser').value = a.userAccount || '9999'; $('fPass').value = '';
    $('acctForm').style.display = ''; $('btnAdd').style.display = 'none';
    $('setupTip').textContent = (a.alias || a.tenantCode) + '：填密码后点「测试连接并保存」，这家店就能出数了';
    try { $('fPass').focus(); } catch (e) { }
  }
  function closeSetup() {
    $('setupMask').classList.remove('on');
    $('acctForm').style.display = 'none';
    $('btnAdd').style.display = '';
    $('ioBox').style.display = 'none';
  }

  // ---------------- 门店配置：导出 / 粘贴导入 ----------------
  // 有了这个，新增门店就不再需要重新打包 App：
  // 在任意一台手机上把门店清单导出成一段文本，微信发到别的手机，粘贴一下导入即可。
  const IO_PREFIX = 'WANGZI-DASH-ACCOUNTS:1:';
  // btoa/atob 只认单字节，中文别名必须先转 UTF-8 再编解码
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
    const list = accounts().map(a => ({
      a: a.alias || a.tenantCode,
      c: String(a.tenantCode),
      u: a.userAccount || '9999',
      p: withPassword ? (a.password || '') : '',
    }));
    return IO_PREFIX + b64enc(JSON.stringify(list));
  }
  function normEntry(o) {
    const code = String((o && (o.c || o.tenantCode || o.code)) || '').trim();
    if (!code) return null;
    return {
      alias: String((o && (o.a || o.alias || o.name)) || code).trim(),
      tenantCode: code,
      userAccount: String((o && (o.u || o.userAccount || o.user)) || '9999').trim() || '9999',
      password: String((o && (o.p || o.password || o.pwd)) || ''),
    };
  }
  /**
   * 宽容解析：认三种写法
   * 1) App 导出的带前缀 base64 文本
   * 2) 直接粘的 JSON 数组 / {"accounts":[...]}
   * 3) 每行一家：`商户ID,显示名,账号,密码`（后三项可省略，密码留空表示稍后补）
   */
  function parseImportText(text) {
    const t = String(text || '').trim();
    if (!t) return [];
    const head = t.slice(0, IO_PREFIX.length);
    if (head === IO_PREFIX) {
      try { return (JSON.parse(b64dec(t.slice(IO_PREFIX.length))) || []).map(normEntry).filter(Boolean); }
      catch (e) { return []; }
    }
    try {
      const o = JSON.parse(t);
      const arr = Array.isArray(o) ? o : (o.accounts || o.stores || []);
      if (Array.isArray(arr)) { const r = arr.map(normEntry).filter(Boolean); if (r.length) return r; }
    } catch (e) { /* 不是 JSON 就按行文本处理 */ }
    const out = [];
    for (const line of t.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s[0] === '#' || s[0] === '{') continue;
      const parts = s.split(/[,，\t|]/).map(x => x.trim());
      const code = parts[0] || '';
      if (!/^[0-9A-Za-z_-]{2,20}$/.test(code)) continue;
      out.push({ alias: parts[1] || code, tenantCode: code, userAccount: parts[2] || '9999', password: parts[3] || '' });
    }
    return out;
  }
  function doExport() {
    const withPwd = !!($('ioWithPwd') && $('ioWithPwd').checked);
    const list = accounts();
    if (!list.length) { $('setupTip').textContent = '还没有账号，先添加或导入一家门店。'; return; }
    $('ioBox').style.display = '';
    $('ioText').value = buildExportText(withPwd);
    $('btnDoImport').style.display = 'none';
    $('setupTip').textContent = withPwd
      ? '已生成含密码的配置：复制后用微信发到另一台手机，打开 App → 设置 → 粘贴导入配置，粘进去即可（含密码请别发给外人）。'
      : '已生成配置（不含密码）：复制后发给另一台手机，导入后按提示补一次密码即可。';
  }
  function doImport() {
    const arr = parseImportText($('ioText').value);
    if (!arr.length) { $('setupTip').textContent = '没认出这段文本里的门店，请确认复制完整（配置以 WANGZI-DASH-ACCOUNTS:1: 开头）。'; return; }
    const list = accounts();
    const byCode = new Map(list.map(a => [String(a.tenantCode), a]));
    let added = 0, updated = 0;
    for (const it of arr) {
      const ex = byCode.get(it.tenantCode);
      if (ex) {
        // 已存在：只补缺的字段，绝不把本地已有的密码改坏
        if (!ex.alias) ex.alias = it.alias;
        if (!ex.userAccount) ex.userAccount = it.userAccount;
        if (!ex.password && it.password) { ex.password = it.password; updated++; }
      } else {
        list.push({ alias: it.alias, tenantCode: it.tenantCode, userAccount: it.userAccount, password: it.password });
        byCode.set(it.tenantCode, list[list.length - 1]);
        added++;
      }
    }
    save(K.acct, list);
    renderAccts();
    $('ioBox').style.display = 'none';
    const needPwd = list.filter(a => !a.password).length;
    $('setupTip').textContent = `导入完成：新增 ${added} 家、补全 ${updated} 家。`
      + (needPwd ? `还有 ${needPwd} 家待填密码，点每家右边的「补密码」。` : '全部门店已就绪。');
    refresh(false);
  }

  async function testAndSave() {
    const a = {
      alias: $('fAlias').value.trim(),
      tenantCode: $('fCode').value.trim(),
      userAccount: $('fUser').value.trim() || '9999',
      password: $('fPass').value,
    };
    if (!a.tenantCode || !a.password) { alert('商户ID 和密码必填'); return; }
    $('btnTest').textContent = '正在测试连接…';
    $('btnTest').disabled = true;
    try {
      const r = await window.DashCore.testAccount(a);
      if (!r.ok) throw new Error('连接失败');
      // 门店口径：一个商户 ID = 一个门店，名字用商户名（会话里取的），
      // 不要用第一个物理分店名 —— 一个 ID 名下往往挂着好几个分店，取第一个会把门店叫错。
      if (!a.alias) a.alias = r.tenantName || a.tenantCode;
      const list = accounts().filter(x => x.tenantCode !== a.tenantCode);
      list.push(a);
      save(K.acct, list);
      const snaps = snapshots(); snaps[a.tenantCode] = r.snapshot; save(K.snap, snaps);
      $('setupTip').textContent = '已保存：' + a.alias
        + (r.branches.length > 1 ? '（该 ID 下 ' + r.branches.length + ' 个分店，数据已合并为这一家门店）' : '');
      $('fAlias').value = ''; $('fCode').value = ''; $('fPass').value = '';
      $('acctForm').style.display = 'none';
      renderAccts();
      closeSetup();
      refresh(true);
    } catch (e) {
      $('setupTip').textContent = '连接失败：' + (e.message || e) + '（检查商户ID、账号、密码）';
    } finally {
      $('btnTest').textContent = '测试连接并保存';
      $('btnTest').disabled = false;
    }
  }

  // ---------- 初始化 ----------
  function init() {
    const theme = load(K.theme, 'dark');
    document.documentElement.setAttribute('data-theme', theme);
    $('fTheme').value = theme;
    S.range = load(K.range, 'today');
    S.store = load(K.store, 'all');
    // v1.6.0 起只剩两档（销售 / 销售库存对照），旧的「剩余库存」档并进「对照」里了
    S.catTab = load(K.catTab, 'sale') === 'stock' ? 'mix' : load(K.catTab, 'sale');
    // 趋势档位改成 本周 / 本月 / 本年，默认本周（旧的 day 档已去掉）
    const tt = load(K.trendTab, 'week');
    S.trendTab = (tt === 'week' || tt === 'month' || tt === 'year') ? tt : 'week';
    S.trend = load(K.trend, null);
    S.seasonOn = !!load(K.seasonTab, false);
    S.season = load('dm.season.' + S.range, null);
    S.fold = load(K.fold, {});
    migrateCache();
    applyFold();
    // 点模块标题 = 折叠 / 展开（页面更紧凑，想看哪块再展开）
    document.addEventListener('click', (e) => {
      const hd = e.target.closest('[data-fold]');
      if (!hd) return;
      const key = hd.getAttribute('data-fold');
      S.fold[key] = !S.fold[key];
      save(K.fold, S.fold);
      applyFold();
    });
    // 趋势柱图：点一根柱往下钻一层，再点同一根收起
    $('trendBars').onclick = (e) => {
      const bk = e.target.closest('[data-back]');
      if (bk) {
        const d = Number(bk.getAttribute('data-back')) || 0;
        const c = String(S.trPath || '').split('>').filter(Boolean);
        S.trPath = c.slice(0, Math.max(0, d - 1)).join('>');
        renderTrend();
        return;
      }
      const el = e.target.closest('[data-tn]'); if (!el) return;
      const lv = Number(el.getAttribute('data-lv')) || 0;
      const id = el.getAttribute('data-tn');
      const c = String(S.trPath || '').split('>').filter(Boolean);
      const same = c[lv] === id;
      const hasKid = !!el.getAttribute('data-kid');
      c.length = lv;
      if (!same || !hasKid) c.push(id);      // 同一根柱再点一次 = 收起它的子层
      S.trPath = c.join('>');
      renderTrend();
    };

    $('ranges').onclick = (e) => {
      const el = e.target.closest('[data-range]'); if (!el) return;
      S.range = el.getAttribute('data-range'); save(K.range, S.range);
      const c = load(K.cache + S.range, null);
      S.view = c || S.view;
      S.store = 'all'; save(K.store, 'all');
      S.trPath = '';
      S.season = load('dm.season.' + S.range, null);
      renderChips(); render();
      refresh(false);
    };
    // 大类模块两档：销售 / 销售与库存对照（剩余库存已并进对照里）
    $('catTabs').onclick = (e) => {
      const el = e.target.closest('[data-cat]'); if (!el) return;
      S.catTab = el.getAttribute('data-cat'); save(K.catTab, S.catTab);
      renderCategory();
    };
    // 趋势三档：本周 / 本月 / 本年（都用同一份长周期日销售，没有就现拉一次）
    $('trendTabs').onclick = (e) => {
      const el = e.target.closest('[data-tr]'); if (!el) return;
      S.trendTab = el.getAttribute('data-tr'); save(K.trendTab, S.trendTab);
      S.trPath = '';                     // 换周期后重新从第一层看
      renderTrend();
      if (!S.trend) loadTrend(false);
    };
    // 季节：默认只统计销售（快）；库存单独点，统计一次缓存 12 小时
    $('btnSeason').onclick = () => { S.seasonOn = true; save(K.seasonTab, true); loadSeason(true, false); };
    $('btnSeasonStock').onclick = () => { S.seasonOn = true; save(K.seasonTab, true); loadSeason(true, true); };
    // 供应商榜：按商品档案归类，默认只算销售 + 库存一起（库存有 12 小时缓存）
    $('btnVendor').onclick = () => loadVendor(true);
    $('vendorTabs').onclick = (e) => {
      const el = e.target.closest('[data-vr]'); if (!el) return;
      S.vendorTab = el.getAttribute('data-vr');
      S.vendorOpen = {}; S.vendorMore = {};
      renderVendor();
      loadVendor(false);
    };
    $('vendorTable').onclick = (e) => {
      const g = e.target.closest('[data-vg]');
      if (g) {
        const n = g.getAttribute('data-vg');
        S.vendorOpen = S.vendorOpen || {};
        if (S.vendorOpen[n]) delete S.vendorOpen[n]; else S.vendorOpen[n] = 1;
        renderVendor(); return;
      }
      const m = e.target.closest('[data-vmore]');
      if (m) {
        const n = m.getAttribute('data-vmore');
        S.vendorMore = S.vendorMore || {};
        if (S.vendorMore[n]) delete S.vendorMore[n]; else S.vendorMore[n] = 1;
        renderVendor();
      }
    };
    $('storeChips').onclick = (e) => {
      const el = e.target.closest('[data-store]'); if (!el) return;
      const key = el.getAttribute('data-store');
      // 点还没填密码的门店 → 直接带它进表单，补一次就能出数
      const a = accounts().find(x => String(x.tenantCode) === key);
      if (a && !a.password) { openSetupFor(key); return; }
      S.store = key; save(K.store, key);
      S.trPath = '';
      // 供应商榜是按门店单独统计的，换店要换一份（本地有缓存就秒出）
      S.vendor = load(vendorKey(), null); S.vendorOpen = {}; S.vendorMore = {};
      renderChips(); render();
    };
    // 手动刷新时也补一次季节（下拉刷新走 refresh() 里的自动补齐）
    $('btnRefresh').onclick = () => refresh(true);
    $('btnSetup').onclick = openSetup;
    $('btnCloseSetup').onclick = closeSetup;
    $('setupMask').onclick = (e) => { if (e.target === $('setupMask')) closeSetup(); };
    $('btnAdd').onclick = () => { $('acctForm').style.display = ''; $('btnAdd').style.display = 'none'; $('setupTip').textContent = '填好后点「测试连接并保存」，账号只存在这台手机里。'; };
    $('btnCancelForm').onclick = () => { $('acctForm').style.display = 'none'; $('btnAdd').style.display = ''; };
    $('btnTest').onclick = testAndSave;
    // 门店配置的导入 / 导出：以后开新门店不用等新版本 App 了
    $('btnImport').onclick = () => {
      $('ioBox').style.display = '';
      $('ioText').value = '';
      $('btnDoImport').style.display = '';
      $('setupTip').textContent = '把大屏电脑上生成的那段配置文本粘进来（也可以粘另一台手机导出的），点「导入」即可一次性加入多家门店。';
      try { $('ioText').focus(); } catch (e) { }
    };
    $('btnExport').onclick = doExport;
    $('btnDoImport').onclick = doImport;
    $('ioWithPwd').onchange = doExport;   // 勾选时立刻按新选项重生成
    $('btnCopyIO').onclick = () => {
      const el = $('ioText');
      try {
        el.select();
        el.setSelectionRange(0, 999999);
        const ok = document.execCommand('copy');
        $('setupTip').textContent = ok
          ? '已复制，粘贴到微信发给自己或店长即可。'
          : '自动复制失败，请长按文本框手动全选复制。';
      } catch (e) {
        $('setupTip').textContent = '请长按文本框手动全选复制。';
      }
    };
    $('acctList').onclick = (e) => {
      const ed = e.target.closest('[data-edit]');
      if (ed) { // 点「补密码 / 改」：把这一条填进表单，改完点测试连接并保存
        const i = Number(ed.getAttribute('data-edit'));
        const a = accounts()[i]; if (!a) return;
        openSetupFor(a.tenantCode);
        return;
      }
      const el = e.target.closest('[data-del]'); if (!el) return;
      const i = Number(el.getAttribute('data-del'));
      const list = accounts(); const removed = list.splice(i, 1)[0];
      save(K.acct, list);
      if (removed) { const s = snapshots(); delete s[removed.tenantCode]; save(K.snap, s); }
      renderAccts();
    };
    $('fTheme').onchange = (e) => {
      document.documentElement.setAttribute('data-theme', e.target.value);
      save(K.theme, e.target.value);
    };

    initPullToRefresh();
    initSeasonLazy();
    // ?demo=1：用离线样例数据渲染（在电脑上看界面效果 / 调试用，App 里不会走到）
    if (/[?&]demo=1/.test(location.search)) {
      S.trendTab = 'month';                       // 电脑上预览时默认看「月」趋势
      const use = (v) => { S.view = v; S.trend = demoTrend(); renderChips(); render(); };
      const useSea = (v) => { S.season = v; renderSeason(); };
      if (window.__DEMO) {
        use(window.__DEMO);
        if (window.__DEMO_SEASON) { useSea(window.__DEMO_SEASON); return; }
      }
      fetch('sample-data.json').then(r => r.json()).then(use)
        .catch(() => { $('empty').textContent = '没找到样例数据（sample-data.json）'; $('empty').style.display = ''; });
      fetch('season-sample.json').then(r => r.json()).then(useSea).catch(() => { });
      return;
    }
    // 首次安装：把打包时预置的门店编号（不含密码）落到本机，用户只需补密码
    if (!accounts().length && Array.isArray(window.__PRESET__) && window.__PRESET__.length) {
      save(K.acct, window.__PRESET__.map((p) => ({
        alias: p.alias || p.tenantCode, tenantCode: String(p.tenantCode),
        userAccount: p.userAccount || '9999', password: '',
      })));
    }
    const cached = load(K.cache + S.range, null);
    if (cached) { S.view = cached; }
    // 门店列表先按配置渲染出来（新加的门店立刻能选），再开始取数
    renderChips();
    if (S.view) render();
    if (!accounts().length) { openSetup(); }
    else refresh(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
