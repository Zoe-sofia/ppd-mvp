/**
 * 三套测试数据（V1.0 §9.9 / 补充项 S-C04）
 * 简单：少量订单、物料齐套、单一工作中心
 * 中等：多订单、多工序、部分缺料及产能冲突
 * 复杂：订单集中、物料延期、部分数量开工、替代工作中心、多异常并发
 *
 * 数据生成使用固定种子的伪随机，保证同一场景每次重建结果一致（S-C03 可复现性）。
 */

import { emptyDb } from './store.js';
import { addDays } from './calendar.js';
import { runSchedule } from './scheduler.js';
import { syncExceptions } from './exceptions.js';

export const SCENARIOS = {
  simple: { code: 'simple', name: '简单场景', desc: '6 张订单、物料齐套、每工序单一工作中心', orders: 6 },
  medium: { code: 'medium', name: '中等场景', desc: '25 张订单、部分缺料、产能冲突', orders: 25 },
  complex: { code: 'complex', name: '复杂场景', desc: '80 张订单、到货延期、部分开工、替代中心、多异常', orders: 80 },
};

/**
 * 演示数据版本
 * 种子数据的结构或取值一旦调整，存量 localStorage 里就可能是"半新半旧"的脏数据。
 * 加载时比对版本号，不一致则提示用户重建，避免用旧数据误判系统行为。
 */
export const SEED_REV = 'seed-2026-11-22.1';

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

/* ───────────── 主数据 ───────────── */

function masterData(simple) {
  const products = [
    { id: 'P1', code: 'RE-100', name: '行星减速机', unit: '台' },
    { id: 'P2', code: 'PB-200', name: '泵体总成', unit: '台' },
    { id: 'P3', code: 'FR-300', name: '焊接机架', unit: '台' },
  ];

  const materials = [
    { id: 'M01', code: 'RM-45S', name: '45# 钢棒', unit: 'kg', type: 'RAW' },
    { id: 'M02', code: 'RM-HT250', name: '铸铁毛坯', unit: 'kg', type: 'RAW' },
    { id: 'M03', code: 'PT-FAST', name: '标准紧固件', unit: '套', type: 'PURCHASE' },
    { id: 'M04', code: 'PT-MOTOR', name: '电机 2.2kW', unit: '台', type: 'PURCHASE' },
    { id: 'M05', code: 'PT-BEAR', name: '轴承 6208', unit: '个', type: 'PURCHASE' },
    { id: 'M06', code: 'PT-SEAL', name: '密封件', unit: '个', type: 'PURCHASE' },
    { id: 'M07', code: 'SE-GEAR', name: '齿轮组件', unit: '套', type: 'SEMI' },
    { id: 'M08', code: 'SE-PUMP', name: '泵体组件', unit: '套', type: 'SEMI' },
    { id: 'M09', code: 'PT-PAINT', name: '防锈漆', unit: 'kg', type: 'PURCHASE' },
  ];

  const bomItems = [
    { id: 'B01', productId: 'P1', level: 1, parentId: 'P1', parentType: 'PRODUCT', childId: 'M07', childType: 'SEMI', qtyPer: 1 },
    { id: 'B02', productId: 'P1', level: 1, parentId: 'P1', parentType: 'PRODUCT', childId: 'M04', childType: 'MATERIAL', qtyPer: 1 },
    { id: 'B03', productId: 'P1', level: 1, parentId: 'P1', parentType: 'PRODUCT', childId: 'M06', childType: 'MATERIAL', qtyPer: 2 },
    { id: 'B04', productId: 'P1', level: 2, parentId: 'M07', parentType: 'SEMI', childId: 'M01', childType: 'MATERIAL', qtyPer: 2.5 },
    { id: 'B05', productId: 'P1', level: 2, parentId: 'M07', parentType: 'SEMI', childId: 'M05', childType: 'MATERIAL', qtyPer: 2 },
    { id: 'B06', productId: 'P2', level: 1, parentId: 'P2', parentType: 'PRODUCT', childId: 'M08', childType: 'SEMI', qtyPer: 1 },
    { id: 'B07', productId: 'P2', level: 1, parentId: 'P2', parentType: 'PRODUCT', childId: 'M03', childType: 'MATERIAL', qtyPer: 8 },
    { id: 'B08', productId: 'P2', level: 1, parentId: 'P2', parentType: 'PRODUCT', childId: 'M09', childType: 'MATERIAL', qtyPer: 0.5 },
    { id: 'B09', productId: 'P2', level: 2, parentId: 'M08', parentType: 'SEMI', childId: 'M02', childType: 'MATERIAL', qtyPer: 3 },
    { id: 'B10', productId: 'P2', level: 2, parentId: 'M08', parentType: 'SEMI', childId: 'M05', childType: 'MATERIAL', qtyPer: 1 },
    { id: 'B11', productId: 'P3', level: 1, parentId: 'P3', parentType: 'PRODUCT', childId: 'M01', childType: 'MATERIAL', qtyPer: 6 },
    { id: 'B12', productId: 'P3', level: 1, parentId: 'P3', parentType: 'PRODUCT', childId: 'M03', childType: 'MATERIAL', qtyPer: 12 },
    { id: 'B13', productId: 'P3', level: 1, parentId: 'P3', parentType: 'PRODUCT', childId: 'M09', childType: 'MATERIAL', qtyPer: 0.8 },
  ];

  const workCenters = [
    { id: 'C01', code: 'WC-CNC', name: '数控车床区', capacityMode: 'DAILY_QTY', dailyCapacity: 60, dailyHours: 8 },
    { id: 'C02', code: 'WC-MC', name: '加工中心', capacityMode: 'DAILY_QTY', dailyCapacity: 40, dailyHours: 8 },
    { id: 'C03', code: 'WC-MILL', name: '铣床区', capacityMode: 'DAILY_QTY', dailyCapacity: 50, dailyHours: 8 },
    { id: 'C04', code: 'WC-WELD', name: '焊接工位', capacityMode: 'DAILY_QTY', dailyCapacity: 60, dailyHours: 8 },
    { id: 'C05', code: 'WC-SUB', name: '部件装配线', capacityMode: 'STD_HOURS', dailyCapacity: 0, dailyHours: 16 },
    { id: 'C06', code: 'WC-ASSY', name: '总装线', capacityMode: 'STD_HOURS', dailyCapacity: 0, dailyHours: 16 },
    { id: 'C07', code: 'WC-QC', name: '检验站', capacityMode: 'DAILY_QTY', dailyCapacity: 100, dailyHours: 8 },
    { id: 'C08', code: 'WC-PACK', name: '包装线', capacityMode: 'DAILY_QTY', dailyCapacity: 120, dailyHours: 8 },
  ];

  const routings = [
    { id: 'R1', productId: 'P1', name: '减速机标准工艺' },
    { id: 'R2', productId: 'P2', name: '泵体总成标准工艺' },
    { id: 'R3', productId: 'P3', name: '焊接机架标准工艺' },
  ];

  const routingOps = [
    { id: 'O11', routingId: 'R1', seq: 10, name: '机械加工', stdHoursPerUnit: 1.2, workCenterId: 'C01' },
    { id: 'O12', routingId: 'R1', seq: 20, name: '零件检验', stdHoursPerUnit: 0.3, workCenterId: 'C07' },
    { id: 'O13', routingId: 'R1', seq: 30, name: '部件装配', stdHoursPerUnit: 0.5, workCenterId: 'C05' },
    { id: 'O14', routingId: 'R1', seq: 40, name: '总装', stdHoursPerUnit: 0.4, workCenterId: 'C06' },
    { id: 'O15', routingId: 'R1', seq: 50, name: '质量检验', stdHoursPerUnit: 0.2, workCenterId: 'C07' },
    { id: 'O16', routingId: 'R1', seq: 60, name: '包装', stdHoursPerUnit: 0.1, workCenterId: 'C08' },
    { id: 'O21', routingId: 'R2', seq: 10, name: '机械加工', stdHoursPerUnit: 1.0, workCenterId: 'C02' },
    { id: 'O22', routingId: 'R2', seq: 20, name: '焊接', stdHoursPerUnit: 0.8, workCenterId: 'C04' },
    { id: 'O23', routingId: 'R2', seq: 30, name: '零件检验', stdHoursPerUnit: 0.3, workCenterId: 'C07' },
    { id: 'O24', routingId: 'R2', seq: 40, name: '部件装配', stdHoursPerUnit: 0.6, workCenterId: 'C05' },
    { id: 'O25', routingId: 'R2', seq: 50, name: '质量检验', stdHoursPerUnit: 0.2, workCenterId: 'C07' },
    { id: 'O31', routingId: 'R3', seq: 10, name: '机械加工', stdHoursPerUnit: 0.9, workCenterId: 'C01' },
    { id: 'O32', routingId: 'R3', seq: 20, name: '焊接', stdHoursPerUnit: 1.1, workCenterId: 'C04' },
    { id: 'O33', routingId: 'R3', seq: 30, name: '零件检验', stdHoursPerUnit: 0.25, workCenterId: 'C07' },
    { id: 'O34', routingId: 'R3', seq: 40, name: '包装', stdHoursPerUnit: 0.15, workCenterId: 'C08' },
  ];

  // 能力声明：简单场景每工序仅一个工作中心，其余场景存在替代中心
  const caps = [];
  const opCenter = {
    机械加工: simple ? ['C01'] : ['C01', 'C02', 'C03'],
    零件检验: ['C07'],
    焊接: ['C04'],
    部件装配: ['C05'],
    总装: ['C06'],
    质量检验: ['C07'],
    包装: ['C08'],
  };
  for (const op of routingOps) {
    const centers = opCenter[op.name] || [op.workCenterId];
    for (const c of centers) caps.push({ id: `CAP-${op.id}-${c}`, workCenterId: c, opId: op.id, opName: op.name });
  }

  return { products, materials, bomItems, routings, routingOps, workCenters, capabilities: caps };
}

/* ───────────── 库存与到货 ───────────── */

function stockData(scenario, asOf) {
  const base = {
    M01: 12000,
    M02: 6000,
    M03: 8000,
    M04: 400,
    M05: 900,
    M06: 700,
    M07: 260,
    M08: 180,
    M09: 500,
  };
  // 中等场景：部分缺料（库存低于单张订单需求量，出现"部分齐套"与"缺料"）
  if (scenario === 'medium') Object.assign(base, { M01: 60, M04: 8, M07: 40 });
  if (scenario === 'complex') Object.assign(base, { M01: 300, M02: 200, M04: 120, M05: 20, M06: 0, M07: 12 });

  const inventory = Object.entries(base).map(([materialId, qty], i) => ({
    id: `INV-${i + 1}`,
    materialId,
    qty,
    warehouse: '主仓',
  }));

  const inbounds = [
    { id: 'IB-1', materialId: 'M01', materialCode: 'RM-45S', qty: 500, expectedDate: addDays(asOf, 6), confirmed: true, supplier: '宏发钢材', actualArrivalDate: '' },
    { id: 'IB-2', materialId: 'M05', materialCode: 'PT-BEAR', qty: 50, expectedDate: addDays(asOf, 4), confirmed: true, supplier: '恒力轴承', actualArrivalDate: '' },
    { id: 'IB-3', materialId: 'M02', materialCode: 'RM-HT250', qty: 1500, expectedDate: addDays(asOf, 9), confirmed: false, supplier: '通达铸造', actualArrivalDate: '' },
    { id: 'IB-4', materialId: 'M07', materialCode: 'SE-GEAR', qty: 60, expectedDate: addDays(asOf, 12), confirmed: false, supplier: '内部半成品', actualArrivalDate: '' },
  ];

  if (scenario === 'complex') {
    inbounds[0].expectedDate = addDays(asOf, -3);
    inbounds[0].actualArrivalDate = addDays(asOf, 2); // 到货延期
    inbounds.push({
      id: 'IB-5',
      materialId: 'M01',
      materialCode: 'RM-45S',
      qty: 5000,
      expectedDate: addDays(asOf, 2),
      confirmed: true,
      supplier: '宏发钢材',
      actualArrivalDate: addDays(asOf, 5),
    });
    inbounds.push({
      id: 'IB-6',
      materialId: 'M04',
      materialCode: 'PT-MOTOR',
      qty: 120,
      expectedDate: addDays(asOf, 15),
      confirmed: false,
      supplier: '东南电机',
      actualArrivalDate: '',
    });
  }
  return { inventory, inbounds };
}

/* ───────────── 订单 ───────────── */

function orderData(scenario, asOf, rnd) {
  const cfg = {
    simple: { n: 6, split: 1, merge: 1, qtyMin: 20, qtyMax: 60, dueFrom: 15, dueTo: 45 },
    medium: { n: 25, split: 2, merge: 2, qtyMin: 20, qtyMax: 90, dueFrom: 10, dueTo: 75 },
    complex: { n: 80, split: 4, merge: 3, qtyMin: 15, qtyMax: 120, dueFrom: 3, dueTo: 70 },
  }[scenario];

  const products = ['P1', 'P2', 'P3'];
  const customers = ['华东重工', '中原装备', '南方机械', '北方机电', '西部传动', '东海自动化'];
  const salesOrders = [];
  const salesOrderLines = [];
  const productionOrders = [];
  const orderLinks = [];

  for (let i = 0; i < cfg.n; i += 1) {
    const soId = `SO-${String(i + 1).padStart(3, '0')}`;
    const lineCount = i < cfg.merge ? 2 : 1;
    salesOrders.push({
      id: soId,
      code: soId,
      customer: pick(rnd, customers),
      orderDate: addDays(asOf, -Math.floor(rnd() * 20) - 1),
      priority: Math.ceil(rnd() * 3),
      status: 'CONFIRMED',
      note: '',
    });

    const lineIds = [];
    for (let j = 0; j < lineCount; j += 1) {
      const lineId = `${soId}-L${j + 1}`;
      const productId = pick(rnd, products);
      const qty = Math.floor(cfg.qtyMin + rnd() * (cfg.qtyMax - cfg.qtyMin));
      salesOrderLines.push({
        id: lineId,
        salesOrderId: soId,
        productId,
        qty,
        dueDate: addDays(asOf, Math.floor(cfg.dueFrom + rnd() * (cfg.dueTo - cfg.dueFrom))),
        status: 'OPEN',
        priority: Math.ceil(rnd() * 3),
      });
      lineIds.push(lineId);
    }

    // 多对一：同一销售订单的两行合并为一张生产订单
    if (lineCount > 1) {
      const lines = salesOrderLines.filter((l) => lineIds.includes(l.id));
      const poId = `PO-${String(productionOrders.length + 1).padStart(3, '0')}`;
      const totalQty = lines.reduce((s, l) => s + l.qty, 0);
      productionOrders.push({
        id: poId,
        code: poId,
        salesOrderLineId: lines[0].id,
        productId: lines[0].productId,
        qty: totalQty,
        planStart: asOf,
        planEnd: '',
        forecastEnd: '',
        actualStart: '',
        actualEnd: '',
        status: 'DRAFT',
        manualPriority: Math.ceil(rnd() * 3) + 2,
        versionId: '',
        reservations: [],
        remark: '多行合并生产',
      });
      for (const l of lines) orderLinks.push({ id: `LK-${poId}-${l.id}`, orderId: poId, lineId: l.id, qty: l.qty });
      continue;
    }

    const line = salesOrderLines.find((l) => l.id === lineIds[0]);
    // 一拆多：部分订单拆成两张生产订单
    const doSplit = i >= cfg.n - cfg.split;
    const parts = doSplit ? 2 : 1;
    for (let p = 0; p < parts; p += 1) {
      const qty = parts === 1 ? line.qty : Math.floor(line.qty / 2);
      const poId = `PO-${String(productionOrders.length + 1).padStart(3, '0')}`;
      productionOrders.push({
        id: poId,
        code: poId,
        salesOrderLineId: line.id,
        productId: line.productId,
        qty: p === 0 ? qty : line.qty - qty,
        planStart: asOf,
        planEnd: '',
        forecastEnd: '',
        actualStart: '',
        actualEnd: '',
        status: 'DRAFT',
        manualPriority: Math.ceil(rnd() * 3) + 1,
        versionId: '',
        reservations: [],
        remark: doSplit ? `拆单第 ${p + 1} 批` : '',
      });
      orderLinks.push({ id: `LK-${poId}-${line.id}`, orderId: poId, lineId: line.id, qty: p === 0 ? qty : line.qty - qty });
    }
  }

  return { salesOrders, salesOrderLines, productionOrders, orderLinks };
}

/* ───────────── 组装 ───────────── */

export function buildSeed(kind = 'medium', asOf) {
  const scenario = SCENARIOS[kind] ? kind : 'medium';
  const db = emptyDb();
  const rnd = lcg(scenario === 'simple' ? 11 : scenario === 'medium' ? 22 : 33);

  const master = masterData(scenario === 'simple');
  Object.assign(db, master);

  const stock = stockData(scenario, asOf);
  db.inventory = stock.inventory;
  db.inbounds = stock.inbounds;

  const ord = orderData(scenario, asOf, rnd);
  db.salesOrders = ord.salesOrders;
  db.salesOrderLines = ord.salesOrderLines;
  db.productionOrders = ord.productionOrders;
  db.orderLinks = ord.orderLinks;

  // 停机：复杂场景加入，用于演示 HC-03
  if (scenario === 'complex') {
    db.downtimes = [
      { id: 'DT-1', workCenterId: 'C01', dateFrom: addDays(asOf, 8), dateTo: addDays(asOf, 10), reason: '设备年度保养' },
      { id: 'DT-2', workCenterId: 'C05', dateFrom: addDays(asOf, 15), dateTo: addDays(asOf, 15), reason: '工装切换' },
    ];
  }

  // 正式计划版本 + 排产
  const version = {
    id: 'PV-001',
    code: 'PV-001',
    name: '初始正式计划',
    kind: 'FORMAL',
    status: 'ACTIVE',
    strategy: 'DELIVERY',
    weights: { DELIVERY: 60, MATERIAL: 20, CAPACITY: 20 },
    createdAt: asOf,
    appliedAt: asOf,
    originVersionId: '',
    note: '系统初始化生成',
  };
  db.planVersions = [version];
  db.activeVersionId = version.id;

  // 排产基准：简单场景自今日起排；中/复杂场景自 12 天前起排，
  // 使部分任务已进入执行期（由此自然产生工序延期、上游延误等生产类异常）
  const schedFrom = scenario === 'simple' ? addDays(asOf, -6) : addDays(asOf, -12);
  for (const o of db.productionOrders) o.planStart = schedFrom;

  const res = runSchedule({ db, orders: db.productionOrders, strategy: 'DELIVERY', versionId: version.id, asOf: schedFrom });
  db.tasks = res.tasks;
  for (const o of db.productionOrders) {
    const list = res.tasks.filter((t) => t.orderId === o.id);
    if (!list.length) continue;
    o.versionId = version.id;
    o.planStart = list[0].startDate;
    o.planEnd = list[list.length - 1].endDate;
    o.forecastEnd = o.planEnd;
    o.status = 'RELEASED';
  }

  // 交期与计划对齐（演示数据自洽性）
  // 客户交期是排产的输入，但随机生成的交期与排产结果可能整体错位：
  // 若交期普遍晚于计划完工太多，准时完工率会因"分母只含窗口内应交订单"而失真。
  // 这里按计划完工日回推交期，并保留约 1/4 的紧张与已逾期订单，让交付看板有真实分布。
  const linesOfOrder = (o) => {
    const ids = new Set(o.salesOrderLineId ? [o.salesOrderLineId] : []);
    for (const l of db.orderLinks || []) if (l.orderId === o.id) ids.add(l.lineId);
    return [...ids];
  };
  for (const o of db.productionOrders) {
    if (!o.planEnd) continue;
    const r = rnd();
    // 0.60 宽松（交期晚于计划 2~15 天）/ 0.20 临界 / 0.20 计划性逾期（2~9 天）
    const offset = r < 0.6 ? 2 + Math.floor(rnd() * 14) : r < 0.8 ? Math.floor(rnd() * 2) : -(2 + Math.floor(rnd() * 8));
    let due = addDays(o.planEnd, offset);
    // 计划已完成的订单，交期也必须落在过去：
    // 否则"当期应交订单"里没有可比较样本，准时完工率恒为 0 或恒为 100
    if (o.planEnd <= asOf && offset >= 0 && due > asOf) due = o.planEnd;
    for (const lineId of linesOfOrder(o)) {
      const line = db.salesOrderLines.find((l) => l.id === lineId);
      if (line) line.dueDate = due;
    }
  }

  // 执行数据：按时间线挑选模拟对象
  // 计划上"应已完工"的订单才可能有报工结果；若这些订单没有报工记录，
  // 它们会被全部算作未准时，指标与异常都会失真。
  const simCount = scenario === 'simple' ? 2 : scenario === 'medium' ? 8 : 26;
  const dueNow = db.productionOrders.filter((o) => o.planEnd && o.planEnd <= asOf);
  const targets = dueNow; // 只对"计划上应已完工"的订单造报工，避免出现未来完工的已完成单
  targets.forEach((o, idx) => {
    const list = db.tasks.filter((t) => t.orderId === o.id).sort((a, b) => a.seq - b.seq);
    if (!list.length) return;
    const first = list[0];
    const kind = idx % 10; // 0-6 准时完工 / 7-8 完工但延期 / 9 仍在制（形成工序延期）
    const lateDays = kind === 7 || kind === 8 ? 3 + (idx % 4) : 0;
    const full = kind !== 9; // 部分订单只做部分数量
    const startedQty = full ? first.planQty : Math.max(10, Math.floor(first.planQty * 0.6));

    first.actualStart = addDays(o.planStart, 0);
    first.actualStartQty = startedQty;
    first.actualDoneQty = full ? startedQty : Math.floor(startedQty * 0.7);
    first.goodQty = idx % 7 === 0 ? Math.floor(first.actualDoneQty * 0.95) : first.actualDoneQty;
    first.scrapQty = first.actualDoneQty - first.goodQty;
    if (first.scrapQty > 0) first.scrapReasons = { DIMENSION: first.scrapQty };
    if (full) {
      first.actualEnd = first.endDate;
      first.status = 'COMPLETED';
    } else {
      // 未完成：计划结束日已在过去 → 触发「工序延期」
      first.status = 'IN_PROGRESS';
    }

    // 第二道工序按第一道合格量开工
    if (list[1] && list[0].goodQty > 0) {
      const second = list[1];
      second.actualStart = second.startDate;
      second.actualStartQty = Math.min(list[0].goodQty, second.planQty);
      second.actualDoneQty = second.actualStartQty;
      second.goodQty = second.actualStartQty;
      second.actualEnd = second.endDate;
      second.status = 'COMPLETED';
    }

    // 整体完工（数量必须逐级守恒：下游开工 ≤ 上游合格）
    if (full && list.length > 2) {
      let upstreamGood = list[0].planQty;
      for (const [i, t] of list.entries()) {
        const startQty = i === 0 ? t.planQty : Math.min(t.planQty, upstreamGood);
        t.actualStartQty = startQty;
        t.actualDoneQty = startQty;
        t.goodQty = startQty;
        t.scrapQty = 0;
        t.actualStart = t.actualStart || t.startDate;
        t.actualEnd = t.endDate;
        t.status = 'COMPLETED';
        upstreamGood = startQty;
      }
      const last = list[list.length - 1];
      if (lateDays) last.actualEnd = addDays(last.endDate, lateDays); // 完工但晚于计划 → 真实延期
      o.actualStart = list[0].startDate;
      o.actualEnd = last.actualEnd;
      o.status = 'COMPLETED';
      db.shipments.push({
        id: `SH-${o.id}`,
        orderId: o.id,
        planDate: addDays(o.actualEnd, 1),
        actualDate: addDays(o.actualEnd, idx % 5 === 0 ? 2 : 1),
        qty: o.qty,
        status: 'SHIPPED',
        note: '',
      });
    } else if (o.status !== 'COMPLETED') {
      o.status = 'IN_PROGRESS';
      o.actualStart = list[0].actualStart;
    }
  });

  // 在制订单：已开工但计划完工仍在未来，让执行页有真实的部分进度
  const running = db.productionOrders.filter((o) => o.planEnd && o.planEnd > asOf).slice(0, 3);
  for (const o of running) {
    const list = db.tasks.filter((t) => t.orderId === o.id).sort((a, b) => a.seq - b.seq);
    const first = list[0];
    if (!first) continue;
    const qty = Math.max(10, Math.floor(first.planQty * 0.5));
    first.actualStart = first.startDate <= asOf ? first.startDate : asOf;
    first.actualStartQty = qty;
    first.actualDoneQty = Math.floor(qty * 0.6);
    first.goodQty = first.actualDoneQty;
    first.status = 'IN_PROGRESS';
    o.status = 'IN_PROGRESS';
    o.actualStart = first.actualStart;
  }

  // 交付：为已确认订单补计划发货
  for (const o of db.productionOrders) {
    if (o.status === 'RELEASED' || o.status === 'IN_PROGRESS') {
      if (!db.shipments.some((s) => s.orderId === o.id)) {
        db.shipments.push({
          id: `SH-${o.id}`,
          orderId: o.id,
          planDate: o.planEnd ? addDays(o.planEnd, 1) : '',
          actualDate: '',
          qty: o.qty,
          status: 'PENDING',
          note: '',
        });
      }
    }
  }

  // 演示数据的报工履历：按已模拟的开工/完工节点补只增不改的记录
  // 注意：id 必须确定（不能用 uid），否则同一场景每次重建结果不一致，破坏可复现性
  db.actuals = [];
  const stampUser = db.users[0] || { name: 'PMC' };
  const stamp = `${asOf} 08:00:00`;
  for (const t of db.tasks) {
    if (t.actualStart && Number(t.actualStartQty) > 0) {
      db.actuals.push({
        id: `AC-${String(db.actuals.length + 1).padStart(4, '0')}`,
        date: t.actualStart,
        type: 'START',
        orderId: t.orderId,
        taskId: t.id,
        seq: t.seq,
        opName: t.opName,
        workCenterId: t.workCenterId,
        qty: Number(t.actualStartQty),
        good: 0,
        scrap: 0,
        reason: '',
        operator: stampUser.name,
        createdAt: stamp,
      });
    }
    if (t.actualEnd && Number(t.actualDoneQty) > 0) {
      db.actuals.push({
        id: `AC-${String(db.actuals.length + 1).padStart(4, '0')}`,
        date: t.actualEnd,
        type: 'COMPLETE',
        orderId: t.orderId,
        taskId: t.id,
        seq: t.seq,
        opName: t.opName,
        workCenterId: t.workCenterId,
        qty: 0,
        good: Number(t.goodQty),
        scrap: Number(t.scrapQty),
        reason: Object.keys(t.scrapReasons || {})[0] || '',
        operator: stampUser.name,
        createdAt: stamp,
      });
    }
  }
  db.actuals.sort((a, b) => `${a.date}|${a.id}`.localeCompare(`${b.date}|${b.id}`));

  db.seedRev = SEED_REV;
  db.seedScenario = kind;
  db.activeVersionId = version.id;
  syncExceptions(db, asOf);
  return db;
}
