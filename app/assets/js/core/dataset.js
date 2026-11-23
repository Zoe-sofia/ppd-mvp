/**
 * 外部测试数据集导入（JSON）
 *
 * 为什么单独成模块：
 * 1. 原实现把"恢复备份"和"载入场景"混在 store.js 里，前者只认自家备份信封，后者写死三套内置场景，
 *    外部测试数据没有可用入口；
 * 2. 导入后的数据必须自洽（尤其是 planVersions / activeVersionId 与 tasks.versionId 的关联），
 *    否则排程、甘特、工作台、指标会"导入成功但一条也看不到"；
 * 3. 校验要能给出字段级定位，而不是一句"结构不符合要求"。
 *
 * 导入契约（详见 README「外部测试数据」）：
 * - 顶层允许三种信封：原始数据集对象 / { data: {...} } / { dataset: {...} } / { db: {...} }
 * - 必须包含 productionOrders（数组，可为空数组表示只导入主数据）；其余集合缺省补空
 * - 关联字段可用 id，也可用编码（productCode / orderCode / workCenterCode / versionCode）自动解析
 * - 缺失计划版本时自动建立工作版本，并把脱链的工序任务重新挂到该版本上
 */

import { emptyDb } from './store.js';
import { ORDER_STATUS, TASK_STATUS, VERSION_KIND, VERSION_STATUS } from './constants.js';
import { addDays, today } from './calendar.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENVELOPES = ['data', 'dataset', 'db'];
const MAX_TASKS = 20000;
const MAX_ORDERS = 5000;

/** 除 settings / calendar / factory / users 之外的集合字段 */
const COLLECTIONS = [
  'products',
  'materials',
  'bomItems',
  'routings',
  'routingOps',
  'workCenters',
  'capabilities',
  'downtimes',
  'inventory',
  'inbounds',
  'salesOrders',
  'salesOrderLines',
  'productionOrders',
  'orderLinks',
  'planVersions',
  'tasks',
  'actuals',
  'shipments',
  'exceptions',
  'freezeLogs',
  'blockedLog',
  'importLogs',
];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const asNum = (v) => {
  if (v === '' || v === null || v === undefined) return NaN;
  return Number(v);
};
const stripBom = (t) => String(t).replace(/^\uFEFF/, '');
const byCode = (arr) => new Map((arr || []).filter((x) => isObj(x) && str(x.code)).map((x) => [str(x.code), x]));
const byId = (arr) => new Map((arr || []).filter((x) => isObj(x) && str(x.id)).map((x) => [str(x.id), x]));

/** 枚举归一：空值用默认值；非法值报错（宁可失败，也不要静默改语义） */
function normEnum(raw, table, fallback, path, errors) {
  const v = str(raw).toUpperCase();
  if (!v) return fallback;
  if (table[v]) return v;
  errors.push({ path, message: `取值「${raw}」不在允许范围：${Object.keys(table).join(' / ')}` });
  return fallback;
}

function checkDate(value, path, errors, required = false) {
  if (!str(value)) {
    if (required) errors.push({ path, message: '日期必填（YYYY-MM-DD）' });
    return '';
  }
  const text = str(value);
  if (!DATE_RE.test(text)) {
    errors.push({ path, message: `日期格式应为 YYYY-MM-DD，实际为「${value}」` });
    return '';
  }
  // 格式正确不代表日期存在：2026-13-45 也能通过正则，必须再验一次日历
  const [y, m, d] = text.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    errors.push({ path, message: `日期不存在：「${text}」` });
    return '';
  }
  return text;
}

/** 拆信封：外部数据可能整体包在 data / dataset / db 里 */
function unwrap(parsed) {
  for (const key of ENVELOPES) {
    if (isObj(parsed[key])) return { payload: parsed[key], envelope: key };
  }
  return { payload: parsed, envelope: 'raw' };
}

/**
 * 导入数据集（纯函数，不写库）
 * @param {string|object} input JSON 文本或对象
 * @param {{fileName?: string}} [options]
 * @returns {{ok: boolean, db: object|null, report: object}}
 */
export function importDataset(input, options = {}) {
  const errors = [];
  const warnings = [];
  const report = {
    ok: false,
    errors,
    warnings,
    counts: {},
    meta: { envelope: '', datasetLabel: '', versionCode: '', assignedTasks: 0 },
  };

  let parsed;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(stripBom(input));
    } catch (e) {
      errors.push({ path: '文件', message: `不是合法 JSON：${e.message}` });
      return { ok: false, db: null, report };
    }
  } else {
    parsed = input;
  }

  if (Array.isArray(parsed)) {
    errors.push({
      path: '根节点',
      message: '顶层必须是对象；若导出的是订单数组，请包成 { "productionOrders": [ ... ] }',
    });
    return { ok: false, db: null, report };
  }
  if (!isObj(parsed)) {
    errors.push({ path: '根节点', message: '顶层必须是对象（当前为空或不是对象）' });
    return { ok: false, db: null, report };
  }

  const { payload, envelope } = unwrap(parsed);
  report.meta.envelope = envelope;

  if (!('productionOrders' in payload)) {
    errors.push({
      path: 'productionOrders',
      message:
        '缺少生产订单集合 productionOrders。可接受的顶层写法：直接放数据集对象，或包在 data / dataset / db 里',
    });
    return { ok: false, db: null, report };
  }
  if (!Array.isArray(payload.productionOrders)) {
    errors.push({ path: 'productionOrders', message: '必须是数组' });
    return { ok: false, db: null, report };
  }

  /* ── 集合形状校验：声明了就必须是数组 ── */
  for (const key of COLLECTIONS) {
    if (key in payload && !Array.isArray(payload[key])) {
      errors.push({ path: key, message: '必须是数组（没有数据请写 []）' });
    }
  }
  if (errors.length) return { ok: false, db: null, report };

  const unknown = Object.keys(payload).filter(
    (k) => !COLLECTIONS.includes(k) && !['settings', 'calendar', 'factory', 'users', 'schema', 'seedRev', 'seedScenario', 'activeVersionId', 'datasetLabel', 'exportedAt'].includes(k)
  );
  if (unknown.length) warnings.push(`已忽略未识别的顶层字段：${unknown.join('、')}`);

  /* ── 组装数据库：以 emptyDb 为骨架，缺省集合补空 ── */
  const db = emptyDb();
  for (const key of COLLECTIONS) {
    if (Array.isArray(payload[key])) db[key] = payload[key].map((x) => (isObj(x) ? { ...x } : x));
  }

  if (isObj(payload.settings)) {
    db.settings = {
      ...db.settings,
      ...payload.settings,
      dateBasis: { ...db.settings.dateBasis, ...(isObj(payload.settings.dateBasis) ? payload.settings.dateBasis : {}) },
    };
  }
  if (isObj(payload.calendar)) {
    db.calendar = { ...db.calendar, ...payload.calendar };
    if (!Array.isArray(db.calendar.workdays)) db.calendar.workdays = [1, 2, 3, 4, 5];
    if (!Array.isArray(db.calendar.holidays)) db.calendar.holidays = [];
  }
  if (isObj(payload.factory) && str(payload.factory.name)) db.factory = { ...db.factory, ...payload.factory };
  if (Array.isArray(payload.users) && payload.users.length) db.users = payload.users;

  /* ── 上下文索引（供编码→id 解析） ── */
  const productById = byId(db.products);
  const productByCode = byCode(db.products);
  const wcById = byId(db.workCenters);
  const wcByCode = byCode(db.workCenters);
  const orderById = byId(db.productionOrders);
  const orderByCode = byCode(db.productionOrders);
  const lineById = byId(db.salesOrderLines);
  const opById = byId(db.routingOps);
  const versionById = byId(db.planVersions);
  const versionByCode = byCode(db.planVersions);

  /* ── 生产订单 ── */
  if (db.productionOrders.length > MAX_ORDERS) {
    errors.push({ path: 'productionOrders', message: `订单数 ${db.productionOrders.length} 超过上限 ${MAX_ORDERS}` });
  }
  const seenOrderCodes = new Set();
  db.productionOrders.forEach((o, i) => {
    const at = `productionOrders[${i}]`;
    if (!isObj(o)) {
      errors.push({ path: at, message: '必须是对象' });
      return;
    }
    o.code = str(o.code) || str(o.id);
    if (!o.code) {
      errors.push({ path: `${at}.code`, message: '生产订单号必填' });
      return;
    }
    if (seenOrderCodes.has(o.code)) {
      errors.push({ path: `${at}.code`, message: `生产订单号「${o.code}」在文件内重复` });
    }
    seenOrderCodes.add(o.code);
    if (!str(o.id)) o.id = o.code;

    o.qty = asNum(o.qty);
    if (!Number.isFinite(o.qty) || o.qty <= 0) {
      errors.push({ path: `${at}.qty`, message: `生产数量必须为正数，实际为「${o.qty}」` });
    }
    o.status = normEnum(o.status, ORDER_STATUS, 'DRAFT', `${at}.status`, errors);

    if (!str(o.productId) && str(o.productCode)) {
      const p = productByCode.get(str(o.productCode));
      if (p) o.productId = p.id;
    }
    if (!str(o.productId)) {
      errors.push({ path: `${at}.productId`, message: 'productId 或 productCode 必填（需能在 products 中解析）' });
    } else if (!productById.has(str(o.productId))) {
      errors.push({ path: `${at}.productId`, message: `产品「${o.productId}」不存在于 products` });
    }
    o.planStart = checkDate(o.planStart, `${at}.planStart`, errors);
    o.planEnd = checkDate(o.planEnd, `${at}.planEnd`, errors);
    if (!Number.isFinite(asNum(o.priority))) o.priority = 1;
    else o.priority = asNum(o.priority);
    if (!Array.isArray(o.linkedLineIds)) o.linkedLineIds = [];
  });

  /* ── 销售订单行（可选） ── */
  const seenLineIds = new Set();
  db.salesOrderLines.forEach((l, i) => {
    const at = `salesOrderLines[${i}]`;
    if (!isObj(l)) {
      errors.push({ path: at, message: '必须是对象' });
      return;
    }
    if (!str(l.id) && str(l.lineCode)) l.id = str(l.lineCode);
    if (!str(l.id)) {
      errors.push({ path: `${at}.id`, message: '销售订单行号必填（id 或 lineCode）' });
      return;
    }
    if (seenLineIds.has(str(l.id))) {
      errors.push({ path: `${at}.id`, message: `销售订单行号「${l.id}」在文件内重复` });
    }
    seenLineIds.add(str(l.id));
    l.qty = asNum(l.qty);
    if (!Number.isFinite(l.qty) || l.qty <= 0) {
      errors.push({ path: `${at}.qty`, message: `数量必须为正数，实际为「${l.qty}」` });
    }
    if (!str(l.productId) && str(l.productCode)) {
      const p = productByCode.get(str(l.productCode));
      if (p) l.productId = p.id;
    }
    if (str(l.productId) && !productById.has(str(l.productId))) {
      errors.push({ path: `${at}.productId`, message: `产品「${l.productId}」不存在于 products` });
    }
    l.dueDate = checkDate(l.dueDate, `${at}.dueDate`, errors);
    if (str(l.salesOrderId) && !byId(db.salesOrders).has(str(l.salesOrderId))) {
      warnings.push(`销售订单行「${l.id}」引用的销售订单 ${l.salesOrderId} 不存在，已忽略该关联`);
      l.salesOrderId = '';
    }
  });

  /* ── 计划版本（缺失则自动建） ── */
  db.planVersions.forEach((v, i) => {
    const at = `planVersions[${i}]`;
    if (!isObj(v)) {
      errors.push({ path: at, message: '必须是对象' });
      return;
    }
    v.code = str(v.code) || str(v.id);
    if (!v.code) {
      errors.push({ path: `${at}.code`, message: '版本号必填' });
      return;
    }
    if (!str(v.id)) v.id = v.code;
    v.kind = normEnum(v.kind, VERSION_KIND, 'FORMAL', `${at}.kind`, errors);
    v.status = normEnum(v.status, VERSION_STATUS, 'ACTIVE', `${at}.status`, errors);
    if (!v.name) v.name = v.code;
  });

  if (!db.planVersions.length) {
    db.planVersions.push({
      id: 'PV-IMPORT',
      code: 'PV-IMPORT',
      name: '导入的测试计划',
      kind: 'FORMAL',
      status: 'ACTIVE',
      strategy: 'DELIVERY',
      weights: { DELIVERY: 60, MATERIAL: 20, CAPACITY: 20 },
      createdAt: '',
      appliedAt: '',
      originVersionId: '',
      note: '导入数据集时自动建立',
    });
    warnings.push('未提供 planVersions，已自动建立工作版本 PV-IMPORT');
  }

  /* 工作版本：优先用文件里声明的，其次第一个生效版本，再次第一个版本 */
  const declared = str(payload.activeVersionId);
  let active = declared && versionById.has(declared) ? versionById.get(declared) : null;
  if (declared && !active) {
    warnings.push(`activeVersionId「${declared}」在 planVersions 中不存在，已按规则重新指定`);
  }
  if (!active) active = db.planVersions.find((v) => v.status === 'ACTIVE') || db.planVersions[0];
  db.activeVersionId = active.id;
  report.meta.versionCode = active.code;

  /* ── 工序任务 ── */
  if (db.tasks.length > MAX_TASKS) {
    errors.push({ path: 'tasks', message: `工序任务数 ${db.tasks.length} 超过上限 ${MAX_TASKS}` });
  }
  const seenTaskIds = new Set();
  let assigned = 0;
  db.tasks.forEach((t, i) => {
    const at = `tasks[${i}]`;
    if (!isObj(t)) {
      errors.push({ path: at, message: '必须是对象' });
      return;
    }
    if (!str(t.orderId) && str(t.orderCode)) {
      const o = orderByCode.get(str(t.orderCode));
      if (o) t.orderId = o.id;
    }
    if (!str(t.orderId)) {
      errors.push({ path: `${at}.orderId`, message: 'orderId 或 orderCode 必填（需能在 productionOrders 中解析）' });
    } else if (!orderById.has(str(t.orderId))) {
      errors.push({ path: `${at}.orderId`, message: `生产订单「${t.orderId}」不存在` });
    }
    if (!str(t.workCenterId) && str(t.workCenterCode)) {
      const w = wcByCode.get(str(t.workCenterCode));
      if (w) t.workCenterId = w.id;
    }
    if (str(t.workCenterId) && !wcById.has(str(t.workCenterId))) {
      errors.push({ path: `${at}.workCenterId`, message: `工作中心「${t.workCenterId}」不存在` });
    }
    if (str(t.opId) && !opById.has(str(t.opId))) {
      warnings.push(`工序任务 ${t.id || i} 引用的工序 ${t.opId} 不在 routingOps 中（排产不受影响）`);
    }

    /* 版本脱链：这是"导入成功但计划页空白"的根因，必须在这里收口 */
    const vId = str(t.versionId);
    if (!vId || !versionById.has(vId)) {
      t.versionId = db.activeVersionId;
      assigned += 1;
    }

    t.seq = Number.isFinite(asNum(t.seq)) ? asNum(t.seq) : (i + 1) * 10;
    if (!str(t.id)) t.id = `T-${t.orderId}-${t.seq}`;
    if (seenTaskIds.has(str(t.id))) {
      errors.push({ path: `${at}.id`, message: `工序任务 id「${t.id}」在文件内重复` });
    }
    seenTaskIds.add(str(t.id));

    t.planQty = asNum(t.planQty);
    if (!Number.isFinite(t.planQty) || t.planQty <= 0) {
      errors.push({ path: `${at}.planQty`, message: `计划数量必须为正数，实际为「${t.planQty}」` });
    }
    t.status = normEnum(t.status, TASK_STATUS, 'PLANNED', `${at}.status`, errors);
    t.startDate = checkDate(t.startDate, `${at}.startDate`, errors);
    t.endDate = checkDate(t.endDate, `${at}.endDate`, errors);

    if (t.dailyPlan !== undefined && !Array.isArray(t.dailyPlan)) {
      errors.push({ path: `${at}.dailyPlan`, message: '必须是数组，元素形如 { "date": "2026-11-24", "qty": 10 }' });
      t.dailyPlan = [];
    }
    const plan = [];
    (t.dailyPlan || []).forEach((d, j) => {
      const p = `${at}.dailyPlan[${j}]`;
      if (!isObj(d)) {
        errors.push({ path: p, message: '必须是对象 { date, qty }' });
        return;
      }
      const date = checkDate(d.date, `${p}.date`, errors, true);
      const qty = asNum(d.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        errors.push({ path: `${p}.qty`, message: `日计划量必须为正数，实际为「${d.qty}」` });
        return;
      }
      if (date) plan.push({ date, qty });
    });
    t.dailyPlan = plan;
    ['actualStartQty', 'actualDoneQty', 'goodQty', 'scrapQty'].forEach((k) => {
      const n = asNum(t[k]);
      t[k] = Number.isFinite(n) && n >= 0 ? n : 0;
    });
    if (!isObj(t.scrapReasons)) t.scrapReasons = {};
    if (!str(t.actualStart)) t.actualStart = '';
    if (!str(t.actualEnd)) t.actualEnd = '';
    if (!str(t.opName)) t.opName = (opById.get(str(t.opId)) || {}).name || '工序';
  });
  report.meta.assignedTasks = assigned;
  if (assigned > 0) {
    warnings.push(`${assigned} 道工序任务的版本引用缺失或无效，已归入工作版本 ${active.code}`);
  }

  /* ── 库存 / 到货：编码解析与数值校验 ── */
  const materialByCode = byCode(db.materials);
  const materialById = byId(db.materials);
  db.inventory.forEach((r, i) => {
    const at = `inventory[${i}]`;
    if (!str(r.materialId) && str(r.materialCode)) {
      const m = materialByCode.get(str(r.materialCode));
      if (m) r.materialId = m.id;
    }
    if (!materialById.has(str(r.materialId))) {
      errors.push({ path: `${at}.materialId`, message: `物料「${r.materialId || r.materialCode || ''}」不存在` });
    }
    r.qty = asNum(r.qty);
    if (!Number.isFinite(r.qty) || r.qty < 0) {
      errors.push({ path: `${at}.qty`, message: `库存数量必须为非负数，实际为「${r.qty}」` });
    }
    if (!str(r.warehouse)) r.warehouse = '主仓';
  });
  db.inbounds.forEach((r, i) => {
    const at = `inbounds[${i}]`;
    if (!str(r.materialId) && str(r.materialCode)) {
      const m = materialByCode.get(str(r.materialCode));
      if (m) r.materialId = m.id;
    }
    if (!materialById.has(str(r.materialId))) {
      errors.push({ path: `${at}.materialId`, message: `物料「${r.materialId || r.materialCode || ''}」不存在` });
    }
    r.qty = asNum(r.qty);
    if (!Number.isFinite(r.qty) || r.qty <= 0) {
      errors.push({ path: `${at}.qty`, message: `到货数量必须为正数，实际为「${r.qty}」` });
    }
    r.expectedDate = checkDate(r.expectedDate, `${at}.expectedDate`, errors, true);
    r.confirmed = r.confirmed === true || /^(y|yes|true|1|是)$/i.test(str(r.confirmed));
    if (!str(r.actualArrivalDate)) r.actualArrivalDate = '';
  });

  /* ── 汇总 ── */
  const counts = {};
  for (const key of COLLECTIONS) counts[key] = Array.isArray(db[key]) ? db[key].length : 0;
  report.counts = counts;
  report.meta.datasetLabel =
    str(options.fileName) ||
    str(payload.datasetLabel) ||
    str(payload.name) ||
    `外部数据集（${counts.productionOrders} 张订单）`;

  db.seedRev = '';
  db.seedScenario = '';
  db.datasetLabel = report.meta.datasetLabel;

  if (counts.productionOrders === 0) warnings.push('未包含生产订单，导入后只有主数据');
  if (counts.tasks === 0 && counts.productionOrders > 0) {
    warnings.push('未包含工序任务，订单会以「待排产」状态进入，需在生产排程页执行自动排产');
  }

  report.ok = errors.length === 0;
  return { ok: report.ok, db: report.ok ? db : null, report };
}

/** 生成一份最小可用的示例数据集（供页面「下载示例数据集」与测试使用） */
export function templateDataset(asOf = today()) {
  const start = addDays(asOf, 1);
  const end = addDays(asOf, 8);
  return {
    datasetLabel: '外部测试数据集模板',
    factory: { id: 'F-EXT', name: '外部测试工厂', code: 'EXT' },
    settings: { bufferDays: 2, freezeDays: 3 },
    calendar: { id: 'CAL-EXT', name: '标准工作日历', workdays: [1, 2, 3, 4, 5], holidays: [] },
    products: [{ id: 'P-EXT-1', code: 'P-T1', name: '测试产品 A', unit: '台' }],
    materials: [
      { id: 'M-EXT-1', code: 'M-T1', name: '测试钢板', unit: '件', type: 'RAW' },
      { id: 'M-EXT-2', code: 'M-T2', name: '测试组件', unit: '件', type: 'PURCHASE' },
    ],
    bomItems: [
      { id: 'B-EXT-1', productId: 'P-EXT-1', level: 1, parentId: 'P-EXT-1', parentType: 'PRODUCT', childId: 'M-EXT-1', childType: 'MATERIAL', qtyPer: 2 },
      { id: 'B-EXT-2', productId: 'P-EXT-1', level: 1, parentId: 'P-EXT-1', parentType: 'PRODUCT', childId: 'M-EXT-2', childType: 'MATERIAL', qtyPer: 1 },
    ],
    routings: [{ id: 'R-EXT-1', productId: 'P-EXT-1', code: 'RT-T1', name: '测试产品 A 标准工艺', version: 'A' }],
    routingOps: [
      { id: 'OP-EXT-1', routingId: 'R-EXT-1', seq: 10, name: '下料', stdHoursPerUnit: 0.5, workCenterId: 'W-EXT-1' },
      { id: 'OP-EXT-2', routingId: 'R-EXT-1', seq: 20, name: '装配', stdHoursPerUnit: 1, workCenterId: 'W-EXT-2' },
    ],
    workCenters: [
      { id: 'W-EXT-1', code: 'W-T1', name: '下料中心', capacityMode: 'DAILY_QTY', dailyCapacity: 100, dailyHours: 8 },
      { id: 'W-EXT-2', code: 'W-T2', name: '装配中心', capacityMode: 'DAILY_QTY', dailyCapacity: 60, dailyHours: 8 },
    ],
    capabilities: [
      { id: 'CAP-EXT-1', workCenterId: 'W-EXT-1', opId: 'OP-EXT-1', opName: '下料' },
      { id: 'CAP-EXT-2', workCenterId: 'W-EXT-2', opId: 'OP-EXT-2', opName: '装配' },
    ],
    inventory: [
      { id: 'INV-EXT-1', materialId: 'M-EXT-1', qty: 1000, warehouse: '主仓' },
      { id: 'INV-EXT-2', materialId: 'M-EXT-2', qty: 200, warehouse: '主仓' },
    ],
    inbounds: [],
    salesOrders: [{ id: 'SO-EXT-1', code: 'SO-T1', customer: '测试客户', orderDate: asOf, priority: 1, status: 'CONFIRMED', note: '' }],
    salesOrderLines: [
      { id: 'SO-EXT-1-L1', salesOrderId: 'SO-EXT-1', productId: 'P-EXT-1', qty: 40, dueDate: addDays(asOf, 12), status: 'OPEN', priority: 1 },
    ],
    productionOrders: [
      {
        id: 'PO-EXT-1',
        code: 'PO-T1-001',
        salesOrderLineId: 'SO-EXT-1-L1',
        productId: 'P-EXT-1',
        qty: 40,
        status: 'DRAFT',
        priority: 1,
        planStart: start,
        planEnd: end,
        actualStart: '',
        actualEnd: '',
        remark: '示例订单，可在生产排程页执行自动排产',
      },
    ],
    orderLinks: [{ id: 'OL-EXT-1', orderId: 'PO-EXT-1', lineId: 'SO-EXT-1-L1', qty: 40 }],
    planVersions: [
      {
        id: 'PV-EXT-1',
        code: 'PV-EXT-1',
        name: '示例正式计划',
        kind: 'FORMAL',
        status: 'ACTIVE',
        strategy: 'DELIVERY',
        weights: { DELIVERY: 60, MATERIAL: 20, CAPACITY: 20 },
        createdAt: asOf,
        appliedAt: asOf,
        originVersionId: '',
        note: '示例数据集自带',
      },
    ],
    activeVersionId: 'PV-EXT-1',
    tasks: [],
    actuals: [],
    shipments: [],
    exceptions: [],
    freezeLogs: [],
    blockedLog: [],
    importLogs: [],
  };
}
