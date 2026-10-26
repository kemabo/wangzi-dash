// 季节明细追溯：把「门店 × 大类 × 季节」里的金额拆到具体商品，
// 并标出这个商品的季节读了哪个档案字段、字段值是什么。
// 用途：门店拿商品编码去系统里核对——我说的「产地=秋」到底对不对，一眼可查。
const fs = require('fs');
const path = require('path');
const season = require('./season');

// 必须与 server.js 的 DATA_DIR 一致（单文件 exe 下 __dirname 不是工作目录）
const DATA_DIR = process.env.DASH_DATA_DIR || path.join(__dirname, '..', 'data');
const GROUPS = season.SEASON_GROUPS || ['男装', '女装', '鞋区', '童装'];
const SEASON_KEYS = ['spring', 'summer', 'autumn', 'winter', 'none'];

/**
 * @param {string} range   档位 today / yesterday / thisWeek / thisMonth / lastMonth
 * @param {string} store   门店 tenantCode，空=全部
 * @param {string} group   大类，如 男装
 * @param {string} skey    季节 key，如 autumn / none
 * @param {number} limit   返回条数
 */
function seasonDetail(range, store, group, skey, limit) {
  const file = path.join(DATA_DIR, `raw-${range}.json`);
  if (!fs.existsSync(file)) return { ok: false, error: `没有 ${range} 档位的原始数据` };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const fields = season.loadFields();
  const rules = season.loadRules();
  const map = season.loadMap();

  const rows = [];
  let covered = 0, total = 0, groupTotal = 0;

  for (const t of raw) {
    const sk = String(t.tenantCode || '');
    if (store && store !== 'all' && sk !== String(store)) continue;

    // 商品档案（补全字段）与款式档案
    const itemMap = new Map();
    for (const it of (t.items || [])) if (it.code) itemMap.set(String(it.code), it);
    const styleMap = new Map();
    const styleById = new Map();
    for (const s of (t.styles || [])) {
      const sv = s.season || s.SeasonName || '';
      if (s.code) styleMap.set(String(s.code), sv);
      if (s.id) styleById.set(String(s.id), sv);
    }
    // 类别编码 → 大类（类别编码前 3 位即大类）
    const l1 = new Map();
    for (const c of (t.categories || [])) {
      const code = String(c.code || '').trim();
      if (code.length === 3) l1.set(code, String(c.name || '').trim());
    }
    const nameCode = new Map();
    for (const c of (t.categories || [])) nameCode.set(String(c.name || '').trim(), String(c.code || '').trim());
    // 季节表现在覆盖所有一级大类，追溯明细时也跟着放开（不再只认春夏秋冬那四大类）
    const l1Names = new Set(l1.values());

    const groupOf = (row) => {
      let code = String(row.categoryCode || '').trim();
      if (!code) {
        const nm = String(row.categoryName || '').trim();
        const it = row.itemCode ? itemMap.get(String(row.itemCode).trim()) : null;
        code = nameCode.get(nm) || (it && it.categoryName ? nameCode.get(it.categoryName) : '') || '';
      }
      if (code) {
        const g = l1.get(code.slice(0, 3));
        if (g) return g;
      }
      const nm2 = String(row.categoryName || '').trim();
      if (l1Names.has(nm2)) return nm2;
      const it2 = row.itemCode ? itemMap.get(String(row.itemCode).trim()) : null;
      if (it2) {
        const cn = String(it2.categoryName || '').trim();
        if (l1Names.has(cn)) return cn;
        const c3 = nameCode.get(cn);
        if (c3) { const g3 = l1.get(c3.slice(0, 3)); if (g3) return g3; }
      }
      return '';
    };

    for (const r of (t.itemSale || [])) {
      const g = groupOf(r);
      if (!g) continue;
      const amt = Number(r.saleAmount || 0);
      if (g === group) groupTotal += amt;
      const it = itemMap.get(String(r.itemCode || '').trim()) || {};
      const det = season.resolveItemSeasonDetailed(
        {
          ItemCode: r.itemCode, SelfCode: r.selfCode || it.selfCode || '',
          Specification: r.specification || it.specification || '',
          Producer: r.producer || it.producer || '',
          Memo1: it.memo1 || '', Memo2: it.memo2 || '',
          CategoryName: r.categoryName || it.categoryName || '',
          itemStyleId: it.itemStyleId || '',
        },
        styleMap, itemMap, map, { leaf: r.categoryName || it.categoryName || '', mid: '' }, rules, styleById);
      // 与聚合同一套口径：strict/auto 只认门店录入的季节，推断（关键词/名称）归未分类；loose 才保留
      const mode = (season.loadMode() || {}).mode || 'strict';
      const key = season.seasonKeyOf(det, mode);
      if (g === group) {
        total += amt;
        if (key !== 'none') covered += amt;
      }
      // skey=all：该大类没有季节属性，整栏展示，不按季节过滤
      if (g !== group || (skey !== 'all' && key !== skey)) continue;
      rows.push({
        store: t.alias || t.tenantName || sk,
        tenantCode: sk,
        code: String(r.itemCode || ''),
        name: String(r.itemName || it.name || ''),
        category: String(r.categoryName || it.categoryName || ''),
        spec: String(it.specification || r.specification || ''),
        producer: String(it.producer || r.producer || ''),
        memo1: String(it.memo1 || ''),
        memo2: String(it.memo2 || ''),
        styleSeason: styleMap.get(String(it.selfCode || r.selfCode || '')) || '',
        source: det.source,
        sourceLabel: season.SOURCE_LABELS[det.source] || det.source,
        amount: Math.round(amt * 100) / 100,
        qty: Number(r.saleQty || 0),
        // 零售云平台销售报表里自带的「无商品 均色 均码」系统占位条目（无码销售/赠品/其他），非真实货品
        placeholder: String(r.itemName || it.name || '').indexOf('无商品') >= 0,
      });
    }
  }

  rows.sort((a, b) => b.amount - a.amount);
  return {
    ok: true, range, store: store || 'all', group, season: skey,
    seasonLabel: skey === 'all' ? '不分季节' : (season.SEASON_LABELS[skey] || skey),
    rows: rows.slice(0, limit),
    matched: rows.length,
    // 该大类里「能追溯到档案季节」的占比，用来判断这个数字可不可信
    groupTotal: Math.round(groupTotal * 100) / 100,
    covered: Math.round(covered * 100) / 100,
    coverRatio: groupTotal > 0 ? Math.round((covered / groupTotal) * 1000) / 10 : 0,
    fields,
  };
}

module.exports = { seasonDetail, SEASON_KEYS, GROUPS };
