/**
 * 业务规则层：BOM 展开、物料需求、齐套判定、可开工数量、产能计算
 * 对应 V1.0 §4.3 / §4.4.4 与补充项 S-A03 / S-A04 / P-03
 * 本文件不依赖任何 DOM，可被排产、执行、指标模块共同调用。
 */

import { KITTING_STATUS, CAPACITY_MODE } from './constants.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/* ───────────── 一、BOM 展开（两级，预留多级） ───────────── */

/**
 * 展开产品物料需求（只返回**需要采购/领用**的项）
 *
 * 半成品口径（与方案一致，不得更改）：
 *   半成品若自身有下级 BOM（如 SE-GEAR → RM-45S + PT-BEAR），说明它是自制件，
 *   需求由下级材料承接，半成品本身不计入需求（也不占库存）；
 *   半成品若**没有**下级 BOM，则按普通物料计需求（相当于外购/现成半成品）。
 * 这一口径让"半成品仍出现在库存与到货页"成立 —— 它有自己的库存与到货记录，
 * 只是不作为产品 BOM 的需求项重复计数。
 *
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

/**
 * BOM 树形展开（用于"物料需求明细"展示层级关系）
 *
 * 与 explodeBom 的区别只在**展示**：这里保留半成品行与它的下级材料行，
 * 并用 indent / parentCode 表达所属关系；需求数量的口径与 explodeBom 完全一致
 * （半成品有下级时不重复计入需求）。
 *
 * @returns [{ kind:'SEMI'|'MATERIAL', materialId, code, name, required, qtyPer,
 *             level, indent, parentId, parentCode, parentRequired, childCount, semi }]
 */
export function explodeBomTree(productId, qty, db) {
  const items = (db.bomItems || []).filter((i) => i.productId === productId);
  const mat = (id) => (db.materials || []).find((m) => m.id === id) || {};
  const rows = [];

  for (const it of items.filter((i) => i.level === 1)) {
    const need = num(it.qtyPer) * num(qty);
    const child = mat(it.childId);

    if (it.childType !== 'SEMI') {
      rows.push({
        kind: 'MATERIAL',
        materialId: it.childId,
        code: child.code || it.childId,
        name: child.name || '',
        required: Math.ceil(need),
        qtyPer: num(it.qtyPer),
        level: 1,
        indent: 0,
        parentId: '',
        parentCode: '',
        parentRequired: 0,
        childCount: 0,
        semi: false,
      });
      continue;
    }

    const level2 = items.filter((i) => i.level === 2 && i.parentId === it.childId);
    if (!level2.length) {
      // 半成品没有下级 BOM：按普通物料计需求（与 explodeBom 一致）
      rows.push({
        kind: 'MATERIAL',
        materialId: it.childId,
        code: child.code || it.childId,
        name: child.name || '',
        required: Math.ceil(need),
        qtyPer: num(it.qtyPer),
        level: 1,
        indent: 0,
        parentId: '',
        parentCode: '',
        parentRequired: 0,
        childCount: 0,
        semi: true,
        note: '半成品无下级 BOM，按物料计需求',
      });
      continue;
    }

    const semiQty = Math.ceil(need);
    rows.push({
      kind: 'SEMI',
      materialId: it.childId,
      code: child.code || it.childId,
      name: child.name || '',
      required: semiQty,
      qtyPer: num(it.qtyPer),
      level: 1,
      indent: 0,
      parentId: '',
      parentCode: '',
      parentRequired: 0,
      childCount: level2.length,
      semi: true,
      note: '半成品：需求由下级材料承接，不计入采购/领用',
    });

    for (const l2 of level2) {
      const c2 = mat(l2.childId);
      rows.push({
        kind: 'MATERIAL',
        materialId: l2.childId,
        code: c2.code || l2.childId,
        name: c2.name || '',
        required: Math.ceil(need * num(l2.qtyPer)),
        qtyPer: num(l2.qtyPer),
        level: 2,
        indent: 1,
        parentId: it.childId,
        parentCode: child.code || it.childId,
        parentRequired: semiQty,
        childCount: 0,
        semi: false,
      });
    }
  }

  return rows;
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

/** 已确认到货（按预计到货日升序） */
export function confirmedInbounds(materialId, db) {
  return (db.inbounds || [])
    .filter((i) => i.materialId === materialId && i.confirmed)
    .sort((a, b) => (a.expectedDate < b.expectedDate ? -1 : a.expectedDate > b.expectedDate ? 1 : 0));
}

/**
 * 按日期累计的可用量曲线
 *
 *   可用量(d) = 当前库存（扣除其他订单已确认预留） + Σ 预计到货日 ≤ d 的已确认到货数量
 *
 * 分批到货时不能只看"确认到货合计"：合计够了，但可能全都到得比开工日还晚。
 * 逐日累计才能回答"哪一天开始够用"。
 *
 * @returns {{ stock:number, points: Array<{date:string, qty:number, add:number, cum:number}> }}
 */
export function availabilityCurve(materialId, db, orderId) {
  const stock = allocatableStock(materialId, db, orderId);
  const points = [];
  let cum = stock;
  for (const ib of confirmedInbounds(materialId, db)) {
    cum += num(ib.qty);
    points.push({ date: ib.expectedDate, add: num(ib.qty), qty: cum, cum });
  }
  return { stock, points };
}

/**
 * 首次达需日：可用量首次 ≥ required 的日期
 * @returns {{ byStock:boolean, met:boolean, date:string }}
 *   byStock=true  → 现有库存已足够，date=''
 *   met=true      → 到 date 这天累计到货后够用
 *   met=false     → 到货计划无论怎么累计都不够
 */
export function firstMetDate(materialId, db, required, orderId) {
  const { stock, points } = availabilityCurve(materialId, db, orderId);
  const need = num(required);
  if (stock >= need) return { byStock: true, met: true, date: '' };
  for (const p of points) {
    if (p.qty >= need) return { byStock: false, met: true, date: p.date };
  }
  return { byStock: false, met: false, date: '' };
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
 *
 * 判定口径（S-A03）：
 *   齐套        库存已够（可用库存 ≥ 需求量）
 *   预计齐套    库存不够，但按日期累计的已确认到货能在计划开工日**之前**达需
 *   到货风险    累计到货能达需，但达需日晚于计划开工日
 *   部分齐套    有库存但不足以达需，且到货累计也不足以达需
 *   缺料        无库存、到货累计也不足以达需
 *   未排产（planStart 为空）时不判断"是否来得及"：没有开工日就没有比较基准，
 *   此时只要能达需就记为「预计齐套」，并由界面提示"排产后复核"。
 *
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

    // 按日期累计，找"首次够用"的那天
    const met = firstMetDate(r.materialId, db, r.qty, order.id);
    const readyDate = met.met && !met.byStock ? met.date : '';
    const coveredByInbound = met.met && !met.byStock;
    const inboundInTime = !!(coveredByInbound && asOf && readyDate <= asOf);

    let status = KITTING_STATUS.KITTED.code;
    if (gap === 0) status = 'KITTED';
    else if (coveredByInbound) {
      if (!asOf) status = 'EXPECTED_KITTED'; // 未排产：到货能覆盖，及时性待排产后判断
      else status = inboundInTime ? 'EXPECTED_KITTED' : 'INBOUND_RISK';
    } else if (stock > 0 || confirmedQty > 0) status = 'PARTIAL';
    else status = 'SHORT';

    const material = (db.materials || []).find((m) => m.id === r.materialId);
    return {
      materialId: r.materialId,
      materialCode: material ? material.code : r.materialId,
      materialName: material ? material.name : '',
      materialType: material ? material.type : '',
      required: r.qty,
      stock,
      confirmedQty,
      unconfirmedQty,
      gap,
      earliestInbound,
      /** 首次达需日（累计到货口径）；库存已够或永远不够时为空 */
      readyDate,
      coveredByInbound,
      inboundInTime,
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

  /** 整单齐套日：全部缺料物料中**最晚**的首次达需日 */
  const readyDates = lines.filter((l) => l.gap > 0 && l.readyDate).map((l) => l.readyDate);
  const allCovered = lines.filter((l) => l.gap > 0).every((l) => l.readyDate);
  const orderReadyDate = lines.some((l) => l.gap > 0) ? (allCovered ? readyDates.sort().pop() : '') : asOf;

  return {
    status,
    lines,
    maxStartByStock: byStock,
    maxStartByInbound: byInbound,
    orderReadyDate,
    shortage: status !== 'KITTED',
  };
}

/**
 * 缺口物料的齐套日（用于排产开工日推算）
 *
 * 口径：对订单**全部缺料物料**分别求首次达需日，取其中最晚的一个；
 * 任一物料永远达不了需 → 返回 ''（无法确定，调用方按原计划并承担风险）。
 */
export function materialReadyDate(order, db) {
  const k = kittingOf(order, db, order.planStart);
  const shortageLines = k.lines.filter((l) => l.gap > 0);
  if (!shortageLines.length) return order.planStart || '';
  let latest = '';
  for (const l of shortageLines) {
    if (!l.readyDate) return ''; // 有物料永远不够（无到货计划）→ 齐套日不可知
    if (l.readyDate > latest) latest = l.readyDate;
  }
  return latest || order.planStart || '';
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
