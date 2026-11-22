/**
 * 自动排产（V1.0 §4.4.6 / §4.4.7；补充项 S-A02 / S-A05 / P-04）
 * 方案：硬约束检查 + 多目标综合评分 + 启发式排产
 * 明确不做：全局数学最优、动态 AI 权重、机器级/分钟级排产
 * 可复现性：不使用随机数与当前时间（基准日由调用方传入），同输入必得同输出。
 */

import { STRATEGIES } from './constants.js';
import {
  routingOpsOf,
  candidateCenters,
  capacityFor,
  capacityPoolOf,
  capacityDemandOf,
  maxQtyInPool,
  kittingOf,
  materialReadyDate,
} from './rules.js';
import { addDays, canProduceOn, diffCalendarDays, firstProducible, producibleDates } from './calendar.js';

const KITTING_SCORE = {
  KITTED: 100,
  EXPECTED_KITTED: 70,
  PARTIAL: 40,
  INBOUND_RISK: 20,
  SHORT: 0,
};

const clamp = (n, a = 0, b = 100) => Math.max(a, Math.min(b, n));

/** 工作日桶评分：交期紧迫度 / 人工优先级 / 已逾期天数 */
export function deliveryBucket(order, line, asOf) {
  const due = line ? line.dueDate : order.planEnd;
  const daysToDue = due ? diffCalendarDays(asOf, due) : 30;
  const urgency = daysToDue <= 0 ? 100 : clamp(100 - daysToDue * 2);
  const manual = clamp((Number(order.manualPriority) || 3) * 20);
  const overdueDays = due && asOf > due ? diffCalendarDays(due, asOf) : 0;
  const delay = clamp(overdueDays * 10);
  return {
    score: Math.round(urgency * 0.5 + manual * 0.2 + delay * 0.3),
    factors: [
      { name: '交期紧迫度', value: urgency, note: daysToDue <= 0 ? '已到交期' : `距交期 ${daysToDue} 天` },
      { name: '人工优先级', value: manual, note: `P${order.manualPriority || 3}` },
      { name: '订单延期时间', value: delay, note: overdueDays > 0 ? `已逾期 ${overdueDays} 天` : '未逾期' },
    ],
  };
}

/** 物料桶评分 */
export function materialBucket(kitting) {
  const score = KITTING_SCORE[kitting.status] ?? 0;
  const names = {
    KITTED: '齐套',
    EXPECTED_KITTED: '预计齐套',
    PARTIAL: '部分齐套',
    INBOUND_RISK: '到货风险',
    SHORT: '缺料',
  };
  return {
    score,
    factors: [{ name: '物料准备情况', value: score, note: names[kitting.status] || kitting.status }],
  };
}

/** 产能桶评分：占用天数（越短越易插入）+ 现有负荷均衡度 */
export function capacityBucket(order, db, committedUtil) {
  const ops = routingOpsOf(order.productId, db);
  let days = 0;
  for (const op of ops) {
    const cands = candidateCenters(op, db);
    const bestCap = cands.reduce((m, wc) => Math.max(m, capacityFor(wc, op)), 0);
    if (bestCap > 0) days += Math.ceil(order.qty / bestCap);
    else days += 5;
  }
  const room = clamp(100 - days * 4);
  const balance = clamp(100 - committedUtil * 100);
  return {
    score: Math.round(room * 0.5 + balance * 0.5),
    factors: [
      { name: '工作中心可用产能', value: room, note: `预计占用 ${days} 个工作日` },
      { name: '负荷均衡', value: Math.round(balance), note: `现有负荷率 ${(committedUtil * 100).toFixed(0)}%` },
    ],
  };
}

/**
 * 订单综合评分（三桶加权，可解释）
 * @returns { total, buckets: {DELIVERY, MATERIAL, CAPACITY}, factors[] }
 */
export function scoreOrder(order, db, asOf, strategyCode, committedUtil) {
  const cfg = STRATEGIES[strategyCode] || STRATEGIES.DELIVERY;
  const line = (db.salesOrderLines || []).find((l) => l.id === order.salesOrderLineId);
  const kitting = kittingOf(order, db, order.planStart || asOf);

  const d = deliveryBucket(order, line, asOf);
  const m = materialBucket(kitting);
  const c = capacityBucket(order, db, committedUtil);

  const buckets = { DELIVERY: d.score, MATERIAL: m.score, CAPACITY: c.score };
  const w = cfg.weights;
  const total = Math.round(
    (buckets.DELIVERY * w.DELIVERY + buckets.MATERIAL * w.MATERIAL + buckets.CAPACITY * w.CAPACITY) / 100
  );

  return {
    total,
    buckets,
    weights: w,
    factors: [...d.factors, ...m.factors, ...c.factors],
    kittingStatus: kitting.status,
  };
}

/** 从已确认的正式计划中计算各工作中心负荷率（用于产能桶评分） */
export function committedUtilization(db, versionId) {
  const tasks = (db.tasks || []).filter((t) => t.versionId === versionId && t.status !== 'CANCELLED');
  if (!tasks.length) return 0;
  const wcMap = Object.fromEntries((db.workCenters || []).map((w) => [w.id, w]));
  const opMap = Object.fromEntries((db.routingOps || []).map((o) => [o.id, o]));
  // 已承诺负荷率：按 (中心, 日期) 汇总物理产能占用，再除以该日产能池
  const used = {};
  for (const t of tasks) {
    const op = opMap[t.opId];
    const wc = wcMap[t.workCenterId];
    for (const d of t.dailyPlan || []) {
      const key = `${t.workCenterId}|${d.date}`;
      used[key] = (used[key] || 0) + capacityDemandOf(wc, op, d.qty);
    }
  }
  let sum = 0;
  let n = 0;
  for (const [k, demand] of Object.entries(used)) {
    const [wcId] = k.split('|');
    const pool = capacityPoolOf(wcMap[wcId]);
    if (pool > 0) {
      sum += demand / pool;
      n += 1;
    }
  }
  return n ? sum / n : 0;
}

/**
 * 执行自动排产
 * @param {object} p
 * @param {object} p.db 数据
 * @param {array}  p.orders 待排产订单
 * @param {string} p.strategy 策略代码
 * @param {string} p.versionId 目标计划版本
 * @param {string} p.asOf 基准日（YYYY-MM-DD）
 * @returns { tasks, scores, warnings, orderPlan }
 */
export function runSchedule({ db, orders, strategy, versionId, asOf }) {
  const cal = db.calendar;
  const downtimes = db.downtimes || [];
  const warnings = [];
  const scores = [];
  const plan = [];

  const committed = committedUtilization(db, versionId);
  const scored = orders.map((o) => ({ order: o, sc: scoreOrder(o, db, asOf, strategy, committed) }));
  scored.sort((a, b) => {
    if (b.sc.total !== a.sc.total) return b.sc.total - a.sc.total;
    const la = (db.salesOrderLines || []).find((l) => l.id === a.order.salesOrderLineId);
    const lb = (db.salesOrderLines || []).find((l) => l.id === b.order.salesOrderLineId);
    const da = la ? la.dueDate : '';
    const dbs = lb ? lb.dueDate : '';
    if (da !== dbs) return da < dbs ? -1 : 1;
    return a.order.code < b.order.code ? -1 : 1;
  });

  // 负荷索引（本批次内累积，保证 HC-04 不越界）
  const load = {};
  const tasks = [];
  const horizonEnd = addDays(asOf, 365);

  for (const { order, sc } of scored) {
    scores.push({ orderId: order.id, orderCode: order.code, ...sc });

    const ops = routingOpsOf(order.productId, db);
    if (!ops.length) {
      warnings.push({ orderId: order.id, msg: `${order.code} 未维护工艺路线，已跳过` });
      continue;
    }

    const kitting = kittingOf(order, db, order.planStart || asOf);
    const ready = materialReadyDate(order, db);
    let cursor = [asOf, order.planStart || asOf, ready || asOf].sort().reverse()[0];

    let prevEnd = '';
    let prevQty = order.qty;
    let seqIndex = 0;

    for (const op of ops) {
      const cands = candidateCenters(op, db);
      if (!cands.length) {
        warnings.push({ orderId: order.id, msg: `${order.code} 的工序「${op.name}」无可用工作中心` });
        break;
      }

      const from = prevEnd && prevEnd > cursor ? prevEnd : cursor;

      // 选择工作中心：可开工最早 → 当日负荷最轻 → 编码
      let chosen = null;
      for (const wc of cands) {
        const s = firstProducible(wc.id, from, cal, downtimes);
        const dayLoad = load[`${wc.id}|${s}`] || 0;
        const cand = { wc, start: s, dayLoad };
        if (!chosen) chosen = cand;
        else if (cand.start < chosen.start) chosen = cand;
        else if (cand.start === chosen.start && cand.dayLoad < chosen.dayLoad) chosen = cand;
        else if (cand.start === chosen.start && cand.dayLoad === chosen.dayLoad && wc.id < chosen.wc.id) chosen = cand;
      }

      // 产能统一按物理量占用：件/日 模式按件，工时模式按标准工时
      const pool = capacityPoolOf(chosen.wc);
      const perUnit = capacityDemandOf(chosen.wc, op, 1);
      const cap = maxQtyInPool(chosen.wc, op);
      if (pool <= 0 || perUnit <= 0 || cap <= 0) {
        warnings.push({ orderId: order.id, msg: `工作中心「${chosen.wc.name}」日产能为 0，无法排产` });
        break;
      }

      // 按日切分数量
      let remaining = order.qty;
      const dailyPlan = [];
      let date = chosen.start;
      let guard = 0;
      while (remaining > 0 && date <= horizonEnd && guard < 600) {
        guard += 1;
        if (canProduceOn(chosen.wc.id, date, cal, downtimes)) {
          const key = `${chosen.wc.id}|${date}`;
          const used = load[key] || 0; // 已占用的物理产能（件 或 工时）
          const freeQty = Math.floor(Math.max(0, pool - used) / perUnit);
          const take = Math.min(remaining, freeQty);
          if (take > 0) {
            dailyPlan.push({ date, qty: take });
            load[key] = used + take * perUnit;
            remaining -= take;
          }
        }
        date = addDays(date, 1);
      }

      if (remaining > 0) {
        warnings.push({ orderId: order.id, msg: `${order.code} 工序「${op.name}」产能不足，${remaining} 件未排入` });
      }

      const start = dailyPlan.length ? dailyPlan[0].date : chosen.start;
      const end = dailyPlan.length ? dailyPlan[dailyPlan.length - 1].date : chosen.start;
      seqIndex += 1;

      tasks.push({
        id: `T-${order.id}-${op.seq}`,
        versionId,
        orderId: order.id,
        opId: op.id,
        seq: op.seq,
        opName: op.name,
        planQty: order.qty,
        startDate: start,
        endDate: end,
        workCenterId: chosen.wc.id,
        stdHoursPerUnit: op.stdHoursPerUnit,
        dailyPlan,
        status: 'PLANNED',
        actualStartQty: 0,
        actualDoneQty: 0,
        goodQty: 0,
        scrapQty: 0,
        scrapReasons: {},
        actualStart: '',
        actualEnd: '',
      });

      prevEnd = end;
      prevQty = order.qty;
      cursor = end;
    }

    const orderTasks = tasks.filter((t) => t.orderId === order.id);
    plan.push({
      orderId: order.id,
      orderCode: order.code,
      startDate: orderTasks.length ? orderTasks[0].startDate : '',
      endDate: orderTasks.length ? orderTasks[orderTasks.length - 1].endDate : '',
      kitting: kitting.status,
      score: sc.total,
    });
  }

  return { tasks, scores, warnings, orderPlan: plan };
}

/** 单工序手工改期后的重排：仅在该工序内重算日切分 */
export function replanTask(task, db, otherTasks) {
  const op = (db.routingOps || []).find((o) => o.id === task.opId);
  const wc = (db.workCenters || []).find((w) => w.id === task.workCenterId);
  if (!op || !wc) return { task, warning: '工序或工作中心不存在' };
  const poolSize = capacityPoolOf(wc);
  const perUnit = capacityDemandOf(wc, op, 1);
  const cap = maxQtyInPool(wc, op);
  if (poolSize <= 0 || perUnit <= 0 || cap <= 0) return { task, warning: '日产能为 0' };

  const load = {};
  for (const t of otherTasks) {
    if (t.id === task.id || t.status === 'CANCELLED') continue;
    const tOp = (db.routingOps || []).find((o) => o.id === t.opId);
    const tWc = (db.workCenters || []).find((w) => w.id === t.workCenterId);
    for (const d of t.dailyPlan || []) {
      const key = `${t.workCenterId}|${d.date}`;
      load[key] = (load[key] || 0) + capacityDemandOf(tWc, tOp, d.qty);
    }
  }

  const dates = producibleDates(task.workCenterId, task.startDate, task.endDate, db.calendar, db.downtimes);
  const pool = dates.length ? dates : producibleDates(task.workCenterId, task.startDate, addDays(task.startDate, 90), db.calendar, db.downtimes);

  let remaining = Number(task.planQty);
  const dailyPlan = [];
  let i = 0;
  while (remaining > 0 && i < pool.length) {
    const d = pool[i];
    const used = load[`${task.workCenterId}|${d}`] || 0;
    const freeQty = Math.floor(Math.max(0, poolSize - used) / perUnit);
    const take = Math.min(remaining, freeQty);
    if (take > 0) {
      dailyPlan.push({ date: d, qty: take });
      load[`${task.workCenterId}|${d}`] = used + take * perUnit;
      remaining -= take;
    }
    i += 1;
  }

  return {
    task: {
      ...task,
      dailyPlan,
      startDate: dailyPlan.length ? dailyPlan[0].date : task.startDate,
      endDate: dailyPlan.length ? dailyPlan[dailyPlan.length - 1].date : task.endDate,
    },
    warning: remaining > 0 ? `仍有 ${remaining} 件无产能可排` : '',
  };
}
