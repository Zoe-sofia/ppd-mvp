/**
 * 异常识别与分级（V1.0 §4.7；补充项 S-A11）
 * 四类异常现象 → 触发条件 → 等级映射；同一对象重复触发时合并，不重复刷屏。
 */

import { kittingOf, capacityFor } from './rules.js';
import { riskOf, dueDateOf, finishDateOf } from './metrics.js';
import { diffCalendarDays } from './calendar.js';

export const EXC_CODE = {
  MAT_SHORT: { code: 'MAT_SHORT', type: 'MATERIAL', name: '物料短缺', level: 'URGENT' },
  MAT_QTY_SHORT: { code: 'MAT_QTY_SHORT', type: 'MATERIAL', name: '物料数量不足', level: 'URGENT' },
  MAT_INBOUND_DELAY: { code: 'MAT_INBOUND_DELAY', type: 'MATERIAL', name: '预计到货延期', level: 'IMPORTANT' },
  CAP_OVERLOAD: { code: 'CAP_OVERLOAD', type: 'CAPACITY', name: '工作中心超负荷', level: 'IMPORTANT' },
  CAP_INSUFFICIENT: { code: 'CAP_INSUFFICIENT', type: 'CAPACITY', name: '工作中心产能不足', level: 'URGENT' },
  CAP_DOWNTIME: { code: 'CAP_DOWNTIME', type: 'CAPACITY', name: '计划停机影响', level: 'IMPORTANT' },
  PROD_OP_DELAY: { code: 'PROD_OP_DELAY', type: 'PRODUCTION', name: '工序延期', level: 'IMPORTANT' },
  PROD_LOW_OUTPUT: { code: 'PROD_LOW_OUTPUT', type: 'PRODUCTION', name: '实际产量低于计划', level: 'IMPORTANT' },
  PROD_UPSTREAM: { code: 'PROD_UPSTREAM', type: 'PRODUCTION', name: '上游工序延误', level: 'URGENT' },
  DEL_FORECAST_DELAY: { code: 'DEL_FORECAST_DELAY', type: 'DELIVERY', name: '预计生产完工延期', level: 'URGENT' },
  DEL_DUE_RISK: { code: 'DEL_DUE_RISK', type: 'DELIVERY', name: '客户交期风险', level: 'IMPORTANT' },
  DEL_SHIP_DELAY: { code: 'DEL_SHIP_DELAY', type: 'DELIVERY', name: '实际发货延期', level: 'NORMAL' },
};

const keyOf = (e) => `${e.code}|${e.orderId || ''}|${e.taskId || ''}|${e.workCenterId || ''}`;

/** 扫描并生成待识别异常（纯函数，不写库） */
export function detect(db, asOf) {
  const out = [];
  const orders = (db.productionOrders || []).filter((o) => !['CANCELLED', 'CLOSED'].includes(o.status));

  // 物料类
  for (const o of orders) {
    const k = kittingOf(o, db, o.planStart);
    if (k.status === 'SHORT') {
      const shortLines = k.lines.filter((l) => l.gap > 0);
      out.push({
        ...EXC_CODE.MAT_SHORT,
        orderId: o.id,
        reason: `${o.code} 存在 ${shortLines.length} 项物料库存与到货累计均不足以覆盖需求`,
        detail: shortLines.map((l) => `${l.materialCode} 需 ${l.required}，库存 ${l.stock}，已确认到货 ${l.confirmedQty}`),
      });
    } else if (k.status === 'PARTIAL') {
      const partialLines = k.lines.filter((l) => l.gap > 0);
      out.push({
        ...EXC_CODE.MAT_QTY_SHORT,
        orderId: o.id,
        reason: `${o.code} 部分物料不足，最多可开工 ${k.maxStartByStock} / ${o.qty}`,
        detail: partialLines.map((l) => `${l.materialCode} 缺 ${l.gap}（库存 ${l.stock}，到货 ${l.confirmedQty}）`),
      });
    } else if (k.status === 'INBOUND_RISK') {
      /**
       * 只在"能说清是哪些物料、差多少天"时才建这条异常。
       * 未排产（planStart 为空）时没有比较基准，旧实现会生成一条 reason 有值、明细为空的异常，
       * 用户点进去只看到一句"另需顺延开工"却看不到是哪张单、哪些料。
       */
      const riskLines = k.lines.filter((l) => l.gap > 0 && l.readyDate && o.planStart && l.readyDate > o.planStart);
      if (riskLines.length) {
        out.push({
          ...EXC_CODE.MAT_INBOUND_DELAY,
          orderId: o.id,
          reason: `${o.code} 已确认到货的累计达需日晚于计划开工 ${o.planStart}，需顺延开工或调整到货`,
          detail: riskLines.map(
            (l) => `${l.materialCode} 需 ${l.required}，库存 ${l.stock}，累计达需 ${l.readyDate}（晚 ${diffCalendarDays(o.planStart, l.readyDate)} 天）`
          ),
        });
      }
    }
    const lateInb = (db.inbounds || []).filter(
      (i) => i.expectedDate && i.actualArrivalDate && i.actualArrivalDate > i.expectedDate
    );
    if (lateInb.length) {
      const affected = k.lines.some((l) => lateInb.some((i) => i.materialId === l.materialId));
      if (affected) {
        out.push({
          ...EXC_CODE.MAT_INBOUND_DELAY,
          orderId: o.id,
          reason: `${o.code} 的物料到货晚于计划：${lateInb.map((i) => `${i.materialCode || i.materialId}(+${diffCalendarDays(i.expectedDate, i.actualArrivalDate)}天)`).join('、')}`,
          detail: lateInb.map(
            (i) => `${i.materialCode || i.materialId} 预计 ${i.expectedDate}，实际 ${i.actualArrivalDate}，晚 ${diffCalendarDays(i.expectedDate, i.actualArrivalDate)} 天`
          ),
        });
      }
    }
  }

  // 产能类
  const tasks = (db.tasks || []).filter((t) => t.status !== 'CANCELLED');
  const loadIdx = {};
  for (const t of tasks) {
    for (const d of t.dailyPlan || []) {
      loadIdx[`${t.workCenterId}|${d.date}`] = (loadIdx[`${t.workCenterId}|${d.date}`] || 0) + d.qty;
    }
  }
  const opMap = Object.fromEntries((db.routingOps || []).map((o) => [o.id, o]));
  for (const [k, qty] of Object.entries(loadIdx)) {
    const [wcId, date] = k.split('|');
    const wc = (db.workCenters || []).find((w) => w.id === wcId);
    const task = tasks.find((t) => t.workCenterId === wcId && (t.dailyPlan || []).some((d) => d.date === date));
    const cap = capacityFor(wc, opMap[task ? task.opId : ''] || { stdHoursPerUnit: 1 });
    if (cap > 0 && qty > cap) {
      out.push({
        ...EXC_CODE.CAP_OVERLOAD,
        workCenterId: wcId,
        orderId: task ? task.orderId : '',
        reason: `${wc ? wc.name : wcId} 在 ${date} 负荷 ${qty} 超过产能 ${cap}`,
      });
    }
  }
  for (const wc of db.workCenters || []) {
    const op = (db.routingOps || []).find((o) => o.workCenterId === wc.id) || { stdHoursPerUnit: 1 };
    if (capacityFor(wc, op) <= 0) {
      out.push({ ...EXC_CODE.CAP_INSUFFICIENT, workCenterId: wc.id, reason: `${wc.name} 日产能配置为 0，无法承接任何任务` });
    }
  }
  for (const d of db.downtimes || []) {
    const hit = tasks.filter(
      (t) => t.workCenterId === d.workCenterId && (t.dailyPlan || []).some((x) => x.date >= d.dateFrom && x.date <= d.dateTo)
    );
    if (hit.length) {
      const wc = (db.workCenters || []).find((w) => w.id === d.workCenterId);
      out.push({
        ...EXC_CODE.CAP_DOWNTIME,
        workCenterId: d.workCenterId,
        orderId: hit[0].orderId,
        reason: `${wc ? wc.name : ''} 计划停机 ${d.dateFrom}~${d.dateTo} 影响 ${hit.length} 个任务`,
      });
    }
  }

  // 生产类
  for (const t of tasks) {
    if (t.status === 'COMPLETED') continue;
    if (t.endDate && t.endDate < asOf && t.status !== 'COMPLETED') {
      out.push({
        ...EXC_CODE.PROD_OP_DELAY,
        orderId: t.orderId,
        taskId: t.id,
        reason: `${t.opName} 计划结束 ${t.endDate} 已过期，当前完成 ${t.goodQty || 0} / ${t.planQty}`,
      });
    }
    if (t.actualStartQty > 0 && t.goodQty + (t.scrapQty || 0) < t.actualStartQty && t.actualEnd && t.actualEnd <= asOf) {
      out.push({
        ...EXC_CODE.PROD_LOW_OUTPUT,
        orderId: t.orderId,
        taskId: t.id,
        reason: `${t.opName} 开工 ${t.actualStartQty}，合格仅 ${t.goodQty}`,
      });
    }
  }
  const byOrder = {};
  for (const t of tasks) {
    byOrder[t.orderId] = byOrder[t.orderId] || [];
    byOrder[t.orderId].push(t);
  }
  for (const [orderId, list] of Object.entries(byOrder)) {
    const sorted = list.sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev.endDate && cur.startDate && prev.status !== 'COMPLETED' && prev.endDate < asOf) {
        out.push({
          ...EXC_CODE.PROD_UPSTREAM,
          orderId,
          taskId: cur.id,
          reason: `上游「${prev.opName}」未完成，下游「${cur.opName}」无法按 ${cur.startDate} 开工`,
        });
      }
    }
  }

  // 交付类
  for (const o of orders) {
    const r = riskOf(db, o);
    const due = dueDateOf(db, o);
    const fin = finishDateOf(db, o);
    if (r.code === 'DELAYED') {
      out.push({
        ...EXC_CODE.DEL_FORECAST_DELAY,
        orderId: o.id,
        reason: `${o.code} 预计完工 ${fin.date} 晚于客户要求 ${due}，延迟 ${r.delayDays} 天`,
      });
    } else if (r.code === 'AT_RISK') {
      out.push({
        ...EXC_CODE.DEL_DUE_RISK,
        orderId: o.id,
        reason: `${o.code} 缓冲仅 ${r.buffer ?? 0} 天，存在交期风险`,
      });
    }
  }
  for (const s of db.shipments || []) {
    if (s.actualDate && s.planDate && s.actualDate > s.planDate) {
      out.push({
        ...EXC_CODE.DEL_SHIP_DELAY,
        orderId: s.orderId,
        reason: `发货晚于内部计划 ${diffCalendarDays(s.planDate, s.actualDate)} 天（内部节点，不影响客户履约口径）`,
      });
    }
  }

  // 去重
  const seen = new Set();
  return out.filter((e) => {
    const k = keyOf(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 同步异常库：新增未登记项，已关闭的不再重开
 * @returns {{created:number, merged:number}}
 */
export function syncExceptions(db, asOf) {
  const found = detect(db, asOf);
  db.exceptions = db.exceptions || [];
  let created = 0;
  let merged = 0;
  for (const f of found) {
    const k = keyOf(f);
    const exist = db.exceptions.find((e) => e.dedupeKey === k && e.status !== 'CLOSED');
    if (exist) {
      exist.lastSeen = asOf;
      exist.reason = f.reason;
      merged += 1;
    } else {
      db.exceptions.push({
        id: `EX-${String(db.exceptions.length + 1).padStart(4, '0')}`,
        dedupeKey: k,
        code: f.code,
        type: f.type,
        name: f.name,
        level: f.level,
        orderId: f.orderId || '',
        taskId: f.taskId || '',
        workCenterId: f.workCenterId || '',
        foundAt: asOf,
        lastSeen: asOf,
        reason: f.reason || '',
        detail: f.detail || [],
        owner: '',
        status: 'OPEN',
        records: [],
      });
      created += 1;
    }
  }
  return { created, merged };
}
