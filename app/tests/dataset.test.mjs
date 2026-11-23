/**
 * 外部测试数据集导入校验（回归测试）
 *
 * 背景：原实现只有「三套内置场景」与一个只认 productionOrders 的恢复函数，
 * 外部测试数据没有入口；即便塞进去，缺少 planVersions / activeVersionId 时
 * 排程页会按 versionId === activeVersionId 过滤，表现为"导入成功但一条计划都看不到"。
 *
 * 运行：node tests/dataset.test.mjs（或 npm test）
 */

import { importDataset, templateDataset } from '../assets/js/core/dataset.js';
import { exportJson } from '../assets/js/core/store.js';
import { checkConstraints } from '../assets/js/core/constraints.js';
import { computeMetrics } from '../assets/js/core/metrics.js';
import { runSchedule } from '../assets/js/core/scheduler.js';

const AS_OF = '2026-11-23';
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

function section(title) {
  results.push(`\n【${title}】`);
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const base = templateDataset(AS_OF);

/** 取错误信息拼接，便于断言"有没有说清哪里错" */
const errText = (r) => r.report.errors.map((e) => `${e.path}:${e.message}`).join(' | ');

/* ═══════════ 1. 模板与基础导入 ═══════════ */
section('1. 示例数据集与基础契约');

{
  const r = importDataset(JSON.stringify(base), { fileName: '外部测试集.json' });
  check('示例数据集可导入', r.ok, errText(r));
  check('订单 / 任务 / 版本计数正确', r.report.counts.productionOrders === 1 && r.report.counts.tasks === 0 && r.report.counts.planVersions === 1);
  check('工作版本被正确识别', r.db.activeVersionId === 'PV-EXT-1' && r.report.meta.versionCode === 'PV-EXT-1');
  check('导入后清空 seedRev / seedScenario（不再被误判为旧演示数据）', r.db.seedRev === '' && r.db.seedScenario === '');
  check('数据集标识优先取文件名', r.report.meta.datasetLabel === '外部测试集.json' && r.db.datasetLabel === '外部测试集.json');
  check('settings 缺省字段被补齐（bufferDays = 2）', r.db.settings.bufferDays === 2 && r.db.settings.dateBasis.delayDays === 'CALENDAR');
  check('calendar 缺省字段被补齐', Array.isArray(r.db.calendar.workdays) && Array.isArray(r.db.calendar.holidays));
}

/* ═══════════ 2. 信封与形状 ═══════════ */
section('2. 信封格式与结构校验');

for (const key of ['data', 'dataset', 'db']) {
  const r = importDataset({ [key]: clone(base) });
  check(`支持 { ${key}: {...} } 信封`, r.ok, errText(r));
}

{
  const r = importDataset(JSON.stringify([{ code: 'PO-1' }]));
  check('顶层数组被拒绝且给出改法', !r.ok && errText(r).includes('productionOrders'));
}

{
  const r = importDataset(JSON.stringify({ products: [] }));
  check('缺少 productionOrders 被拒绝', !r.ok && errText(r).includes('缺少生产订单集合'));
  check('缺失提示里说明可接受的三种信封', errText(r).includes('data') && errText(r).includes('dataset') && errText(r).includes('db'));
}

{
  const bad = clone(base);
  bad.productionOrders = { code: 'PO-1' };
  const r = importDataset(bad);
  check('productionOrders 非数组被拒绝', !r.ok && errText(r).includes('必须是数组'));
}

{
  const bad = clone(base);
  bad.products = {};
  const r = importDataset(bad);
  check('集合声明为非数组被拒绝', !r.ok && errText(r).includes('products'));
}

{
  const r = importDataset('{ 这不是 json');
  check('非法 JSON 被拒绝并保留解析原因', !r.ok && r.report.errors[0].message.includes('JSON'));
}

{
  const extra = clone(base);
  extra.fooBar = 1;
  const r = importDataset(extra);
  check('未知顶层字段只警告、不阻断', r.ok && r.report.warnings.some((w) => w.includes('fooBar')));
}

/* ═══════════ 3. 字段级校验 ═══════════ */
section('3. 字段级校验与错误定位');

{
  const bad = clone(base);
  bad.productionOrders[0].qty = 'abc';
  const r = importDataset(bad);
  check('数量非数字被拒绝', !r.ok && errText(r).includes('productionOrders[0].qty'));
}

{
  const bad = clone(base);
  bad.productionOrders[0].qty = 0;
  const r = importDataset(bad);
  check('数量非正数被拒绝', !r.ok && errText(r).includes('必须为正数'));
}

{
  const bad = clone(base);
  bad.productionOrders[0].status = '随便写';
  const r = importDataset(bad);
  check('非法状态被拒绝并列出可选值', !r.ok && errText(r).includes('DRAFT') && errText(r).includes('CANCELLED'));
}

{
  const bad = clone(base);
  bad.productionOrders.push(clone(bad.productionOrders[0]));
  const r = importDataset(bad);
  check('订单号重复被拒绝', !r.ok && errText(r).includes('重复'));
}

{
  const bad = clone(base);
  bad.productionOrders[0].planStart = '2026/11/24';
  const r = importDataset(bad);
  check('日期格式错误被拒绝', !r.ok && errText(r).includes('YYYY-MM-DD'));
}

{
  const bad = clone(base);
  bad.productionOrders[0].productId = 'P-不存在';
  const r = importDataset(bad);
  check('产品不存在被拒绝', !r.ok && errText(r).includes('不存在于 products'));
}

{
  const coded = clone(base);
  delete coded.productionOrders[0].productId;
  coded.productionOrders[0].productCode = 'P-T1';
  const r = importDataset(coded);
  check('productCode 可解析为 productId', r.ok && r.db.productionOrders[0].productId === 'P-EXT-1', errText(r));
}

{
  const bad = clone(base);
  bad.salesOrderLines[0].qty = -5;
  const r = importDataset(bad);
  check('销售行数量为负被拒绝', !r.ok && errText(r).includes('salesOrderLines[0].qty'));
}

{
  const bad = clone(base);
  bad.inventory[0].materialCode = 'M-不存在';
  delete bad.inventory[0].materialId;
  const r = importDataset(bad);
  check('库存物料不存在被拒绝', !r.ok && errText(r).includes('inventory[0].materialId'));
}

{
  const bad = clone(base);
  bad.inbounds = [{ materialCode: 'M-T1', qty: 10, expectedDate: '2026-13-45', confirmed: '是' }];
  const r = importDataset(bad);
  check('到货日期非法被拒绝', !r.ok && errText(r).includes('expectedDate'));
}

/* ═══════════ 4. 版本重连（本次修复的核心回归） ═══════════ */
section('4. 计划版本与任务的关联修复');

{
  // 外部数据常带工序任务但不带版本字段：修复前这些任务在排程页全部不可见
  const withTasks = clone(base);
  withTasks.tasks = [
    { id: 'T-1', orderCode: 'PO-T1-001', seq: 10, opName: '下料', planQty: 40, workCenterCode: 'W-T1', startDate: '2026-11-24', endDate: '2026-11-24', dailyPlan: [{ date: '2026-11-24', qty: 40 }], status: 'PLANNED' },
    { id: 'T-2', orderCode: 'PO-T1-001', seq: 20, opName: '装配', planQty: 40, workCenterCode: 'W-T2', startDate: '2026-11-25', endDate: '2026-11-25', dailyPlan: [{ date: '2026-11-25', qty: 40 }], status: 'PLANNED' },
  ];
  const r = importDataset(withTasks);
  const visible = r.db.tasks.filter((t) => t.versionId === r.db.activeVersionId).length;
  check('脱链任务被重新挂到工作版本', r.ok && r.report.meta.assignedTasks === 2, errText(r));
  check('排程页可见任务数 = 导入任务数（回归：修复前为 0）', visible === 2, `visible=${visible}`);
  check('orderCode / workCenterCode 被解析为 id', r.db.tasks[0].orderId === 'PO-EXT-1' && r.db.tasks[0].workCenterId === 'W-EXT-1');
  check('脱链修复会产生明确提示', r.report.warnings.some((w) => w.includes('2 道工序任务')));
}

{
  const noVersion = clone(base);
  delete noVersion.planVersions;
  delete noVersion.activeVersionId;
  noVersion.tasks = [{ id: 'T-9', orderCode: 'PO-T1-001', seq: 10, opName: '下料', planQty: 40, startDate: '2026-11-24', endDate: '2026-11-24', dailyPlan: [{ date: '2026-11-24', qty: 40 }] }];
  const r = importDataset(noVersion);
  check('缺 planVersions 时自动建立工作版本', r.ok && r.db.planVersions.length === 1 && r.db.planVersions[0].id === 'PV-IMPORT');
  check('自动建立的版本被激活且任务可见', r.db.activeVersionId === 'PV-IMPORT' && r.db.tasks.every((t) => t.versionId === 'PV-IMPORT'));
}

{
  const broken = clone(base);
  broken.activeVersionId = 'PV-不存在';
  broken.tasks = [{ id: 'T-9', orderCode: 'PO-T1-001', seq: 10, planQty: 40, startDate: '2026-11-24', endDate: '2026-11-24', dailyPlan: [{ date: '2026-11-24', qty: 40 }] }];
  const r = importDataset(broken);
  check('activeVersionId 失效时被修正到有效版本', r.ok && r.db.activeVersionId === 'PV-EXT-1');
  check('失效版本引用会产生提示', r.report.warnings.some((w) => w.includes('不存在')));
}

{
  const wrongVersion = clone(base);
  wrongVersion.planVersions.push({ id: 'PV-2', code: 'PV-2', kind: 'SCENARIO', status: 'ARCHIVED' });
  wrongVersion.tasks = [{ id: 'T-9', orderCode: 'PO-T1-001', seq: 10, planQty: 40, startDate: '2026-11-24', endDate: '2026-11-24', dailyPlan: [{ date: '2026-11-24', qty: 40 }], versionId: 'PV-UNKNOWN' }];
  const r = importDataset(wrongVersion);
  check('任务引用未知版本时被改挂到工作版本', r.ok && r.db.tasks[0].versionId === 'PV-EXT-1', errText(r));
}

/* ═══════════ 5. 与既有能力衔接 ═══════════ */
section('5. 导入数据与既有能力衔接');

{
  const r = importDataset(JSON.stringify(base), { fileName: '往返.json' });
  const roundTrip = importDataset(exportJson(r.db));
  check('导入结果可被自身备份格式再次导入（备份/恢复兼容）', roundTrip.ok && roundTrip.report.counts.productionOrders === 1, errText(roundTrip));
}

{
  const r = importDataset(base);
  let ok = true;
  let detail = '';
  try {
    const v = checkConstraints([], r.db, r.db.settings);
    ok = Array.isArray(v);
  } catch (e) {
    ok = false;
    detail = e.message;
  }
  check('导入数据可直接进入约束校验（不因缺字段抛错）', ok, detail);
}

{
  const r = importDataset(base);
  const m = computeMetrics(r.db, { from: '2026-01-01', to: '2026-12-31' });
  const bad = m.filter((x) => !Number.isFinite(x.value));
  check('导入数据计算 12 项指标无 NaN', m.length === 12 && bad.length === 0, bad.map((x) => x.key).join(','));
}

{
  const r = importDataset(base);
  const res = runSchedule({
    db: r.db,
    orders: r.db.productionOrders.filter((o) => o.status === 'DRAFT'),
    strategy: 'DELIVERY',
    versionId: r.db.activeVersionId,
    asOf: AS_OF,
  });
  check('导入的待排产订单可直接排产（2 道工序）', res.tasks.length === 2, `tasks=${res.tasks.length}`);
  check('排产结果归属导入的工作版本', res.tasks.every((t) => t.versionId === 'PV-EXT-1'));
}

{
  const a = importDataset(clone(base));
  const b = importDataset(clone(base));
  check('同一数据集两次导入结果一致（确定性）', JSON.stringify(a.db) === JSON.stringify(b.db));
}

/* ═══════════ 输出 ═══════════ */
console.log(results.join('\n'));
console.log(`\n${'='.repeat(60)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
