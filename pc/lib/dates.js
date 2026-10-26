'use strict';
// 日期区间工具（本地时区）
function pad(n) { return String(n).padStart(2, '0'); }
function fmt(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fmtCN(d) { return `${d.getMonth() + 1}月${d.getDate()}日`; }

/** 本周一（周一为一周起点） */
function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const w = (x.getDay() + 6) % 7; // 周一=0
  x.setDate(x.getDate() - w);
  return x;
}

function rangeOf(key, now = new Date()) {
  const wrap = (begin, end, label) => ({
    begin, end, label,
    beginStr: fmt(begin), endStr: fmt(end),
  });
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (key) {
    case 'today': return wrap(today, today, '今日实时');
    case 'yesterday': {
      const y = new Date(today); y.setDate(y.getDate() - 1);
      return wrap(y, y, '昨天');
    }
    case 'thisWeek': return wrap(startOfWeek(today), today, '本周');
    case 'lastWeek': {
      const s = startOfWeek(today); const e = new Date(s); e.setDate(e.getDate() - 1);
      const b = new Date(s); b.setDate(b.getDate() - 7);
      return wrap(b, e, '上周');
    }
    case 'thisMonth': return wrap(new Date(today.getFullYear(), today.getMonth(), 1), today, '本月');
    case 'lastMonth': {
      const b = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const e = new Date(today.getFullYear(), today.getMonth(), 0);
      return wrap(b, e, '上月');
    }
    default: return rangeOf('today', now);
  }
}

const RANGES = ['today', 'yesterday', 'thisWeek', 'thisMonth', 'lastMonth'];

function eachDay(begin, end) {
  const out = [];
  const cur = new Date(begin);
  while (cur <= end && out.length < 400) {
    out.push(fmt(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

module.exports = { pad, fmt, fmtCN, rangeOf, startOfWeek, RANGES, eachDay };
