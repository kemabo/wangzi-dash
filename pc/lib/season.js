'use strict';
// 季节归类
// 真实来源（按门店建档方式自动路由，优先级从高到低）：
//   1) 特性款式档案：商品档案的 SelfCode（款式码）→ 款式档案 SeasonName
//   2) 商品档案：Specification（规格）字段里填的季节
//   3) 商品档案：Memo1 / Memo2（备注）里填的季节（严格匹配，避免厂家名误判）
//   4) 手工归类（季节归类设置里指派的小类/中类）
//   5) 关键词规则（season-rules.json，可编辑）：小类名 → 中类名 → 商品名
//   6) 仍未识别 → 未分类
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DASH_DATA_DIR || path.join(__dirname, '..', 'data');
const MAP_FILE = path.join(DATA_DIR, 'season-map.json');
const RULES_FILE = path.join(DATA_DIR, 'season-rules.json');
const MODE_FILE = path.join(DATA_DIR, 'season-mode.json');

// 大屏季节表的四个目标大类（按一级大类名称匹配）
const SEASON_GROUPS = ['男装', '女装', '鞋区', '童装'];

// season key -> 展示名
const SEASON_LABELS = { spring: '春', summer: '夏', autumn: '秋', winter: '冬', none: '未分类' };

// 规则判定顺序：先看冬（加绒/棉），再看夏，再秋，再春
const RULE_ORDER = ['winter', 'summer', 'autumn', 'spring'];

// 默认关键词规则（鞋服行业常见叫法）
const DEFAULT_RULES = {
  winter: ['棉', '棉鞋', '棉靴', '二棉', '大棉', '加绒', '加厚', '羽绒', '保暖', '雪地', '打底', '绒'],
  summer: ['凉', '凉鞋', '洞洞', '洞洞鞋', '网', '网鞋', '网布', '沙滩', '短袖', 'T恤', 't恤', '短裤', '裙', '防晒', '冰丝', '拖鞋'],
  autumn: ['单鞋', '单', '外套', '风衣', '马甲', '卫衣', '长袖', '毛衫', '毛衣', '针织'],
  spring: ['春秋', '开衫', '衬衣', '衬衫', '春款'],
};

// ---------------- 配置文件内存缓存 ----------------
// map / rules / mode / fields 这四份季节口径配置，在聚合时会被「逐商品」调用几十万次
// （见 resolveItemSeasonDetailed）。每次都 fs 读盘 + JSON.parse 会把一次 build 拖到 15 秒，
// 实测约 62% 的 CPU 耗在了 statSync / open 上。这里统一按文件 mtime 缓存，
// 并且 mtime 本身也做节流 —— 缓存有效期内是纯内存查找，零 IO。
const STAT_MEM = new Map();   // file -> { at, mtimeMs }
const CONF_MEM = new Map();   // key  -> { mtimeMs, value }
const STAT_TTL = 1000;        // 1s 内不重复 stat：聚合高峰期能省掉几十万次系统调用

function statMs(file) {
  const now = Date.now();
  const m = STAT_MEM.get(file);
  if (m && now - m.at < STAT_TTL) return m.mtimeMs;
  let ms = -1;
  try { ms = fs.statSync(file).mtimeMs; } catch (e) { ms = -1; }
  STAT_MEM.set(file, { at: now, mtimeMs: ms });
  return ms;
}

/** 读一份配置：文件没变就直接返回上次的结果，文件被改（或不存在）才重新解析 */
function readConf(file, key, parseFn) {
  const ms = statMs(file);
  const c = CONF_MEM.get(key);
  if (c && c.mtimeMs === ms) return c.value;
  const value = parseFn();
  CONF_MEM.set(key, { mtimeMs: ms, value });
  return value;
}

/** 配置被改写后调用，让下次读取重新解析 */
function invalidateConf(file) {
  STAT_MEM.delete(file);
}

function loadMap() {
  return readConf(MAP_FILE, 'map', () => {
    try {
      const o = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
      if (o && typeof o === 'object') return o;
    } catch (e) { }
    return {};
  });
}

function saveMap(map) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }
  fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2), 'utf8');
  CONF_MEM.delete('map');
  invalidateConf(MAP_FILE);
}

function loadRules() {
  return readConf(RULES_FILE, 'rules', () => {
    try {
      const o = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
      if (o && typeof o === 'object') {
        // 只接受已知季节键，过滤空数组
        const out = {};
        for (const k of RULE_ORDER) {
          if (Array.isArray(o[k])) out[k] = o[k].filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
        }
        if (Object.keys(out).length) return out;
      }
    } catch (e) { }
    return DEFAULT_RULES;
  });
}

function saveRules(rules) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf8');
  CONF_MEM.delete('rules');
  invalidateConf(RULES_FILE);
}

// ---------------- 季节字段白名单 ----------------
// 只有下面这些「门店系统里真实存在的档案字段」里填了季节，才计入春夏秋冬。
// 业务口径（用户明确要求）：
//   特性·款式档案的款式季节 + 商品档案的 规格 / 产地 / 等级 / 备注1 / 备注2，
//   这几个地方都没写季节 → 一律「未分类」，绝不靠商品名或关键词去猜。
const FIELD_LABELS = {
  style: '特性·款式档案（基础资料·季节）',
  spec: '商品档案·规格',
  producer: '商品档案·产地',
  memo: '商品档案·备注1/备注2',
  manual: '大屏手工指派',
};
const DEFAULT_FIELDS = { style: true, spec: true, producer: true, memo: true, manual: true };
const FIELDS_FILE = path.join(DATA_DIR, 'season-fields.json');

function loadFields() {
  return readConf(FIELDS_FILE, 'fields', () => {
    const fallback = { ...DEFAULT_FIELDS };
    try {
      const o = JSON.parse(fs.readFileSync(FIELDS_FILE, 'utf8'));
      const v = {};
      for (const k of Object.keys(DEFAULT_FIELDS)) v[k] = o && typeof o[k] === 'boolean' ? o[k] : DEFAULT_FIELDS[k];
      return v;
    } catch (e) {
      return fallback;
    }
  });
}

function saveFields(fields) {
  const v = {};
  for (const k of Object.keys(DEFAULT_FIELDS)) v[k] = !!(fields && fields[k]);
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }
  fs.writeFileSync(FIELDS_FILE, JSON.stringify(v, null, 2), 'utf8');
  CONF_MEM.delete('fields');
  invalidateConf(FIELDS_FILE);
  return v;
}

// ---------------- 季节判定口径 ----------------
// strict（默认，也是业务要求）只认门店系统里**真正录入**的季节：
//         特性·款式档案的款式季节、商品档案的 规格 / 产地 / 备注、以及大屏里手工指派的类别季节。
//         关键词规则与名称识别都属于「猜」，一律计入未分类 —— 门店没录季节就不许凭空出现季节数据。
// auto   自动：在 strict 的基础上，某个「门店×大类」档案季节覆盖到的销售/库存占比低于阈值时，
//         说明该大类基本没维护季节 → 整类并入未分类（会连同真实的那部分一起并入，更保守）。
// loose  宽松：档案 + 关键词推断都保留（数据更满，但可能有偏差，不推荐）
const DEFAULT_MODE = { mode: 'strict', threshold: 20 };

function loadMode() {
  try {
    const o = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
    if (o && ['auto', 'strict', 'loose'].includes(o.mode)) {
      return { mode: o.mode, threshold: Number(o.threshold) > 0 ? Number(o.threshold) : DEFAULT_MODE.threshold };
    }
  } catch (e) { }
  return { ...DEFAULT_MODE };
}

function saveMode(mode) {
  const clean = {
    mode: ['auto', 'strict', 'loose'].includes(mode && mode.mode) ? mode.mode : DEFAULT_MODE.mode,
    threshold: Math.max(0, Math.min(100, Number(mode && mode.threshold) || DEFAULT_MODE.threshold)),
  };
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }
  fs.writeFileSync(MODE_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

/** 把任意文本归一到季节 key；识别不出返回 '' */
// 顺序很重要：「春秋」归春、「冬」优先于「秋」
function normalizeSeason(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return '';
  if (/四季/.test(s)) return '';           // 四季款不占具体季节
  if (/春/.test(s)) return 'spring';       // 含「春秋」
  if (/夏/.test(s)) return 'summer';
  if (/冬/.test(s)) return 'winter';
  if (/秋/.test(s)) return 'autumn';
  // 服饰常见别名兜底
  if (/(大棉|二棉|棉鞋|棉靴|加绒|加厚|羽绒|保暖|雪地)/.test(s)) return 'winter';
  if (/(单鞋|网鞋|凉鞋|洞洞|沙滩|防晒)/.test(s)) return 'summer';
  return '';
}

/** 严格季节文本：仅用于备注字段，避免把厂家名（如「夏彬」）当季节 */
function strictSeason(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s || s.length > 6) return '';
  if (/^(春|夏|秋|冬|春秋)(款|季|装)?$/.test(s)) return normalizeSeason(s);
  return '';
}

/**
 * 档案里自由文本字段的季节判定（产地 / 规格 / 年份字段等）。
 * 允许：「夏」「春秋」「2026秋季」「秋2026」「夏款」「冬装」「2026秋冬」
 * 拒绝：「夏彬」「夏发联营男单」「199」（价格）等厂家名或非季节文本
 */
function archiveSeasonText(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s || s.length > 12) return '';
  // 去掉年份（2026 / 26 / 25）与分隔符，只保留核心词
  const core = s.replace(/[0-9]{2,4}/g, '').replace(/[-_/·.\s]/g, '');
  if (!core) return '';
  if (/^(春|夏|秋|冬|春秋|秋冬|春夏|夏秋)(款|季|装|天|季款)?$/.test(core)) return normalizeSeason(core);
  return '';
}

/**
 * 规格/产地这类「档案自由填写字段」的季节判定：严格 + 尾部匹配
 * 允许：「夏」「春秋」「2026秋季」「女鞋冬」「冬2x2.3」「冬款」
 * 拒绝：「夏发联营男单」（厂商名）、「199」（价格）
 */
function specSeason(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s || s.length > 12) return '';
  const bare = s.replace(/[0-9.]+$/g, '').trim();   // 去掉尾部数字（冬2x2.3 → 冬）
  return archiveSeasonText(bare) || tailSeason(bare) || archiveSeasonText(s) || '';
}

/**
 * 尾部季节匹配：用于备注这类「前缀 + 季节」的写法
 * 允许：「女装春」「女鞋-秋」「童装上衣夏」「2026秋季」
 * 拒绝：「夏彬」「春季新品到店」（过长的描述）
 */
function tailSeason(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s || s.length > 10) return '';
  const a = archiveSeasonText(s);
  if (a) return a;
  if (/(春|夏|秋|冬|春秋|秋冬)(款|季|装)?$/.test(s)) return normalizeSeason(s.match(/(春|夏|秋|冬|春秋|秋冬)/)[1]);
  return '';
}

/** 按关键词规则识别季节（text 里出现任一关键词即命中） */
function seasonByRules(text, rules) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return '';
  const r = rules || DEFAULT_RULES;
  for (const key of RULE_ORDER) {
    const arr = r[key] || [];
    for (const kw of arr) {
      if (kw && s.indexOf(kw) >= 0) return key;
    }
  }
  return '';
}

/** 按类别名称关键词自动识别季节 */
function autoSeason(name) {
  if (!name) return '';
  const s = String(name);
  if (/春秋/.test(s)) return 'spring';   // 春秋款默认计入春，可在设置里调整
  if (/夏/.test(s)) return 'summer';
  if (/冬/.test(s)) return 'winter';
  if (/秋/.test(s)) return 'autumn';
  if (/春/.test(s)) return 'spring';
  if (/(大棉|二棉|棉鞋|棉靴|加绒|加厚|羽绒|保暖|雪地)/.test(s)) return 'winter';
  if (/(单鞋|网鞋|凉鞋|洞洞|沙滩|防晒)/.test(s)) return 'summer';
  return '';
}

/**
 * 解析一个小类的季节（类别维度兜底用）
 * @returns {string} '' | 'spring' | 'summer' | 'autumn' | 'winter'
 */
function resolveSeason(name, parentName, map) {
  const m = map || {};
  if (name && m[name]) return m[name];
  if (parentName && m[parentName]) return m[parentName];
  let s = autoSeason(name);
  if (s) return s;
  s = autoSeason(parentName);
  return s || '';
}

const norm = (v) => String(v == null ? '' : v).trim();

/**
 * 解析一个「商品」的季节
 * @param {object} row       商品级行：{ItemCode, SelfCode, Specification, CategoryName, ItemName}
 * @param {Map}    styleMap  款式码 -> 季节文本（款式档案 SeasonName）
 * @param {Map}    itemMap   商品码 -> 档案 {SelfCode, Specification, Memo1, Memo2}
 * @param {object} map       手工季节映射（类别名 -> key）
 * @param {object} catPath   {leaf, mid} 报表行类别编码对应的小类/中类名称
 * @param {object} rules     关键词规则（可选，默认读 season-rules.json）
 * @returns {string} 'spring' | 'summer' | 'autumn' | 'winter' | 'none'
 */
/**
 * 解析一个「商品」的季节，并返回来源，用于判断该行是否属于「明细季节」
 * source: style(款式档案) | spec(商品档案规格) | memo(商品档案备注) | manual(手工指派)
 *         | rule(关键词规则推断) | name(名称自动识别) | none(未识别)
 * @returns {{season:string, source:string}}
 */
function resolveItemSeasonDetailed(row, styleMap, itemMap, map, catPath, rules, styleById) {
  const r = row || {};
  const ruleSet = rules || loadRules();
  // 字段白名单：关掉的字段即使里面有季节也不采用（门店可能拿产地/备注填厂商名，可自行取舍）
  const fcfg = loadFields();
  const on = (k) => fcfg[k] !== false;
  const pick = (a, b) => norm(r[a] != null ? r[a] : r[b]);
  const code = pick('ItemCode', 'itemCode');
  const self = pick('SelfCode', 'selfCode');
  const spec = pick('Specification', 'specification');
  const producer = pick('Producer', 'producer');
  const styleHit = (key) => {
    if (!key || !styleMap || !styleMap.has(key)) return '';
    return normalizeSeason(styleMap.get(key));
  };
  // 1) 特性款式档案：自编码（款式码）在款式档案里有季节
  let k = on('style') ? styleHit(self) : '';
  if (k) return { season: k, source: 'style' };
  // 2) 商品档案的规格字段（多数门店把季节就填在规格里）
  if (spec && on('spec')) {
    k = specSeason(spec);
    if (k) return { season: k, source: 'spec' };
  }
  // 2b) 商品档案的产地字段（部分门店把季节填在产地，值形如 夏 / 春秋 / 2026秋季）
  if (producer && on('producer')) {
    k = specSeason(producer);
    if (k) return { season: k, source: 'producer' };
  }
  // 3) 用商品档案补全（报表行里的 SelfCode / Specification / 产地 可能为空）
  //    商品档案里的季节来源：款式档案(按款式码或款式ID) → 规格 → 产地 → 备注
  const it = code && itemMap ? itemMap.get(code) : null;
  if (it) {
    k = on('style') ? styleHit(norm(it.selfCode)) : '';
    if (k) return { season: k, source: 'style' };
    if (on('style') && styleById && it.itemStyleId && styleById.has(String(it.itemStyleId))) {
      k = normalizeSeason(styleById.get(String(it.itemStyleId)));
      if (k) return { season: k, source: 'style' };
    }
    if (on('spec')) { k = specSeason(it.specification); if (k) return { season: k, source: 'spec' }; }
    // 产地字段：部分门店（如闪电仓）把季节维护在「产地」上，值形如 夏 / 春秋 / 2026秋季
    if (on('producer')) { k = specSeason(it.producer); if (k) return { season: k, source: 'producer' }; }
    if (on('memo')) {
      k = strictSeason(it.memo1) || strictSeason(it.memo2) || tailSeason(it.memo1) || tailSeason(it.memo2);
      if (k) return { season: k, source: 'memo' };
    }
  }
  // 4) 手工归类：小类 → 中类（季节归类设置里指派）
  const m = on('manual') ? (map || {}) : {};
  const cp = catPath || {};
  const catLeaf = pick('CategoryName', 'categoryName') || cp.leaf || '';
  const catMid = cp.mid || '';
  if (catLeaf && m[catLeaf]) return { season: m[catLeaf], source: 'manual' };
  if (catMid && m[catMid]) return { season: m[catMid], source: 'manual' };
  // 5) 关键词规则：小类名 → 中类名 → 商品名
  k = seasonByRules(catLeaf, ruleSet);
  if (k) return { season: k, source: 'rule' };
  if (catMid) { k = seasonByRules(catMid, ruleSet); if (k) return { season: k, source: 'rule' }; }
  const nm = pick('ItemName', 'itemName');
  if (nm) { k = seasonByRules(nm, ruleSet); if (k) return { season: k, source: 'rule' }; }
  // 6) 名称里直接写了季节（如「男中夏T恤」）
  const direct = autoSeason(catLeaf) || (catMid ? autoSeason(catMid) : '');
  if (direct) return { season: direct, source: 'name' };
  return { season: 'none', source: 'none' };
}

/** 兼容旧调用：只要季节 key */
function resolveItemSeason(row, styleMap, itemMap, map, catPath, rules, styleById) {
  return resolveItemSeasonDetailed(row, styleMap, itemMap, map, catPath, rules, styleById).season;
}

// 哪些来源算「系统里有明细的季节数据」（其余属于推测，可能混淆）
// style  = 特性款式档案（款式季节）
// spec   = 商品档案规格字段
// producer = 商品档案产地字段（部分门店把季节填在这里）
// memo   = 商品档案备注
// manual = 大屏里手工指派的类别季节
const ARCHIVAL_SOURCES = new Set(['style', 'spec', 'producer', 'memo', 'manual']);
function isArchivalSeason(source) { return ARCHIVAL_SOURCES.has(source); }

/**
 * 统一的「商品 → 季节键」判定。聚合（季节表）与明细（点开追溯）必须共用同一个函数，
 * 否则同一个退货/商品会被聚合算进某季节、明细又算进未分类，出现「表里是负数、点开是正数」的割裂。
 *
 * @param {object} det  resolveItemSeasonDetailed 的返回值
 * @param {string} mode strict（默认）/ auto / loose
 *   - strict / auto：只认门店系统里**真实录入**的季节（款式档案/规格/产地/备注/手工指派）；
 *     关键词规则与名称识别属于「猜」，一律归入 'none'（未分类）。
 *   - loose：档案 + 关键词推断都保留。
 * @returns {'spring'|'summer'|'autumn'|'winter'|'none'}
 */
function seasonKeyOf(det, mode) {
  const k = (det && det.season && det.season !== 'none') ? det.season : 'none';
  if (k === 'none') return 'none';
  if (mode === 'loose') return k;                       // 宽松：推断也展示
  return isArchivalSeason(det.source) ? k : 'none';      // 严格/自动：只认门店录入
}

// 来源的中文说明（给「季节来源」诊断页用）
const SOURCE_LABELS = {
  style: '特性·款式档案',
  spec: '商品档案·规格',
  producer: '商品档案·产地',
  memo: '商品档案·备注1/2',
  manual: '手工指派',
  rule: '关键词规则推断',
  name: '名称自动识别',
  none: '未识别',
};

module.exports = {
  SEASON_GROUPS, SEASON_LABELS, loadMap, saveMap, loadRules, saveRules,
  loadMode, saveMode, DEFAULT_MODE,
  loadFields, saveFields, DEFAULT_FIELDS, FIELD_LABELS,
  autoSeason, resolveSeason, normalizeSeason, strictSeason, seasonByRules,
  archiveSeasonText, tailSeason, specSeason,
  seasonKeyOf, isArchivalSeason,
  resolveItemSeason, resolveItemSeasonDetailed,
  DEFAULT_RULES, RULE_ORDER, SOURCE_LABELS,
};
