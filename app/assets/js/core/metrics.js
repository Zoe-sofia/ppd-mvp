/**
 * 指标口径字典（V1.0 §4.10 / 补充项 S-B01；D-03 / D-07 已裁决）
 *
 * 交付：准时完工率、延期订单数、平均延期天数、准时发货率（内部指标，P-01）
 * 生产：计划达成率、实际产量、工作中心利用率、工序等待时间
 * 物料：物料齐套率、缺料订单数、缺料停工次数、到料准时率
 *
 * 口径约束：
 *   准时完工率分母 = 当期应交订单（应完工日落在统计期内，含未完工）  [D-03]
 *   平均延期天数    = 取消订单不计入                                  [D-07]
 *   工作中心利用率  = 分母按可用工作日（扣周末与停机）                [D-07]
 */

import { kittingOf } from './rules.js';
import { addDays, countWorkdays, diffCalendarDays, today } from './calendar.js';
import { capacityFor } from './rules.js';
import { checkConstraints } from './constraints.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
/** 分母为 0 时显示 —：0.0% 会被读成"实际为 0"，而真相是"没有样本" */
const pctText = (a, b) => (b > 0 ? pct(a, b).toFixed(1) : '—');
const avgText = (arr) => (arr.length ? (arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(1) : '—');

/**
 * 默认统计期（口径单一来源）
 * 仪表盘与统计分析必须使用同一默认窗口，否则同名指标会出现两个数字。
 * 前 30 天用于回看交付/产出，后 30 天用于覆盖在制订单的应交日。
 */
export function defaultPeriod(asOf) {
  return { from: addDays(asOf, -30), to: addDays(asOf, 30), productId: '', workCenterId: '' };
}

/** 有效订单（排除取消） */
const activeOrders = (db) => (db.productionOrders || []).filter((o) => o.status !== 'CANCELLED');

/** 订单关联的销售行 */
const lineOf = (db, order) => (db.salesOrderLines || []).find((l) => l.id === order.salesOrderLineId);

/**
 * 订单的客户要求完工日
 * 一拆多 / 多对一时取所有关联行中最早的交期（最保守，P-02）
 */
export function dueDateOf(db, order) {
  const links = (db.orderLinks || []).filter((l) => l.orderId === order.id);
  if (links.length) {
    const dues = links
      .map((l) => {
        const line = (db.salesOrderLines || []).find((x) => x.id === l.lineId);
        return line ? line.dueDate : '';
      })
      .filter(Boolean)
      .sort();
    if (dues.length) return dues[0];
  }
  const l = lineOf(db, order);
  return l ? l.dueDate : order.planEnd;
}

/** 订单的预计/实际完工日 */
export function finishDateOf(db, order) {
  if (order.actualEnd) return { date: order.actualEnd, actual: true };
  const tasks = (db.tasks || []).filter((t) => t.orderId === order.id && t.status !== 'CANCELLED');
  if (tasks.length) {
    const last = tasks.reduce((m, t) => (t.endDate > m ? t.endDate : m), '');
    return { date: last, actual: false };
  }
  return { date: order.planEnd || '', actual: false };
}

/** 交付风险判定（P-01：只比较生产完工与客户要求完工日） */
export function riskOf(db, order) {
  if (order.status === 'CANCELLED') return { code: 'PENDING', delayDays: 0 };
  const due = dueDateOf(db, order);
  const fin = finishDateOf(db, order);
  if (!due || !fin.date) return { code: 'PENDING', delayDays: 0 };
  if (fin.actual) {
    const delay = diffCalendarDays(due, fin.date);
    return delay > 0 ? { code: 'DONE_LATE', delayDays: delay } : { code: 'DONE_ON_TIME', delayDays: 0 };
  }
  const delay = diffCalendarDays(due, fin.date);
  if (delay > 0) return { code: 'DELAYED', delayDays: delay };
  if (delay >= -2) return { code: 'AT_RISK', delayDays: 0, buffer: -delay };
  return { code: 'ON_TIME', delayDays: 0, buffer: -delay };
}

/**
 * 计算 12 项指标
 * @param {object} filter { from, to, productId, workCenterId, opName }
 */
export function computeMetrics(db, filter = {}) {
  const { from = '2000-01-01', to = '2999-12-31' } = filter;
  const asOf = filter.asOf || today();
  const orders = activeOrders(db).filter((o) => (!filter.productId || o.productId === filter.productId));
  const inPeriod = (d) => d && d >= from && d <= to;

  /* ── 交付类 ── */
  // 当期应交：应完工日已到期，且落在统计期内（D-03 解读）
  // 未到期订单尚未构成"应交"，计入分母会把未来订单都算成未准时，指标失真。
  const shouldDeliver = orders.filter((o) => {
    const due = dueDateOf(db, o);
    return inPeriod(due) && due <= asOf;
  });
  const onTimeDone = shouldDeliver.filter((o) => {
    const fin = finishDateOf(db, o);
    return fin.actual && fin.date <= dueDateOf(db, o);
  });
  const onTimeRate = pct(onTimeDone.length, shouldDeliver.length);

  const delayedOrders = orders.filter((o) => {
    const r = riskOf(db, o);
    return r.code === 'DELAYED' || r.code === 'DONE_LATE';
  });
  const delayedInPeriod = delayedOrders.filter((o) => {
    const due = dueDateOf(db, o);
    return inPeriod(due) || inPeriod(finishDateOf(db, o).date);
  });

  // 平均延期天数：仅统计已完工且延期的订单，取消订单不计（D-07）
  const lateDone = orders.filter((o) => o.actualEnd && o.actualEnd > (dueDateOf(db, o) || ''));
  const avgDelay = lateDone.length
    ? lateDone.reduce((s, o) => s + diffCalendarDays(dueDateOf(db, o), o.actualEnd), 0) / lateDone.length
    : 0;

  // 准时发货率（内部指标）
  const shipped = (db.shipments || []).filter((s) => s.actualDate && inPeriod(s.actualDate));
  const onTimeShip = shipped.filter((s) => s.planDate && s.actualDate <= s.planDate);
  const shipRate = pct(onTimeShip.length, shipped.length);

  /* ── 生产类 ── */
  const finishedInPeriod = orders.filter((o) => inPeriod(o.actualEnd));
  const planQtySum = finishedInPeriod.reduce((s, o) => s + num(o.qty), 0);
  const goodQtySum = finishedInPeriod.reduce((s, o) => {
    const tasks = (db.tasks || []).filter((t) => t.orderId === o.id && t.status !== 'CANCELLED');
    const last = tasks.sort((a, b) => a.seq - b.seq)[tasks.length - 1];
    return s + (last ? num(last.goodQty) : 0);
  }, 0);
  const attainment = pct(goodQtySum, planQtySum);

  // 实际产量：统计期内完工订单的合格数量合计
  const actualOutput = goodQtySum;

  // 工作中心利用率：Σ实际合格量 ÷ Σ(日产能 × 可用工作日)，分母按可用工作日（D-07）
  let utilNumer = 0;
  let utilDenom = 0;
  const wcList = (db.workCenters || []).filter((w) => !filter.workCenterId || w.id === filter.workCenterId);
  for (const wc of wcList) {
    const centerOps = (db.routingOps || []).filter((o) => o.workCenterId === wc.id);
    const cap = capacityFor(wc, centerOps[0] || { stdHoursPerUnit: 1 });
    const wd = countWorkdays(from, to, db.calendar);
    if (cap > 0 && wd > 0) {
      utilDenom += cap * wd;
      const tasks = (db.tasks || []).filter(
        (t) => t.workCenterId === wc.id && t.status !== 'CANCELLED' && (!filter.opName || t.opName === filter.opName)
      );
      for (const t of tasks) {
        for (const d of t.dailyPlan || []) {
          if (inPeriod(d.date)) {
            // 用实际完成量估算产出（无实际时用计划量）
            const ratio = t.planQty > 0 ? num(t.goodQty) / t.planQty : 0;
            utilNumer += ratio > 0 ? d.qty * ratio : 0;
          }
        }
      }
    }
  }
  const utilization = pct(utilNumer, utilDenom);

  // 工序等待时间：下游实际开工 − 上游实际完工
  const waits = [];
  for (const o of orders) {
    const tasks = (db.tasks || [])
      .filter((t) => t.orderId === o.id && t.status !== 'CANCELLED')
      .sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < tasks.length; i += 1) {
      const prev = tasks[i - 1];
      const cur = tasks[i];
      if (prev.actualEnd && cur.actualStart) {
        waits.push(diffCalendarDays(prev.actualEnd, cur.actualStart));
      }
    }
  }
  const avgWait = waits.length ? waits.reduce((s, x) => s + x, 0) / waits.length : 0;

  /* ── 物料类 ── */
  const wip = orders.filter((o) => !['COMPLETED', 'CLOSED'].includes(o.status));
  const kittingInfos = wip.map((o) => ({ order: o, k: kittingOf(o, db, o.planStart) }));
  const kittedRate = pct(kittingInfos.filter((x) => x.k.status === 'KITTED').length, kittingInfos.length);
  const shortOrders = kittingInfos.filter((x) => x.k.status === 'SHORT');

  const blockedLog = (db.blockedLog || []).filter((b) => inPeriod(b.date));
  const inboundArrived = (db.inbounds || []).filter((i) => i.actualArrivalDate);
  const inboundOnTime = inboundArrived.filter((i) => i.actualArrivalDate <= i.expectedDate);
  const inboundRate = pct(inboundOnTime.length, inboundArrived.length);

  return [
    {
      group: '交付',
      key: 'onTimeRate',
      name: '订单准时完工率',
      value: onTimeRate,
      unit: '%',
      display: pctText(onTimeDone.length, shouldDeliver.length),
      formula: '准时完工订单数 ÷ 当期应交订单数',
      basis: `分母＝应完工日已到期（≤ 基准日 ${asOf}）且落在 ${from} ~ ${to} 的订单，含已到期未完工（D-03 解读）；分子＝实际完工日 ≤ 客户要求完工日`,
      detail: shouldDeliver.map((o) => ({
        code: o.code,
        due: dueDateOf(db, o),
        finish: finishDateOf(db, o).date,
        ok: finishDateOf(db, o).actual && finishDateOf(db, o).date <= dueDateOf(db, o),
      })),
    },
    {
      group: '交付',
      key: 'delayedOrders',
      name: '延期订单数',
      value: delayedInPeriod.length,
      unit: '单',
      display: String(delayedInPeriod.length),
      formula: '预计延期 + 实际延期的订单数（不含取消）',
      basis: '预计延期看系统预计完工日；实际延期看实际完工日',
      detail: delayedInPeriod.map((o) => ({ code: o.code, risk: riskOf(db, o).code, delay: riskOf(db, o).delayDays })),
    },
    {
      group: '交付',
      key: 'avgDelay',
      name: '平均延期天数',
      value: avgDelay,
      unit: '天',
      display: avgText(lateDone.map((o) => diffCalendarDays(dueDateOf(db, o), o.actualEnd))),
      formula: 'Σ(实际完工日 − 客户要求完工日) ÷ 延期订单数',
      basis: '仅统计已完工且延期订单；已取消订单不计入（D-07）；按自然日计算',
      detail: lateDone.map((o) => ({ code: o.code, delay: diffCalendarDays(dueDateOf(db, o), o.actualEnd) })),
    },
    {
      group: '交付',
      key: 'shipRate',
      name: '准时发货率（内部）',
      value: shipRate,
      unit: '%',
      display: pctText(onTimeShip.length, shipped.length),
      formula: '准时发货记录数 ÷ 已发货记录数',
      basis: '内部执行指标，不构成客户履约口径（P-01：客户承诺止于生产完工）',
      detail: shipped.map((s) => ({ order: s.orderId, plan: s.planDate, actual: s.actualDate })),
    },
    {
      group: '生产',
      key: 'attainment',
      name: '生产计划达成率',
      value: attainment,
      unit: '%',
      display: pctText(goodQtySum, planQtySum),
      formula: '统计期内完工订单的合格数量合计 ÷ 这些订单的计划数量合计',
      basis: '仅统计统计期内实际完工的订单',
      detail: finishedInPeriod.map((o) => ({ code: o.code, plan: o.qty })),
    },
    {
      group: '生产',
      key: 'output',
      name: '实际产量',
      value: actualOutput,
      unit: '件',
      display: String(actualOutput),
      formula: '统计期内完工订单的末道工序合格数量合计',
      basis: '不良数量不计入产量',
      detail: finishedInPeriod.map((o) => ({ code: o.code, qty: o.qty })),
    },
    {
      group: '生产',
      key: 'utilization',
      name: '工作中心利用率',
      value: utilization,
      unit: '%',
      display: pctText(utilNumer, utilDenom),
      formula: '实际产出量 ÷ (日产能 × 可用工作日)',
      basis: '分母按可用工作日，扣除周末与计划停机（D-07）',
      detail: wcList.map((w) => ({ code: w.code, name: w.name })),
    },
    {
      group: '生产',
      key: 'waitTime',
      name: '工序等待时间',
      value: avgWait,
      unit: '天',
      display: avgText(waits),
      formula: 'Σ(下游实际开工日 − 上游实际完工日) ÷ 工序衔接对数',
      basis: '仅有实际数据的工序衔接参与计算',
      detail: waits.map((w, i) => ({ idx: i + 1, days: w })),
    },
    {
      group: '物料',
      key: 'kittingRate',
      name: '物料齐套率',
      value: kittedRate,
      unit: '%',
      display: pctText(kittingInfos.filter((x) => x.k.status === 'KITTED').length, kittingInfos.length),
      formula: '齐套订单数 ÷ 在制订单数',
      basis: '在制＝未完工且未关闭；齐套按整单最差项判定（短板原则）',
      detail: kittingInfos.map((x) => ({ code: x.order.code, status: x.k.status })),
    },
    {
      group: '物料',
      key: 'shortOrders',
      name: '缺料订单数',
      value: shortOrders.length,
      unit: '单',
      display: String(shortOrders.length),
      formula: '齐套状态为「缺料」的在制订单数',
      basis: '部分齐套、到货风险不计入缺料',
      detail: shortOrders.map((x) => ({ code: x.order.code })),
    },
    {
      group: '物料',
      key: 'blocked',
      name: '缺料停工次数',
      value: blockedLog.length,
      unit: '次',
      display: String(blockedLog.length),
      formula: '因物料不足被拒绝开工的次数',
      basis: '由开工闸门自动记录，人工无法补录',
      detail: blockedLog.map((b) => ({ date: b.date, order: b.orderId, qty: b.qty })),
    },
    {
      group: '物料',
      key: 'inboundRate',
      name: '到料准时率',
      value: inboundRate,
      unit: '%',
      display: pctText(inboundOnTime.length, inboundArrived.length),
      formula: '准时到货记录数 ÷ 已到货记录数',
      basis: '实际到货日 ≤ 预计到货日；未到货记录不参与',
      detail: inboundArrived.map((i) => ({ material: i.materialId, expect: i.expectedDate, actual: i.actualArrivalDate })),
    },
  ];
}

/** PMC 工作台汇总（11 类信息） */
export function dashboardSummary(db, asOf) {
  const orders = activeOrders(db);
  const tasks = (db.tasks || []).filter((t) => t.status !== 'CANCELLED');
  const wip = orders.filter((o) => ['RELEASED', 'IN_PROGRESS'].includes(o.status));

  const shortages = orders.filter((o) => {
    if (['COMPLETED', 'CLOSED'].includes(o.status)) return false;
    return kittingOf(o, db, o.planStart).status === 'SHORT';
  });

  const risks = orders.filter((o) => ['DELAYED', 'AT_RISK', 'DONE_LATE'].includes(riskOf(db, o).code));

  const todayTasks = tasks.filter((t) => (t.dailyPlan || []).some((d) => d.date === asOf));
  const todayQty = todayTasks.reduce(
    (s, t) => s + (t.dailyPlan || []).filter((d) => d.date === asOf).reduce((a, d) => a + d.qty, 0),
    0
  );

  const openExceptions = (db.exceptions || []).filter((e) => ['OPEN', 'PROCESSING'].includes(e.status));

  // 产能冲突：由当前工作版本的排产结果实时推导（不落库，避免成为永不更新的死指标）
  const planTasks = (db.tasks || []).filter((t) => t.versionId === db.activeVersionId && t.status !== 'CANCELLED');
  const conflicts = checkConstraints(planTasks, db, db.settings).filter(
    (c) => c.code === 'HC-04' && (!c.date || c.date >= asOf)
  );

  // 工作中心负荷（未来 14 天）
  const wcLoad = (db.workCenters || []).map((wc) => {
    const op = (db.routingOps || []).find((o) => o.workCenterId === wc.id) || { stdHoursPerUnit: 1 };
    const cap = capacityFor(wc, op);
    let load = 0;
    let days = 0;
    for (const t of tasks) {
      if (t.workCenterId !== wc.id) continue;
      for (const d of t.dailyPlan || []) {
        if (d.date >= asOf && diffCalendarDays(asOf, d.date) <= 14) {
          load += d.qty;
          days += 1;
        }
      }
    }
    const windowDays = countWorkdays(asOf, addDaysStr(asOf, 14), db.calendar) || 1;
    return { wc, cap, load, util: cap > 0 ? load / (cap * windowDays) : 0 };
  });

  return {
    totalOrders: orders.filter((o) => !['COMPLETED', 'CLOSED'].includes(o.status)).length,
    toSchedule: orders.filter((o) => o.status === 'DRAFT').length,
    inProduction: orders.filter((o) => o.status === 'IN_PROGRESS').length,
    shortageOrders: shortages.length,
    capacityConflicts: conflicts.length,
    riskOrders: risks.length,
    todayTaskCount: todayTasks.length,
    todayQty,
    openExceptions: openExceptions.length,
    recentDone: orders
      .filter((o) => o.actualEnd && diffCalendarDays(o.actualEnd, asOf) >= 0 && diffCalendarDays(o.actualEnd, asOf) <= 7)
      .slice(0, 6),
    wcLoad,
  };
}

function addDaysStr(s, n) {
  const d = new Date(`${s}T00:00:00`);
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
