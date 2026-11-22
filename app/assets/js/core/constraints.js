/**
 * 硬约束 / 软约束判定（V1.0 §4.4.8 / 补充项 S-A06）
 * 硬约束命中 → 不允许确认（HC-01 ~ HC-05）
 * 软约束允许保存，但必须显示风险与影响（SC-01 ~ SC-05）
 * 判定为纯函数：同输入必得同结果，可被自动化校验调用。
 */

import { capacityPoolOf, capacityDemandOf, routingOpsOf, kittingOf, confirmedInbounds } from './rules.js';
import { canProduceOn, diffCalendarDays, isWorkday } from './calendar.js';
import { HARD_CONSTRAINTS, SOFT_CONSTRAINTS, DEFAULT_BUFFER_DAYS, CAPACITY_MODE } from './constants.js';

const capByCode = (list, code) => list.find((c) => c.code === code) || { code, name: code, desc: '' };

/** 构建工作中心-日期负荷索引 */
export function buildLoad(tasks, db) {
  const byCenterDate = {};
  for (const t of tasks) {
    if (t.status === 'CANCELLED') continue;
    for (const d of t.dailyPlan || []) {
      const key = `${t.workCenterId}|${d.date}`;
      byCenterDate[key] = (byCenterDate[key] || 0) + Number(d.qty || 0);
    }
  }
  const byCenter = {};
  for (const [key, qty] of Object.entries(byCenterDate)) {
    const [wcId] = key.split('|');
    byCenter[wcId] = byCenter[wcId] || { load: 0, dates: 0 };
    byCenter[wcId].load += qty;
    byCenter[wcId].dates += 1;
  }
  return { byCenterDate, byCenter };
}

function v(code, level, payload) {
  const meta = level === 'HARD' ? capByCode(HARD_CONSTRAINTS, code) : capByCode(SOFT_CONSTRAINTS, code);
  return {
    code,
    level,
    name: meta.name,
    object: payload.object || '',
    msg: payload.msg || meta.desc,
    impact: payload.impact || '',
    where: payload.where || '',
    orderId: payload.orderId || '',
    taskId: payload.taskId || '',
    workCenterId: payload.workCenterId || '',
    date: payload.date || '',
  };
}

/**
 * 全量约束检查
 * @param tasks 待检查的任务集合（同一计划版本）
 */
export function checkConstraints(tasks, db, settings) {
  const out = [];
  const cal = db.calendar;
  const downtimes = db.downtimes || [];
  const bufferDays = (settings && settings.bufferDays) ?? DEFAULT_BUFFER_DAYS;

  // 按订单分组
  const byOrder = {};
  for (const t of tasks) {
    if (t.status === 'CANCELLED') continue;
    byOrder[t.orderId] = byOrder[t.orderId] || [];
    byOrder[t.orderId].push(t);
  }

  /* ── HC-01 工序顺序 + HC-05 数量流转 ── */
  for (const [orderId, list] of Object.entries(byOrder)) {
    const sorted = [...list].sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const cur = sorted[i];

      if (cur.startDate < prev.endDate) {
        out.push(
          v('HC-01', 'HARD', {
            orderId,
            taskId: cur.id,
            object: `${cur.opName}（工序 ${cur.seq}）`,
            msg: `计划开始 ${cur.startDate} 早于上游「${prev.opName}」结束 ${prev.endDate}`,
            impact: '工序顺序不成立，生产无法按此执行',
            where: '生产排程 → 计划表格 → 调整工序日期',
          })
        );
      }

      if (Number(cur.planQty) > Number(prev.planQty)) {
        out.push(
          v('HC-05', 'HARD', {
            orderId,
            taskId: cur.id,
            object: `${cur.opName}（工序 ${cur.seq}）`,
            msg: `计划数量 ${cur.planQty} 超过上游「${prev.opName}」可流转数量 ${prev.planQty}`,
            impact: '下游将无料可做，数量勾稽不成立',
            where: '生产排程 → 计划表格 → 调整工序数量',
          })
        );
      }
    }
  }

  /* ── HC-02 加工能力 / HC-03 不可生产日期 / HC-04 超产能 ── */
  const wcMap = Object.fromEntries((db.workCenters || []).map((w) => [w.id, w]));
  const opMap = Object.fromEntries((db.routingOps || []).map((o) => [o.id, o]));

  // HC-04 先汇总再比较：同一(工作中心,日期)只报一条，结果与任务数组顺序无关。
  // 逐条累加再判断会因工序标准工时不同而给出随顺序变化的结论（同一计划会算出 0/15/19 三种结果）。
  const dayLoad = new Map();
  for (const t of tasks) {
    if (t.status === 'CANCELLED') continue;
    const wc = wcMap[t.workCenterId];
    const op = opMap[t.opId];
    for (const d of t.dailyPlan || []) {
      if (!(d.qty > 0)) continue;
      const key = `${t.workCenterId}|${d.date}`;
      const cur = dayLoad.get(key) || { wcId: t.workCenterId, date: d.date, demand: 0, taskIds: [] };
      cur.demand += capacityDemandOf(wc, op, d.qty);
      cur.taskIds.push(t.id);
      dayLoad.set(key, cur);
    }
  }

  for (const t of tasks) {
    if (t.status === 'CANCELLED') continue;
    const wc = wcMap[t.workCenterId];
    const op = opMap[t.opId];

    // HC-02
    const capable = (db.capabilities || []).some(
      (c) => c.workCenterId === t.workCenterId && (c.opId === t.opId || c.opName === (op && op.name))
    );
    if (!wc) {
      out.push(
        v('HC-02', 'HARD', {
          orderId: t.orderId,
          taskId: t.id,
          object: t.opName,
          msg: '未分配工作中心',
          impact: '任务无法执行',
          where: '生产排程 → 调整辅助面板 → 选择工作中心',
        })
      );
    } else if (!capable) {
      out.push(
        v('HC-02', 'HARD', {
          orderId: t.orderId,
          taskId: t.id,
          object: `${t.opName} → ${wc.name}`,
          msg: `工作中心「${wc.name}」未声明具备「${t.opName}」加工能力`,
          impact: '设备无法完成该工序',
          where: '基础数据 → 工序与工作中心适配关系',
        })
      );
    }

    // HC-03：逐日检查
    for (const d of t.dailyPlan || []) {
      if (d.qty <= 0) continue;
      if (!canProduceOn(t.workCenterId, d.date, cal, downtimes)) {
        const reason = !isWorkday(d.date, cal) ? '非工作日' : '工作中心计划停机';
        out.push(
          v('HC-03', 'HARD', {
            orderId: t.orderId,
            taskId: t.id,
            workCenterId: t.workCenterId,
            object: `${t.opName} @ ${d.date}`,
            msg: `安排在不可生产日期（${reason}）`,
            impact: '该日无可用产能，计划不可执行',
            where: '生产排程 → 计划表格 → 调整工序日期',
          })
        );
        break; // 同一任务只报一次，避免刷屏
      }
    }
  }

  // HC-04：逐 (工作中心, 日期) 判定超产能，按物理量口径（件 或 标准工时）
  for (const g of dayLoad.values()) {
    const wc = wcMap[g.wcId];
    if (!wc) continue;
    const pool = capacityPoolOf(wc);
    if (pool <= 0) continue;
    if (g.demand > pool + 1e-9) {
      const unit = (wc.capacityMode || CAPACITY_MODE.DAILY_QTY) === CAPACITY_MODE.STD_HOURS ? '工时' : '件';
      const first = tasks.find((t) => t.id === g.taskIds[0]);
      out.push(
        v('HC-04', 'HARD', {
          orderId: first ? first.orderId : '',
          taskId: first ? first.id : '',
          workCenterId: g.wcId,
          date: g.date,
          object: `${wc.name} @ ${g.date}`,
          msg: `当日负荷 ${Math.round(g.demand * 10) / 10} ${unit} 超过日产能 ${pool} ${unit}（涉及 ${g.taskIds.length} 道工序）`,
          impact: '产能不足，需拆分日期或改派工作中心',
          where: '生产排程 → 甘特图 → 查看工作中心负荷',
        })
      );
    }
  }

  /* ── 软约束 ── */
  for (const [orderId, list] of Object.entries(byOrder)) {
    const order = (db.productionOrders || []).find((o) => o.id === orderId);
    if (!order) continue;
    const line = (db.salesOrderLines || []).find((l) => l.id === order.salesOrderLineId);
    const due = line ? line.dueDate : '';
    const lastEnd = list.reduce((m, t) => (t.endDate > m ? t.endDate : m), '');
    const ship = (db.shipments || []).find((s) => s.orderId === orderId);

    // SC-01 / SC-03
    if (due && lastEnd > due) {
      out.push(
        v('SC-01', 'SOFT', {
          orderId,
          object: order.code,
          msg: `预计完工 ${lastEnd} 晚于客户要求 ${due}`,
          impact: `预计延期 ${diffCalendarDays(due, lastEnd)} 天`,
          where: '交付管理 → 交付风险',
        })
      );
    } else if (due && lastEnd) {
      const buffer = diffCalendarDays(lastEnd, due);
      if (buffer < bufferDays) {
        out.push(
          v('SC-03', 'SOFT', {
            orderId,
            object: order.code,
            msg: `缓冲仅 ${buffer} 天，低于设置的 ${bufferDays} 天`,
            impact: '任一工序延误将直接冲击交期',
            where: '生产排程 → 甘特图 → 查看缓冲',
          })
        );
      }
    }

    // SC-04 / SC-05：物料类
    const k = kittingOf(order, db, order.planStart);
    const riskLines = k.lines.filter((l) => l.gap > 0 && l.unconfirmedQty > 0);
    if (riskLines.length) {
      out.push(
        v('SC-04', 'SOFT', {
          orderId,
          object: order.code,
          msg: `缺口依赖未确认到货：${riskLines.map((l) => l.materialCode).join('、')}`,
          impact: '未确认到货不计入确定可用量，存在停工风险',
          where: '物料管理 → 齐套分析',
        })
      );
    }
    const lateInbound = k.lines.filter(
      (l) => l.earliestInbound && order.planStart && l.earliestInbound > order.planStart
    );
    if (lateInbound.length) {
      out.push(
        v('SC-05', 'SOFT', {
          orderId,
          object: order.code,
          msg: `已确认到货晚于计划开工：${lateInbound.map((l) => `${l.materialCode}(${l.earliestInbound})`).join('、')}`,
          impact: '开工日需顺延或调整到货计划',
          where: '物料管理 → 到货信息',
        })
      );
    }
    if (ship && ship.planDate && order.actualEnd && ship.planDate < order.actualEnd) {
      out.push(
        v('SC-01', 'SOFT', {
          orderId,
          object: order.code,
          msg: `计划发货 ${ship.planDate} 早于实际完工 ${order.actualEnd}`,
          impact: '内部发货节点不成立',
          where: '交付管理 → 发货记录',
        })
      );
    }
  }

  // SC-02 负荷不均：按 (中心,日期) 的物理产能占用，与该中心这些日子的产能池比较
  const centerAgg = new Map();
  for (const g of dayLoad.values()) {
    const cur = centerAgg.get(g.wcId) || { days: 0, demand: 0 };
    cur.days += 1;
    cur.demand += g.demand;
    centerAgg.set(g.wcId, cur);
  }
  const utils = [];
  for (const [wcId, agg] of centerAgg) {
    const wc = wcMap[wcId];
    if (!wc) continue;
    const cap = capacityPoolOf(wc) * agg.days;
    utils.push({ wcId, name: wc.name, util: cap > 0 ? agg.demand / cap : 0 });
  }
  if (utils.length > 1) {
    const avg = utils.reduce((s, u) => s + u.util, 0) / utils.length;
    const worst = utils.reduce((a, b) => (b.util > a.util ? b : a));
    if (worst.util - avg > 0.3) {
      out.push(
        v('SC-02', 'SOFT', {
          object: worst.name,
          workCenterId: worst.wcId,
          msg: `负荷率 ${(worst.util * 100).toFixed(0)}%，高于全厂均值 ${(avg * 100).toFixed(0)}%`,
          impact: '该中心存在积压，其他中心产能闲置',
          where: '生产排程 → 甘特图 → 工作中心负荷',
        })
      );
    }
  }

  return out;
}

/** 汇总：是否有硬约束 */
export const hasHard = (violations) => violations.some((x) => x.level === 'HARD');

/** 校验单个任务的编辑（保存前拦截，返回第一条硬约束） */
export function checkTaskEdit(task, allTasks, db, settings) {
  const others = allTasks.filter((t) => t.id !== task.id);
  return checkConstraints([...others, task], db, settings).filter((x) => x.taskId === task.id || !x.taskId);
}
