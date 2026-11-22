/**
 * 工作日历（V1.0 §4.4.5 / S-B03 日期口径）
 * 排产推进一律按工作日历；延期天数按自然日计算，二者不混用。
 */

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' → Date（本地时区，避免 UTC 偏移） */
export function toDate(s) {
  if (!s) return null;
  if (s instanceof Date) return new Date(s.getFullYear(), s.getMonth(), s.getDate());
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function fmt(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : toDate(d);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export function today() {
  return fmt(new Date());
}

export function addDays(s, n) {
  const d = toDate(s);
  d.setDate(d.getDate() + n);
  return fmt(d);
}

/** 自然日差（b - a） */
export function diffCalendarDays(a, b) {
  if (!a || !b) return 0;
  return Math.round((toDate(b) - toDate(a)) / 86400000);
}

/** 星期：1=周一 … 7=周日 */
export function weekday(s) {
  const d = toDate(s).getDay();
  return d === 0 ? 7 : d;
}

/** 正常工作日：星期命中 workdays 且不在节假日列表 */
export function isWorkday(s, cal) {
  if (!s) return false;
  const c = cal || {};
  const wds = c.workdays && c.workdays.length ? c.workdays : [1, 2, 3, 4, 5];
  if (!wds.includes(weekday(s))) return false;
  const holidays = c.holidays || [];
  return !holidays.some((h) => h.date === s);
}

/** 工作中心计划停机（含区间） */
export function isDowntime(wcId, s, downtimes) {
  return (downtimes || []).some((d) => {
    if (d.workCenterId && d.workCenterId !== wcId) return false;
    return s >= d.dateFrom && s <= d.dateTo;
  });
}

/** 该中心该日是否可生产 */
export function canProduceOn(wcId, s, cal, downtimes) {
  return isWorkday(s, cal) && !isDowntime(wcId, s, downtimes);
}

/** 向后找第一个可生产日（含当日） */
export function firstProducible(wcId, from, cal, downtimes, limit = 400) {
  let s = from;
  for (let i = 0; i < limit; i += 1) {
    if (canProduceOn(wcId, s, cal, downtimes)) return s;
    s = addDays(s, 1);
  }
  return from;
}

/** 向后推 n 个工作日 */
export function addWorkdays(from, n, cal) {
  let s = from;
  let left = n;
  while (left > 0) {
    s = addDays(s, 1);
    if (isWorkday(s, cal)) left -= 1;
  }
  return s;
}

/** 区间内工作日数量（含首尾） */
export function countWorkdays(from, to, cal) {
  if (!from || !to || to < from) return 0;
  let s = from;
  let n = 0;
  for (let i = 0; i < 800 && s <= to; i += 1) {
    if (isWorkday(s, cal)) n += 1;
    s = addDays(s, 1);
  }
  return n;
}

/** 列出区间内可生产日 */
export function producibleDates(wcId, from, to, cal, downtimes) {
  const out = [];
  let s = from;
  for (let i = 0; i < 800 && s <= to; i += 1) {
    if (canProduceOn(wcId, s, cal, downtimes)) out.push(s);
    s = addDays(s, 1);
  }
  return out;
}
