/**
 * 导入导出（V1.0 §4.9 / 补充项 S-A13 / D-12）
 *
 * 三条导入通道，职责互不重叠：
 * 1. Excel / CSV 批量导入（本文件 importSheetFiles）：按"数据场景"合并进现有库，可累积、不整库替换；
 * 2. 外部数据集 JSON（core/dataset.js）：整库替换，用于测试数据整体载入 / 备份恢复；
 * 3. 内置场景（core/seed.js）：整库重建。
 *
 * 合并语义（这是本模块最重要的约定）：
 * - 主数据（MASTER）：有编码的按编码覆盖更新，保留原 id；无编码的按"自然键"去重（BOM / 能力 / 库存），
 *   重复导入同一份文件不会产生重复行；
 * - 业务单据（DOC）：重复即拒绝，绝不覆盖已有单据（销售订单行 / 生产订单 / 采购到货）；
 * - 只写目标集合：导入销售订单不会碰生产订单，导入生产订单也不会碰销售订单；
 * - 手工录入的数据与导入数据在同一集合里，导入只增改本文件涉及的记录，不删除、不清空其他记录。
 *
 * 表头宽容：支持别名（中英文 / ERP 常见列名）、标题行在第 1 行之上、千分位数字、
 * Excel 日期序列号、GBK 编码、分号 / 制表符分隔。
 */

import { uid } from './core/store.js';
import { readTableFile, trimGrid, parseDelimitedText, decodeBytes } from './core/sheet.js';

/* ═══════════════ 字段与规格 ═══════════════ */

const pad2 = (n) => String(n).padStart(2, '0');

/** 真实日历日校验：格式对但 2026-13-45 不存在，必须拦下 */
function isRealDate(text) {
  const [y, m, d] = text.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 日期归一：Excel 里的日期常是序列号（45292），ERP 导出常写 2026/12/1 或 20261201。
 * 统一成 YYYY-MM-DD；无法识别返回 ''，由调用方报错。
 */
export function normalizeDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isRealDate(s) ? s : '';
  let m = /^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})$/.exec(s);
  if (m) {
    const d = `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
    return isRealDate(d) ? d : '';
  }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) {
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    return isRealDate(d) ? d : '';
  }
  // Excel 日期序列号（1900 日期系统，覆盖 1954~2146）
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n >= 20000 && n <= 90000) {
      const dt = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
      return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
    }
  }
  return '';
}

/** 数字归一：容忍千分位、全角逗号与空格 */
export function normalizeNumber(raw) {
  if (typeof raw === 'number') return raw;
  const s = String(raw ?? '').trim().replace(/[,，\s]/g, '');
  if (!s) return NaN;
  return Number(s);
}

const TRUTHY = /^(y|yes|true|1|是|已确认|确认)$/i;
export const isTruthy = (v) => v === true || TRUTHY.test(String(v ?? '').trim());

const f = (key, label, type = 'text', extra = {}) => ({ key, label, type, required: false, ...extra });

export const IMPORT_SPECS = {
  products: {
    label: '产品',
    scene: '主数据',
    kind: 'MASTER',
    key: 'code',
    rank: 1,
    hint: ['产品', 'product', 'item'],
    fields: [
      f('code', '产品编号', 'text', { required: true, aliases: ['产品编码', '产品代码', '产品号', '料号', 'productCode', 'product_code', 'code', 'Item Code', 'Item'] }),
      f('name', '产品名称', 'text', { required: true, aliases: ['名称', '品名', '描述', 'productName', 'name', 'Description'] }),
      f('unit', '单位', 'text', { required: true, def: '台', aliases: ['计量单位', '单位名称', 'unit', 'UOM'] }),
    ],
    toEntity: (r, db) => ({
      id: (db.products.find((p) => p.code === r.code) || {}).id || uid('P'),
      code: r.code,
      name: r.name,
      unit: r.unit || '台',
    }),
  },

  materials: {
    label: '物料',
    scene: '主数据',
    kind: 'MASTER',
    key: 'code',
    rank: 1,
    hint: ['物料', 'material', 'item'],
    fields: [
      f('code', '物料编号', 'text', { required: true, aliases: ['物料编码', '物料代码', '料号', 'materialCode', 'code', 'Item Code'] }),
      f('name', '物料名称', 'text', { required: true, aliases: ['名称', '品名', 'materialName', 'name'] }),
      f('unit', '单位', 'text', { required: true, aliases: ['计量单位', 'unit', 'UOM'] }),
      f('type', '物料类型', 'enum', {
        required: true,
        enums: ['RAW', 'PURCHASE', 'SEMI'],
        aliases: ['类型', '物料类别', 'type', 'Material Type'],
        valueAliases: { 原材料: 'RAW', 采购件: 'PURCHASE', 采购: 'PURCHASE', 外购件: 'PURCHASE', 半成品: 'SEMI', 自制件: 'SEMI' },
      }),
    ],
    toEntity: (r, db) => ({
      id: (db.materials.find((m) => m.code === r.code) || {}).id || uid('M'),
      code: r.code,
      name: r.name,
      unit: r.unit,
      type: r.type,
    }),
  },

  workCenters: {
    label: '工作中心',
    scene: '主数据',
    kind: 'MASTER',
    key: 'code',
    rank: 1,
    hint: ['工作中心', 'workcenter', 'center'],
    fields: [
      f('code', '编码', 'text', { required: true, aliases: ['工作中心编码', '工作中心代码', 'workCenterCode', 'code'] }),
      f('name', '名称', 'text', { required: true, aliases: ['工作中心名称', 'workCenterName', 'name'] }),
      f('capacityMode', '产能模式', 'enum', {
        required: true,
        enums: ['DAILY_QTY', 'STD_HOURS'],
        aliases: ['产能类型', 'capacityMode'],
        valueAliases: { '固定日产能': 'DAILY_QTY', '件/日': 'DAILY_QTY', '标准工时': 'STD_HOURS', '工时/件': 'STD_HOURS' },
      }),
      f('dailyCapacity', '日产能(件/日)', 'number', { aliases: ['日产能', 'dailyCapacity', 'Capacity'] }),
      f('dailyHours', '日可用工时', 'number', { aliases: ['可用工时', 'dailyHours', 'Hours'] }),
    ],
    toEntity: (r, db) => ({
      id: (db.workCenters.find((w) => w.code === r.code) || {}).id || uid('C'),
      code: r.code,
      name: r.name,
      capacityMode: r.capacityMode,
      dailyCapacity: Number(r.dailyCapacity) || 0,
      dailyHours: Number(r.dailyHours) || 8,
    }),
  },

  bomItems: {
    label: 'BOM 明细',
    scene: '主数据',
    kind: 'MASTER',
    key: null,
    rank: 2,
    hint: ['bom', '物料清单'],
    naturalKey: (r) => `${r.productCode}|${r.level}|${r.childCode}`,
    fields: [
      f('productCode', '产品编号', 'text', { required: true, ref: 'products', aliases: ['产品编码', 'productCode'] }),
      f('level', '层级', 'number', { required: true, enums: [1, 2], aliases: ['BOM层级', '阶次', 'level'] }),
      f('parentCode', '父项编码', 'text', { required: true, aliases: ['父件编码', '父项', 'parentCode'] }),
      f('childCode', '子项编码', 'text', { required: true, ref: 'materials', aliases: ['子件编码', '子项', 'childCode'] }),
      f('childType', '子项类型', 'enum', {
        required: true,
        enums: ['SEMI', 'MATERIAL'],
        aliases: ['childType'],
        valueAliases: { 半成品: 'SEMI', 物料: 'MATERIAL', 原材料: 'MATERIAL' },
      }),
      f('qtyPer', '单位用量', 'number', { required: true, aliases: ['用量', '单位耗用', 'qtyPer', 'Qty Per'] }),
    ],
    toEntity: (r, db) => {
      const product = db.products.find((p) => p.code === r.productCode);
      const child = db.materials.find((m) => m.code === r.childCode);
      if (!product) throw new Error(`产品「${r.productCode}」不存在，请先导入产品主数据`);
      if (!child) throw new Error(`物料「${r.childCode}」不存在，请先导入物料主数据`);
      return {
        id: uid('B'),
        productId: product.id,
        level: Number(r.level),
        parentId: Number(r.level) === 1 ? product.id : (db.materials.find((m) => m.code === r.parentCode) || {}).id,
        parentType: Number(r.level) === 1 ? 'PRODUCT' : 'SEMI',
        childId: child.id,
        childType: r.childType,
        qtyPer: Number(r.qtyPer),
      };
    },
  },

  capabilities: {
    label: '工序与工作中心适配',
    scene: '主数据',
    kind: 'MASTER',
    key: null,
    rank: 2,
    hint: ['工序适配', 'capabilit', '能力'],
    naturalKey: (r) => `${r.wcCode}|${r.opName}`,
    fields: [
      f('wcCode', '工作中心编码', 'text', { required: true, ref: 'workCenters', aliases: ['工作中心', '工作中心代码', 'wcCode', 'workCenterCode'] }),
      f('opName', '工序名称', 'text', { required: true, aliases: ['工序', 'opName', 'Operation'] }),
    ],
    toEntity: (r, db) => {
      const wc = db.workCenters.find((w) => w.code === r.wcCode);
      if (!wc) throw new Error(`工作中心「${r.wcCode}」不存在，请先导入工作中心`);
      return { id: uid('CAP'), workCenterId: wc.id, opName: r.opName, opId: '' };
    },
  },

  inventory: {
    label: '库存',
    scene: '物料',
    kind: 'MASTER',
    key: null,
    rank: 2,
    hint: ['库存', 'inventory', 'stock'],
    naturalKey: (r) => `${r.materialCode}|${r.warehouse || '主仓'}`,
    fields: [
      f('materialCode', '物料编号', 'text', { required: true, ref: 'materials', aliases: ['物料编码', '料号', 'materialCode'] }),
      f('qty', '数量', 'number', { required: true, aliases: ['库存数量', '结存数量', 'qty', 'Quantity'] }),
      f('warehouse', '仓库', 'text', { def: '主仓', aliases: ['仓库名称', '库位', 'warehouse', 'Warehouse'] }),
    ],
    toEntity: (r, db) => {
      const m = db.materials.find((x) => x.code === r.materialCode);
      if (!m) throw new Error(`物料「${r.materialCode}」不存在，请先导入物料主数据`);
      return { id: uid('INV'), materialId: m.id, qty: Number(r.qty), warehouse: r.warehouse || '主仓' };
    },
  },

  inbounds: {
    label: '采购到货',
    scene: '物料',
    kind: 'DOC',
    key: null,
    rank: 2,
    hint: ['到货', 'inbound', '到料'],
    naturalKey: (r) => `${r.materialCode}|${r.expectedDate}|${r.qty}`,
    fields: [
      f('materialCode', '物料编号', 'text', { required: true, ref: 'materials', aliases: ['物料编码', '料号', 'materialCode'] }),
      f('qty', '数量', 'number', { required: true, aliases: ['到货数量', 'qty'] }),
      f('expectedDate', '预计到货日', 'date', { required: true, aliases: ['预计到货日期', '到货日', 'ETA', 'expectedDate'] }),
      f('confirmed', '是否确认', 'bool', { required: true, aliases: ['确认', 'confirmed'] }),
      f('supplier', '供应商', 'text', { aliases: ['供应商名称', 'supplier', 'Vendor'] }),
    ],
    toEntity: (r, db) => {
      const m = db.materials.find((x) => x.code === r.materialCode);
      if (!m) throw new Error(`物料「${r.materialCode}」不存在，请先导入物料主数据`);
      return {
        id: uid('IB'),
        materialId: m.id,
        materialCode: m.code,
        qty: Number(r.qty),
        expectedDate: r.expectedDate,
        confirmed: isTruthy(r.confirmed),
        supplier: r.supplier || '',
        actualArrivalDate: '',
      };
    },
  },

  salesOrderLines: {
    label: '销售订单行',
    scene: '销售',
    kind: 'DOC',
    key: 'lineCode',
    rank: 2,
    hint: ['销售订单', '销售', 'salesorder', 'sales'],
    fields: [
      f('lineCode', '销售订单行号', 'text', { required: true, aliases: ['订单行号', '销售行号', '行号', 'lineCode', 'SO Line', 'SO Line No'] }),
      f('soCode', '销售订单号', 'text', { aliases: ['订单号', '销售订单编号', 'soCode', 'SO No', 'Sales Order'] }),
      f('customer', '客户名称', 'text', { required: true, aliases: ['客户', 'customer', 'Customer'] }),
      f('productCode', '产品编号', 'text', { required: true, ref: 'products', aliases: ['产品编码', 'productCode', 'Item Code'] }),
      f('qty', '数量', 'number', { required: true, aliases: ['订单数量', 'qty', 'Quantity'] }),
      f('dueDate', '客户要求完工日', 'date', { required: true, aliases: ['交期', '客户交期', '要求完工日', 'dueDate', 'Due Date', 'Delivery Date'] }),
      f('priority', '订单优先级', 'number', { aliases: ['优先级', 'priority'] }),
    ],
    toEntity: (r, db) => {
      const p = db.products.find((x) => x.code === r.productCode);
      if (!p) throw new Error(`产品「${r.productCode}」不存在，请先导入产品主数据`);
      const code = r.soCode || String(r.lineCode).split('-')[0] || `SO-${r.lineCode}`;
      const exist = db.salesOrders.find((s) => s.code === code);
      return {
        so: exist
          ? null
          : { id: uid('SO'), code, customer: r.customer, orderDate: r.dueDate, priority: Number(r.priority) || 1, status: 'CONFIRMED', note: '' },
        line: {
          id: r.lineCode,
          salesOrderId: exist ? exist.id : '',
          productId: p.id,
          qty: Number(r.qty),
          dueDate: r.dueDate,
          status: 'OPEN',
          priority: Number(r.priority) || 1,
        },
      };
    },
  },

  productionOrders: {
    label: '生产订单',
    scene: '生产',
    kind: 'DOC',
    key: 'code',
    rank: 3,
    hint: ['生产订单', '工单', 'productionorder', 'workorder', 'mo'],
    fields: [
      f('code', '生产订单号', 'text', { required: true, aliases: ['生产订单', '生产订单编号', '工单号', '订单号', 'code', 'MO', 'Work Order'] }),
      f('lineCode', '销售订单行号', 'text', { ref: 'salesOrderLines', aliases: ['销售行号', '销售订单行', 'lineCode', 'SO Line'] }),
      f('productCode', '产品编号', 'text', { ref: 'products', aliases: ['产品编码', 'productCode', 'Item Code'] }),
      f('qty', '生产数量', 'number', { required: true, aliases: ['数量', '计划数量', 'qty', 'Quantity'] }),
      f('dueDate', '客户要求完工日', 'date', { aliases: ['交期', 'dueDate', 'Due Date'] }),
      f('manualPriority', '人工优先级', 'number', { aliases: ['优先级', 'manualPriority'] }),
    ],
    toEntity: (r, db) => {
      const line = r.lineCode ? db.salesOrderLines.find((l) => l.id === r.lineCode) : null;
      let product = r.productCode ? db.products.find((p) => p.code === r.productCode) : null;
      if (line && !product) product = db.products.find((p) => p.id === line.productId);
      if (!line && !r.productCode) {
        if (r.lineCode) {
          throw new Error(`销售订单行「${r.lineCode}」不存在：请先导入销售订单，或在表中补一列「产品编号」`);
        }
        throw new Error('「销售订单行号」与「产品编号」至少填一个，用于确定生产对象');
      }
      if (!product) throw new Error(`产品「${r.productCode}」不存在，请先导入产品主数据`);
      return {
        id: (db.productionOrders.find((o) => o.code === r.code) || {}).id || uid('PO'),
        code: r.code,
        salesOrderLineId: line ? line.id : '',
        productId: product.id,
        qty: Number(r.qty),
        planStart: '',
        planEnd: '',
        forecastEnd: '',
        actualStart: '',
        actualEnd: '',
        status: 'DRAFT',
        manualPriority: Number(r.manualPriority) || 3,
        versionId: '',
        reservations: [],
        remark: '',
        // 由 applyImport 决定是否补建占位销售行，避免"单独导入生产订单"直接失败
        _needsLine: !line,
        _dueDate: r.dueDate || '',
      };
    },
  },
};

/**
 * 列别名补充表
 *
 * 为什么单独列一张表：真实文件里同一列有太多叫法（ERP 导出、手工台账、英文模板各一套），
 * 逐个塞进字段定义会把规格读成一团。这里集中维护，且只做"并集"，不改原有别名。
 * 匹配前会先做归一化（去括号、去单位、去空格、全角转半角），所以这里不必写"数量（件）"。
 */
const EXTRA_ALIASES = {
  'products.code': ['产品号', '品号', '产品id', 'itemno', 'sku'],
  'products.name': ['产品', '产品名', '品名规格', 'productname', 'description'],
  'products.unit': ['基本单位', '库存单位', 'uom', 'baseunit'],

  'materials.code': ['物料号', '物料id', '料品编码', 'materialno', 'itemno'],
  'materials.name': ['物料名', '料品名称', 'materialname'],
  'materials.unit': ['基本单位', 'uom'],
  'materials.type': ['物料属性', 'materialtype', 'category'],

  'workCenters.code': ['中心编码', '工作中心', 'wc', 'workcenter'],
  'workCenters.name': ['中心名称', '工作中心名', 'workcentername'],
  'workCenters.capacityMode': ['产能模式', '模式', 'capacitymode'],
  'workCenters.dailyCapacity': ['产能', '日产量', 'capacity'],
  'workCenters.dailyHours': ['工时', '可用小时', 'hours'],

  'bomItems.productCode': ['产品', '成品编号', 'productcode'],
  'bomItems.level': ['层级', 'bom层级', '阶次', '层', 'level'],
  'bomItems.parentCode': ['父件', '父级编码', 'parent', 'parentcode'],
  'bomItems.childCode': ['子件', '子项编码', '组件编码', 'child', 'childcode'],
  'bomItems.qtyPer': ['用量', '单耗', '单位用量', 'qtyper', 'qty'],

  'capabilities.wcCode': ['工作中心', '中心编码', 'wccode'],
  'capabilities.opName': ['工序', '工序名', 'operation', 'opname'],

  'inventory.materialCode': ['物料', '物料号', '料号', 'materialcode'],
  'inventory.qty': ['库存', '库存量', '现有量', '结存', 'onhand', 'stock', 'quantity'],
  'inventory.warehouse': ['仓库', '库位', '仓别', 'location', 'warehouse'],

  'inbounds.materialCode': ['物料', '物料号', '料号', 'materialcode'],
  'inbounds.qty': ['到货量', '数量', 'qty', 'quantity'],
  'inbounds.expectedDate': ['预计到货', '到货日期', '预到日期', 'eta', 'expecteddate'],
  'inbounds.confirmed': ['确认状态', '是否已确认', 'confirmed'],
  'inbounds.supplier': ['供应商', '供货商', 'supplier', 'vendor'],

  'salesOrderLines.lineCode': ['行号', '订单行', '销售订单行', 'line', 'soline', 'lineno'],
  'salesOrderLines.soCode': ['订单号', '订单编号', '销售单号', 'sono', 'salesorder', 'orderno'],
  'salesOrderLines.customer': ['客户', '客户全称', '顾客', 'customer', 'client'],
  'salesOrderLines.productCode': ['产品', '产品号', '料号', 'productcode', 'itemcode'],
  'salesOrderLines.qty': ['订单量', '订货数量', 'qty', 'quantity'],
  'salesOrderLines.dueDate': ['交期', '客户交期', '要求交期', '完工日', 'duedate', 'deliverydate'],
  'salesOrderLines.priority': ['优先级', 'priority'],

  'productionOrders.code': ['工单', '工单编号', '生产单号', '制令单号', 'mo', 'workorder', 'orderno'],
  'productionOrders.lineCode': ['销售行号', '源单行号', 'soline', 'linecode'],
  'productionOrders.productCode': ['产品', '产品号', '料号', 'productcode', 'itemcode'],
  'productionOrders.qty': ['生产量', '计划量', 'qty', 'quantity'],
  'productionOrders.dueDate': ['交期', '完工日', '计划完工', 'duedate'],
  'productionOrders.manualPriority': ['优先级', 'priority'],
};

/** 文件名 / 工作表名里的场景关键词（名称命中才加分，避免只靠内容猜） */
const EXTRA_HINTS = {
  products: ['产品主数据', '产品清单', '成品'],
  materials: ['物料主数据', '物料清单', '料件'],
  workCenters: ['工作中心', '产能'],
  bomItems: ['bom', '用料', '配方'],
  capabilities: ['工序', '适配'],
  inventory: ['现存量', '库存表', '结存'],
  inbounds: ['到货记录', '到货明细', '收料', '入库'],
  salesOrderLines: ['销售订单行', '订单明细', '销售明细', '订单行'],
  productionOrders: ['生产订单', '生产工单', '工单明细'],
};

for (const [path, list] of Object.entries(EXTRA_ALIASES)) {
  const [specKey, fieldKey] = path.split('.');
  const spec = IMPORT_SPECS[specKey];
  const field = spec && spec.fields.find((x) => x.key === fieldKey);
  if (field) field.aliases = [...new Set([...(field.aliases || []), ...list])];
}
for (const [specKey, list] of Object.entries(EXTRA_HINTS)) {
  if (IMPORT_SPECS[specKey]) IMPORT_SPECS[specKey].hint = [...new Set([...(IMPORT_SPECS[specKey].hint || []), ...list])];
}

/** 依赖顺序：主数据必须先落地，否则单据的关联关系无处可挂 */
export const SPEC_ORDER = Object.keys(IMPORT_SPECS).sort(
  (a, b) => IMPORT_SPECS[a].rank - IMPORT_SPECS[b].rank || IMPORT_SPECS[a].label.localeCompare(IMPORT_SPECS[b].label)
);

/* ═══════════════ 模板 ═══════════════ */

export function templateCsv(specKey) {
  const spec = IMPORT_SPECS[specKey];
  const headers = spec.fields.map((x) => x.label).join(',');
  const sample = spec.fields.map((x) => {
    if (x.enums) return x.enums[0];
    if (x.type === 'date') return '2026-12-31';
    if (x.type === 'number') return '1';
    if (x.type === 'bool') return '是';
    return `示例${x.label}`;
  });
  return `${headers}\n${sample.join(',')}\n`;
}

/* ═══════════════ 解析（CSV 兼容入口） ═══════════════ */

export function parseCsv(text) {
  const p = parseDelimitedText(text);
  return { headers: p.headers, rows: p.rows, grid: p.grid, delimiter: p.delimiter };
}

/** 兼容入口：整本 xlsx 的第一张工作表 → {headers, rows} */
export async function parseXlsx(buffer) {
  const { sheets } = await readTableFile({ name: 'import.xlsx', buffer });
  const grid = trimGrid(sheets[0].grid);
  if (!grid.length) return { headers: [], rows: [] };
  const headers = (grid[0] || []).map((h) => String(h || '').trim());
  const rows = grid.slice(1).map((cells) => {
    const o = {};
    headers.forEach((h, i) => {
      o[h] = cells[i] === undefined ? '' : String(cells[i]);
    });
    return o;
  });
  return { headers, rows };
}

/* ═══════════════ 表头识别 ═══════════════ */

/**
 * 表头归一化：真实表头常带单位、必填标记、全角括号和空格
 * （"数量（件）"、"产品编号(必填)"、" SO Line No. "），不归一化就会"看起来一样却匹配不上"。
 */
const normHeader = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    // 去掉任意位置的括号说明：单位、必填、备注都不参与匹配
    .replace(/[（(\[【][^）)\]】]*[）)\]】]/g, '')
    .replace(/[\s\u3000]/g, '')
    // 标点与连接符不参与匹配（SO-Line / SO Line / SO_Line 等价）
    .replace(/[：:、,，.。;；/\\_\-—–*#№"'“”‘’]/g, '')
    .replace(/(必填|必录|选填|可选|可空|required|optional)$/i, '')
    .toLowerCase();

function headerLookup(spec) {
  const map = new Map();
  for (const field of spec.fields) {
    map.set(normHeader(field.label), field);
    for (const a of field.aliases || []) map.set(normHeader(a), field);
  }
  return map;
}

/**
 * 在前若干行里找表头：真实报表常有"XX 数据（2026 版）"这类标题行，
 * 直接拿第一行当表头会把整表读成 0 行。
 *
 * 打分：命中列数 ×2 + 命中必填列 ×4 + 文本密度（防止把数据行当表头）。
 * 质量门槛：至少命中 2 列；只命中 1 列时视为"没找到表头"，而不是"随便捡一行"。
 */
export function locateHeader(spec, grid) {
  const lookup = headerLookup(spec);
  let best = null;
  const limit = Math.min(grid.length, 20);
  for (let r = 0; r < limit; r += 1) {
    const row = grid[r] || [];
    const used = new Set();
    const cols = new Map();
    const aliasHits = [];
    let textCells = 0;
    row.forEach((h, c) => {
      if (String(h ?? '').trim() !== '') textCells += 1;
      const field = lookup.get(normHeader(h));
      if (!field || used.has(field.key)) return;
      used.add(field.key);
      cols.set(field.key, c);
      if (normHeader(h) !== normHeader(field.label)) aliasHits.push(`${h}→${field.label}`);
    });
    const matched = used.size;
    const reqMatched = spec.fields.filter((x) => x.required && used.has(x.key)).length;
    const score = matched * 2 + reqMatched * 4 + Math.min(textCells, 10) * 0.2;
    if (!best || score > best.score) best = { row: r, score, matched, reqMatched, cols, aliasHits, textCells };
  }
  if (!best) return null;
  // 至少两列命中才算表头：只命中 1 列（哪怕它恰好是必填列）时，多半是把数据行里的
  // 某个词当成了列名，继续往下校验只会报"表头缺少必填列"，掩盖真正原因。
  return best.matched >= 2 ? best : null;
}

/**
 * 只裁列、保留行位置。
 *
 * 表头定位与错误行号都依赖"第几行"，如果用 trimGrid 去掉空行，
 * 回给用户的"表头在第 3 行"就会变成第 2 行，报错行号也会和 Excel 左侧对不上。
 */
function gridKeepRows(grid) {
  const rows = (grid || []).filter((r) => Array.isArray(r));
  if (!rows.length) return [];
  let min = Infinity;
  let max = -1;
  for (const r of rows) {
    for (let i = 0; i < r.length; i += 1) {
      if (String(r[i] ?? '').trim() !== '') {
        if (i < min) min = i;
        if (i > max) max = i;
      }
    }
  }
  if (max < 0) return rows.map(() => []);
  return rows.map((r) => {
    const out = [];
    for (let i = min; i <= max; i += 1) out.push(String(r[i] ?? '').trim());
    return out;
  });
}

/** 网格 + 规格 → 规范化的行（键为字段 label，附原始行号 __row） */
export function normalizeSheet(specKey, sheet) {
  const spec = IMPORT_SPECS[specKey];
  const grid = gridKeepRows(sheet.grid || sheet);
  if (!grid.some((r) => r.some((c) => c !== ''))) {
    return { found: false, empty: true, headers: [], rows: [], headerRow: 0, missing: [], extra: [], aliasHits: [] };
  }
  const head = locateHeader(spec, grid);
  if (!head) {
    return { found: false, empty: false, headers: (grid[0] || []).map(String), rows: [], headerRow: 0, missing: [], extra: [], aliasHits: [] };
  }
  const mapped = new Set(head.cols.keys());
  const missing = spec.fields.filter((x) => x.required && !mapped.has(x.key)).map((x) => x.label);
  const knownCols = new Set(head.cols.values());
  const extra = (grid[head.row] || [])
    .map((h, i) => ({ h: String(h ?? '').trim(), i }))
    .filter((x) => x.h && !knownCols.has(x.i))
    .map((x) => x.h);

  const rows = [];
  for (let i = head.row + 1; i < grid.length; i += 1) {
    const cells = grid[i] || [];
    const rec = {};
    let any = false;
    for (const field of spec.fields) {
      const c = head.cols.get(field.key);
      const val = c === undefined ? '' : String(cells[c] ?? '').trim();
      rec[field.label] = val;
      if (val) any = true;
    }
    if (!any) continue;
    rec.__row = i + 1; // 1 基行号，与 Excel 左侧行号一致
    rows.push(rec);
  }
  return {
    found: true,
    headers: spec.fields.filter((x) => mapped.has(x.key)).map((x) => x.label),
    rows,
    headerRow: head.row + 1,
    missing,
    extra,
    aliasHits: head.aliasHits,
  };
}

/** 旧形状 {headers, rows:[{表头:值}]} → 网格，让校验逻辑只有一条路径 */
function legacyToGrid(parsed) {
  const headers = Array.isArray(parsed.headers) && parsed.headers.length
    ? parsed.headers
    : Object.keys((parsed.rows && parsed.rows[0]) || {});
  const rows = (parsed.rows || []).map((r) => headers.map((h) => (r && r[h] !== undefined ? r[h] : '')));
  return { grid: [headers, ...rows] };
}

/* ═══════════════ 校验 ═══════════════ */

const enumText = (field) => field.enums.map(String).join(' / ');

function readField(field, raw, line, errors, warnings) {
  const text = String(raw ?? '').trim();
  if (!text) {
    if (field.required) {
      errors.push({ line, field: field.label, message: '必填项为空' });
      return undefined;
    }
    // 选填列留空是常态（如"人工优先级"），不能因为类型是数字就当成错误
    return '';
  }
  if (field.type === 'number') {
    const n = normalizeNumber(text);
    if (!Number.isFinite(n)) {
      errors.push({ line, field: field.label, message: `不是有效数字：${text}` });
      return undefined;
    }
    if (field.enums && !field.enums.map(String).includes(String(n))) {
      errors.push({ line, field: field.label, message: `取值必须是 ${enumText(field)}：${text}` });
      return undefined;
    }
    return n;
  }
  if (field.type === 'date') {
    const d = normalizeDate(text);
    if (!d) {
      errors.push({ line, field: field.label, message: `日期无法识别（支持 2026-12-01 / 2026/12/1 / Excel 日期单元格）：${text}` });
      return '';
    }
    return d;
  }
  if (field.type === 'enum') {
    const up = text.toUpperCase();
    const canon = field.enums.map(String).find((e) => e.toUpperCase() === up);
    const alias = (field.valueAliases || {})[text] || (field.valueAliases || {})[up];
    const value = canon || alias;
    if (!value) {
      errors.push({ line, field: field.label, message: `取值必须是 ${enumText(field)}：${text}` });
      return '';
    }
    if (!canon && alias) warnings.push(`第 ${line} 行「${field.label}」的值「${text}」已按 ${alias} 处理`);
    return value;
  }
  if (field.type === 'bool') return isTruthy(text);
  return text;
}

/**
 * 校验一张表
 * @returns {{errors, warnings, entities, headers, meta}}
 */
export function validateImport(specKey, parsed, db, options = {}) {
  const spec = IMPORT_SPECS[specKey];
  if (!spec) throw new Error(`未知的导入场景：${specKey}`);
  const errors = [];
  const warnings = [];
  const entities = [];
  const norm = parsed && parsed.grid ? normalizeSheet(specKey, parsed) : normalizeSheet(specKey, legacyToGrid(parsed || {}));

  if (!norm.found) {
    const grid = parsed && parsed.grid ? parsed.grid : legacyToGrid(parsed || {}).grid;
    const seen = (norm.headers || []).map((h) => String(h ?? '').trim()).filter(Boolean).slice(0, 8);
    if (norm.empty) {
      errors.push({
        line: 1,
        field: '文件',
        message: '解析到 0 行数据：文件可能为空、数据在图片/图表里，或不是标准表格。请在 Excel 中另存为 .xlsx 或 CSV 后重试',
      });
    } else {
      // 给出"更像哪类数据"，用户改选场景能少走一轮
      const guess = detectSpec('', { grid });
      const tip = guess ? `；这些列看起来更像「${IMPORT_SPECS[guess.key].label}」，可改选该场景` : '';
      const sample = seen.length ? `（当前读到：${seen.join(' | ')}）` : '';
      errors.push({
        line: 1,
        field: '表头',
        message: `前 20 行没有找到表头${sample}。至少需要一列已知列，例如「${spec.fields[0].label}」或「${
          (spec.fields[1] || {}).label || spec.label
        }」${tip}`,
      });
    }
    return { errors, warnings, entities, headers: norm.headers, meta: norm };
  }
  if (norm.missing.length) {
    for (const label of norm.missing) {
      errors.push({ line: norm.headerRow, field: label, message: `表头缺少必填列「${label}」` });
    }
    // 缺必填列时不再逐行校验：否则每一行都会重复报同一件事，反而看不到真正原因
    return { errors, warnings, entities, headers: norm.headers, meta: norm };
  }
  if (norm.extra.length) warnings.push(`已忽略未识别的列：${norm.extra.join('、')}`);
  if (norm.aliasHits.length) warnings.push(`按别名识别列：${norm.aliasHits.join('；')}`);

  const seen = new Map();
  for (const rec of norm.rows) {
    const line = rec.__row;
    let bad = false;
    const clean = {};
    for (const field of spec.fields) {
      const v = readField(field, rec[field.label], line, errors, warnings);
      if (v === undefined) bad = true;
      else clean[field.key] = v;
    }
    if (bad) continue;

    const dedupeKey = spec.key ? String(clean[spec.key] || '') : spec.naturalKey ? spec.naturalKey(clean) : '';
    if (dedupeKey) {
      if (seen.has(dedupeKey)) {
        const fieldLabel = spec.key ? spec.fields.find((x) => x.key === spec.key).label : '组合键';
        errors.push({ line, field: fieldLabel, message: `文件内重复（与第 ${seen.get(dedupeKey)} 行相同）：${dedupeKey}` });
        continue;
      }
      seen.set(dedupeKey, line);
    }

    try {
      const entity = spec.toEntity(clean, db);
      entities.push({ line, entity, rec: clean });
    } catch (e) {
      errors.push({ line, field: '关联关系', message: e.message });
    }
  }

  // 单据重复：校验阶段就提示，用户能立刻看到"为什么只导入了 3 条"
  if (spec.kind === 'DOC') {
    for (const { line, entity, rec } of entities) {
      const key = spec.key ? entity[spec.key] : null;
      let dup = false;
      if (key && db[collectionOf(specKey)].some((x) => x[spec.key] === key)) dup = true;
      if (!dup && spec.naturalKey) {
        const nk = spec.naturalKey(rec);
        dup = db[collectionOf(specKey)].some((x) => naturalKeyOfDoc(specKey, x, db) === nk);
      }
      if (dup) warnings.push(`第 ${line} 行：${key || '该记录'} 已存在，导入时将跳过（单据不覆盖）`);
    }
  }

  return { errors, warnings, entities, headers: norm.headers, meta: norm };
}

/* ═══════════════ 落库 ═══════════════ */

const COLLECTION_MAP = {
  products: 'products',
  materials: 'materials',
  bomItems: 'bomItems',
  workCenters: 'workCenters',
  capabilities: 'capabilities',
  inventory: 'inventory',
  inbounds: 'inbounds',
  salesOrderLines: 'salesOrderLines',
  productionOrders: 'productionOrders',
};

const collectionOf = (specKey) => COLLECTION_MAP[specKey];

/** 单据的自然键（用于判断"是否已存在"，不依赖编码） */
function naturalKeyOfDoc(specKey, row, db) {
  if (specKey === 'inbounds') {
    const m = db.materials.find((x) => x.id === row.materialId);
    return `${(m || {}).code || row.materialCode || ''}|${row.expectedDate || ''}|${row.qty}`;
  }
  return '';
}

/** 主数据的自然键（无编码类：BOM / 能力 / 库存），用于"重复导入不产生重复行" */
function naturalKeyOfMaster(specKey, row, db) {
  if (specKey === 'bomItems') {
    const product = db.products.find((p) => p.id === row.productId);
    const child = db.materials.find((m) => m.id === row.childId);
    return `${(product || {}).code || ''}|${row.level}|${(child || {}).code || ''}`;
  }
  if (specKey === 'capabilities') {
    const wc = db.workCenters.find((w) => w.id === row.workCenterId);
    return `${(wc || {}).code || ''}|${row.opName}`;
  }
  if (specKey === 'inventory') {
    const m = db.materials.find((x) => x.id === row.materialId);
    return `${(m || {}).code || ''}|${row.warehouse || '主仓'}`;
  }
  return '';
}

/**
 * 应用一批已校验的实体
 * @returns {{created, updated, skipped, rejected, autoLines, createdIds}}
 */
export function applyImport(specKey, entities, db, options = {}) {
  const spec = IMPORT_SPECS[specKey];
  const coll = collectionOf(specKey);
  const out = { created: 0, updated: 0, skipped: 0, rejected: [], autoLines: 0, linked: 0, createdIds: [] };
  const stamp = options.batch ? { batch: options.batch, file: options.file || '', at: options.at || '' } : null;
  const mark = (entity) => {
    if (stamp) entity.imp = { ...stamp };
  };

  /* 销售订单行：连带维护销售订单头，且不覆盖已有订单头 */
  if (specKey === 'salesOrderLines') {
    for (const { line, entity } of entities) {
      if (db.salesOrderLines.some((l) => l.id === entity.line.id)) {
        out.rejected.push({ line, id: entity.line.id, reason: '销售订单行已存在（单据不覆盖）' });
        continue;
      }
      let so = entity.so ? db.salesOrders.find((s) => s.code === entity.so.code) : null;
      if (!so && entity.so) {
        mark(entity.so);
        db.salesOrders.push(entity.so);
        so = entity.so;
      }
      if (!so) {
        out.rejected.push({ line, id: entity.line.id, reason: '找不到对应的销售订单头' });
        continue;
      }
      entity.line.salesOrderId = so.id;
      mark(entity.line);
      db.salesOrderLines.push(entity.line);
      out.created += 1;
    }
    return out;
  }

  for (const { line, entity, rec } of entities) {
    if (spec.kind === 'MASTER') {
      let exist = null;
      if (spec.key && entity[spec.key]) exist = db[coll].find((x) => x[spec.key] === entity[spec.key]);
      if (!exist && spec.naturalKey && rec) {
        const nk = spec.naturalKey(rec);
        exist = db[coll].find((x) => naturalKeyOfMaster(specKey, x, db) === nk);
      }
      if (exist) {
        Object.assign(exist, entity, { id: exist.id });
        mark(exist);
        out.updated += 1;
      } else {
        mark(entity);
        db[coll].push(entity);
        out.created += 1;
        out.createdIds.push(entity.id);
      }
      continue;
    }

    /* DOC：重复即拒绝 */
    const key = spec.key ? entity[spec.key] : null;
    if (key && db[coll].some((x) => x[spec.key] === key)) {
      out.rejected.push({ line, id: key, reason: '单据已存在（重复即拒绝，不覆盖原记录）' });
      continue;
    }
    if (!key && spec.naturalKey && rec) {
      const nk = spec.naturalKey(rec);
      if (db[coll].some((x) => naturalKeyOfDoc(specKey, x, db) === nk)) {
        out.rejected.push({ line, id: nk, reason: '同一到货记录已存在（重复即拒绝）' });
        continue;
      }
    }

    /* 生产订单：没有销售行时补建占位行，让"单独导入生产订单"可用 */
    if (specKey === 'productionOrders' && entity._needsLine) {
      const soCode = `SO-AUTO-${entity.code}`.slice(0, 60);
      let so = db.salesOrders.find((s) => s.code === soCode);
      if (!so) {
        so = { id: uid('SO'), code: soCode, customer: '（导入自动建立）', orderDate: entity._dueDate || '', priority: 1, status: 'CONFIRMED', note: '导入生产订单时为缺失的销售行自动建立' };
        mark(so);
        db.salesOrders.push(so);
      }
      const lineId = `${soCode}-L1`;
      let salesLine = db.salesOrderLines.find((l) => l.id === lineId);
      if (!salesLine) {
        salesLine = {
          id: lineId,
          salesOrderId: so.id,
          productId: entity.productId,
          qty: entity.qty,
          dueDate: entity._dueDate || '',
          status: 'OPEN',
          priority: 1,
          auto: true,
        };
        mark(salesLine);
        db.salesOrderLines.push(salesLine);
      }
      entity.salesOrderLineId = salesLine.id;
      out.autoLines += 1;
    }
    delete entity._needsLine;
    delete entity._dueDate;
    mark(entity);
    db[coll].push(entity);
    out.created += 1;
    out.createdIds.push(entity.id);

    /**
     * 生产订单与销售行有两处关联：订单上的 salesOrderLineId（交期回查用）与
     * orderLinks 关联表（销售订单页展示"该行已建立哪些生产订单"用）。
     * 旧版本导入只写了前者，导致销售订单页明明有生产订单却仍显示「建立生产订单」按钮。
     */
    if (specKey === 'productionOrders' && entity.salesOrderLineId) {
      db.orderLinks = db.orderLinks || [];
      let link = db.orderLinks.find((l) => l.orderId === entity.id);
      if (!link) {
        link = { id: uid('LK'), orderId: entity.id, lineId: entity.salesOrderLineId, qty: Number(entity.qty) || 0 };
        mark(link);
        db.orderLinks.push(link);
      } else {
        link.lineId = entity.salesOrderLineId;
        link.qty = Number(entity.qty) || 0;
      }
      out.linked += 1;
    }
  }
  return out;
}

/* ═══════════════ 场景识别 ═══════════════ */

/**
 * 按工作表名 / 文件名 / 表头内容综合判断这份文件属于哪个导入场景。
 *
 * 打分：命中列 ×2、命中必填列 ×4、必填覆盖率 ×6，文件名/表名命中场景关键词 +10。
 * 两个场景分差 ≤3 视为"歧义"，此时不自动选中，由界面给出候选让用户确认 —— 猜错场景
 * 比让用户点一下更糟：会按错误规格校验，报一堆莫名其妙的字段错误。
 */
export function detectSpec(fileName, sheet) {
  const text = `${String(fileName || '')} ${String((sheet && sheet.name) || '')}`.toLowerCase();
  const grid = trimGrid((sheet && sheet.grid) || []);
  if (!grid.length) return null;
  const scored = [];
  for (const key of SPEC_ORDER) {
    const spec = IMPORT_SPECS[key];
    const head = locateHeader(spec, grid);
    if (!head) continue;
    const reqTotal = spec.fields.filter((x) => x.required).length || 1;
    const reqRatio = head.reqMatched / reqTotal;
    let score = head.matched * 2 + head.reqMatched * 4 + reqRatio * 6;
    const hintHit = (spec.hint || []).find((h) => text.includes(String(h).toLowerCase()));
    if (hintHit) score += 10;
    scored.push({
      key,
      score,
      headerRow: head.row + 1,
      matched: head.matched,
      reqMatched: head.reqMatched,
      reqRatio,
      hint: hintHit || '',
    });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  // 信息量门槛：只碰到 1 列（哪怕是必填列）不足以定场景。
  // 例：表头只有"编号 | 名称 | 备注"时，"名称"会命中产品/物料/工作中心三家的必填列，
  // 这时硬猜某个场景，用户会在校验阶段看到一堆莫名其妙的"表头缺少必填列"。
  const strong = !!top.hint || top.matched >= 3 || (top.matched >= 2 && top.reqMatched >= 1);
  if (!strong) return null;
  const second = scored[1];
  // 歧义判定不能只看总分：英文通用列名（Item Code / Name / Unit）会同时命中"产品"和"物料"，
  // 但两者必填覆盖率通常差得开（物料还多一个"类型"），这种情况应直接采用覆盖率高的那个。
  const closeScore = !!second && top.score - second.score <= 3;
  const sameShape = !!second && top.matched === second.matched && Math.abs(top.reqRatio - second.reqRatio) < 0.15;
  return {
    ...top,
    ambiguous: closeScore && sameShape,
    candidates: scored.slice(0, 3).map((s) => ({
      key: s.key,
      label: IMPORT_SPECS[s.key].label,
      score: Math.round(s.score),
      hint: s.hint,
    })),
  };
}

/** 给界面用的"我到底读到了什么"摘要：行数、列数、前几行原样文本 */
export function sheetSummary(sheet) {
  const grid = trimGrid((sheet && sheet.grid) || []);
  const headerCandidate = grid.find((r) => r.some((c) => String(c ?? '').trim() !== '')) || [];
  return {
    rows: grid.length,
    cols: headerCandidate.length,
    sample: grid.slice(0, 3).map((r) => r.map((c) => String(c ?? '')).slice(0, 8)),
  };
}

/* ═══════════════ 多文件批量导入 ═══════════════ */

const cloneDb = (db) =>
  typeof structuredClone === 'function' ? structuredClone(db) : JSON.parse(JSON.stringify(db));

const newBatchId = (now = new Date()) =>
  `IMP-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;

/**
 * 一次导入多份数据
 *
 * 编排规则：
 * - 先全部解析，再按依赖顺序（产品/物料/工作中心 → BOM/库存/销售行 → 生产订单）逐份校验；
 * - 每份文件独立成败：某份出错只跳过该份，其余照常导入（结果里逐份给出原因）；
 * - 校验在"已叠加前面文件结果"的副本上做，因此同批次里"产品 + 生产订单"可以一起导入；
 * - 全部成功后才由调用方写库，避免出现"一半新一半旧"。
 *
 * @param {Array<{name:string, buffer?:ArrayBuffer, text?:string, specKey?:string, sheetName?:string}>} files
 * @param {object} db 当前库（不会被修改）
 * @param {{batchId?:string, specByFile?:object, at?:string}} [options]
 */
export async function importSheetFiles(files, db, options = {}) {
  const batchId = options.batchId || newBatchId();
  const draft = cloneDb(db);
  const results = [];
  const parsedFiles = [];
  const orderOf = new Map((files || []).map((file, i) => [file.name, i]));

  for (const file of files || []) {
    try {
      const read = await readTableFile(file);
      const sheet = pickSheet(read.sheets, file.sheetName);
      const assigned = file.specKey || (options.specByFile || {})[file.name];
      const detected = assigned ? { key: assigned, score: 999, ambiguous: false, candidates: [] } : detectSpec(file.name, sheet);
      parsedFiles.push({
        file,
        format: read.format,
        sheetName: sheet ? sheet.name : '',
        sheetCount: read.sheets.length,
        // 歧义时宁可不猜：按错误规格校验会报一堆看不懂的字段错误，不如让用户点一下
        specKey: detected && !detected.ambiguous ? detected.key : '',
        suggestion: detected ? detected.candidates || [] : [],
        notes: read.notes || [],
        rowCount: sheet ? trimGrid(sheet.grid).length : 0,
        sheet,
      });
    } catch (e) {
      results.push({
        file: file.name,
        order: orderOf.get(file.name) ?? 99,
        status: 'error',
        format: '',
        specKey: '',
        specLabel: '',
        sheetName: '',
        rows: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        autoLines: 0,
        rejected: [],
        errors: [{ line: 0, field: '文件', message: e.message }],
        warnings: [],
      });
    }
  }

  parsedFiles.sort((a, b) => {
    const ra = a.specKey ? IMPORT_SPECS[a.specKey].rank : 99;
    const rb = b.specKey ? IMPORT_SPECS[b.specKey].rank : 99;
    return ra - rb;
  });

  for (const pf of parsedFiles) {
    const base = {
      file: pf.file.name,
      order: orderOf.get(pf.file.name) ?? 99,
      format: pf.format,
      sheetName: pf.sheetName,
      rows: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      autoLines: 0,
      rejected: [],
      errors: [],
      warnings: [],
    };
    if (!pf.specKey) {
      const cand = (pf.suggestion || []).map((c) => c.label).filter(Boolean);
      results.push({
        ...base,
        status: 'error',
        specKey: '',
        specLabel: '',
        errors: [
          {
            line: 0,
            field: '场景',
            message: cand.length
              ? `无法确定这份文件属于哪类数据（候选：${cand.join(' / ')}），请在上表手动选择场景`
              : '无法自动识别这份文件属于哪类数据，请手动选择场景后重试（可先看解析到的前几行是否正常）',
          },
        ],
        warnings: pf.notes || [],
      });
      continue;
    }
    const spec = IMPORT_SPECS[pf.specKey];
    const v = validateImport(pf.specKey, { grid: pf.sheet.grid }, draft);
    base.rows = (v.meta.rows || []).length;
    base.warnings = v.warnings;
    if (v.errors.length) {
      results.push({ ...base, status: 'error', specKey: pf.specKey, specLabel: spec.label, errors: v.errors });
      continue;
    }
    const applied = applyImport(pf.specKey, v.entities, draft, {
      batch: batchId,
      file: pf.file.name,
      at: options.at || new Date().toISOString(),
    });
    results.push({
      ...base,
      status: v.entities.length ? 'ok' : 'empty',
      specKey: pf.specKey,
      specLabel: spec.label,
      created: applied.created,
      updated: applied.updated,
      skipped: applied.rejected.length,
      autoLines: applied.autoLines,
      rejected: applied.rejected,
      warnings: [
        ...base.warnings,
        ...(applied.autoLines ? [`有 ${applied.autoLines} 张生产订单缺销售行，已自动建立占位销售行`] : []),
      ],
    });
  }

  // 处理顺序按依赖，展示顺序仍按用户选择文件的顺序
  results.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

  const totals = results.reduce(
    (t, r) => ({
      files: t.files + 1,
      created: t.created + r.created,
      updated: t.updated + r.updated,
      rejected: t.rejected + r.rejected.length,
      failed: t.failed + (r.status === 'error' ? 1 : 0),
    }),
    { files: 0, created: 0, updated: 0, rejected: 0, failed: 0 }
  );

  const ok = results.some((r) => r.status === 'ok');
  if (ok) {
    draft.importLogs = Array.isArray(draft.importLogs) ? draft.importLogs : [];
    draft.importLogs.push({
      at: options.at || new Date().toISOString(),
      batch: batchId,
      created: totals.created,
      updated: totals.updated,
      rejected: totals.rejected,
      files: results.map((r) => ({
        file: r.file,
        spec: r.specKey,
        created: r.created,
        updated: r.updated,
        rejected: r.rejected.length,
        errors: r.errors.length,
      })),
    });
    if (draft.importLogs.length > 50) draft.importLogs = draft.importLogs.slice(-50);
  }

  return { ok, batchId, db: ok ? draft : null, results, totals };
}

function pickSheet(sheets, sheetName) {
  const list = sheets || [];
  if (!list.length) return null;
  if (sheetName) {
    const hit = list.find((s) => s.name === sheetName);
    if (hit) return hit;
  }
  // 跳过"说明 / 封面"这类没有数据的表
  const withData = list.find((s) => trimGrid(s.grid).length > 1);
  return withData || list[0];
}

/* ═══════════════ 导出 ═══════════════ */

/** 导出任意实体集合为 CSV（列由 columns 指定） */
export function exportCsv(rows, columns) {
  const head = columns.map((c) => c.label).join(',');
  const body = rows
    .map((r) =>
      columns
        .map((c) => {
          const v = c.get ? c.get(r) : r[c.key];
          const s = v === null || v === undefined ? '' : String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(',')
    )
    .join('\n');
  return `${head}\n${body}`;
}

/** 一键下载全部场景的空白模板（返回 [{name, content}]，由界面逐个触发下载） */
export function allTemplates() {
  return SPEC_ORDER.map((key) => ({ key, name: `${IMPORT_SPECS[key].label}_导入模板.csv`, content: templateCsv(key) }));
}

export { decodeBytes };
