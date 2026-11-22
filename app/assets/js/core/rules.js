/**
 * 业务规则层：BOM 展开、物料需求、齐套判定、可开工数量、产能计算
 * 对应 V1.0 §4.3 / §4.4.4 与补充项 S-A03 / S-A04 / P-03
 * 本文件不依赖任何 DOM，可被排产、执行、指标模块共同调用。
 */

import { KITTING_STATUS, CAPACITY_MODE } from './constants.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/* ───────────── 一、BOM 展开（两级，预留多级） ───────────── */

/**
 * 展开产品物料需求
 * @returns [{ materialId, qty, level }]  已按物料汇总
 */
export function explodeBom(productId, qty, db) {
  const items = (db.bomItems || []).filter((i) => i.productId === productId);
  const result = new Map();

  const add = (materialId, amount) => {
    if (!materialId) return;
    result.set(materialId, (result.get(materialId) || 0) + amount);
  };

  const level1 = items.filter((i) => i.level === 1);
  for (const it of level1) {
    const need = num(it.qtyPer) * num(qty);
    if (it.childType === 'SEMI') {
      // 二级：半成品 → 原材料 / 采购件
      const level2 = items.filter((i) => i.level === 2 && i.parentId === it.childId);
      if (level2.length === 0) {
        // 半成品本身按物料管理
        add(it.childId, need);
      } else {
        for (const l2 of level2) add(l2.childId, need * num(l2.qtyPer));
      }
    } else {
      add(it.childId, need);
    }
  }

  return [...result.entries()].map(([materialId, qty]) => ({
    materialId,
    qty: Math.ceil(qty),
    level: 1,
  }));
}

/* ───────────── 二、可用量口径（V1.0 §4.3 / BR-08） ───────────── */

/** 物料当前库存合计 */
export function stockOf(materialId, db) {
  return (db.inventory || [])
    .filter((i) => i.materialId === materialId)
    .reduce((s, i) => s + num(i.qty), 0);
}

/** 已确认预留合计（排除指定订单，用于计算"其他订单占用"） */
export function reservedOf(materialId, db, excludeOrderId) {
  return (db.productionOrders || [])
    .filter((o) => o.id !== excludeOrderId && o.status !== 'CANCELLED')
    .reduce((s, o) => {
      const r = (o.reservations || []).find((x) => x.materialId === materialId);
      return s + (r ? num(r.qty) : 0);
    }, 0);
}

/** 可分配给某订单的库存 = 库存 − 其他订单已确认预留 */
export function allocatableStock(materialId, db, orderId) {
  return Math.max(0, stockOf(materialId, db) - reservedOf(materialId, db, orderId));
}

/** 已确认到货（按日期汇总） */
export function confirmedInbounds(materialId, db) {
  return (db.inbounds || [])
    .filter((i) => i.materialId === materialId && i.confirmed)
    .sort((a, b) => (a.expectedDate < b.expectedDate ? -1 : 1));
}

/* ───────────── 三、齐套分析（S-A03 五状态判定） ───────────── */

const SEVERITY = {
  KITTED: 1,
  EXPECTED_KITTED: 2,
  PARTIAL: 3,
  INBOUND_RISK: 4,
  SHORT: 5,
};

/**
 * 计算单订单的物料齐套情况
 * @param order 生产订单
 * @param db
 * @param planStart 计划开工日（用于判断到货是否来得及）
 */
export function kittingOf(order, db, planStart) {
  const asOf = planStart || order.planStart || '';
  const required = explodeBom(order.productId, order.qty, db);
  const lines = required.map((r) => {
    const stock = allocatableStock(r.materialId, db, order.id);
    const confirmed = confirmedInbounds(r.materialId, db);
    const confirmedQty = confirmed.reduce((s, i) => s + num(i.qty), 0);
    const unconfirmedQty = (db.inbounds || [])
      .filter((i) => i.materialId === r.materialId && !i.confirmed)
      .reduce((s, i) => s + num(i.qty), 0);
    const gap = Math.max(0, r.qty - stock);
    const earliestInbound = confirmed.length ? confirmed[0].expectedDate : '';
    const coveredByInbound = confirmedQty >= gap;
    const inboundInTime = earliestInbound && asOf ? earliestInbound <= asOf : false;

    let status = KITTING_STATUS.KITTED.code;
    if (gap === 0) status = 'KITTED';
    else if (stock === 0 && confirmedQty === 0) status = 'SHORT';
    else if (coveredByInbound && !inboundInTime) status = 'INBOUND_RISK';
    else if (coveredByInbound && inboundInTime) status = 'EXPECTED_KITTED';
    else if (stock > 0) status = 'PARTIAL';
    else status = 'SHORT';

    const material = (db.materials || []).find((m) => m.id === r.materialId);
    return {
      materialId: r.materialId,
      materialCode: material ? material.code : r.materialId,
      materialName: material ? material.name : '',
      required: r.qty,
      stock,
      confirmedQty,
      unconfirmedQty,
      gap,
      earliestInbound,
      status,
      severity: SEVERITY[status],
    };
  });

  // 整单状态：短板原则
  const worst = lines.reduce((w, l) => (l.severity > w.severity ? l : w), { severity: 0, status: 'KITTED' });
  const status = lines.length === 0 ? 'KITTED' : worst.status;

  // 最大可开工：仅按当前库存（实际开工的闸门，§4.4.8）
  const perUnit = (l) => (order.qty > 0 ? l.required / order.qty : 0);
  let byStock = order.qty;
  for (const l of lines) {
    const per = perUnit(l);
    if (per > 0) byStock = Math.min(byStock, Math.floor(l.stock / per));
  }
  byStock = Math.max(0, Math.min(order.qty, byStock));

  // 预计可开工：含已确认到货（计划层面参考值）
  let byInbound = order.qty;
  for (const l of lines) {
    const per = perUnit(l);
    if (per > 0) byInbound = Math.min(byInbound, Math.floor((l.stock + l.confirmedQty) / per));
  }
  byInbound = Math.max(0, Math.min(order.qty, byInbound));

  return { status, lines, maxStartByStock: byStock, maxStartByInbound: byInbound, shortage: status !== 'KITTED' };
}

/** 缺口物料的预计可满足日（用于排产开工日推算） */
export function materialReadyDate(order, db) {
  const k = kittingOf(order, db, order.planStart);
  if (k.status === 'KITTED') return order.planStart || '';
  const shortageLines = k.lines.filter((l) => l.gap > 0);
  if (shortageLines.length === 0) return order.planStart || '';
  let latest = order.planStart || '';
  for (const l of shortageLines) {
    if (!l.earliestInbound) return order.planStart || ''; // 无到货计划，按原计划（带风险）
    if (l.earliestInbound > latest) latest = l.earliestInbound;
  }
  return latest;
}

/* ───────────── 四、产能计算（P-03：双模式无换算层） ───────────── */

/**
 * 工作中心对某工序的日产能
 * 固定日产能：件/日
 * 标准工时：日可用工时 ÷ 单位标准工时
 */
export function capacityFor(wc, op) {
  if (!wc) return 0;
  if ((wc.capacityMode || CAPACITY_MODE.DAILY_QTY) === CAPACITY_MODE.STD_HOURS) {
    const std = num(op && op.stdHoursPerUnit);
    if (std <= 0) return 0;
    return Math.floor(num(wc.dailyHours) / std);
  }
  return Math.floor(num(wc.dailyCapacity));
}

/**
 * 产能池与单件消耗（统一口径）
 *
 * 同一工作中心可能承接标准工时不同的多道工序。若用"件数"占用产能，
 * 0.5h/件 与 0.6h/件 混排时会被当成同一种消耗，出现"账面不超、物理超时"。
 * 因此按模式取物理量统一比较：
 *   DAILY_QTY：池＝日产能(件)，单件消耗＝1
 *   STD_HOURS：池＝日可用工时，单件消耗＝单位标准工时
 * 排产与 HC-04 校验必须共用这一对函数，否则两处会得出不同结论。
 */
export function capacityPoolOf(wc) {
  if (!wc) return 0;
  if ((wc.capacityMode || CAPACITY_MODE.DAILY_QTY) === CAPACITY_MODE.STD_HOURS) {
    return num(wc.dailyHours);
  }
  return num(wc.dailyCapacity);
}

export function capacityDemandOf(wc, op, qty) {
  if (!wc) return 0;
  const q = num(qty);
  if ((wc.capacityMode || CAPACITY_MODE.DAILY_QTY) === CAPACITY_MODE.STD_HOURS) {
    return q * num(op && op.stdHoursPerUnit);
  }
  return q;
}

/** 池单位下的可容件数（向下取整，避免排出小数件） */
export function maxQtyInPool(wc, op) {
  const pool = capacityPoolOf(wc);
  const per = capacityDemandOf(wc, op, 1);
  if (pool <= 0 || per <= 0) return 0;
  return Math.floor(pool / per);
}

/** 工作中心是否具备该工序能力 */
export function canProcess(wcId, opId, opName, db) {
  return (db.capabilities || []).some(
    (c) => c.workCenterId === wcId && (c.opId === opId || (opName && c.opName === opName))
  );
}

/** 产品工艺路线工序（按工序号升序） */
export function routingOpsOf(productId, db) {
  const routing = (db.routings || []).find((r) => r.productId === productId);
  if (!routing) return [];
  return (db.routingOps || [])
    .filter((o) => o.routingId === routing.id)
    .sort((a, b) => a.seq - b.seq);
}

/** 某工序的候选工作中心 */
export function candidateCenters(op, db) {
  return (db.workCenters || []).filter((wc) => canProcess(wc.id, op.id, op.name, db));
}
