'use strict';
/**
 * 单店视图：把「全公司」的聚合结果投影成「某一个门店」的视角。
 *
 * 之所以放在服务端做，是因为一旦在浏览器里下发全量数据，
 * 单店员工改个地址就能看到别家店的数字；在服务端裁剪后，
 * 单店拿到的报文里就不存在其他门店的任何数据。
 *
 * @param {object} payload build() 的产物
 * @param {string} storeKey 门店 key（= 商户账号 tenantCode）
 * @returns {object} 结构完全一致、但数值只剩该门店的 payload
 */
function projectStore(payload, storeKey) {
  const nz = (v) => Number(v) || 0;
  const p = payload;
  if (!p || !storeKey) return p;
  const key = String(storeKey);
  const store = (p.stores || []).find(s => String(s.key) === key);
  if (!store) return p;

  const num = (v) => Number(Number(v || 0).toFixed(2));
  const pick = (obj, k) => (obj && obj[k]) ? obj[k] : {};
  // 只留下本店这一支：前端读 byStore 的代码全部照常工作，且看不到别家店
  const only = (obj) => {
    const v = (obj || {})[key];
    return v ? { [key]: v } : {};
  };

  // ---------- 大类 × 库存 ----------
  const categories = (p.categories || []).map(c => {
    const s = pick(c.byStore, key);
    const st = pick(c.stockByStore, key);
    return {
      code: c.code, name: c.name, level: c.level,
      saleAmount: num(s.amount), saleQty: num(s.qty), grossProfit: num(s.gross),
      costAmount: num(s.amount - s.gross),
      stockQty: num(st.stockQty), stockCost: num(st.stockCost), stockRetail: num(st.stockRetail),
      byStore: only(c.byStore), stockByStore: only(c.stockByStore),
    };
  }).filter(c => c.saleAmount || c.saleQty || c.stockQty || c.stockCost || c.stockRetail)
    .sort((a, b) => b.saleAmount - a.saleAmount);

  // ---------- 每日明细 ----------
  const dailyTable = (p.dailyTable || []).map(d => {
    const v = pick(d.cells, key);
    return {
      date: d.date, total: num(v.amount), qty: num(v.qty), gross: num(v.gross), cost: num(v.cost),
      cells: only(d.cells),
    };
  });

  // ---------- 类别树 ----------
  const projectNode = (n) => {
    const s = pick(n.byStore, key);
    const kids = (n.children || []).map(projectNode);
    return {
      code: n.code, name: n.name, level: n.level, auth: !!n.auth,
      saleAmount: num(s.saleAmount), saleQty: num(s.saleQty), grossProfit: num(s.grossProfit),
      stockQty: num(s.stockQty), stockCost: num(s.stockCost), stockRetail: num(s.stockRetail),
      saleAmountAll: 0, saleQtyAll: 0, stockQtyAll: 0, stockCostAll: 0, stockRetailAll: 0,
      byStore: only(n.byStore),
      byStoreAll: only(n.byStoreAll),
      children: kids,
    };
  };
  const pruneTree = (arr) => arr.filter(n => {
    n.children = pruneTree(n.children || []);
    const kidSum = n.children.reduce((s, c) => s + c.stockCostAll, 0);
    n.stockCostAll = Number((Number(n.stockCost || 0) + kidSum).toFixed(2));
    const kidQty = n.children.reduce((s, c) => s + c.stockQtyAll, 0);
    n.stockQtyAll = Number((Number(n.stockQty || 0) + kidQty).toFixed(2));
    const kidRetail = n.children.reduce((s, c) => s + c.stockRetailAll, 0);
    n.stockRetailAll = Number((Number(n.stockRetail || 0) + kidRetail).toFixed(2));
    const kidAmt = n.children.reduce((s, c) => s + c.saleAmountAll, 0);
    n.saleAmountAll = n.auth ? n.saleAmount : Number((Number(n.saleAmount || 0) + kidAmt).toFixed(2));
    const kidQ = n.children.reduce((s, c) => s + c.saleQtyAll, 0);
    n.saleQtyAll = n.auth ? n.saleQty : Number((Number(n.saleQty || 0) + kidQ).toFixed(2));
    return !!(n.saleAmountAll || n.saleQtyAll || n.stockQtyAll || n.stockCostAll) || n.children.length > 0;
  });
  const tree = pruneTree((p.tree || []).map(projectNode));
  tree.sort((a, b) => b.saleAmountAll - a.saleAmountAll);
  // 一级节点的库存要包含所有子孙（大类数量表按这个口径显示）
  const rollupStock = (node) => {
    const out = {};
    const add = (o) => {
      for (const [sk, v] of Object.entries(o || {})) {
        const t = out[sk] = out[sk] || { stockQty: 0, stockCost: 0, stockRetail: 0 };
        t.stockQty += nz(v.stockQty); t.stockCost += nz(v.stockCost); t.stockRetail += nz(v.stockRetail);
      }
    };
    add(node.byStore);
    for (const ch of (node.children || [])) add(rollupStock(ch));
    return out;
  };
  for (const n of tree) n.stockByStore = rollupStock(n);

  // ---------- 季节表 ----------
  const seasonRow = (r) => {
    const s = pick(r.byStore, key);
    return {
      key: r.key, season: r.season,
      saleAmount: num(s.saleAmount), saleQty: num(s.saleQty), costAmount: num(s.costAmount),
      grossProfit: num(s.grossProfit), stockQty: num(s.stockQty), stockCost: num(s.stockCost),
      byStore: only(r.byStore),
    };
  };
  // 这家店在这个大类里到底有没有维护季节：有 → 春夏秋冬+未分类；没有 → 合并成一栏「不分季节」
  // （判定必须按门店单独算，不能拿三店合计的结果，否则该店会看到四行全 0 的季节）
  const seasonalOf = (g) => {
    const m = g.seasonalByStore || {};
    return Object.prototype.hasOwnProperty.call(m, key) ? !!m[key] : !!g.seasonal;
  };
  const mergeRows = (rows) => {
    const FIELDS = ['saleAmount', 'saleQty', 'costAmount', 'grossProfit', 'stockQty', 'stockCost'];
    const out = { saleAmount: 0, saleQty: 0, costAmount: 0, grossProfit: 0, stockQty: 0, stockCost: 0 };
    const bs = { saleAmount: 0, saleQty: 0, costAmount: 0, grossProfit: 0, stockQty: 0, stockCost: 0 };
    let any = false;
    for (const r of rows) {
      for (const f of FIELDS) out[f] += Number(r[f]) || 0;
      const v = r.byStore && r.byStore[key];
      if (v) { any = true; for (const f of FIELDS) bs[f] += Number(v[f]) || 0; }
    }
    for (const f of FIELDS) { out[f] = num(out[f]); bs[f] = num(bs[f]); }
    return { key: 'all', season: '不分季节', ...out, byStore: any ? { [key]: bs } : {} };
  };
  const seasonTable = p.seasonTable ? {
    groups: (p.seasonTable.groups || []).map(g => {
      let rows = (g.rows || []).map(seasonRow);
      const seasonal = seasonalOf(g);
      if (!seasonal && rows.length > 1) rows = [mergeRows(rows)];
      const s = pick(g.totalByStore, key);
      return {
        name: g.name, rows, seasonal, seasonalByStore: { [key]: seasonal },
        total: {
          saleAmount: num(s.saleAmount), saleQty: num(s.saleQty), costAmount: num(s.costAmount),
          grossProfit: num(s.grossProfit), stockQty: num(s.stockQty), stockCost: num(s.stockCost),
        },
        totalByStore: only(g.totalByStore),
      };
      // 这家店没有的大类（销售、库存都为 0）直接不显示，别留一堆空行
    }).filter(g => g.total.saleAmount || g.total.saleQty || g.total.stockQty || g.total.stockCost),
    total: (() => {
      const s = pick((p.seasonTable.total || {}).byStore, key);
      return {
        saleAmount: num(s.saleAmount), saleQty: num(s.saleQty), costAmount: num(s.costAmount),
        grossProfit: num(s.grossProfit), stockQty: num(s.stockQty), stockCost: num(s.stockCost),
        byStore: only((p.seasonTable.total || {}).byStore),
      };
    })(),
    labels: p.seasonTable.labels,
    meta: Object.assign({}, p.seasonTable.meta, {
      merged: (p.seasonTable.meta && p.seasonTable.meta.merged || []).filter(m => String(m.tenantCode) === key),
      weak: (p.seasonTable.meta && p.seasonTable.meta.weak || []).filter(m => String(m.tenantCode) === key),
      sources: (p.seasonTable.meta && p.seasonTable.meta.sources || []).filter(m => String(m.tenantCode) === key),
    }),
  } : p.seasonTable;

  // ---------- 大类 × 供应商 ----------
  // 顶层字段换成只算本店的数，byStore 只留本店一支 —— 别家店的供应商数据一个都不能带出去
  let vendorByCat = p.vendorByCat;
  if (vendorByCat && vendorByCat.byCat) {
    // 与 aggregate.js 的 VENDOR_NONE 同值：兜底桶照样排最后
    const NONE = '未填供应商';
    const byCat = {};
    for (const [name, g] of Object.entries(vendorByCat.byCat)) {
      const vendors = (g.vendors || []).map(v => {
        const b = (v.byStore || {})[key];
        if (!b) return null;   // 本店没有这家供应商的任何销售/库存，直接丢掉
        return {
          name: v.name,
          saleQty: num(b.saleQty), saleAmount: num(b.saleAmount),
          stockQty: num(b.stockQty), stockCost: num(b.stockCost),
          byStore: { [key]: b },
        };
      }).filter(Boolean)
        .sort((a, b) => (a.name === NONE ? 1 : 0) - (b.name === NONE ? 1 : 0)
          || b.saleAmount - a.saleAmount || b.saleQty - a.saleQty);
      if (!vendors.length) continue;   // 本店这个大类压根没有数据，整行不出现
      byCat[name] = { vendorCount: vendors.length, vendors };
    }
    vendorByCat = Object.assign({}, vendorByCat, { byCat });
  }

  // ---------- 实时 ----------
  const rtSrc = pick((p.realtime || {}).byStore, key);
  const realtime = {
    updatedAt: (p.realtime || {}).updatedAt,
    hourly: rtSrc.hourly || [],
    categories: rtSrc.categories || [],
    items: rtSrc.items || [],
    today: rtSrc.today || { saleAmount: 0, customers: 0, avgPrice: 0 },
    stores: (p.realtime && p.realtime.stores || []).filter(s => String(s.key) === key),
    byStore: only((p.realtime || {}).byStore),
    members: 0,
    memberCount: 0,
  };

  // ---------- KPI ----------
  const totalSale = categories.reduce((s, c) => s + c.saleAmount, 0);
  const totalQty = categories.reduce((s, c) => s + c.saleQty, 0);
  const totalGross = categories.reduce((s, c) => s + c.grossProfit, 0);
  const stockQty = tree.reduce((s, c) => s + (c.stockQtyAll || 0), 0);
  const stockCost = tree.reduce((s, c) => s + (c.stockCostAll || 0), 0);
  const stockRetail = tree.reduce((s, c) => s + (c.stockRetailAll || 0), 0);
  const kpi = {
    saleAmount: num(totalSale),
    saleQty: num(totalQty),
    grossProfit: num(totalGross),
    grossRate: totalSale > 0 ? Number((totalGross / totalSale * 100).toFixed(2)) : 0,
    customers: realtime.today.customers,
    avgPrice: realtime.today.avgPrice,
    stockQty: num(stockQty),
    stockCost: num(stockCost),
    stockRetail: num(stockRetail),
    storeCount: 1,
    categoryCount: categories.length,
    online: 0,
    offline: 0,
  };

  // 其余字段（updatedAt 等）原样带过去
  const rest = {};
  for (const [k, v] of Object.entries(p)) {
    if (['range', 'kpi', 'stores', 'categories', 'dailyTable', 'tree', 'seasonTable', 'realtime', 'tenants', 'vendorByCat'].includes(k)) continue;
    rest[k] = v;
  }
  return Object.assign(rest, {
    range: p.range,
    kpi,
    stores: [store],
    categories,
    dailyTable,
    tree,
    seasonTable,
    realtime,
    // 单店视角的供应商榜：只剩本店的数
    vendorByCat,
    // 单店视图下不暴露其他门店的采集状态
    tenants: (p.tenants || []).filter(t => String(t.tenantCode) === key),
    storeKey: key,
    storeName: store.name,
  });
}

module.exports = { projectStore };
