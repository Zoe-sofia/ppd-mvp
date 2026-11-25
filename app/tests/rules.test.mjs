/**
 * 业务规则回归：齐套日口径、BOM 半成品展开、生产订单关联表、异常明细完整性
 *
 * 覆盖本轮修正的三处规则口径：
 *   1) 齐套状态按「库存 + 预计到货日 ≤ d 的已确认到货」逐日累计，取首次达需日，
 *      再对整单全部缺料物料取最晚日期 —— 不能只看"确认到货合计"或"首批到货日"；
 *   2) 半成品有下级 BOM 时只计下级材料（explodeBom 口径不变），
 *      但需求明细要保留半成品行与所属关系（explodeBomTree）；
 *   3) 生产订单导入必须同时写 orderLinks，否则销售订单页看不到关联的生产订单。
 *
 * 用例以 TA-PO-001~008 命名，对应验收时用于核对齐套状态的八张订单。
 *
 * 运行：node tests/rules.test.mjs
 */

import { kittingOf, materialReadyDate, explodeBom, explodeBomTree, stockOf } from '../assets/js/core/rules.js';
import { detect } from '../assets/js/core/exceptions.js';
import { dueDateOf } from '../assets/js/core/metrics.js';
import { applyImport } from '../assets/js/io.js';
import { emptyDb } from '../assets/js/core/store.js';

let pass = 0;
let fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    results.push(`  PASS  ${name}`);
  } else {
    fail += 1;
    results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const BASE = '2026-11-25';
const d = (offset) => {
  const t = new Date(`${BASE}T00:00:00`);
  t.setDate(t.getDate() + offset);
  const p = (x) => String(x).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};

/* ───────── 构造最小库：一个产品 + 八个物料 + 八张订单 ───────── */

/** 每张订单一个独立产品（一对一 BOM），避免"多物料共用产品"把单物料用例串成整单缺料 */
const KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const pid = (n) => `PA-${String(n).padStart(3, '0')}`; // PA-001 ~ PA-008

function buildDb() {
  const db = emptyDb();
  db.products = KEYS.map((k, i) => ({ id: pid(i + 1), code: `TA-P-${i + 1}`, name: `测试产品 ${k}`, unit: '台' }));
  db.materials = KEYS.map((k) => ({
    id: `M${k}`,
    code: `TM-${k}`,
    name: `测试物料 ${k}`,
    unit: '件',
    type: 'PURCHASE',
  }));
  db.bomItems = KEYS.map((k, i) => ({
    id: `B${k}`,
    productId: pid(i + 1),
    level: 1,
    parentId: pid(i + 1),
    parentType: 'PRODUCT',
    childId: `M${k}`,
    childType: 'MATERIAL',
    qtyPer: 1,
  }));
  db.workCenters = [];
  db.inventory = [];
  db.inbounds = [];
  db.productionOrders = [];
  db.orderLinks = [];
  db.salesOrders = [];
  db.salesOrderLines = [];
  return db;
}

const db = buildDb();

const stock = (materialId, qty) => db.inventory.push({ id: `IV-${materialId}`, materialId, qty, warehouse: '主仓' });
const inbound = (id, materialId, qty, date, confirmed = true) =>
  db.inbounds.push({ id, materialId, materialCode: materialId, qty, expectedDate: date, confirmed, actualArrivalDate: '' });
const order = (code, qty, planStart) => {
  // TA-PO-003 → 产品 PA-003，与该产品的一对一 BOM 对应
  const n = code.slice(-3);
  const o = {
    id: code,
    code,
    salesOrderLineId: '',
    productId: pid(Number(n)),
    qty,
    planStart,
    planEnd: '',
    status: 'DRAFT',
    manualPriority: 3,
    versionId: '',
    reservations: [],
  };
  db.productionOrders.push(o);
  return o;
};

// 001：合计 80 够 70，但首批 40 不够 —— 旧口径按"合计覆盖 + 首批早于开工"会误判为预计齐套
stock('MA', 0);
inbound('IB-01', 'MA', 40, d(1));
inbound('IB-02', 'MA', 40, d(5));
const po1 = order('TA-PO-001', 70, d(3));

// 002：库存即齐套
stock('MB', 56);
const po2 = order('TA-PO-002', 56, d(2));

// 003：库存 8 + 到货 20 在 +2 达需，早于开工 +4
stock('MC', 8);
inbound('IB-03', 'MC', 20, d(2));
const po3 = order('TA-PO-003', 28, d(4));

// 004：一次到货但晚于开工
stock('MD', 0);
inbound('IB-04', 'MD', 24, d(10));
const po4 = order('TA-PO-004', 24, d(2));

// 005：库存齐套
stock('ME', 30);
const po5 = order('TA-PO-005', 30, d(1));

// 006：无库存无到货 → 缺料，且齐套日不可知
const po6 = order('TA-PO-006', 18, d(3));

// 007：库存 10 + 到货 16 在 +3 达需，早于开工 +5
stock('MG', 10);
inbound('IB-07', 'MG', 16, d(3));
const po7 = order('TA-PO-007', 26, d(5));

// 008：两批各 16，第二批次才达需
stock('MH', 0);
inbound('IB-08', 'MH', 16, d(2));
inbound('IB-09', 'MH', 16, d(7));
const po8 = order('TA-PO-008', 32, d(4));

/* ═══════════ 一、逐单齐套状态 ═══════════ */

const k1 = kittingOf(po1, db, po1.planStart);
const k2 = kittingOf(po2, db, po2.planStart);
const k3 = kittingOf(po3, db, po3.planStart);
const k4 = kittingOf(po4, db, po4.planStart);
const k5 = kittingOf(po5, db, po5.planStart);
const k6 = kittingOf(po6, db, po6.planStart);
const k7 = kittingOf(po7, db, po7.planStart);
const k8 = kittingOf(po8, db, po8.planStart);

check('TA-PO-001：首批到货早于开工，但累计达需晚于开工 → 到货风险', k1.status === 'INBOUND_RISK', k1.status);
check('TA-PO-001：累计达需日 = 第二批次日期', k1.lines[0].readyDate === d(5), k1.lines[0].readyDate);
check(
  'TA-PO-001：旧口径会误判（首批到货日 ' + d(1) + ' 早于开工 ' + d(3) + '，合计 80 ≥ 70）',
  k1.lines[0].earliestInbound === d(1) && k1.lines[0].confirmedQty === 80,
  JSON.stringify({ earliestInbound: k1.lines[0].earliestInbound, confirmedQty: k1.lines[0].confirmedQty })
);
check('TA-PO-002：库存即齐套', k2.status === 'KITTED' && k2.lines[0].readyDate === '', k2.status);
check('TA-PO-003：累计达需早于开工 → 预计齐套', k3.status === 'EXPECTED_KITTED', k3.status);
check('TA-PO-003：达需日 = 到货日', k3.lines[0].readyDate === d(2), k3.lines[0].readyDate);
check('TA-PO-004：到货晚于开工 → 到货风险', k4.status === 'INBOUND_RISK' && k4.lines[0].readyDate === d(10), `${k4.status}/${k4.lines[0].readyDate}`);
check('TA-PO-005：库存齐套', k5.status === 'KITTED', k5.status);
check('TA-PO-006：无库存无到货 → 缺料', k6.status === 'SHORT', k6.status);
check('TA-PO-006：齐套日不可知（返回空）', materialReadyDate(po6, db) === '', materialReadyDate(po6, db));
check('TA-PO-007：分批但达需早于开工 → 预计齐套', k7.status === 'EXPECTED_KITTED', k7.status);
check('TA-PO-008：第二批次才达需且晚于开工 → 到货风险', k8.status === 'INBOUND_RISK' && k8.lines[0].readyDate === d(7), `${k8.status}/${k8.lines[0].readyDate}`);

/* ═══════════ 二、整单齐套日 = 缺料物料最晚日期 ═══════════ */

check('TA-PO-001：整单齐套日 = ' + d(5), k1.orderReadyDate === d(5), k1.orderReadyDate);
check('TA-PO-008：整单齐套日 = ' + d(7), k8.orderReadyDate === d(7), k8.orderReadyDate);
check('TA-PO-002：齐套订单的齐套日 = 计划开工日', k2.orderReadyDate === po2.planStart, k2.orderReadyDate);
check('materialReadyDate(TA-PO-001) 取缺料物料最晚日期', materialReadyDate(po1, db) === d(5), materialReadyDate(po1, db));

/* 多物料取最晚：再给 TA-PO-001 加一个更晚达需的物料 */
db.bomItems.push({ id: 'BZ', productId: pid(1), level: 1, parentId: pid(1), parentType: 'PRODUCT', childId: 'MZ', childType: 'MATERIAL', qtyPer: 0 });
db.materials.push({ id: 'MZ', code: 'TM-Z', name: '测试物料 Z', unit: '件', type: 'PURCHASE' });
db.bomItems[db.bomItems.length - 1].qtyPer = 1;
db.inbounds.push({ id: 'IB-Z', materialId: 'MZ', qty: 70, expectedDate: d(9), confirmed: true, actualArrivalDate: '' });
const k1b = kittingOf(po1, db, po1.planStart);
check('两处缺料：整单齐套日取更晚的那个（' + d(9) + '）', k1b.orderReadyDate === d(9), k1b.orderReadyDate);
check('materialReadyDate 同步取更晚日期', materialReadyDate(po1, db) === d(9), materialReadyDate(po1, db));

/* ═══════════ 三、未排产不误判为到货风险 ═══════════ */

const poUnscheduled = { ...po4, id: 'TA-PO-004X', code: 'TA-PO-004X', planStart: '' };
const ku = kittingOf(poUnscheduled, db, '');
check('未排产（planStart 空）：有到货可覆盖时判为预计齐套，而不是到货风险', ku.status === 'EXPECTED_KITTED', ku.status);

/* ═══════════ 四、异常明细不为空 ═══════════ */

const exc = detect(db, BASE);
const emptyDetail = exc.filter((e) => !(e.detail && e.detail.length));
check('任何异常都带明细（不再出现"数量有值、明细为空"）', emptyDetail.length === 0, JSON.stringify(emptyDetail.slice(0, 2)));
check(
  '未排产订单不产生「预计到货延期」异常',
  !exc.some((e) => e.code === 'MAT_INBOUND_DELAY' && e.orderId === poUnscheduled.id),
  JSON.stringify(exc.filter((e) => e.code === 'MAT_INBOUND_DELAY').map((e) => e.orderId))
);
const delayExc = exc.find((e) => e.code === 'MAT_INBOUND_DELAY' && e.orderId === po1.id);
check('已排产且到货晚于开工 → 异常明细含物料与晚几天', !!delayExc && /TM-A/.test(delayExc.detail.join('')) && /晚 \d+ 天/.test(delayExc.detail.join('')), JSON.stringify(delayExc && delayExc.detail));

/* ═══════════ 五、BOM 半成品口径与树形展示 ═══════════ */

const db2 = emptyDb();
db2.products = [{ id: 'P1', code: 'RE-100', name: '行星减速机', unit: '台' }];
db2.materials = [
  { id: 'M01', code: 'RM-45S', name: '45# 钢棒', unit: 'kg', type: 'RAW' },
  { id: 'M05', code: 'PT-BEAR', name: '轴承 6208', unit: '个', type: 'PURCHASE' },
  { id: 'M04', code: 'PT-MOTOR', name: '电机 2.2kW', unit: '台', type: 'PURCHASE' },
  { id: 'M07', code: 'SE-GEAR', name: '齿轮组件', unit: '套', type: 'SEMI' },
  { id: 'M11', code: 'SE-SOLO', name: '外购半成品', unit: '套', type: 'SEMI' },
];
db2.bomItems = [
  { id: 'B01', productId: 'P1', level: 1, parentId: 'P1', parentType: 'PRODUCT', childId: 'M07', childType: 'SEMI', qtyPer: 1 },
  { id: 'B02', productId: 'P1', level: 1, parentId: 'P1', parentType: 'PRODUCT', childId: 'M04', childType: 'MATERIAL', qtyPer: 1 },
  { id: 'B03', productId: 'P1', level: 1, parentId: 'P1', parentType: 'PRODUCT', childId: 'M11', childType: 'SEMI', qtyPer: 2 },
  { id: 'B04', productId: 'P1', level: 2, parentId: 'M07', parentType: 'SEMI', childId: 'M01', childType: 'MATERIAL', qtyPer: 2.5 },
  { id: 'B05', productId: 'P1', level: 2, parentId: 'M07', parentType: 'SEMI', childId: 'M05', childType: 'MATERIAL', qtyPer: 2 },
];
db2.inventory = [{ id: 'IV1', materialId: 'M07', qty: 260, warehouse: '主仓' }];

const flat = explodeBom('P1', 10, db2);
const flatIds = flat.map((r) => r.materialId).sort();
check(
  'explodeBom：有下级 BOM 的半成品不计入需求，只展开下级材料',
  !flatIds.includes('M07') && flatIds.includes('M01') && flatIds.includes('M05'),
  JSON.stringify(flatIds)
);
check('explodeBom：无下级 BOM 的半成品按物料计需求（10 × 2 = 20）', (flat.find((r) => r.materialId === 'M11') || {}).qty === 20, JSON.stringify(flat));
check('半成品本身仍有库存（库存页可见）', stockOf('M07', db2) === 260, String(stockOf('M07', db2)));

const tree = explodeBomTree('P1', 10, db2);
const semiRow = tree.find((r) => r.kind === 'SEMI' && r.materialId === 'M07');
const childRows = tree.filter((r) => r.indent === 1);
check('explodeBomTree：保留半成品行（SE-GEAR）并标注下级数量', !!semiRow && semiRow.childCount === 2, JSON.stringify(semiRow));
check('explodeBomTree：下级材料带缩进与所属母项', childRows.length === 2 && childRows.every((r) => r.parentCode === 'SE-GEAR' && r.indent === 1), JSON.stringify(childRows.map((r) => [r.code, r.parentCode, r.indent])));
check('explodeBomTree：下级需求量按单位用量换算（10 × 2.5 = 25）', (childRows.find((r) => r.code === 'RM-45S') || {}).required === 25, JSON.stringify(childRows.map((r) => [r.code, r.required])));
check('explodeBomTree：无下级半成品标注说明', tree.some((r) => r.code === 'SE-SOLO' && /无下级 BOM/.test(r.note || '')), JSON.stringify(tree.map((r) => r.code)));

/* ═══════════ 六、导入生产订单补 orderLinks ═══════════ */

const db3 = emptyDb();
db3.salesOrders = [{ id: 'SO-1', code: 'TA-SO-001', customer: '甲', orderDate: BASE, priority: 1, status: 'CONFIRMED' }];
db3.salesOrderLines = [{ id: 'TA-SO-001-L1', salesOrderId: 'SO-1', productId: 'P1', qty: 28, dueDate: d(12), status: 'OPEN' }];
db3.products = [{ id: 'P1', code: 'RE-100', name: '行星减速机', unit: '台' }];
db3.productionOrders = [];
db3.orderLinks = [];

const rImp = applyImport(
  'productionOrders',
  [{ line: 2, entity: { id: 'PO-X1', code: 'TA-PO-001', productId: 'P1', qty: 28, salesOrderLineId: 'TA-SO-001-L1', status: 'DRAFT', reservations: [] } }],
  db3
);
check('导入生产订单：落库 1 条', rImp.created === 1 && db3.productionOrders.length === 1, JSON.stringify(rImp));
check('导入生产订单：同时写入 orderLinks', (db3.orderLinks || []).length === 1, JSON.stringify(db3.orderLinks));
check(
  '导入生产订单：orderLinks 指向正确的销售行与数量',
  db3.orderLinks[0].orderId === 'PO-X1' && db3.orderLinks[0].lineId === 'TA-SO-001-L1' && Number(db3.orderLinks[0].qty) === 28,
  JSON.stringify(db3.orderLinks[0])
);
check('导入生产订单：交期仍按 salesOrderLineId 回查', dueDateOf(db3, db3.productionOrders[0]) === d(12), dueDateOf(db3, db3.productionOrders[0]));

// 重复导入不应重复建关联
const rImp2 = applyImport(
  'productionOrders',
  [{ line: 2, entity: { id: 'PO-X2', code: 'TA-PO-001', productId: 'P1', qty: 28, salesOrderLineId: 'TA-SO-001-L1', status: 'DRAFT', reservations: [] } }],
  db3
);
check('重复导入：被拒绝且不新增关联', rImp2.rejected.length === 1 && db3.orderLinks.length === 1, JSON.stringify({ rejected: rImp2.rejected.length, links: db3.orderLinks.length }));

/* ═══════════ 结果 ═══════════ */

console.log(results.join('\n'));
console.log('='.repeat(60));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(60));
if (fail) process.exitCode = 1;
