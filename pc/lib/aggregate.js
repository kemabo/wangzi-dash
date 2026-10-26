'use strict';
// 把多租户数据聚合成大屏需要的结构
const fs = require('fs');
const path = require('path');
const { levelOf } = require('./collector');
const {
  SEASON_GROUPS, SEASON_LABELS, resolveSeason, resolveItemSeason,
  resolveItemSeasonDetailed, isArchivalSeason, seasonKeyOf, loadRules, loadMode, loadFields,
} = require('./season');

const nz = (v) => Number(v) || 0;
const r2 = (v) => Number((nz(v)).toFixed(2));

// 门店口径：一个商户账号 = 一个门店
const storeKeyLabel = (t) => t.alias || t.tenantName || String(t.tenantCode);

function accumulate(map, key, fields) {
  let o = map.get(key);
  if (!o) { o = {}; map.set(key, o); }
  for (const [k, v] of Object.entries(fields)) o[k] = nz(o[k]) + v;
  return o;
}

function build(tenantsRaw, rangeKey, meta = {}) {
  const tenants = tenantsRaw.filter(t => t.ok);
  const range = tenants[0] ? { key: rangeKey, label: tenants[0].rangeLabel, begin: tenants[0].begin, end: tenants[0].end }
    : { key: rangeKey, label: rangeKey, begin: null, end: null };

  // ---------- 门店维度 ----------
  // 口径：一个商户账号（tenantId）汇总为一个「门店」，其下的物理分店数据全部累加
  const stores = [];
  const storeMap = new Map(); // tenantCode -> store
  const ensureStore = (t) => {
    const key = String(t.tenantCode);
    let s = storeMap.get(key);
    if (!s) {
      s = {
        key, name: t.alias || t.tenantName || key,
        tenantCode: t.tenantCode, tenantName: t.tenantName || '',
        branchCount: (t.branches || []).length,
      };
      storeMap.set(key, s);
      stores.push(s);
    }
    return s;
  };
  for (const t of tenants) ensureStore(t);
  const storeNameByKey = new Map(stores.map(s => [s.key, s.name]));

  // ---------- 大类 × 门店（第二屏核心） ----------
  // 分类按「名称」跨商户合并，避免同名大类重复成行
  const catMap = new Map();      // name -> {...}
  const CATKEY = '\u0001';
  for (const t of tenants) {
    const storeKey = ensureStore(t).key;
    for (const r of (t.categoryBranch || [])) {
      if (!r.categoryCode) continue;
      const key = (r.categoryName || r.categoryCode) + CATKEY + levelOf(r.categoryCode);
      const c = accumulate(catMap, key, {
        saleAmount: r.saleAmount, saleQty: r.saleQty, grossProfit: r.grossProfit,
        costAmount: r.costAmount,
      });
      c.name = c.name || r.categoryName || '未分类';
      c.code = c.code || r.categoryCode;
      c.level = c.level || levelOf(r.categoryCode);
      c.byStore = c.byStore || {};
      c.byStore[storeKey] = {
        amount: nz(c.byStore[storeKey] && c.byStore[storeKey].amount) + r.saleAmount,
        qty: nz(c.byStore[storeKey] && c.byStore[storeKey].qty) + r.saleQty,
        gross: nz(c.byStore[storeKey] && c.byStore[storeKey].gross) + r.grossProfit,
      };
    }
  }
  const categories = [...catMap.values()].map(c => ({
    code: c.code, name: c.name || '未分类',
    saleAmount: nz(c.saleAmount), saleQty: nz(c.saleQty), grossProfit: nz(c.grossProfit),
    costAmount: nz(c.costAmount),
    byStore: c.byStore || {},
  })).sort((a, b) => b.saleAmount - a.saleAmount);

  // ---------- 每日明细 ----------
  const dailyMap = new Map(); // date -> Map(storeKey -> {amount,qty,gross,cost})
  const dateSet = new Set();
  for (const t of tenants) {
    for (const r of (t.branchDaily || [])) {
      if (!r.date) continue;
      dateSet.add(r.date);
      let dm = dailyMap.get(r.date);
      if (!dm) { dm = new Map(); dailyMap.set(r.date, dm); }
      const storeKey = ensureStore(t).key;
      accumulate(dm, storeKey, { amount: r.saleAmount, qty: r.saleQty, gross: r.grossProfit, cost: r.costAmount });
    }
  }
  const dates = [...dateSet].sort();
  const dailyTable = dates.map(d => {
    const dm = dailyMap.get(d) || new Map();
    const row = { date: d, total: 0, qty: 0, gross: 0, cells: {} };
    for (const [sk, v] of dm) {
      row.cells[sk] = v;
      row.total += nz(v.amount); row.qty += nz(v.qty); row.gross += nz(v.gross);
    }
    row.total = Number(row.total.toFixed(2));
    row.qty = Number(row.qty.toFixed(2));
    row.gross = Number(row.gross.toFixed(2));
    return row;
  });

  // ---------- 大类/中类/小类树 + 库存 ----------
  // 每个商户先按类目编码自洽地构树，再按「名称路径」跨商户合并，保证同名类目不重复
  function buildTenantTree(tenant) {
    const map = new Map();
    // 类别主数据 -> 父子关系（按 ParentId 精确解析，缺失时退回编码前缀推断）
    const master = tenant.categories || [];
    const byId = new Map(master.map(c => [c.id, c]));
    const put = (code, name) => {
      let o = map.get(code);
      if (!o) {
        o = {
          code, name: name || '未分类', level: levelOf(code), parent: null,
          saleAmount: 0, saleQty: 0, grossProfit: 0, stockQty: 0, stockCost: 0, stockRetail: 0, byStore: {},
        };
        map.set(code, o);
      } else if (name && (!o.name || o.name === '未分类')) {
        o.name = name;
      }
      return o;
    };
    // 1) 先用类别主数据搭好完整层级
    for (const c of master) put(c.code, c.name);
    for (const c of master) {
      const node = map.get(c.code);
      const p = c.parentId ? byId.get(c.parentId) : null;
      node.parent = p ? map.get(p.code) || null : null;
    }
    // 2) 报表里出现而主数据缺失的编码，用最长编码前缀推断父级
    const extra = [...(tenant.categoryTree || []), ...(tenant.stock || [])];
    for (const r of extra) {
      if (!r.categoryCode || map.has(r.categoryCode)) continue;
      const o = put(r.categoryCode, r.categoryName);
      const cands = [...map.keys()].filter(k => k !== r.categoryCode && r.categoryCode.startsWith(k));
      o.parent = cands.length ? map.get(cands.reduce((a, b) => (b.length > a.length ? b : a))) : null;
    }
    const sn0 = String(tenant.tenantCode); // 门店口径统一用 tenantCode
    for (const r of (tenant.categoryTree || [])) {
      if (!r.categoryCode) continue;
      const o = put(r.categoryCode, r.categoryName);
      o.saleAmount += r.saleAmount;
      o.saleQty += r.saleQty;
      o.grossProfit += r.grossProfit;
      // 按门店记录小类销售：报表本身就是单个商户的数据，顺手拆出来即可，
      // 单店视图要靠它在二/三级类目下钻时也能看到本店数字
      o.byStore[sn0] = o.byStore[sn0] || { saleAmount: 0, saleQty: 0, grossProfit: 0, stockQty: 0, stockCost: 0, stockRetail: 0 };
      o.byStore[sn0].saleAmount += r.saleAmount;
      o.byStore[sn0].saleQty += r.saleQty;
      o.byStore[sn0].grossProfit += r.grossProfit;
    }
    // 分类库存（零售云平台 StockByCategory）：fetchStock 已按父子链折算成「自有值」并保留
    // 服务端符号——负库存是红字异常（先销后入 / 串码），看板直接显示负数才能暴露问题；
    // 翻成绝对值会让大类合计虚高数倍，与商品级库存 / 导出报表都对不上。
    for (const s of (tenant.stock || [])) {
      if (!s.categoryCode) continue;
      const o = put(s.categoryCode, s.categoryName);
      const sq = nz(s.stockQty), sc = nz(s.costAmount), sr = nz(s.retailAmount);
      o.stockQty += sq;
      o.stockCost += sc;
      o.stockRetail += sr;
      const sn = String(tenant.tenantCode); // 门店口径统一用 tenantCode
      o.byStore[sn] = o.byStore[sn] || { stockQty: 0, stockCost: 0, stockRetail: 0 };
      o.byStore[sn].stockQty += sq;
      o.byStore[sn].stockCost += sc;
      o.byStore[sn].stockRetail += sr;
    }
    return [...map.values()];
  }

  const pathMap = new Map();
  for (const t of tenants) {
    const nodes = buildTenantTree(t);
    for (const n of nodes) {
      const seg = [];
      let cur = n;
      while (cur) { seg.unshift(cur.name); cur = cur.parent; }
      const path = seg.join(CATKEY);
      let o = pathMap.get(path);
      if (!o) {
        o = {
          key: path, name: n.name, level: seg.length,
          saleAmount: 0, saleQty: 0, grossProfit: 0,
          stockQty: 0, stockCost: 0, stockRetail: 0, byStore: {}, children: new Map(),
        };
        pathMap.set(path, o);
      }
      o.saleAmount += n.saleAmount;
      o.saleQty += n.saleQty;
      o.grossProfit += n.grossProfit;
      o.stockQty += n.stockQty;
      o.stockCost += n.stockCost;
      o.stockRetail += n.stockRetail;
      for (const [sn, v] of Object.entries(n.byStore || {})) {
        o.byStore[sn] = o.byStore[sn] || { saleAmount: 0, saleQty: 0, grossProfit: 0, stockQty: 0, stockCost: 0, stockRetail: 0 };
        o.byStore[sn].saleAmount += nz(v.saleAmount);
        o.byStore[sn].saleQty += nz(v.saleQty);
        o.byStore[sn].grossProfit += nz(v.grossProfit);
        o.byStore[sn].stockQty += nz(v.stockQty);
        o.byStore[sn].stockCost += nz(v.stockCost);
        o.byStore[sn].stockRetail += nz(v.stockRetail);
      }
      if (o.code === undefined) o.code = n.code;
    }
  }
  // 没有出现在树里的大类（如不在小类报表中）补进去
  for (const c of categories) {
    const path = c.name;
    if (!pathMap.has(path)) {
      pathMap.set(path, {
        key: path, name: c.name, level: 1, code: c.code,
        saleAmount: c.saleAmount, saleQty: c.saleQty, grossProfit: c.grossProfit,
        stockQty: 0, stockCost: 0, stockRetail: 0, byStore: {}, children: new Map(),
      });
    }
  }
  // 顶级节点采用「类别汇总」报表的权威销售口径
  const authoritative = new Map(categories.map(c => [c.name, c]));
  for (const o of pathMap.values()) {
    if (o.level !== 1) continue;
    const a = authoritative.get(o.name);
    if (a) {
      o.saleAmount = a.saleAmount;   // 该值已含各下级，不能再与子节点相加
      o.saleQty = a.saleQty;
      o.grossProfit = a.grossProfit;
      o.auth = true;
      for (const [sk, v] of Object.entries(a.byStore || {})) {
        o.byStore[sk] = Object.assign(o.byStore[sk] || { stockQty: 0, stockCost: 0, stockRetail: 0 }, { saleAmount: v.amount, saleQty: v.qty });
      }
    }
  }
  // 路径→树
  const rootList = [];
  for (const o of pathMap.values()) {
    const seg = o.key.split(CATKEY);
    if (seg.length === 1) { rootList.push(o); continue; }
    const pkey = seg.slice(0, -1).join(CATKEY);
    const parent = pathMap.get(pkey);
    if (parent) parent.children.set(o.name, o); else rootList.push(o);
  }
  const toArr = (parent) => {
    const kids = [...parent.children.values()].map(toArr).filter(Boolean);
    kids.sort((a, b) => (b.saleAmountAll !== undefined ? b.saleAmountAll : b.saleAmount) - (a.saleAmountAll !== undefined ? a.saleAmountAll : a.saleAmount));
    parent.childrenArr = kids;
    return {
      code: parent.code, name: parent.name, level: parent.level, auth: !!parent.auth,
      saleAmount: Number((parent.saleAmount || 0).toFixed(2)),
      saleQty: Number((parent.saleQty || 0).toFixed(2)),
      stockQty: Number((parent.stockQty || 0).toFixed(2)),
      stockCost: Number((parent.stockCost || 0).toFixed(2)),
      stockRetail: Number((parent.stockRetail || 0).toFixed(2)),
      byStore: parent.byStore || {},
      children: kids,
    };
  };
  const roots = rootList.map(toArr);
  const rollup = (node) => {
    for (const ch of node.children) rollup(ch);
    node.saleAmountAll = node.auth
      ? node.saleAmount
      : Number((node.saleAmount + node.children.reduce((s, c) => s + c.saleAmountAll, 0)).toFixed(2));
    node.saleQtyAll = node.auth
      ? node.saleQty
      : Number((node.saleQty + node.children.reduce((s, c) => s + c.saleQtyAll, 0)).toFixed(2));
    node.stockQtyAll = Number((node.stockQty + node.children.reduce((s, c) => s + c.stockQtyAll, 0)).toFixed(2));
    node.stockCostAll = Number((node.stockCost + node.children.reduce((s, c) => s + c.stockCostAll, 0)).toFixed(2));
    node.stockRetailAll = Number((node.stockRetail + node.children.reduce((s, c) => s + c.stockRetailAll, 0)).toFixed(2));
    // v1.2.1f：按门店的「含子孙」销售口径（byStore 只是本节点自有值，
    // 小类行在门店列要显示含下级的数，否则单店视图门店列 ≠ 合计列）
    const bsa = {};
    const addB = (o) => {
      for (const [sk, v] of Object.entries(o || {})) {
        const t = bsa[sk] = bsa[sk] || { saleAmount: 0, saleQty: 0, grossProfit: 0 };
        t.saleAmount += nz(v.saleAmount);
        t.saleQty += nz(v.saleQty);
        t.grossProfit += nz(v.grossProfit);
      }
    };
    addB(node.byStore);
    for (const ch of node.children) addB(ch.byStoreAll);
    node.byStoreAll = bsa;
    return node;
  };
  roots.forEach(rollup);
  // 剔除既无销售也无库存的空分支，避免大屏出现大量 0 行
  const prune = (arr) => arr.filter(n => {
    n.children = prune(n.children || []);
    const has = !!(n.saleAmount || n.saleQty || n.stockQty || n.stockCost);
    return has || n.children.length > 0;
  });
  const tree = prune(roots);
  tree.sort((a, b) => b.saleAmountAll - a.saleAmountAll);
  const allCats = [...pathMap.values()];

  // ---------- 大类库存（树一级节点全口径）+ 按门店拆分 ----------
  const rollStockStore = (node) => {
    const m = {};
    const add = (sk, v) => {
      if (!v || (nz(v.stockQty) === 0 && nz(v.stockCost) === 0 && nz(v.stockRetail) === 0)) return;
      const o = m[sk] = m[sk] || { stockQty: 0, stockCost: 0, stockRetail: 0 };
      o.stockQty += nz(v.stockQty); o.stockCost += nz(v.stockCost); o.stockRetail += nz(v.stockRetail);
    };
    for (const [sk, v] of Object.entries(node.byStore || {})) add(sk, v);
    for (const ch of (node.children || [])) for (const [sk, v] of Object.entries(rollStockStore(ch))) add(sk, v);
    return m;
  };
  const l1Node = new Map(tree.map(n => [n.name, n]));
  // 树一级节点：库存按门店拆分（销售数量口径与库存口径分开累计）
  for (const n of tree) {
    n.stockByStore = {};
    for (const [sk, v] of Object.entries(rollStockStore(n))) {
      n.stockByStore[sk] = {
        stockQty: Number(v.stockQty.toFixed(2)),
        stockCost: Number(v.stockCost.toFixed(2)),
        stockRetail: Number(v.stockRetail.toFixed(2)),
      };
    }
  }
  for (const c of categories) {
    const n = l1Node.get(c.name);
    if (!n) continue;
    c.stockQty = n.stockQtyAll;
    c.stockCost = n.stockCostAll;
    c.stockRetail = n.stockRetailAll;
    c.stockByStore = n.stockByStore;
  }

  // ---------- 季节表（男装/女装/鞋区/童装 × 春夏秋冬，含按门店拆分） ----------
  // 口径：逐「商品」判定季节，再汇总到 大类 × 季节
  //   ① 特性款式档案：商品 SelfCode（款式码）→ 款式档案 SeasonName
  //   ② 商品档案：Specification（规格）字段里填的季节
  //   ③ 兜底：类别名称关键词（门店未维护季节时）
  const seasonMap = meta.seasonMap || {};
  const seasonRules = loadRules();
  // 季节判定口径：门店系统中没有明细季节的大类（如部分门店的鞋区/童装），
  // 推断出来的季节容易误导 → 整个大类并入「未分类」。详见 lib/season.js:loadMode
  const modeCfg = loadMode();
  const seasonMode = modeCfg.mode || 'strict';
  const seasonThreshold = Number(modeCfg.threshold) || 40;
  const mergedNote = [];   // 记录被整类并入未分类的「门店 × 大类」（仅 auto 模式会真的合并）
  const weakNote = [];     // 记录档案季节覆盖不足的「门店 × 大类」（提示用：该大类基本没维护季节）
  const tenantLabel = new Map(tenants.map(t => [String(t.tenantCode), t.tenantName || t.alias || String(t.tenantCode)]));
  const ZERO_SEASON = () => ({ saleAmount: 0, saleQty: 0, costAmount: 0, grossProfit: 0, stockQty: 0, stockCost: 0 });
  const addNums = (o, fields) => { for (const [k, v] of Object.entries(fields)) o[k] = nz(o[k]) + nz(v); };
  const seasonAcc = new Map(); // group -> seasonKey -> {fields..., byStore:{storeKey:{...}}}
  // 哪些大类「真的有季节属性」：门店档案里录了季节、且覆盖率达标（auto 口径下未达标会整类并入未分类）。
  // 没有季节属性的大类（配件、包袋…）在季节表里不拆春夏秋冬，直接整合一栏，见下方 seasonGroups。
  const groupHasSeason = new Set();
  // 按「门店」分别记录：同一大类在不同门店的建档情况可能完全不同
  // （例如闪电仓鞋区档案里根本没录季节，而小象两店的鞋区季节覆盖率 90%+）。
  // 单店视图必须按自己这家店判断，否则会出现「春夏秋冬四行全是 0、数字全挤在未分类」。
  const groupSeasonByStore = new Map(); // storeKey -> Set(group)
  /**
   * 「这个大类到底有没有春夏秋冬特性」的判定底线（按门店商品档案统计）：
   * 档案里录了季节的商品 ≥ 5 件、且占该大类商品数 ≥ 20%，才拆春夏秋冬；
   * 低于底线的大类（床品、促销品、内衣、小商品、炒货…）不拆季节，整体并为一栏「不分季节」。
   * 真有季节特性的大类覆盖率远高于此（女装/男装/童装/鞋区/针织 27%～100%），
   * 20% 正落在「有特性」与「无特性」之间的自然空档，不会误伤真有季节的大类；
   * 5 件的下限用来挡掉「整个大类只有 1 件商品带了季节」这种零星噪声。
   */
  const SEASON_SPLIT_MIN_ITEMS = 5;
  const SEASON_SPLIT_MIN_RATIO = 0.2;
  const splitMeaningful = (st) => !!st && st.total > 0 && st.auth >= SEASON_SPLIT_MIN_ITEMS
    && (st.auth / st.total) >= SEASON_SPLIT_MIN_RATIO;
  // 全局（所有门店汇总）判定用：把各店档案统计汇总后再判定，
  // 避免某家店零星几条季节记录就把一个没有季节特性的大类在汇总视图里也拆成春夏秋冬
  const pooledGroupStat = {}; // group -> {auth, total}
  const seasonSources = [];    // 每个门店的季节来源诊断（款式档案 / 商品档案 … 各命中多少商品）
  const seasonBucket = (g, k) => {
    let gm = seasonAcc.get(g);
    if (!gm) { gm = {}; seasonAcc.set(g, gm); }
    let o = gm[k];
    if (!o) { o = ZERO_SEASON(); o.byStore = {}; gm[k] = o; }
    return o;
  };

  for (const t of tenants) {
    const sk = String(t.tenantCode);
    const dbg = {};
    const master = t.categories || [];
    const l1 = new Map(master.filter(c => String(c.code).length === 3).map(c => [String(c.code), c.name]));
    const styleMap = new Map((t.styles || []).filter(s => s.code).map(s => [String(s.code), s.season]));
    // 款式档案按 Id 索引：商品档案里有 ItemStyleId 时可直接命中（比款式码更可靠）
    const styleById = new Map((t.styles || []).filter(s => s.id).map(s => [String(s.id), s.season]));
    const itemMap = new Map((t.items || []).filter(i => i.code).map(i => [String(i.code), i]));
    // 类别编码 ↔ 名称（用于把报表行还原成 大类/中类/小类 三级路径）
    const codeName = new Map(master.map(c => [String(c.code), c.name]));
    const nameCode = new Map();
    for (const c of master) if (!nameCode.has(c.name)) nameCode.set(c.name, String(c.code));
    const midName = new Map(master.filter(c => String(c.code).length === 6).map(c => [String(c.code), c.name]));

    /**
     * 商品行 → 它所属的一级大类名称（春夏秋冬那四大类只是「顺序上排前面」，
     * 其余大类一样要进季节表；完全没有类别信息才返回 null）。
     * 只认「报表行自己的类别」（销售/库存发生时的类别），与大类汇总报表保持同一口径；
     * 仅当报表行完全没有类别信息时，才回退到商品档案。
     */
    const l1Names = new Set(l1.values());
    const groupOfRow = (row) => {
      // 1) 报表行自带类别编码（销售行）
      const code = String(row.categoryCode || '').trim();
      if (code) {
        const g = l1.get(code.slice(0, 3));
        if (g) return g;
      }
      // 2) 类别名 → 类别编码（库存行只返回类别名，多为中/小类）
      const nm = String(row.categoryName || '').trim();
      if (nm) {
        if (l1Names.has(nm)) return nm;
        const c2 = nameCode.get(nm);
        if (c2) {
          const g2 = l1.get(c2.slice(0, 3));
          if (g2) return g2;
        }
      }
      // 3) 回退到商品档案的类别
      const it = row.itemCode ? itemMap.get(String(row.itemCode).trim()) : null;
      if (it) {
        const cn = String(it.categoryName || '').trim();
        if (l1Names.has(cn)) return cn;
        const c3 = nameCode.get(cn);
        if (c3) {
          const g3 = l1.get(c3.slice(0, 3));
          if (g3) return g3;
        }
      }
      return null;
    };

    /** 报表行 → 类别三级路径 {leaf, mid}；库存行没有类别编码时用类别名/商品档案反查 */
    const pathOfRow = (row) => {
      let code = String(row.categoryCode || '').trim();
      if (!code) {
        const nm = String(row.categoryName || '').trim();
        const it = row.itemCode ? itemMap.get(String(row.itemCode).trim()) : null;
        code = nameCode.get(nm) || (it && it.categoryName ? nameCode.get(it.categoryName) : '') || '';
      }
      if (!code) return { leaf: String(row.categoryName || '').trim(), mid: '' };
      return {
        leaf: codeName.get(code) || String(row.categoryName || '').trim(),
        mid: midName.get(code.slice(0, 6)) || '',
      };
    };

    /**
     * 季节表数据来源（双轨）：
     * ① 大类「是否分春夏秋冬」的决策 —— 基于完整商品档案 t.items（门店商品主数据）+ 特性·款式档案，
     *    不再被最多 50 行的销售/库存样本带偏（这是上一轮修好的核心，女装因此正确拆分）。
     * ② 季节表的真实数值（销售额/数量/成本/毛利/库存数量/金额）—— 直接来自商品级销售 itemSale
     *    与商品级库存 itemStock（二者线上均抓全量，无 50 行上限）；每一行通过 itemCode 关联商品主数据
     *    t.items，再走 款式档案→规格→产地→备注→手工指派 的真实建档口径判定季节。
     *    这样数值真实、字段齐全，且季节判定与①同一套逻辑，绝不脱节。
     */
    const groupOfItem = (it) => {
      const cn = String(it.categoryName || '').trim();
      if (l1Names.has(cn)) return cn;
      const c = nameCode.get(cn);
      if (c) { const g = l1.get(c.slice(0, 3)); if (g) return g; }
      return null;
    };
    // ① 大类「是否分季节」决策（基于完整商品档案）
    const catalogGroupStat = {};
    for (const it of (t.items || [])) {
      const code = String(it.code || '').trim();
      if (!code || String(it.name || '').indexOf('无商品') >= 0) continue;   // 跳过占位"无商品"
      const g = groupOfItem(it);
      if (!g) continue;
      const det = resolveItemSeasonDetailed(
        { ItemCode: code, SelfCode: it.selfCode, Specification: it.specification, CategoryName: it.categoryName,
          Producer: it.producer, ItemName: it.name, ItemStyleId: it.itemStyleId, memo1: it.memo1, memo2: it.memo2 },
        styleMap, itemMap, seasonMap, { leaf: it.categoryName || '', mid: '' }, seasonRules, styleById);
      const k = (det.season && det.season !== 'none') ? det.season : 'none';
      const key = g + '|' + sk;
      const st = catalogGroupStat[key] = catalogGroupStat[key] || { auth: 0, inferred: 0, total: 0 };
      st.total += 1;
      if (k !== 'none' && isArchivalSeason(det.source)) st.auth += 1;
    }
    const keepDetail = {};
    for (const [key, st] of Object.entries(catalogGroupStat)) {
      keepDetail[key] = seasonMode === 'loose' ? true
        : (st.total > 0 && (st.auth / st.total) * 100 >= seasonThreshold);
    }
    for (const [key, st] of Object.entries(catalogGroupStat)) {
      const gname = key.split('|')[0];
      // 单店判定：过了「有季节特性」底线才拆（auto 口径还要达到覆盖率阈值）
      if (splitMeaningful(st) && (seasonMode !== 'auto' || keepDetail[key])) {
        let set = groupSeasonByStore.get(sk);
        if (!set) { set = new Set(); groupSeasonByStore.set(sk, set); }
        set.add(gname);
      }
      const p = pooledGroupStat[gname] = pooledGroupStat[gname] || { auth: 0, total: 0 };
      p.auth += st.auth; p.total += st.total;
    }
    for (const [key, ok] of Object.entries(keepDetail)) {
      if (ok) continue;
      const st = catalogGroupStat[key];
      const rec = {
        group: key.split('|')[0],
        tenantCode: sk,
        store: tenantLabel.get(sk) || sk,
        authRatio: st.total > 0 ? Number(((st.auth / st.total) * 100).toFixed(1)) : 0,
      };
      // 仍会拆季节、只是覆盖率偏低 → 提示「基本未录入季节」；
      // 连判定底线都没到的大类已整体合并为一栏（前端会列在「无季节属性」里），不再说「计入未分类」
      if (splitMeaningful(st)) weakNote.push(rec);
      if (seasonMode === 'auto') mergedNote.push(rec);  // 只有 auto 会真的把整类并进未分类
    }
    let arcTotal = 0, arcHit = 0;
    for (const st of Object.values(catalogGroupStat)) { arcTotal += st.total; arcHit += st.auth; }
    seasonSources.push({
      tenantCode: sk,
      store: tenantLabel.get(sk) || sk,
      counted: (t.items || []).length,
      counts: { archive: arcTotal ? 'ok' : 'empty' },
      archive: { total: arcTotal, hit: arcHit, ratio: arcTotal ? Number(((arcHit / arcTotal) * 100).toFixed(1)) : 0 },
      // 每个大类里「档案季节」覆盖率（基于完整商品档案），用于判断是否展示明细
      groups: Object.entries(catalogGroupStat).map(([key, st]) => ({
        group: key.split('|')[0],
        authRatio: st.total > 0 ? Number(((st.auth / st.total) * 100).toFixed(1)) : 0,
        keep: !!keepDetail[key],
      })),
    });

    // ② 真实数值采集：逐行关联商品档案判定季节，累加真实数值到（大类×季节）桶
    const seasonRow = (row, fields) => {
      const code = String(row.itemCode || row.ItemCode || '').trim();
      const it = code ? itemMap.get(code) : null;
      const g = it ? groupOfItem(it) : groupOfRow(row);
      if (!g) return;
      const det = it
        ? resolveItemSeasonDetailed(
            { ItemCode: code, SelfCode: it.selfCode, Specification: it.specification, CategoryName: it.categoryName,
              Producer: it.producer, ItemName: it.name, ItemStyleId: it.itemStyleId, memo1: it.memo1, memo2: it.memo2 },
            styleMap, itemMap, seasonMap, { leaf: it.categoryName || '', mid: '' }, seasonRules, styleById)
        : resolveItemSeasonDetailed(
            { ItemCode: code, SelfCode: row.selfCode, Specification: row.specification, CategoryName: row.categoryName, ItemName: row.itemName },
            styleMap, itemMap, seasonMap, { leaf: row.categoryName || '', mid: '' }, seasonRules, styleById);
      const k = seasonKeyOf(det, seasonMode);
      const b = seasonBucket(g, k);
      addNums(b, fields);
      const os = b.byStore[sk] = b.byStore[sk] || ZERO_SEASON();
      addNums(os, fields);
    };
    for (const r of (t.itemSale || [])) {
      seasonRow(r, { saleAmount: nz(r.saleAmount), saleQty: nz(r.saleQty), costAmount: nz(r.costAmount), grossProfit: nz(r.grossProfit) });
    }
    for (const s of (t.itemStock || [])) {
      seasonRow(s, { stockQty: nz(s.stockQty), stockCost: nz(s.stockCost) });
    }
  }

  // 全局（所有门店汇总视图）「有无季节特性」：按汇总的档案覆盖率判定，与单店同一套底线。
  // 没有季节特性的大类在汇总视图里同样不拆春夏秋冬（由前端合并为一栏「不分季节」）。
  for (const [gname, st] of Object.entries(pooledGroupStat)) {
    if (!splitMeaningful(st)) continue;
    if (seasonMode === 'auto') {
      // auto 口径还要至少一家店达到覆盖率阈值才保留拆分（与单店判定保持一致）
      let anyKeep = false;
      for (const set of groupSeasonByStore.values()) if (set.has(gname)) { anyKeep = true; break; }
      if (!anyKeep) continue;
    }
    groupHasSeason.add(gname);
  }

  // 与「大类汇总」权威口径校准：商品级合计与大类报表存在小幅差异时按结构等比缩放，
  // 保证季节表各大类合计 = 大类销售，季节占比仍为商品级的真实结构
  // 权威口径融合：catByName 原本只含「销售报表（categoryBranch）里出现的一级大类名」。
  // 女装/鞋区等大类在销售报表里只有「女单/女凉」这类小类、没有「女装」这一级名，
  // 导致 catByName.get('女装') 取不到 → 整块跳过校准（销售与库存都不对齐，库存数字全错）。
  // 这里把「分类树一级节点」也并入：树已按主数据+库存上卷好销售与库存，覆盖全部一级大类，
  // 保证女装/鞋区也能拿到权威口径并对齐库存（库存数量对齐 rstock 大类库存、金额对齐大类库存金额）。
  const catByName = new Map(categories.map(c => [c.name, c]));
  for (const n of tree) {
    if (!catByName.has(n.name)) {
      catByName.set(n.name, {
        name: n.name, code: n.code,
        saleAmount: n.saleAmountAll, saleQty: n.saleQtyAll, grossProfit: n.grossProfit, costAmount: n.costAmount,
        stockQty: n.stockQtyAll, stockCost: n.stockCostAll,
        byStore: n.byStore || {}, stockByStore: n.stockByStore || {},
      });
    } else {
      // 已在销售报表里的，用树的权威库存补全（部分一级名本身不带库存/按门店库存拆分）
      const ex = catByName.get(n.name);
      if (!nz(ex.stockQty) && nz(n.stockQtyAll)) ex.stockQty = n.stockQtyAll;
      if (!nz(ex.stockCost) && nz(n.stockCostAll)) ex.stockCost = n.stockCostAll;
      if (!ex.stockByStore && n.stockByStore) ex.stockByStore = n.stockByStore;
    }
  }
  const SALE_FIELDS = ['saleAmount', 'saleQty', 'costAmount', 'grossProfit'];
  const STOCK_FIELDS = ['stockQty', 'stockCost'];
  /**
   * 库存兜底（大库门店商品级库存抓不全的对策）：
   * 商品级库存（RptStmItems）服务端每页硬返 50 行、抓取还有 100 页上限，
   * 闪电仓 5 万+ SKU 一次只能覆盖几千个商品。若某个「大类 × 门店」的
   * 商品级库存合计低于权威分类库存（StockByCategory，已翻页拉全），
   * 把差额补进未分类桶——保证季节表各大类库存合计 == 销售模块的权威库存。
   * 春/夏/秋/冬各桶仍全部是真实商品级数据，不缩放、不按比例摊派；
   * 补的只是「还没抓到的商品」，前端提示文案会说明。
   * 完全没有商品级数据的大类不走这里（下面季节表循环用权威值整块兜底）。
   */
  let stockPatched = 0;   // 补了多少个「大类 × 门店」组合（供前端提示）
  for (const [gname, gm] of seasonAcc) {
    const c = catByName.get(gname);
    if (!c) continue;
    let sItem = 0, qItem = 0;
    for (const k of Object.keys(gm)) { sItem += nz(gm[k].saleAmount); qItem += nz(gm[k].stockQty); }
    if (sItem <= 0 && qItem <= 0) continue;    // 整块无商品级数据 → 交给下面的权威兜底
    for (const t of tenants) {
      const tk = String(t.tenantCode);
      const auth = (c.stockByStore || {})[tk] || {};
      const aq2 = nz(auth.stockQty), ac2 = nz(auth.stockCost);
      if (aq2 <= 0 && ac2 <= 0) continue;      // 这家店该大类本来就没有库存
      let iq = 0, ic = 0;
      for (const k of Object.keys(gm)) {
        const sv = (gm[k].byStore || {})[tk];
        if (sv) { iq += nz(sv.stockQty); ic += nz(sv.stockCost); }
      }
      const dq = aq2 - iq, dc = ac2 - ic;
      if (dq <= 0.01 && dc <= 0.01) continue;  // 商品级已覆盖（甚至更全），不动
      const b = seasonBucket(gname, 'none');
      b.stockQty += Math.max(dq, 0);
      b.stockCost += Math.max(dc, 0);
      const os = b.byStore[tk] = b.byStore[tk] || ZERO_SEASON();
      os.stockQty += Math.max(dq, 0);
      os.stockCost += Math.max(dc, 0);
      stockPatched++;
    }
  }
  // 季节表覆盖的大类：春夏秋冬那四大类排前面，其余一级大类按销售额依次跟进
  // （以前只固定四个大类，其余大类的销售/库存根本不进季节表）
  const l1CatNames = new Set(categories.filter(c => levelOf(c.code) === 1).map(c => c.name));
  const seasonGroupNames = [];
  for (const g of SEASON_GROUPS) if (seasonAcc.has(g) || l1CatNames.has(g)) seasonGroupNames.push(g);
  const restGroupNames = [...new Set([...seasonAcc.keys()].concat([...l1CatNames]))]
    .filter(g => !SEASON_GROUPS.includes(g))
    .sort((a, b) => nz((catByName.get(b) || {}).saleAmount) - nz((catByName.get(a) || {}).saleAmount));
  seasonGroupNames.push(...restGroupNames);
  for (const g of seasonGroupNames) {
    const c = catByName.get(g);
    if (!c) continue;
    const gm = seasonAcc.get(g);
    // 真实数值桶合计（来自 itemSale+itemStock 全量）
    let sItem = 0, qItem = 0, cItem = 0;
    if (gm) for (const k of Object.keys(gm)) { sItem += nz(gm[k].saleAmount); qItem += nz(gm[k].stockQty); cItem += nz(gm[k].stockCost); }
    const sAuth = nz(c.saleAmount), qAuth = nz(c.stockQty), cAuth = nz(c.stockCost);
    const hasSeason = groupHasSeason.has(g);

    // 商品级真实数据缺失（线上没抓到该大类销售/库存）→ 用权威值兜底整块计入未分类
    if (!gm || (sItem <= 0 && qItem <= 0)) {
      if (sAuth > 0 || qAuth > 0) {
        const b = seasonBucket(g, 'none');
        b.saleAmount = sAuth; b.saleQty = nz(c.saleQty); b.costAmount = nz(c.costAmount);
        b.grossProfit = nz(c.grossProfit); b.stockQty = qAuth; b.stockCost = cAuth;
        for (const t2 of tenants) {
          const tk = String(t2.tenantCode);
          const os = b.byStore[tk] = b.byStore[tk] || ZERO_SEASON();
          os.saleAmount = nz(((c.byStore || {})[tk] || {}).saleAmount) || nz(((c.byStore || {})[tk] || {}).amount);
          os.saleQty = nz(((c.byStore || {})[tk] || {}).saleQty);
          os.costAmount = nz(((c.byStore || {})[tk] || {}).costAmount);
          os.grossProfit = nz(((c.byStore || {})[tk] || {}).grossProfit);
          os.stockQty = nz(((c.stockByStore || {})[tk] || {}).stockQty);
          os.stockCost = nz(((c.stockByStore || {})[tk] || {}).stockCost);
        }
      }
      continue;
    }

    /**
     * 季节表数值直接采用商品级真实销售/库存（itemSale / itemStock 全量），不再做任何等比缩放。
     * 原因：缩放会把整数金额乘出小数、并让「聚合单元格」与「点开明细」两套数字对不上
     *（用户反馈：汇总有小数、点进去是整数；某门店女装秋款聚合为负、明细为正）。
     * 现在聚合单元格 == 其明细各行金额之和，口径完全一致；大类合计即商品级销售之和。
     */
  }
  const seasonRowKeys = [['spring', '春'], ['summer', '夏'], ['autumn', '秋'], ['winter', '冬'], ['none', '未分类']];
  const mkSeasonRow = (v, label, key) => {
    const byStore = {};
    for (const [sk, sv] of Object.entries(v.byStore || {})) {
      byStore[sk] = {
        saleAmount: r2(sv.saleAmount), saleQty: r2(sv.saleQty), costAmount: r2(sv.costAmount),
        grossProfit: r2(sv.grossProfit), stockQty: r2(sv.stockQty), stockCost: r2(sv.stockCost),
      };
    }
    return {
      key, season: label,
      saleAmount: r2(v.saleAmount), saleQty: r2(v.saleQty), costAmount: r2(v.costAmount),
      grossProfit: r2(v.grossProfit), stockQty: r2(v.stockQty), stockCost: r2(v.stockCost),
      byStore,
    };
  };
  const seasonGroups = seasonGroupNames.map(g => {
    const b = seasonAcc.get(g) || {};
    const hasSeason = groupHasSeason.has(g);
    // 行数据恒给全 5 行；没有季节特性的大类由前端按当前视图（汇总/单店）合并成一栏「不分季节」
    const rows = seasonRowKeys.map(([k, label]) => mkSeasonRow(b[k] || ZERO_SEASON(), label, k));
    const total = rows.reduce((s, r) => ({
      saleAmount: s.saleAmount + r.saleAmount, saleQty: s.saleQty + r.saleQty,
      costAmount: s.costAmount + r.costAmount, grossProfit: s.grossProfit + r.grossProfit,
      stockQty: s.stockQty + r.stockQty, stockCost: s.stockCost + r.stockCost,
    }), ZERO_SEASON());
    const totalByStore = {};
    for (const r of rows) {
      for (const [sk, sv] of Object.entries(r.byStore)) {
        const o = totalByStore[sk] = totalByStore[sk] || ZERO_SEASON();
        addNums(o, sv);
      }
    }
    // 每个门店各自的「这个类有没有季节」：单店视图按自己这家店决定拆不拆春夏秋冬
    const seasonalByStore = {};
    for (const t of tenants) {
      const tk = String(t.tenantCode);
      const set = groupSeasonByStore.get(tk);
      seasonalByStore[tk] = set ? set.has(g) : false;
    }
    return {
      name: g, rows, seasonal: hasSeason, seasonalByStore,
      total: {
        saleAmount: r2(total.saleAmount), saleQty: r2(total.saleQty), costAmount: r2(total.costAmount),
        grossProfit: r2(total.grossProfit), stockQty: r2(total.stockQty), stockCost: r2(total.stockCost),
      },
      totalByStore,
    };
  });
  // 销售和库存都为 0 的大类不占位（例如只在别的门店存在、或已清空的类别）
  const seasonGroupsUsed = seasonGroups.filter(g =>
    g.total.saleAmount || g.total.saleQty || g.total.stockQty || g.total.stockCost);
  const seasonTotal = seasonGroupsUsed.reduce((s, g) => ({
    saleAmount: s.saleAmount + g.total.saleAmount, saleQty: s.saleQty + g.total.saleQty,
    costAmount: s.costAmount + g.total.costAmount, grossProfit: s.grossProfit + g.total.grossProfit,
    stockQty: s.stockQty + g.total.stockQty, stockCost: s.stockCost + g.total.stockCost,
  }), ZERO_SEASON());
  const seasonTotalByStore = {};
  for (const g of seasonGroupsUsed) {
    for (const [sk, sv] of Object.entries(g.totalByStore)) {
      const o = seasonTotalByStore[sk] = seasonTotalByStore[sk] || ZERO_SEASON();
      addNums(o, sv);
    }
  }
  const seasonTable = {
    groups: seasonGroupsUsed,
    total: { saleAmount: r2(seasonTotal.saleAmount), saleQty: r2(seasonTotal.saleQty), costAmount: r2(seasonTotal.costAmount), grossProfit: r2(seasonTotal.grossProfit), stockQty: r2(seasonTotal.stockQty), stockCost: r2(seasonTotal.stockCost), byStore: seasonTotalByStore },
    labels: SEASON_LABELS,
    meta: {
      mode: seasonMode,       // auto | strict | loose
      threshold: seasonThreshold,
      fields: loadFields(),   // 季节字段白名单：只认哪些档案字段里填的季节
      merged: mergedNote,     // 因没有明细季节而整类并入未分类的「门店 × 大类」（仅 auto 模式）
      mergedGroups: [...new Set(mergedNote.map(m => m.group))],
      weak: weakNote,         // 档案季节覆盖不足的「门店 × 大类」（提示：该类大多数商品没录入季节）
      weakGroups: [...new Set(weakNote.map(m => m.group))],
      sources: seasonSources, // 各门店季节来源诊断（款式档案 / 商品档案 / 产地 / 备注 / 推断）
      stockPatched,           // 商品级库存没抓全、按权威分类库存补差额的「大类 × 门店」组合数
    },
  };

  // ---------- 实时（始终今日） ----------
  const realtime = { updatedAt: 0, hourly: [], stores: [], items: [], today: null, categories: [], members: 0, memberCount: 0 };
  const hourMap = new Map();
  const todayCatMap = new Map();
  const rtStoreMap = new Map();
  // 每个门店单独一份实时明细（小时走势 / 今日类别 / 热销商品 / 今日实收），供单店视图投影
  const rtPer = new Map();
  const ensurePer = (sk) => {
    let o = rtPer.get(sk);
    if (!o) { o = { hour: new Map(), cat: new Map(), items: new Map(), today: 0, customers: 0, avgSum: 0, avgCount: 0 }; rtPer.set(sk, o); }
    return o;
  };
  let tToday = 0, tCustomers = 0, tAvgSum = 0, tAvgCount = 0, memberCount = 0;
  for (const t of tenants) {
    const h = t.today;
    if (!h) continue;
    realtime.updatedAt = Math.max(realtime.updatedAt, nz(h.date ? Date.parse(h.date.replace(' ', 'T')) : 0));
    tToday += h.totalSale || 0;
    tCustomers += h.customers || 0;
    if (h.avgPrice > 0) { tAvgSum += h.avgPrice; tAvgCount++; }
    memberCount += h.memberCount || 0;
    const per = ensurePer(String(t.tenantCode));
    per.today += nz(h.totalSale);
    per.customers += nz(h.customers);
    if (h.avgPrice > 0) { per.avgSum += h.avgPrice; per.avgCount++; }
    for (const [k, v] of Object.entries(h.hourly || {})) {
      hourMap.set(String(k), nz(hourMap.get(String(k))) + nz(v));
      per.hour.set(String(k), nz(per.hour.get(String(k))) + nz(v));
    }
    for (const [name, v] of Object.entries(h.category || {})) {
      todayCatMap.set(name, nz(todayCatMap.get(name)) + nz(v));
      per.cat.set(name, nz(per.cat.get(name)) + nz(v));
    }
    // 该账号下所有分店的实时销售额累加为该门店的销售额
    let brSum = 0, custSum = 0;
    for (const [name, v] of Object.entries(h.branchRanking || {})) {
      brSum += nz(v);
      custSum += nz((h.PassengerFlowRanking || {})[name]);
    }
    const rtKey = String(t.tenantCode);
    const o = rtStoreMap.get(rtKey) || {
      key: rtKey, name: t.alias || t.tenantName || rtKey, tenantCode: t.tenantCode,
      tenantName: t.tenantName || '', today: 0, customers: 0,
    };
    o.today += brSum;
    o.customers += custSum;
    rtStoreMap.set(rtKey, o);
    for (const [name, v] of Object.entries(h.itemRanking || {})) {
      realtime.items.push({ name, qty: nz(v) });
      per.items.set(name, nz(per.items.get(name)) + nz(v));
    }
  }
  realtime.hourly = [...hourMap.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([h, v]) => ({ hour: `${String(h).padStart(2, '0')}:00`, amount: Number(v.toFixed(2)) }));
  realtime.categories = [...todayCatMap.entries()].sort((a, b) => b[1] - a[1])
    .map(([name, amount]) => ({ name, amount: Number(amount.toFixed(2)) }));
  // 实时门店：覆盖全部门店（今日无销售也显示为 0）
  const rtAll = stores.map(s => {
    const hit = rtStoreMap.get(s.key);
    return hit || { key: s.key, name: s.name, tenantCode: s.tenantCode, tenantName: s.tenantName, today: 0, customers: 0 };
  });
  realtime.stores = rtAll.sort((a, b) => b.today - a.today);
  realtime.items = realtime.items.sort((a, b) => b.qty - a.qty).slice(0, 12);
  realtime.memberCount = memberCount;
  realtime.today = {
    saleAmount: Number(tToday.toFixed(2)),
    customers: tCustomers,
    avgPrice: tAvgCount ? Number((tAvgSum / tAvgCount).toFixed(2)) : 0,
  };
  // 各门店自己的实时明细（单店视图使用）
  realtime.byStore = {};
  for (const [sk, per] of rtPer) {
    realtime.byStore[sk] = {
      hourly: [...per.hour.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([h, v]) => ({ hour: `${String(h).padStart(2, '0')}:00`, amount: Number(v.toFixed(2)) })),
      categories: [...per.cat.entries()].sort((a, b) => b[1] - a[1])
        .map(([name, amount]) => ({ name, amount: Number(amount.toFixed(2)) })),
      items: [...per.items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
        .map(([name, qty]) => ({ name, qty: Number(qty.toFixed(2)) })),
      today: {
        saleAmount: Number(per.today.toFixed(2)),
        customers: per.customers,
        avgPrice: per.avgCount ? Number((per.avgSum / per.avgCount).toFixed(2)) : 0,
      },
    };
  }

  // ---------- KPI ----------
  const totalSale = categories.reduce((s, c) => s + c.saleAmount, 0);
  const totalQty = categories.reduce((s, c) => s + c.saleQty, 0);
  const totalGross = categories.reduce((s, c) => s + c.grossProfit, 0);
  const stockQty = allCats.reduce((s, c) => s + c.stockQty, 0);
  const stockCost = allCats.reduce((s, c) => s + c.stockCost, 0);
  const stockRetail = allCats.reduce((s, c) => s + c.stockRetail, 0);
  const kpi = {
    saleAmount: Number(totalSale.toFixed(2)),
    saleQty: Number(totalQty.toFixed(2)),
    grossProfit: Number(totalGross.toFixed(2)),
    grossRate: totalSale > 0 ? Number((totalGross / totalSale * 100).toFixed(2)) : 0,
    customers: realtime.today.customers,
    avgPrice: realtime.today.avgPrice,
    stockQty: Number(stockQty.toFixed(2)),
    stockCost: Number(stockCost.toFixed(2)),
    stockRetail: Number(stockRetail.toFixed(2)),
    storeCount: stores.length,
    categoryCount: categories.length,
    online: tenants.reduce((s, t) => s + nz(t.today && t.today.online), 0),
    offline: tenants.reduce((s, t) => s + nz(t.today && t.today.offline), 0),
  };

  return {
    range,
    kpi,
    stores,
    categories,
    dailyTable,
    tree,
    seasonTable,
    realtime,
    // 大类 × 供应商排名：和上面所有模块吃同一份快照，顶部切档它就跟着变，
    // 不再单独联网取数（也没有自己的时间档）
    vendorByCat: buildVendorByCatCached(tenantsRaw),
    tenants: tenantsRaw.map(t => ({
      tenantCode: t.tenantCode, alias: t.alias, tenantName: t.tenantName, siteHost: t.siteHost,
      ok: t.ok, error: t.error, fetchedAt: t.fetchedAt,
      branchCount: (t.branches || []).length,
      saleAmount: Number((t.categoryBranch || []).reduce((s, r) => s + r.saleAmount, 0).toFixed(2)),
      todayAmount: Number(nz(t.today && t.today.totalSale).toFixed(2)),
    })),
    ...meta,
  };
}

/**
 * 年度月度汇总：把「今年 1 月 1 日 ~ 今天」的日销售，按月份汇总成 12 根柱子的数据。
 * 给大屏的「年度月销售柱状图」用：每月一根柱子，销售额 + 毛利并列，
 * 横轴固定从 1 月开始到 12 月，还没到的月份留空（自然体现年度进度）。
 *
 * @param results collectYearly 的产出数组（每家门店一个）
 */
function buildYearly(results, meta = {}) {
  const list = Array.isArray(results) ? results : [];
  const okList = list.filter(r => r && r.ok);
  const year = nz((list.find(r => r && r.year) || {}).year) || new Date().getFullYear();
  const months = [];
  for (let m = 1; m <= 12; m++) months.push({ m, label: m + '月', sale: 0, qty: 0, profit: 0, cost: 0, byStore: {} });

  for (const r of okList) {
    const key = String(r.tenantCode);
    for (const d of (r.daily || [])) {
      const mm = parseInt(String(d.date || '').slice(5, 7), 10);
      if (!(mm >= 1 && mm <= 12)) continue;
      const o = months[mm - 1];
      o.sale += nz(d.saleAmount);
      o.qty += nz(d.saleQty);
      o.profit += nz(d.grossProfit);
      o.cost += nz(d.costAmount);
      const bs = o.byStore[key] = o.byStore[key] || { sale: 0, qty: 0, profit: 0 };
      bs.sale += nz(d.saleAmount);
      bs.qty += nz(d.saleQty);
      bs.profit += nz(d.grossProfit);
    }
  }

  let tSale = 0, tQty = 0, tProfit = 0, tCost = 0, used = 0;
  for (const o of months) {
    o.sale = r2(o.sale); o.qty = r2(o.qty); o.profit = r2(o.profit); o.cost = r2(o.cost);
    o.rate = o.sale > 0 ? Number((o.profit / o.sale * 100).toFixed(2)) : 0;
    for (const k of Object.keys(o.byStore)) {
      const v = o.byStore[k];
      v.sale = r2(v.sale); v.qty = r2(v.qty); v.profit = r2(v.profit);
    }
    tSale += o.sale; tQty += o.qty; tProfit += o.profit; tCost += o.cost;
    if (o.sale > 0) used = o.m;   // 有销售的最大月份 = 数据走到几月
  }

  return {
    year, months,
    monthCount: used,
    total: {
      sale: r2(tSale), qty: r2(tQty), profit: r2(tProfit), cost: r2(tCost),
      rate: tSale > 0 ? Number((tProfit / tSale * 100).toFixed(2)) : 0,
      avgMonth: used > 0 ? r2(tSale / used) : 0,
    },
    updatedAt: meta.updatedAt || Date.now(),
    status: okList.length ? (okList.length < list.length ? 'partial' : 'ok') : 'error',
    errors: list.filter(r => r && !r.ok).map(r => ({ tenantCode: r.tenantCode, alias: r.alias, error: r.error })),
  };
}

module.exports = { build, buildYearly };

/**
 * 生成季节归类设置页所需的类别清单（按大类分组的小类列表 + 当前生效季节）
 * @returns {Array<{group:string, mid:string, name:string, current:string}>}
 */
function seasonCategoryList(tenantsRaw, seasonMap) {
  const out = new Map(); // group\0001name -> item
  for (const t of (tenantsRaw || []).filter(t => t.ok)) {
    const master = t.categories || [];
    const l1 = new Map(master.filter(c => String(c.code).length === 3).map(c => [c.code, c.name]));
    const midMap = new Map(master.filter(c => String(c.code).length === 6).map(c => [c.code, c.name]));
    const rows = new Map();
    for (const r of [...(t.categoryTree || []), ...(t.stock || [])]) {
      if (!r.categoryCode || String(r.categoryCode).length < 9) continue;
      rows.set(String(r.categoryCode), r.categoryName);
    }
    for (const [code, name] of rows) {
      const g = l1.get(code.slice(0, 3));
      if (!SEASON_GROUPS.includes(g)) continue;
      const mid = midMap.get(code.slice(0, 6)) || '';
      const key = g + '\u0001' + name;
      if (out.has(key)) continue;
      out.set(key, {
        group: g, mid, name,
        current: resolveSeason(name, mid, seasonMap || {}) || 'none',
      });
    }
  }
  const gOrder = SEASON_GROUPS.reduce((m, g, i) => (m[g] = i, m), {});
  return [...out.values()].sort((a, b) =>
    (gOrder[a.group] - gOrder[b.group]) || a.mid.localeCompare(b.mid, 'zh') || a.name.localeCompare(b.name, 'zh'));
}

module.exports.seasonCategoryList = seasonCategoryList;

// ---------------------------------------------------------------------------
// 大类 × 供应商：每个大类下面各供应商的销售排名（销量 / 销售额）+ 库存（数量 / 成本）
//
// 数据来源（都不需要额外请求，全部来自已有快照）：
//   销售 —— 商品级销售 itemSale（自带 itemCode 与 categoryCode）
//   库存 —— 商品级库存 itemStock（自带 itemCode；注意它只有小类名，必须靠档案还原大类）
//   供应商 —— 商品档案的 VendorName（零售云平台把供应商叫 Vendor，档案自带；供应商档案接口不存在）
// 商品档案的 categoryCode 实际是 CategoryId，要沿 categories.parentId 上溯到顶层才是「大类」。
// ---------------------------------------------------------------------------
const VENDOR_NONE = '未填供应商';

/** 单个商户内部的「商品 → 大类 / 供应商」解析器 */
function makeResolver(t) {
  // 档案有两种形态：快照里的是精简过的（code/vendorName/categoryCode），
  // items3 缓存里的是接口原始行（Code/VendorName/CategoryId）—— 两种都要认
  const itemByCode = new Map();
  for (const it of (t.items || [])) itemByCode.set(String(it.code != null ? it.code : it.Code), it);
  const cats = t.categories || [];
  const byId = new Map(cats.map(c => [String(c.id), c]));
  const byCode = new Map(cats.map(c => [String(c.code), c]));
  const byName = new Map();
  for (const c of cats) if (!byName.has(String(c.name))) byName.set(String(c.name), c);
  const topOf = (c) => {
    let x = c, guard = 0;
    while (x && x.parentId && byId.get(String(x.parentId)) && guard++ < 6) x = byId.get(String(x.parentId));
    return x;
  };
  // 销售 / 库存动辄几万行，同一商品会反复查，缓存住避免重复做类别上溯
  const catCache = new Map();
  const vendorCache = new Map();
  return {
    /** 商品归到哪个顶层大类：档案类别 id → 上溯；兜底用类别码前 3 位 / 类别名 */
    cat(itemCode, fbCode, fbName) {
      const ck = JSON.stringify([itemCode, fbCode || '', fbName || '']);
      const hit = catCache.get(ck);
      if (hit) return hit;
      const it = itemByCode.get(String(itemCode));
      let node = null;
      const itCat = it ? (it.categoryCode || it.CategoryId || it.CategoryCode) : '';
      if (itCat) node = byId.get(String(itCat));
      if (!node && fbCode) { const s = String(fbCode); node = byCode.get(s.slice(0, 3)) || byId.get(s) || null; }
      if (!node && fbName) node = byName.get(String(fbName)) || null;
      const itCatName = it ? (it.categoryName || it.CategoryName) : '';
      if (!node && itCatName) node = byName.get(String(itCatName)) || null;
      let out;
      if (!node) out = { code: '000', name: fbName || '未分类' };
      else {
        const top = topOf(node);
        out = { code: String(top.code || '000'), name: String(top.name || top.code || '未分类') };
      }
      catCache.set(ck, out);
      return out;
    },
    vendor(itemCode) {
      const k = String(itemCode);
      let v = vendorCache.get(k);
      if (v === undefined) {
        const it = itemByCode.get(k);
        const s = it ? String(it.vendorName || it.VendorName || '').trim() : '';
        v = s || VENDOR_NONE;
        vendorCache.set(k, v);
      }
      return v;
    },
    hasVendor(itemCode) {
      const it = itemByCode.get(String(itemCode));
      return !!(it && String(it.vendorName || it.VendorName || '').trim());
    },
  };
}

/**
 * @param tenantsRaw 每商户原始快照（含 items / itemSale / itemStock / categories）
 * @param opts.saleOf(t) 自定义取销售行的函数（「本年」档用外部抓取的商品级销售）
 * @param opts.withStock 是否统计库存（库存与档位无关，切档时可传 false 省一半计算）
 */
// 每个大类最多下发多少家供应商：供应商动辄两三百家，全塞进报文会拖慢每次刷新
const VENDOR_TOP_CAP = 60;

/**
 * 商品档案（含供应商）—— 按商户独立缓存，与档位无关。
 * 为什么要单独读一份而不直接用快照里的 items：
 *   只有「今日」档是最近抓的，items 里带 vendorName；
 *   昨天 / 本周 / 本月这些历史档是早先抓的，那份 items 还没这个字段。
 *   档案本身不随日期变，所以统一读 items3-<商户号>.json 这一份长期缓存。
 */
const DATA_DIR = process.env.DASH_DATA_DIR || path.join(__dirname, '..', 'data');
const ITEM_ARCHIVE_TTL = 30 * 60 * 1000;
const itemArchiveCache = new Map();
function loadItemArchive(tenantCode) {
  const code = String(tenantCode);
  const hit = itemArchiveCache.get(code);
  if (hit && Date.now() - hit.at < ITEM_ARCHIVE_TTL) return hit.rows;
  let rows = null;
  try {
    const p = path.join(DATA_DIR, `items3-${code}.json`);
    if (fs.existsSync(p)) {
      const o = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (o && Array.isArray(o.rows) && o.rows.length) rows = o.rows;
    }
  } catch (e) { }
  itemArchiveCache.set(code, { at: Date.now(), rows });
  return rows;
}

/**
 * 大类 × 供应商排名（随主数据一起出，不单独联网）
 * 行 = 大类名称（与「各大类销售数量与库存」里的行对齐，前端点大类行展开）
 * 每个供应商带 byStore，切到单店视角时只算那家店的数，切回全部则跨店合并。
 *
 * @param tenantsRaw 每商户原始快照（含 items / itemSale / itemStock / categories）
 */
function buildVendorByCat(tenantsRaw) {
  const tenants = (tenantsRaw || []).filter(t => t && t.ok !== false);
  const groups = new Map();
  let missing = 0, total = 0;

  const ensure = (catName) => {
    let g = groups.get(catName);
    if (!g) { g = { name: catName, vendors: new Map() }; groups.set(catName, g); }
    return g;
  };
  const bumpV = (g, vendorName, storeKey, patch) => {
    let v = g.vendors.get(vendorName);
    if (!v) {
      v = { name: vendorName, saleQty: 0, saleAmount: 0, stockQty: 0, stockCost: 0, byStore: {} };
      g.vendors.set(vendorName, v);
    }
    for (const k of Object.keys(patch)) {
      v[k] += patch[k];
      const b = v.byStore[storeKey] || (v.byStore[storeKey] = { saleQty: 0, saleAmount: 0, stockQty: 0, stockCost: 0 });
      b[k] += patch[k];
    }
  };

  for (const t of tenants) {
    // 历史档快照里的 items 没有供应商，统一换成按商户缓存的那份
    const items = loadItemArchive(t.tenantCode) || t.items || [];
    const R = makeResolver(Object.assign({}, t, { items }));
    const sk = String(t.tenantCode);
    for (const r of (t.itemSale || [])) {
      const q = nz(r.saleQty), amt = nz(r.saleAmount);
      if (!q && !amt) continue;
      total++;
      if (!R.hasVendor(r.itemCode)) missing++;
      bumpV(ensure(R.cat(r.itemCode, r.categoryCode, r.categoryName).name),
        R.vendor(r.itemCode), sk, { saleQty: q, saleAmount: amt });
    }
    for (const r of (t.itemStock || [])) {
      const q = nz(r.stockQty), c = nz(r.stockCost);
      if (!q && !c) continue;
      bumpV(ensure(R.cat(r.itemCode, null, r.categoryName).name),
        R.vendor(r.itemCode), sk, { stockQty: q, stockCost: c });
    }
  }

  const byCat = {};
  for (const g of groups.values()) {
    // 主序 = 销售数量（件数）从多到少：这张榜看的是「谁走得快」，不是「谁单价高」；
    // 金额只做件数相同时的次序。未填供应商仍置尾。
    const all = [...g.vendors.values()].sort((a, b) =>
      (a.name === VENDOR_NONE ? 1 : 0) - (b.name === VENDOR_NONE ? 1 : 0)
      || b.saleQty - a.saleQty || b.saleAmount - a.saleAmount || (a.name < b.name ? -1 : 1));
    // 「未填供应商」是档案没维护供应商的兜底桶，别让它占着榜首，也别被截断丢掉
    const kept = all.filter(v => v.name !== VENDOR_NONE).slice(0, VENDOR_TOP_CAP)
      .concat(all.filter(v => v.name === VENDOR_NONE));
    byCat[g.name] = {
      vendorCount: g.vendors.size,
      vendors: kept.map(v => ({
        name: v.name,
        saleQty: r2(v.saleQty), saleAmount: r2(v.saleAmount),
        stockQty: r2(v.stockQty), stockCost: r2(v.stockCost),
        byStore: Object.fromEntries(Object.entries(v.byStore).map(([k, b]) => [k, {
          saleQty: r2(b.saleQty), saleAmount: r2(b.saleAmount),
          stockQty: r2(b.stockQty), stockCost: r2(b.stockCost),
        }])),
      })),
    };
  }

  return {
    byCat,
    topCap: VENDOR_TOP_CAP,
    // 档案里没维护供应商的商品占比：高的话说明该去零售云平台后台补供应商，榜就不准
    missingVendorRate: total ? Number((missing / total * 100).toFixed(1)) : 0,
    missingVendorRows: missing,
  };
}

/**
 * 带缓存的入口：遍历几万行销售 + 库存要两秒左右，
 * 快照没换（同一批商户、同一批抓取时间）就直接复用上一次的结果。
 */
let vendorCache = { sig: '', at: 0, data: null };
function buildVendorByCatCached(tenantsRaw) {
  // 注意不能只看 fetchedAt：商品档案是从 items3 单独读的，它可能已经刷新过，
  // 所以再叠一层 30 分钟兜底，保证档案更新后榜也能跟着更新
  const sig = (tenantsRaw || []).map(t => [t.tenantCode, t.fetchedAt || 0,
    (t.items || []).length, (t.itemSale || []).length, (t.itemStock || []).length].join('|')).join(';');
  const now = Date.now();
  if (vendorCache.data && vendorCache.sig === sig && now - vendorCache.at < 30 * 60 * 1000) {
    return vendorCache.data;
  }
  const data = buildVendorByCat(tenantsRaw);
  vendorCache = { sig, at: now, data };
  return data;
}
module.exports.buildVendorByCat = buildVendorByCatCached;
