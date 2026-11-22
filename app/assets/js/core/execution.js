/**
 * 生产执行：数量流转与开工闸门（V1.0 §4.5 / BR-10 / BR-11；补充项 S-A09）
 *
 * 数量勾稽（订单级）：
 *   已开工 = 首道工序累计开工量
 *   合格完成 = 末道工序累计合格量
 *   待生产 = 计划量 − 已开工        剩余 = 计划量 − 合格完成
 *
 * 三条不可越过的闸门（对应验收红线 2、3）：
 *   G1 开工量不得超过物料当前库存可支撑的最大开工量
 *   G2 下游开工量不得超过上游已合格且未流转的数量
 *   G3 完成量（合格+不良）不得超过已开工量
 */

import { kittingOf, routingOpsOf } from './rules.js';
import { canProduceOn, today } from './calendar.js';
import { QTY_DEF } from './constants.js';
import { uid } from './store.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 报工履历（只增不改）
 * 任务上的累计字段是为了渲染与校验方便，履历才是可追溯的原始记录：
 * 任何一次开工/完工申报都追加一条，不允许覆盖历史。
 */
export function appendActual(db, { task, type, qty = 0, good = 0, scrap = 0, reason = '', date }) {
  db.actuals = db.actuals || [];
  const rec = {
    id: uid('AC'),
    date,
    type,
    orderId: task.orderId,
    taskId: task.id,
    seq: task.seq,
    opName: task.opName,
    workCenterId: task.workCenterId,
    qty: num(qty),
    good: num(good),
    scrap: num(scrap),
    reason,
    operator: (db.users && db.users[0] && db.users[0].name) || 'PMC',
    createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
  };
  db.actuals.push(rec);
  return rec;
}

/** 订单在某计划版本下的任务（按工序号） */
export function tasksOfOrder(db, orderId, versionId) {
  return (db.tasks || [])
    .filter((t) => t.orderId === orderId && (!versionId || t.versionId === versionId) && t.status !== 'CANCELLED')
    .sort((a, b) => a.seq - b.seq);
}

/** 订单进度（订单级 + 工序级） */
export function orderProgress(db, order, versionId) {
  const tasks = tasksOfOrder(db, order.id, versionId || order.versionId);
  const first = tasks[0];
  const last = tasks[tasks.length - 1];
  const startedQty = first ? num(first.actualStartQty) : 0;
  const goodQty = last ? num(last.goodQty) : 0;
  const scrapQty = tasks.reduce((s, t) => s + num(t.scrapQty), 0);
  return {
    planQty: num(order.qty),
    startedQty,
    goodQty,
    scrapQty,
    toProduce: QTY_DEF.toProduce(num(order.qty), startedQty),
    remaining: QTY_DEF.remaining(num(order.qty), goodQty),
    tasks,
  };
}

/** 上游可流转给下游的数量 = 上游合格量 − 已流转下游量（本处以本工序已开工量近似已流转） */
export function transferableTo(task, db) {
  const tasks = tasksOfOrder(db, task.orderId, task.versionId);
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx <= 0) return Infinity; // 首道工序无上游
  const prev = tasks[idx - 1];
  return Math.max(0, num(prev.goodQty) - num(task.actualStartQty));
}

/**
 * 校验开工申请
 * @returns { ok, message, maxAllowed }
 */
export function validateStart(db, task, qty, date) {
  const q = num(qty);
  if (!(q > 0)) return { ok: false, message: '开工数量必须大于 0' };

  const order = (db.productionOrders || []).find((o) => o.id === task.orderId);
  if (!order) return { ok: false, message: '订单不存在' };

  const d = date || today();
  const wc = (db.workCenters || []).find((w) => w.id === task.workCenterId);
  if (!canProduceOn(task.workCenterId, d, db.calendar, db.downtimes)) {
    return { ok: false, message: `${wc ? wc.name : '工作中心'} 在 ${d} 不可生产（非工作日或计划停机）` };
  }

  const tasks = tasksOfOrder(db, order.id, task.versionId);
  const first = tasks[0];

  // G1：物料闸门（仅首道工序开工时校验）
  if (first && first.id === task.id) {
    const k = kittingOf(order, db, order.planStart);
    const already = num(first.actualStartQty);
    const allowed = Math.max(0, k.maxStartByStock - already);
    if (q > allowed) {
      return {
        ok: false,
        maxAllowed: allowed,
        message: `物料不足：当前库存最多支持再开工 ${allowed} 件（订单 ${order.qty} 件，已开工 ${already} 件）`,
      };
    }
  }

  // G2：上游流转闸门
  const canGet = transferableTo(task, db);
  if (Number.isFinite(canGet) && q > canGet) {
    return { ok: false, maxAllowed: canGet, message: `上游可流转数量仅 ${canGet} 件，不能开工 ${q} 件` };
  }

  if (num(task.actualStartQty) + q > num(task.planQty)) {
    return { ok: false, message: `累计开工将超过工序计划数量 ${task.planQty} 件` };
  }

  return { ok: true, message: '' };
}

/** 校验完工申报 */
export function validateComplete(db, task, good, scrap) {
  const g = num(good);
  const s = num(scrap);
  if (g < 0 || s < 0) return { ok: false, message: '数量不能为负' };
  if (g + s <= 0) return { ok: false, message: '合格与不良数量不能同时为 0' };

  const startedLeft = num(task.actualStartQty) - num(task.actualDoneQty);
  if (g + s > startedLeft) {
    return {
      ok: false,
      message: `本次申报 ${g + s} 件超过已开工未完成数量 ${startedLeft} 件（已开工 ${task.actualStartQty}）`,
    };
  }
  return { ok: true, message: '' };
}

/** 应用开工（返回新的任务对象，不直接改库） */
export function applyStart(task, qty, date) {
  const q = num(qty);
  return {
    ...task,
    actualStartQty: num(task.actualStartQty) + q,
    actualStart: task.actualStart || date,
    status: 'IN_PROGRESS',
  };
}

/** 应用完工申报 */
export function applyComplete(task, good, scrap, scrapReason, date) {
  const g = num(good);
  const s = num(scrap);
  const reasons = { ...(task.scrapReasons || {}) };
  if (s > 0 && scrapReason) reasons[scrapReason] = num(reasons[scrapReason]) + s;
  const doneQty = num(task.actualDoneQty) + g + s;
  const completed = doneQty >= num(task.planQty);
  return {
    ...task,
    goodQty: num(task.goodQty) + g,
    scrapQty: num(task.scrapQty) + s,
    scrapReasons: reasons,
    actualEnd: completed ? date : task.actualEnd,
    status: completed ? 'COMPLETED' : 'IN_PROGRESS',
  };
}

/** 订单级状态推导（不覆盖人工取消/关闭） */
export function deriveOrderStatus(db, order) {
  if (['CANCELLED', 'CLOSED'].includes(order.status)) return order.status;
  const p = orderProgress(db, order, order.versionId);
  if (p.tasks.length === 0) return order.status === 'RELEASED' ? 'RELEASED' : 'DRAFT';
  if (p.remaining === 0) return 'COMPLETED';
  if (p.startedQty > 0) return 'IN_PROGRESS';
  return order.status === 'DRAFT' ? 'DRAFT' : 'RELEASED';
}

/** 报工导入的行级校验（返回错误列表，全通过才允许落库） */
export function validateReportRows(rows, db) {
  const errors = [];
  rows.forEach((r, i) => {
    const line = i + 1;
    const order = (db.productionOrders || []).find((o) => o.code === r.orderCode);
    if (!order) {
      errors.push({ line, field: '生产订单号', message: `订单「${r.orderCode}」不存在` });
      return;
    }
    const tasks = tasksOfOrder(db, order.id, order.versionId);
    const task = tasks.find((t) => String(t.seq) === String(r.seq));
    if (!task) {
      errors.push({ line, field: '工序号', message: `订单 ${order.code} 无工序 ${r.seq}` });
      return;
    }
    if (!r.date) errors.push({ line, field: '日期', message: '日期必填' });
    if (!(Number(r.good) >= 0) || !(Number(r.scrap) >= 0)) {
      errors.push({ line, field: '数量', message: '数量必须为非负数字' });
    }
    const check = validateComplete(db, task, r.good, r.scrap);
    if (!check.ok) errors.push({ line, field: '数量', message: check.message });
  });
  return errors;
}
