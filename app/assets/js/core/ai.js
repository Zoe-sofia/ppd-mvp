/**
 * AI 辅助层（V1.0 §4.8；补充项 S-A12；P10 待定）
 *
 * 当前状态：AI 服务未接入（供应商与预算待定）。
 * 本文件实现的是**降级态**：由规则引擎生成确定性摘要，不调用任何外部模型。
 * 因此：
 *   1. 输出必须标注「规则摘要」而非模型推理；
 *   2. 输出必须区分「已知事实」（引用具体字段值）与「推测」（标注为推测）；
 *   3. 不产生任何写入操作，不得修改正式计划、物料预留、执行记录（BR-22）；
 *   4. AI 不可用时核心业务不受影响 —— 本模块失败仅影响分析文本，不影响排产与计算。
 */

import { kittingOf, capacityFor } from './rules.js';
import { riskOf, dueDateOf, finishDateOf } from './metrics.js';
import { diffCalendarDays } from './calendar.js';

export const AI_STATUS = {
  connected: false,
  label: '规则摘要（AI 未接入）',
  notice:
    '当前为降级态：以下内容由确定性规则引擎基于系统内业务数据生成，非大模型推理。接入 AI 服务后（P10 待定）将替换为模型分析，但引用要求与"不直接改数据"的边界不变。',
};

/** 异常分析：事实 / 推测 / 建议 三段 */
export function analyzeException(db, exc) {
  const order = (db.productionOrders || []).find((o) => o.id === exc.orderId);
  const line = order ? (db.salesOrderLines || []).find((l) => l.id === order.salesOrderLineId) : null;
  const facts = [];
  const inferences = [];
  const suggestions = [];
  const citations = [];

  if (order) {
    facts.push(`订单 ${order.code}：产品 ${order.productId}，数量 ${order.qty} 件，状态「${order.status}」`);
    citations.push(`productionOrders/${order.id}`);
    if (line) {
      facts.push(`客户要求完工日 ${line.dueDate}，客户 ${line.customer || '—'}`);
      citations.push(`salesOrderLines/${line.id}`);
    }
    const fin = finishDateOf(db, order);
    if (fin.date) {
      facts.push(`系统预计完工日 ${fin.date}${fin.actual ? '（实际）' : '（按当前计划推算）'}`);
    }
    const r = riskOf(db, order);
    facts.push(`交付风险判定：${r.code}${r.delayDays ? `，延迟 ${r.delayDays} 天` : ''}`);
  }

  if (exc.type === 'MATERIAL' || exc.code.startsWith('MAT')) {
    const k = order ? kittingOf(order, db, order.planStart) : null;
    if (k) {
      const gaps = k.lines.filter((l) => l.gap > 0);
      facts.push(
        `齐套状态「${k.status}」：${gaps.length} 项物料存在缺口，合计缺口 ${gaps.reduce((s, l) => s + l.gap, 0)} 件`
      );
      facts.push(`按当前库存最大可开工 ${k.maxStartByStock} 件，含已确认到货可至 ${k.maxStartByInbound} 件`);
      citations.push(`kittingOf/${order.id}`);
      inferences.push(
        gaps.some((l) => l.earliestInbound)
          ? '推测：若已确认到货按期到达，开工可推迟至最早到货日之后进行，未必需要改交期'
          : '推测：缺口物料无已确认到货，短期内无法开工，需外部采购或调整订单优先级'
      );
      if (k.maxStartByStock > 0 && k.maxStartByStock < order.qty) {
        suggestions.push({
          title: `先按 ${k.maxStartByStock} 件部分开工`,
          detail: `系统允许最多 ${k.maxStartByStock} 件进入生产，剩余 ${order.qty - k.maxStartByStock} 件等待物料。开工时系统会再次校验库存。`,
          expected: '可保住前段工期，剩余部分待料后补，需在计划中保留第二批排程空间',
        });
      }
      if (gaps.some((l) => l.earliestInbound)) {
        suggestions.push({
          title: '按到货日顺延开工',
          detail: `最早已确认到货日 ${gaps.map((l) => l.earliestInbound).filter(Boolean).sort()[0]}，可将开工日推迟至该日之后。`,
          expected: '避免开工即停工，但对交期影响需通过模拟方案确认',
        });
      }
      suggestions.push({
        title: '受理为交期风险并记录',
        detail: '若物料无法加速，可将该订单登记为交期风险，由 PMC 与销售确认是否改期。系统不自动改交期。',
        expected: '交期风险透明化，避免到期才发现',
      });
    }
  }

  if (exc.type === 'CAPACITY' || exc.code.startsWith('CAP')) {
    const wc = (db.workCenters || []).find((w) => w.id === exc.workCenterId);
    if (wc) {
      const op = (db.routingOps || []).find((o) => o.workCenterId === wc.id) || { stdHoursPerUnit: 1 };
      facts.push(`工作中心 ${wc.name}：产能模式 ${wc.capacityMode}，日产能 ${capacityFor(wc, op)} 件/日`);
      citations.push(`workCenters/${wc.id}`);
      const alternatives = (db.workCenters || []).filter(
        (w) => w.id !== wc.id && (db.capabilities || []).some((c) => c.workCenterId === w.id && c.opName === (exc.taskId ? '' : '') )
      );
      if (alternatives.length) {
        inferences.push(`推测：同工序存在 ${alternatives.length} 个候选工作中心，改派可缓解积压（需确认其能力声明与负荷）`);
      }
      suggestions.push({
        title: '拆分日期消化超载',
        detail: '将超载日期的任务数量分摊至相邻可生产日，系统会重新校验 HC-03/HC-04。',
        expected: '负荷曲线平缓，该订单完工日后移',
      });
      suggestions.push({
        title: '改派候选工作中心',
        detail: '在调整辅助面板中查看具备该工序能力的其他中心，选择负荷较低者。',
        expected: '缓解单点积压，需确认新中心加工能力与质量要求',
      });
    }
  }

  if (exc.type === 'DELIVERY' || exc.code.startsWith('DEL')) {
    const due = order ? dueDateOf(db, order) : '';
    const fin = order ? finishDateOf(db, order) : { date: '' };
    if (due && fin.date) {
      const gap = diffCalendarDays(due, fin.date);
      facts.push(`交期缺口：${gap > 0 ? `预计晚 ${gap} 天` : `尚余 ${-gap} 天缓冲`}（按自然日）`);
      citations.push(`dueDate=${due}`, `finishDate=${fin.date}`);
      inferences.push(
        gap > 0
          ? '推测：按期交付需压缩前道工期或调整优先级，单纯加班不在系统建模范围内（硬性最大产能＝日产能）'
          : '推测：当前缓冲可吸收一次工序延误，但不足以吸收两次'
      );
      suggestions.push({
        title: '提高该订单人工优先级后重新排产',
        detail: '在订单管理中把人工优先级调高，用同一策略重跑排产，比较交期变化。',
        expected: '该订单前移，其他订单相应后移（需看方案比较）',
      });
      suggestions.push({
        title: '复制为模拟方案比较取舍',
        detail: '复制正式计划为模拟方案，仅调整该订单，比较交付、物料与负荷三组差异后再决定是否应用。',
        expected: '决策有据，且不影响当前正式计划（BR-17）',
      });
    }
  }

  return { facts, inferences, suggestions, citations, aiLabel: AI_STATUS.label, notice: AI_STATUS.notice };
}

/** 方案比较（三组差异） */
export function comparePlans(db, tasksA, tasksB, labelA = '方案 A', labelB = '方案 B') {
  const summarize = (tasks) => {
    const byOrder = {};
    for (const t of tasks) {
      byOrder[t.orderId] = byOrder[t.orderId] || [];
      byOrder[t.orderId].push(t);
    }
    const rows = Object.entries(byOrder).map(([orderId, list]) => {
      const sorted = list.sort((a, b) => a.seq - b.seq);
      const order = (db.productionOrders || []).find((o) => o.id === orderId);
      const due = order ? dueDateOf(db, order) : '';
      const end = sorted[sorted.length - 1].endDate;
      const start = sorted[0].startDate;
      return { orderId, code: order ? order.code : orderId, start, end, due, delay: due ? diffCalendarDays(due, end) : 0 };
    });
    // 负荷
    const load = {};
    for (const t of tasks) {
      for (const d of t.dailyPlan || []) {
        load[t.workCenterId] = (load[t.workCenterId] || 0) + d.qty;
      }
    }
    const utils = (db.workCenters || []).map((w) => ({ wc: w, load: load[w.id] || 0 }));
    const max = Math.max(...utils.map((u) => u.load), 1);
    const avg = utils.reduce((s, u) => s + u.load, 0) / (utils.length || 1);
    const spread = avg > 0 ? (Math.max(...utils.map((u) => u.load)) - Math.min(...utils.map((u) => u.load))) / avg : 0;
    const delayed = rows.filter((r) => r.delay > 0);
    const avgDelay = delayed.length ? delayed.reduce((s, r) => s + r.delay, 0) / delayed.length : 0;
    return { rows, utils, delayed, avgDelay, spread, max, avg };
  };

  const a = summarize(tasksA);
  const b = summarize(tasksB);
  const orderIds = [...new Set([...a.rows.map((r) => r.orderId), ...b.rows.map((r) => r.orderId)])];

  return {
    delivery: orderIds.map((id) => {
      const ra = a.rows.find((r) => r.orderId === id) || {};
      const rb = b.rows.find((r) => r.orderId === id) || {};
      return {
        orderId: id,
        code: ra.code || rb.code,
        due: ra.due || rb.due,
        aStart: ra.start || '—',
        bStart: rb.start || '—',
        aEnd: ra.end || '—',
        bEnd: rb.end || '—',
        shift: ra.end && rb.end ? diffCalendarDays(ra.end, rb.end) : 0,
        aDelay: ra.delay || 0,
        bDelay: rb.delay || 0,
      };
    }),
    material: [{ metric: '延期订单数', a: a.delayed.length, b: b.delayed.length, better: 'lower' }],
    capacity: [
      { metric: '平均延期天数', a: +a.avgDelay.toFixed(1), b: +b.avgDelay.toFixed(1), better: 'lower' },
      { metric: '负荷离散度', a: +a.spread.toFixed(2), b: +b.spread.toFixed(2), better: 'lower' },
    ],
    labels: { a: labelA, b: labelB },
  };
}

/** 策略推荐（解释为什么推荐某策略） */
export function recommendStrategy(db, orders) {
  const kits = orders.map((o) => kittingOf(o, db, o.planStart).status);
  const shortRatio = kits.filter((s) => s === 'SHORT').length / (kits.length || 1);
  const tardy = orders.filter((o) => riskOf(db, o).code === 'DELAYED').length;

  if (shortRatio > 0.3) {
    return {
      strategy: 'MATERIAL',
      reason: `事实：${(shortRatio * 100).toFixed(0)}% 的在制订单处于缺料状态。推测：优先排齐套订单可减少开工即停工。`,
    };
  }
  if (tardy > 0) {
    return {
      strategy: 'DELIVERY',
      reason: `事实：${tardy} 张订单预计延期。推测：交付优先策略可先保住高风险订单。`,
    };
  }
  return { strategy: 'BALANCE', reason: '事实：当前无明显缺料与延期集中于单一订单。推测：产能均衡策略可降低负荷波动。' };
}
