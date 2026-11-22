/**
 * 计划冻结（V1.0 §4.4.11；补充项 S-A07；P-05 单参数口径）
 * 冻结窗口 = 自基准日起 N 天（默认 3，可配 0~10），全厂统一，不按工作中心分设。
 * 冻结期内任务不可直接修改；人工解冻必须填写原因并留痕。
 */

import { diffCalendarDays, today } from './calendar.js';

/** 冻结窗口内的日期集合判定 */
export function inFreezeWindow(db, dateStr, asOf) {
  const n = Number(db.settings.freezeDays ?? 3);
  if (!(n > 0) || !dateStr) return false;
  const d = diffCalendarDays(asOf || today(), dateStr);
  return d >= 0 && d <= n;
}

/** 某订单是否已在本日被人工解冻（解冻按订单+日期记录） */
export function isUnfrozen(db, orderId, asOf) {
  return (db.freezeLogs || []).some((l) => l.orderId === orderId && l.date === (asOf || today()));
}

/**
 * 任务是否被冻结
 * 仅对已确认（RELEASED）或生产中（IN_PROGRESS）的订单生效；待排产订单不冻结。
 */
export function isTaskFrozen(db, order, task, asOf) {
  if (!order || !task) return false;
  if (!['RELEASED', 'IN_PROGRESS'].includes(order.status)) return false;
  if (isUnfrozen(db, order.id, asOf)) return false;
  return inFreezeWindow(db, task.startDate, asOf);
}

/** 冻结清单 */
export function frozenTasks(db, asOf) {
  return (db.tasks || []).filter((t) => {
    if (t.versionId !== db.activeVersionId) return false;
    const order = (db.productionOrders || []).find((o) => o.id === t.orderId);
    return isTaskFrozen(db, order, t, asOf);
  });
}

/** 解冻（记录原因与影响） */
export function unfreeze(db, orderId, reason, asOf, affectedTaskIds) {
  db.freezeLogs = db.freezeLogs || [];
  db.freezeLogs.push({
    id: `FZ-${db.freezeLogs.length + 1}`,
    orderId,
    date: asOf || today(),
    reason,
    affectedTaskIds: affectedTaskIds || [],
    by: 'PMC',
  });
  return db.freezeLogs[db.freezeLogs.length - 1];
}
