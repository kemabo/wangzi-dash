'use strict';
// 零依赖极简 XLSX 生成器（Node 原生 zlib 打 zip，inlineStr 存字符串）
// 用法：buildXlsx([{ name:'工作表', cols:[12,10], rows:[[{v:'表头',s:'h'}, 123]] }]) -> Buffer
const zlib = require('zlib');

const CRC = (buf) => (zlib.crc32 ? zlib.crc32(buf) : crc32(buf)) >>> 0;

// zlib.crc32 不可用时的兜底实现
function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// 样式名 → cellXfs 索引
const S = { '': 0, h: 1, t: 2, money: 3, int: 4, sub: 5, grand: 6, group: 7 };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function colName(i) { // 0 -> A
  let s = '';
  i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function sheetXml(sheet) {
  const rows = sheet.rows || [];
  const cols = sheet.cols || [];
  let colsXml = '';
  if (cols.length) {
    colsXml = '<cols>' + cols.map((w, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${Number(w) || 10}" customWidth="1"/>`).join('') + '</cols>';
  }
  const body = rows.map((row, ri) => {
    const cells = (row || []).map((c, ci) => {
      const ref = colName(ci) + (ri + 1);
      const o = (c && typeof c === 'object' && !Array.isArray(c)) ? c : { v: c };
      const sidx = S[o.s || ''] || 0;
      if (o.v == null || o.v === '') return `<c r="${ref}" s="${sidx}"/>`;
      if (typeof o.v === 'number' && isFinite(o.v)) return `<c r="${ref}" s="${sidx}"><v>${o.v}</v></c>`;
      return `<c r="${ref}" s="${sidx}" t="inlineStr"><is><t xml:space="preserve">${esc(o.v)}</t></is></c>`;
    }).join('');
    const ht = sheet.rowH && sheet.rowH[ri] ? ` ht="${sheet.rowH[ri]}" customHeight="1"` : '';
    return `<row r="${ri + 1}"${ht}>${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"${sheet.freeze ? '>' + freezeXml(sheet.freeze) + '</sheetView>' : '/>'}</sheetViews>
<sheetFormatPr defaultRowHeight="18"/>
${colsXml}<sheetData>${body}</sheetData></worksheet>`;
}

function freezeXml(f) {
  // f: {row:n} 冻结前 n 行
  const n = Number(f.row || 0);
  if (!n) return '';
  return `<pane ySplit="${n}" topLeftCell="A${n + 1}" activePane="bottomLeft" state="frozen"/>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0"/></numFmts>
<fonts count="4">
<font><sz val="11"/><color rgb="FF1F3864"/><name val="\u5fae\u8f6f\u96c5\u9ed1"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="\u5fae\u8f6f\u96c5\u9ed1"/></font>
<font><b/><sz val="11"/><color rgb="FF0B3A63"/><name val="\u5fae\u8f6f\u96c5\u9ed1"/></font>
<font><b/><sz val="12"/><color rgb="FF7C4A00"/><name val="\u5fae\u8f6f\u96c5\u9ed1"/></font>
</fonts>
<fills count="6">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE2EFDA"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FF9DC3E6"/></left><right style="thin"><color rgb="FF9DC3E6"/></right><top style="thin"><color rgb="FF9DC3E6"/></top><bottom style="thin"><color rgb="FF9DC3E6"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="164" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="3" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="2" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="\u5e38\u89c4" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function zipStore(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = CRC(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    chunks.push(h, nameBuf, data);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += h.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

/** sheets: [{name, cols:[width...], freeze:{row:n}, rows:[[cell,...]]}] */
function buildXlsx(sheets) {
  const files = [];
  const enc = (s) => Buffer.from(s, 'utf8');

  let ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`;
  sheets.forEach((_, i) => {
    ct += `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  });
  ct += '</Types>';
  files.push({ name: '[Content_Types].xml', data: enc(ct) });

  files.push({
    name: '_rels/.rels',
    data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
  });

  const sheetTags = sheets.map((s, i) =>
    `<sheet name="${esc(s.name || ('Sheet' + (i + 1)))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  files.push({
    name: 'xl/workbook.xml',
    data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetTags}</sheets></workbook>`),
  });

  let rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;
  sheets.forEach((_, i) => {
    rels += `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`;
  });
  rels += `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: enc(rels) });

  files.push({ name: 'xl/styles.xml', data: enc(STYLES) });
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc(sheetXml(s)) }));

  return zipStore(files);
}

module.exports = { buildXlsx, parseXlsx, xlsxToObjects };

// ================= XLSX 解析器（读取零售云平台导出文件） =================
// 导出文件结构：zip（xl/sharedStrings.xml + xl/worksheets/sheet1.xml），
// 第 1 行是报表标题，第 2 行是表头，数据行之后可能带一行「合计」。

/** 最小 ZIP 读取器（仅取所需条目，避免依赖第三方库） */
function readZip(buf) {
  const files = {};
  const eocd = buf.lastIndexOf(Buffer.from('PK\x05\x06'));
  if (eocd < 0) throw new Error('not a zip');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  let p = cdOffset;
  while (p < buf.length && buf.readUInt32LE(p) === 0x02014b50) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt32LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lnl = buf.readUInt16LE(lho + 26);
    const lel = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lnl + lel;
    const raw = buf.slice(dataStart, dataStart + compSize);
    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function decodeEntities(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/** 解析 sheet1 + sharedStrings → { shared, rows:[{r, cells:[{col,val}]}] } */
function parseXlsx(buf) {
  const files = readZip(buf);
  const names = Object.keys(files);
  const sheetName = names.find(n => /^xl\/worksheets\/sheet1\.xml$/.test(n)) || names.find(n => /^xl\/worksheets\/.*\.xml$/.test(n));
  const ssName = names.find(n => /^xl\/sharedStrings\.xml$/.test(n));
  const shared = [];
  if (ssName) {
    const ss = files[ssName].toString('utf8');
    for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => decodeEntities(x[1]));
      shared.push(texts.join(''));
    }
  }
  if (!sheetName) throw new Error('xlsx 无工作表');
  const sheet = files[sheetName].toString('utf8');
  const rows = [];
  for (const rm of sheet.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[2].matchAll(/<c[^>]*?r="([A-Z]+)\d+"([^>]*)>(?:<v>([\s\S]*?)<\/v>)?/g)) {
      const col = cm[1], attrs = cm[2] || '', v = cm[3];
      let val = null;
      if (v != null) {
        if (/t="s"/.test(attrs)) val = shared[Number(v)] ?? '';
        else if (/t="str"/.test(attrs)) val = decodeEntities(v);
        else if (/t="inlineStr"/.test(attrs)) val = '';
        else { const n = Number(v); val = isNaN(n) ? v : n; }
      }
      cells.push({ col, val });
    }
    rows.push({ r: Number(rm[1]), cells });
  }
  return { shared, rows };
}

/**
 * xlsx Buffer → 对象数组（零售云平台报表导出专用）
 * 约定：第 1 行标题、第 2 行表头；自动剔除「合计」行
 * （零售云平台每个导出文件末尾都带一行合计：序号列为"合计"，直接累加会翻倍）
 * @param {Buffer} buf
 * @param {object}  [opts]
 * @param {number}  [opts.headerRow=1]   表头行下标（0 起，默认第 2 行）
 * @param {string[]} [opts.keyCols]      关键列名（这些列同时为空即判定为合计行）
 * @returns {{header:string[], rows:object[]}}
 */
function xlsxToObjects(buf, opts = {}) {
  const headerRowIdx = opts.headerRow == null ? 1 : opts.headerRow;
  const keyCols = opts.keyCols || ['货号', '门店编码', '类别编码', '供应商编码'];
  const parsed = parseXlsx(buf);
  const colIdx = (c) => { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const grid = parsed.rows.map(row => {
    const arr = [];
    for (const cell of row.cells) arr[colIdx(cell.col)] = cell.val;
    return arr;
  });
  if (grid.length <= headerRowIdx) return { header: [], rows: [] };
  const header = (grid[headerRowIdx] || []).map(x => x == null ? '' : String(x));
  const seqIdx = header.indexOf('序号');
  const out = [];
  for (let i = headerRowIdx + 1; i < grid.length; i++) {
    const arr = grid[i];
    const obj = {};
    header.forEach((h, j) => { if (h) obj[h] = arr[j] == null ? '' : arr[j]; });
    if (!Object.values(obj).some(v => v !== '' && v != null)) continue;   // 全空行
    // 合计行判定：零售云平台导出文件末尾有一行「合计」（序号列写着"合计"而非数字）。
    // 注意不能用「关键列为空」一棒子打死——供应商库存表里「无供应商」是合法数据行
    // （有序号、有门店、有库存），只有序号为非数字才认定是合计行。
    const seq = seqIdx >= 0 ? String(arr[seqIdx] ?? '').trim() : '';
    const seqNumeric = seq === '' || /^\d+(\.\d+)?$/.test(seq);
    if (!seqNumeric) continue;
    out.push(obj);
  }
  return { header, rows: out };
}
