/**
 * 导入导出校验（io.js）
 *
 * io.js 负责 CSV / XLSX 解析与逐行校验，是"外部数据进入系统"的唯一入口，
 * 但此前只有手工验收。这里补的是不依赖 DOM 的部分：
 *   - 模板与表头契约
 *   - CSV 解析的边界（BOM / CRLF / 引号 / 内嵌换行 / 空行）
 *   - 逐行校验的错误定位（行号、字段、原因）
 *   - 主数据覆盖 vs 单据重复即拒绝
 *   - 导出的转义
 *   - XLSX 非法输入的失败姿态
 *
 * 说明：parseXlsx 的正向路径依赖 DOMParser，Node 环境无法覆盖，只能测错误路径。
 *
 * 运行：node tests/io.test.mjs
 */

import {
  IMPORT_SPECS,
  templateCsv,
  parseCsv,
  parseXlsx,
  validateImport,
  applyImport,
  exportCsv,
} from '../assets/js/io.js';
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

function section(title) {
  results.push(`\n【${title}】`);
}

const csv = (lines) => lines.join('\n');

/* ═══════════ 1. 模板与表头契约 ═══════════ */
section('1. 模板与表头契约');

for (const key of Object.keys(IMPORT_SPECS)) {
  const spec = IMPORT_SPECS[key];
  const parsed = parseCsv(templateCsv(key));
  check(
    `${key}：模板表头与规格一致（${spec.fields.length} 列）`,
    parsed.headers.length === spec.fields.length && parsed.headers.every((h, i) => h === spec.fields[i].label),
    `实际 ${parsed.headers.join('|')}`
  );
  const res = validateImport(key, parsed, emptyDb());
  const headerErr = res.errors.filter((e) => e.line === 1 && /表头缺少必填列/.test(e.message));
  check(`${key}：自带模板不会报"表头缺列"`, headerErr.length === 0, headerErr.map((e) => e.message).join('；'));
}

/* ═══════════ 2. CSV 解析边界 ═══════════ */
section('2. CSV 解析边界');

const bom = parseCsv('\ufeff产品编号,产品名称\r\nP-1,泵体\r\n');
check('BOM 与 CRLF：表头去掉 BOM 前缀', bom.headers[0] === '产品编号', bom.headers[0]);
check('BOM 与 CRLF：解析出 1 行数据', bom.rows.length === 1 && bom.rows[0]['产品名称'] === '泵体');

const quote = parseCsv(csv(['a,b', '"含,逗号","含""引号"']));
check('引号内的逗号不被切分', quote.rows[0].a === '含,逗号', quote.rows[0].a);
check('双写引号还原为一个引号', quote.rows[0].b === '含"引号', quote.rows[0].b);

const multi = parseCsv('a,b\n"第一行\n第二行",z');
check('引号内的换行不切行', multi.rows.length === 1 && multi.rows[0].a === '第一行\n第二行', JSON.stringify(multi.rows));

const blanks = parseCsv(csv(['a,b', '1,2', '', '   ', '3,4']));
check('空行与全空白行被过滤', blanks.rows.length === 2, `实际 ${blanks.rows.length} 行`);

const none = parseCsv('');
check('空文本返回空结构', none.headers.length === 0 && none.rows.length === 0);

const ragged = parseCsv(csv(['a,b,c', '1,2']));
check('缺列的行补空字符串而不是 undefined', ragged.rows[0].c === '', String(ragged.rows[0].c));

/* ═══════════ 3. 逐行校验的错误定位 ═══════════ */
section('3. 逐行校验（行号 / 字段 / 原因）');

const db0 = emptyDb();

const missHeader = validateImport('products', parseCsv('产品编号\nP-1'), db0);
check(
  '缺必填列：定位到第 1 行（表头）',
  missHeader.errors.length === 2 && missHeader.errors.every((e) => e.line === 1),
  JSON.stringify(missHeader.errors)
);

const emptyCell = validateImport('products', parseCsv(csv(['产品编号,产品名称,单位', 'P-1,,台'])), db0);
check(
  '必填为空：定位到第 2 行并指出字段',
  emptyCell.errors.length === 1 && emptyCell.errors[0].line === 2 && emptyCell.errors[0].field === '产品名称',
  JSON.stringify(emptyCell.errors)
);

const dup = validateImport('products', parseCsv(csv(['产品编号,产品名称,单位', 'P-1,A,台', 'P-1,B,台'])), db0);
check(
  '文件内编码重复：定位到第 3 行并指出与第 2 行相同',
  dup.errors.length === 1 && dup.errors[0].line === 3 && /文件内重复/.test(dup.errors[0].message),
  JSON.stringify(dup.errors)
);
check('重复行不计入可导入实体', dup.entities.length === 1, `实际 ${dup.entities.length}`);

const badEnum = validateImport('materials', parseCsv(csv(['物料编号,物料名称,单位,物料类型', 'M-1,钢,件,XX'])), db0);
check(
  '枚举非法：给出可选值',
  badEnum.errors.length === 1 && /取值必须是 RAW \/ PURCHASE \/ SEMI/.test(badEnum.errors[0].message),
  JSON.stringify(badEnum.errors)
);

const badNum = validateImport('workCenters', parseCsv(csv(['编码,名称,产能模式,日产能(件/日)', 'WC-1,中心,DAILY_QTY,abc'])), db0);
check(
  '非数字：报"不是有效数字"并回显原值',
  badNum.errors.length === 1 && /不是有效数字：abc/.test(badNum.errors[0].message),
  JSON.stringify(badNum.errors)
);

const badDate = validateImport(
  'inbounds',
  parseCsv(csv(['物料编号,数量,预计到货日,是否确认', 'M-1,10,2026-02-30,是'])),
  db0
);
check(
  '格式对但不存在的日期被拦下（2 月 30 日）',
  badDate.errors.some((e) => /日期无法识别/.test(e.message)),
  JSON.stringify(badDate.errors)
);

const dbDate = emptyDb();
dbDate.materials.push({ id: 'M-1', code: 'M-1', name: '钢', unit: '件', type: 'RAW' });
const slashDate = validateImport(
  'inbounds',
  parseCsv(csv(['物料编号,数量,预计到货日,是否确认', 'M-1,10,2026/12/1,是', 'M-1,20,46387,否'])),
  dbDate
);
check(
  '日期容错：2026/12/1 与 Excel 序列号都归一为 YYYY-MM-DD',
  slashDate.errors.length === 0 &&
    slashDate.entities[0].entity.expectedDate === '2026-12-01' &&
    /^2026-1[12]-\d{2}$/.test(slashDate.entities[1].entity.expectedDate),
  JSON.stringify([slashDate.errors, slashDate.entities.map((x) => x.entity.expectedDate)])
);

const dbBool = emptyDb();
dbBool.materials.push({ id: 'M-1', code: 'M-1', name: '钢', unit: '件', type: 'RAW' });
const boolRes = validateImport(
  'inbounds',
  parseCsv(csv(['物料编号,数量,预计到货日,是否确认', 'M-1,10,2026-12-01,是', 'M-1,20,2026-12-02,否'])),
  dbBool
);
check(
  '布尔列：是/否 解析为 true/false',
  boolRes.errors.length === 0 &&
    boolRes.entities[0].entity.confirmed === true &&
    boolRes.entities[1].entity.confirmed === false,
  JSON.stringify(boolRes.errors)
);

const badRef = validateImport(
  'bomItems',
  parseCsv(csv(['产品编号,层级,父项编码,子项编码,子项类型,单位用量', 'P-X,1,P-X,M-1,MATERIAL,2'])),
  db0
);
check(
  '关联对象不存在：归到「关联关系」并说明缺哪个',
  badRef.errors.length === 1 && badRef.errors[0].field === '关联关系' && /产品「P-X」不存在/.test(badRef.errors[0].message),
  JSON.stringify(badRef.errors)
);

const good = validateImport('products', parseCsv(csv(['产品编号,产品名称,单位', 'P-1,泵体,台', 'P-2,机架,台'])), db0);
check('合法数据：0 错误、2 条实体、行号连续', good.errors.length === 0 && good.entities.length === 2 && good.entities[1].line === 3);

/* ═══════════ 4. 应用导入的两种语义 ═══════════ */
section('4. 应用导入（主数据覆盖 / 单据拒绝）');

const dbA = emptyDb();
dbA.products.push({ id: 'P-EXIST', code: 'P-1', name: '旧名称', unit: '台' });
const parsedOverwrite = validateImport('products', parseCsv(csv(['产品编号,产品名称,单位', 'P-1,新名称,件'])), dbA);
const rOver = applyImport('products', parsedOverwrite.entities, dbA);
check('主数据：同编码覆盖，不新增', rOver.updated === 1 && rOver.created === 0 && dbA.products.length === 1, JSON.stringify(rOver));
check('主数据：覆盖后保留原 id', dbA.products[0].id === 'P-EXIST', dbA.products[0].id);
check('主数据：字段已更新', dbA.products[0].name === '新名称' && dbA.products[0].unit === '件');

const dbB = emptyDb();
const parsedNew = validateImport('products', parseCsv(csv(['产品编号,产品名称,单位', 'P-9,新件,台'])), dbB);
const rNew = applyImport('products', parsedNew.entities, dbB);
check('主数据：新编码新增', rNew.created === 1 && dbB.products.length === 1, JSON.stringify(rNew));

const dbC = emptyDb();
dbC.productionOrders.push({ id: 'PO-OLD', code: 'PO-001' });
const rDoc = applyImport('productionOrders', [{ entity: { id: 'PO-NEW', code: 'PO-001' } }], dbC);
check(
  '单据：重复即拒绝并给出原因',
  rDoc.rejected.length === 1 && rDoc.created === 0 && /单据已存在/.test(rDoc.rejected[0].reason),
  JSON.stringify(rDoc)
);
check('单据：被拒绝的记录不落库', dbC.productionOrders.length === 1);

/* ═══════════ 5. 导出转义 ═══════════ */
section('5. 导出转义');

const out = exportCsv(
  [{ name: '含,逗号' }, { name: '含"引号' }, { name: '含\n换行' }, { name: '普通' }],
  [{ label: '名称', key: 'name' }]
);
const outLines = out.split('\n');
check('导出：表头正确', out.startsWith('名称\n'));
check('导出：逗号触发引号包裹', out.includes('"含,逗号"'));
check('导出：引号双写转义', out.includes('"含""引号"'));
check('导出：换行触发引号包裹', out.includes('"含\n换行"'));
check('导出：普通值不加引号', outLines[outLines.length - 1] === '普通', outLines[outLines.length - 1]);

const outEmpty = exportCsv([{ name: null }], [{ label: '名称', key: 'name' }]);
check('导出：null 输出为空字符串而不是 "null"', outEmpty === '名称\n', JSON.stringify(outEmpty));

/* ═══════════ 6. XLSX 非法输入 ═══════════ */
section('6. XLSX 非法输入');

let xlsxMsg = '';
try {
  await parseXlsx(new ArrayBuffer(16));
} catch (e) {
  xlsxMsg = e.message;
}
check('非 zip 内容：抛出可读错误而不是静默失败', /不是有效的 xlsx 文件/.test(xlsxMsg), xlsxMsg);

/* ═══════════ 结果 ═══════════ */
console.log(results.join('\n'));
console.log(`\n${'='.repeat(60)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
