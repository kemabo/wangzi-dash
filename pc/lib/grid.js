'use strict';
// 把 MVC 网格返回的 HTML 片段解析为结构化数据
function stripTags(s) {
  return String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function num(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[,%\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

function parseGrid(html) {
  if (!html) return { head: [], rows: [], total: 0 };
  if (/^\s*[{[]/.test(html.trim())) {
    try {
      const j = JSON.parse(html);
      if (j.status === 'error') throw new Error(j.message && j.message.msg || '接口返回错误');
    } catch (e) { throw new Error(e.message); }
  }
  const head = [];
  const hm = html.match(/<thead[\s\S]*?<\/thead>/i);
  if (hm) for (const m of hm[0].matchAll(/<th[^>]*field="([^"]*)"/g)) head.push(m[1]);

  const rows = [];
  const bm = html.match(/<tbody[\s\S]*?<\/tbody>/i);
  if (bm) {
    for (const tr of bm[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const obj = {};
      for (const td of tr[1].matchAll(/<td[^>]*field="([^"]*)"[^>]*>([\s\S]*?)<\/td>/g)) {
        obj[td[1]] = stripTags(td[2]);
      }
      if (Object.keys(obj).length) rows.push(obj);
    }
  }
  const tm = html.match(/共<em>(\d+)<\/em>条/);
  const total = tm ? Number(tm[1]) : rows.length;
  return { head, rows, total };
}

module.exports = { parseGrid, stripTags, num };
