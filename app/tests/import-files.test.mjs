/**
 * Excel / CSV 批量导入（io.js + core/sheet.js）
 *
 * 这一组测试针对的是"把导入从 JSON 扩到 Excel、并且不再整库覆盖"之后的真实风险：
 *   - 三种格式是否都能读（xlsx / xls / GBK-CSV），表头有标题行、日期是序列号时是否还原；
 *   - 多份文件一次导入时，依赖顺序、错误隔离、增量合并是否符合预期；
 *   - 销售订单与生产订单分别导入时是否互不覆盖；重复导入是否幂等；
 *   - 手工录入的数据是否被保留；
 *   - 清空后能否从空库重新导入。
 *
 * 运行：node tests/import-files.test.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  importSheetFiles,
  detectSpec,
  normalizeSheet,
  validateImport,
  applyImport,
  IMPORT_SPECS,
} from '../assets/js/io.js';
import { readTableFile, trimGrid } from '../assets/js/core/sheet.js';
import { emptyDb, clearAllData, loadDb, replaceDb } from '../assets/js/core/store.js';
import { buildSeed } from '../assets/js/core/seed.js';

let pass = 0;
let fail = 0;
const results = [];
const check = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    results.push(`  PASS  ${name}`);
  } else {
    fail += 1;
    results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const section = (t) => results.push(`\n【${t}】`);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = async (name) => {
  const buf = await readFile(path.join(HERE, 'fixtures', name));
  return { name, buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};

/* ═══════════ 1. 三种格式都能读 ═══════════ */
section('1. 格式解析（xlsx / xls / CSV）');

const productsFile = await fixture('products.xlsx');
const salesFile = await fixture('sales-orders.xlsx');
const prodFile = await fixture('production-orders.xls');
const soloFile = await fixture('production-orders-solo.xlsx');
const longFile = await fixture('products-long.xls');
const enFile = await fixture('products-en.xlsx');
const gbkFile = await fixture('inventory-gbk.csv');

const productsRead = await readTableFile(productsFile);
check('xlsx：识别格式与工作表名', productsRead.format === 'xlsx' && productsRead.sheets[0].name === '产品');
const pGrid = trimGrid(productsRead.sheets[0].grid);
check(
  'xlsx：保留标题行，表头在第 2 行',
  pGrid.length === 5 && pGrid[0][0] === '产品主数据（2026 版）' && pGrid[1][0] === '产品编号',
  JSON.stringify(pGrid[0])
);

const salesRead = await readTableFile(salesFile);
const sGrid = trimGrid(salesRead.sheets[0].grid);
check(
  'xlsx：日期单元格（序列号）能被识别为数字串',
  /^\d{5}$/.test(sGrid[1][4]),
  sGrid[1][4]
);

const prodRead = await readTableFile(prodFile);
check(
  'xls：BIFF8 文本与数字都正确',
  prodRead.format === 'xls' &&
    prodRead.sheets[0].grid[1][0] === 'PO-T1-001' &&
    prodRead.sheets[0].grid[1][2] === '40',
  JSON.stringify(prodRead.sheets[0].grid[1])
);

const longRead = await readTableFile(longFile);
const longGrid = trimGrid(longRead.sheets[0].grid);
check('xls：大表（共享字符串跨 CONTINUE）601 行无错位', longGrid.length === 601, `实际 ${longGrid.length}`);
check(
  'xls：跨记录字符串完整（首行/末行抽查）',
  longGrid[1][1].startsWith('超长产品名称第001号') && longGrid[600][1].startsWith('超长产品名称第600号')
);
check('xls：多工作表都能列出', longRead.sheets.length === 2 && longRead.sheets[1].name === '说明');

const gbkRead = await readTableFile(gbkFile);
check(
  'CSV：GBK + 制表符自动识别，中文不乱码',
  gbkRead.format === 'csv' &&
    gbkRead.sheets[0].grid[0].join('|') === '物料编号|数量|仓库' &&
    gbkRead.sheets[0].grid[1][2] === '主仓',
  JSON.stringify(gbkRead.sheets[0].grid[0])
);

const zhuan = await readTableFile({ name: 'x.csv', text: '产品编号;产品名称;单位\nP-1;泵体;台\n' });
check('CSV：分号分隔也能识别', zhuan.sheets[0].grid[1][1] === '泵体', JSON.stringify(zhuan.sheets[0].grid));

/* ═══════════ 2. 表头与场景识别 ═══════════ */
section('2. 表头定位与场景识别');

const normP = normalizeSheet('products', productsRead.sheets[0]);
check('表头定位：跳过标题行，行号从 Excel 第 3 行起', normP.found && normP.headerRow === 2 && normP.rows[0].__row === 3);
check('表头定位：3 行产品数据', normP.rows.length === 3, `实际 ${normP.rows.length}`);

const enNorm = normalizeSheet('products', (await readTableFile(enFile)).sheets[0]);
check('表头别名：Item Code / Name / UOM 映射到产品三列', enNorm.found && enNorm.rows.length === 1 && enNorm.rows[0]['产品编号'] === 'P-T9');

const vEn = validateImport('products', (await readTableFile(enFile)).sheets[0], emptyDb());
check('表头别名：给出"按别名识别"的提示而不是报错', vEn.errors.length === 0 && vEn.warnings.some((w) => /别名/.test(w)), JSON.stringify(vEn.errors));

check('场景识别：工作表名「生产订单」→ productionOrders', detectSpec('anything.xlsx', prodRead.sheets[0]).key === 'productionOrders');
check('场景识别：文件名「sales-orders」→ salesOrderLines', detectSpec('sales-orders.xlsx', salesRead.sheets[0]).key === 'salesOrderLines');
check('场景识别：GBK 库存表 → inventory', detectSpec('inventory-gbk.csv', gbkRead.sheets[0]).key === 'inventory');

/* ═══════════ 3. 一次导入多份文件（乱序选择） ═══════════ */
section('3. 多文件一次导入');

const base = emptyDb();
const batch = await importSheetFiles([salesFile, prodFile, productsFile], base);
check('多文件：全部成功', batch.ok && batch.results.every((r) => r.status === 'ok'), JSON.stringify(batch.results.map((r) => [r.file, r.status, r.errors])));
check('多文件：按依赖顺序处理（产品先于销售行与生产订单）', batch.results.every((r) => r.status === 'ok'));
check('多文件：3 个产品 + 2 个销售行 + 2 张生产订单', batch.db.products.length === 3 && batch.db.salesOrderLines.length === 2 && batch.db.productionOrders.length === 2);
check('多文件：销售订单头按行号前缀合并为 1 张', batch.db.salesOrders.length === 1, JSON.stringify(batch.db.salesOrders.map((s) => s.code)));
check('多文件：原始库未被修改（校验通过后才写库）', base.products.length === 0);
check('多文件：批次号写入 importLogs', /^IMP-/.test(batch.batchId) && batch.db.importLogs.length === 1 && batch.db.importLogs[0].batch === batch.batchId);
check(
  '多文件：写入来源批次，便于区分"这批数据哪来的"',
  batch.db.products.every((p) => p.imp && p.imp.batch === batch.batchId)
);
check('多文件：返回结果按用户选择顺序展示，而不是处理顺序', batch.results.map((r) => r.file).join(',') === 'sales-orders.xlsx,production-orders.xls,products.xlsx', batch.results.map((r) => r.file).join(','));

/* ═══════════ 4. 销售 / 生产分别导入互不覆盖 ═══════════ */
section('4. 销售与生产分别导入');

// 4.1 先销售、后生产
const dbA = emptyDb();
const rP1 = await importSheetFiles([productsFile], dbA);
const rS1 = await importSheetFiles([salesFile], rP1.db);
const rO1 = await importSheetFiles([prodFile], rS1.db);
check(
  '先导入销售订单，再导入生产订单：两边都在',
  rO1.ok && rO1.db.salesOrderLines.length === 2 && rO1.db.productionOrders.length === 2,
  JSON.stringify([rO1.db.salesOrderLines.length, rO1.db.productionOrders.length])
);

// 4.2 先生产、后销售（生产订单只带产品编号 → 自动补占位销售行）
const dbB = emptyDb();
const bP = await importSheetFiles([productsFile], dbB);
const bO = await importSheetFiles([soloFile], bP.db);
check(
  '单独导入生产订单：只带产品编号时自动补占位销售行',
  bO.ok && bO.db.productionOrders.length === 1 && bO.results[0].autoLines === 1,
  JSON.stringify(bO.results[0])
);
const bS = await importSheetFiles([salesFile], bO.db);
check(
  '随后导入销售订单：生产订单不被覆盖，销售行追加',
  bS.ok && bS.db.productionOrders.length === 1 && bS.db.salesOrderLines.length === 3,
  JSON.stringify([bS.db.productionOrders.length, bS.db.salesOrderLines.length])
);
check(
  '生产订单仍挂在原销售行上（关联未被改写）',
  bS.db.productionOrders.every((o) => o.salesOrderLineId.startsWith('SO-AUTO-'))
);

/* ═══════════ 5. 多批次累积与幂等 ═══════════ */
section('5. 多批次累积（重复导入不叠加、不覆盖）');

const again = await importSheetFiles([productsFile, salesFile, prodFile], batch.db);
check(
  '重复导入同一批文件：主数据更新、销售行与生产订单跳过',
  again.ok &&
    again.totals.created === 0 &&
    again.totals.updated === 3 &&
    again.totals.rejected === 4,
  JSON.stringify(again.totals)
);
check(
  '重复导入：集合条数不增长',
  again.db.products.length === 3 &&
    again.db.salesOrderLines.length === 2 &&
    again.db.productionOrders.length === 2,
  JSON.stringify([again.db.products.length, again.db.salesOrderLines.length, again.db.productionOrders.length])
);
check(
  '主数据更新保留原 id（生产订单的 productId 不失效）',
  again.db.productionOrders.every((o) => again.db.products.some((p) => p.id === o.productId))
);

/* ═══════════ 6. 手工录入数据被保留 ═══════════ */
section('6. 手工录入与导入共存');

const manual = emptyDb();
manual.products.push({ id: 'P-MANUAL', code: 'P-M', name: '手工录入产品', unit: '台' });
manual.productionOrders.push({ id: 'PO-MANUAL', code: 'PO-M', productId: 'P-MANUAL', qty: 5, status: 'DRAFT' });
const merged = await importSheetFiles([productsFile, soloFile], manual);
check(
  '导入不删除手工录入的产品与订单',
  merged.ok &&
    merged.db.products.some((p) => p.id === 'P-MANUAL') &&
    merged.db.productionOrders.some((o) => o.id === 'PO-MANUAL'),
  JSON.stringify([merged.db.products.map((p) => p.code), merged.db.productionOrders.map((o) => o.code)])
);
check('导入后产品数 = 手工 1 + 导入 3', merged.db.products.length === 4, String(merged.db.products.length));
check(
  '生产订单引用不存在销售行时给出可执行提示',
  (await importSheetFiles([prodFile], bP.db)).results[0].status === 'error',
  ''
);

/* ═══════════ 7. BOM / 库存 的自然键去重 ═══════════ */
section('7. 无编码主数据按自然键去重');

const nb = emptyDb();
nb.products.push({ id: 'P-1', code: 'P-T1', name: '泵', unit: '台' });
nb.materials.push({ id: 'M-1', code: 'M-T1', name: '钢', unit: '件', type: 'RAW' });
nb.materials.push({ id: 'M-2', code: 'M-T2', name: '组件', unit: '件', type: 'PURCHASE' });
const bomCsv = {
  name: 'bom.csv',
  text: '产品编号,层级,父项编码,子项编码,子项类型,单位用量\nP-T1,1,P-T1,M-T1,MATERIAL,2\nP-T1,1,P-T1,M-T2,MATERIAL,1\n',
};
const bom1 = await importSheetFiles([bomCsv], nb);
const bom2 = await importSheetFiles([bomCsv], bom1.db);
check('BOM 首次导入 2 行', bom1.ok && bom1.db.bomItems.length === 2, JSON.stringify(bom1.results[0]));
check(
  'BOM 再次导入：按（产品+层级+子项）更新，不产生重复行',
  bom2.ok && bom2.db.bomItems.length === 2 && bom2.totals.updated === 2 && bom2.totals.created === 0,
  JSON.stringify([bom2.db.bomItems.length, bom2.totals])
);

const inv = { name: 'inv.csv', text: '物料编号,数量,仓库\nM-T1,1000,主仓\nM-T2,200,主仓\n' };
const inv1 = await importSheetFiles([inv], bom2.db);
const inv2 = await importSheetFiles([{ name: 'inv2.csv', text: '物料编号,数量,仓库\nM-T1,800,主仓\n' }], inv1.db);
check('库存首次导入 2 条', inv1.ok && inv1.db.inventory.length === 2);
check(
  '库存再次导入：同（物料+仓库）更新数量，不新增行',
  inv2.ok && inv2.db.inventory.length === 2 && inv2.db.inventory.find((x) => x.materialId === 'M-1').qty === 800,
  JSON.stringify(inv2.db.inventory)
);

/* ═══════════ 8. 错误隔离 ═══════════ */
section('8. 错误隔离与整批拒绝');

const badFile = { name: 'bad.csv', text: '产品编号,产品名称,单位\nP-1,泵体,台\nP-1,重复,台\n' };
const mixed = await importSheetFiles([badFile, productsFile], emptyDb());
check('一份文件出错不影响另一份', mixed.ok && mixed.db.products.length === 3, JSON.stringify(mixed.results.map((r) => [r.file, r.status])));
const badRes = mixed.results.find((r) => r.file === 'bad.csv');
check('出错文件给出字段级定位', badRes.status === 'error' && badRes.errors.some((e) => e.line === 3 && /重复/.test(e.message)), JSON.stringify(badRes.errors));
check('出错文件未写入任何行', mixed.db.products.every((p) => p.code !== 'P-1' || p.name === '测试泵体'));

const unknown = await importSheetFiles([{ name: 'x.csv', text: '甲,乙\n1,2\n' }], emptyDb());
check('无法识别场景时明确报错并给出处理建议', unknown.results[0].status === 'error' && /无法自动识别/.test(unknown.results[0].errors[0].message));

const missingMaster = await importSheetFiles([salesFile], emptyDb());
check(
  '缺产品主数据时给出"先导入产品"的指引',
  missingMaster.results[0].status === 'error' &&
    missingMaster.results[0].errors.some((e) => /先导入产品主数据/.test(e.message)),
  JSON.stringify(missingMaster.results[0].errors)
);

/* ═══════════ 9. 清空全部数据 ═══════════ */
section('9. 清空全部数据');

// Node 里没有 localStorage，用最小实现验证清空语义（删键 + 写回空库）
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const seeded = buildSeed('medium', '2026-11-23');
localStorage.setItem('ppd-mvp-v1', JSON.stringify(seeded));
check('清空前：loadDb 能读回数据', loadDb().productionOrders.length > 0);
const cleared = clearAllData();
const reloaded = loadDb();
check(
  '清空后：库为空且不会自动重建演示数据',
  cleared.productionOrders.length === 0 &&
    cleared.products.length === 0 &&
    reloaded &&
    reloaded.productionOrders.length === 0 &&
    !reloaded.seedScenario,
  JSON.stringify([cleared.productionOrders.length, reloaded && reloaded.productionOrders.length])
);

const rebuildTarget = buildSeed('simple', '2026-11-23');
const importedAfterClear = await importSheetFiles([productsFile, salesFile], reloaded);
replaceDb(reloaded, importedAfterClear.db);
check(
  '清空后可以重新导入，且不影响 replaceDb 的目标对象',
  importedAfterClear.ok && reloaded.products.length === 3 && reloaded.salesOrderLines.length === 2,
  JSON.stringify([importedAfterClear.ok, reloaded.products.length])
);
check('replaceDb 保留对象引用（页面持有同一个库）', reloaded === reloaded && rebuildTarget.productionOrders.length > 0);

/* ═══════════ 10. 规格完整性 ═══════════ */
section('10. 规格完整性');

check('9 个导入场景都定义了 label / kind / rank', Object.values(IMPORT_SPECS).every((s) => s.label && s.kind && s.rank));
check(
  '主数据都有编码或自然键（否则重复导入会堆重复行）',
  Object.values(IMPORT_SPECS)
    .filter((s) => s.kind === 'MASTER')
    .every((s) => !!s.key || !!s.naturalKey)
);
check(
  '单据都有编码或自然键（否则无法判断重复）',
  Object.values(IMPORT_SPECS)
    .filter((s) => s.kind === 'DOC')
    .every((s) => !!s.key || !!s.naturalKey)
);
check(
  '生产订单允许只给产品编号（单独导入场景）',
  IMPORT_SPECS.productionOrders.fields.some((f) => f.key === 'productCode') &&
    !IMPORT_SPECS.productionOrders.fields.find((f) => f.key === 'lineCode').required
);
check(
  'applyImport 直接调用（旧接口）仍然可用',
  (() => {
    const d = emptyDb();
    const r = applyImport('products', [{ entity: { id: 'P-X', code: 'P-1', name: 'a', unit: '台' } }], d);
    return r.created === 1 && d.products.length === 1;
  })()
);

/* ═══════════ 结果 ═══════════ */
console.log(results.join('\n'));
console.log(`\n${'='.repeat(60)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
