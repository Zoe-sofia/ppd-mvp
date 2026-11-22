/**
 * 导入导出（V1.0 §4.9 / 补充项 S-A13 / D-12）
 *
 * 主数据（MASTER）：按编码覆盖更新
 * 业务单据（DOC）：重复即拒绝，要求人工确认
 * 校验：必填、编码唯一、关联存在、类型正确、重复识别；错误行给出行号与原因
 * 格式：CSV（UTF-8，Excel 可直接打开）与 XLSX（读取 sheet1，浏览器原生解压，无第三方库）
 */

import { uid } from './core/store.js';

/* ───────────── 导入规格 ───────────── */

export const IMPORT_SPECS = {
  products: {
    label: '产品',
    kind: 'MASTER',
    key: 'code',
    fields: [
      { key: 'code', label: '产品编号', type: 'text', required: true },
      { key: 'name', label: '产品名称', type: 'text', required: true },
      { key: 'unit', label: '单位', type: 'text', required: true, def: '台' },
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
    kind: 'MASTER',
    key: 'code',
    fields: [
      { key: 'code', label: '物料编号', type: 'text', required: true },
      { key: 'name', label: '物料名称', type: 'text', required: true },
      { key: 'unit', label: '单位', type: 'text', required: true },
      { key: 'type', label: '物料类型', type: 'enum', enums: ['RAW', 'PURCHASE', 'SEMI'], required: true },
    ],
    toEntity: (r, db) => ({
      id: (db.materials.find((m) => m.code === r.code) || {}).id || uid('M'),
      code: r.code,
      name: r.name,
      unit: r.unit,
      type: r.type,
    }),
  },
  bomItems: {
    label: 'BOM 明细',
    kind: 'MASTER',
    key: null,
    fields: [
      { key: 'productCode', label: '产品编号', type: 'text', required: true, ref: 'products' },
      { key: 'level', label: '层级', type: 'number', required: true, enums: [1, 2] },
      { key: 'parentCode', label: '父项编码', type: 'text', required: true },
      { key: 'childCode', label: '子项编码', type: 'text', required: true, ref: 'materials' },
      { key: 'childType', label: '子项类型', type: 'enum', enums: ['SEMI', 'MATERIAL'], required: true },
      { key: 'qtyPer', label: '单位用量', type: 'number', required: true },
    ],
    toEntity: (r, db) => {
      const product = db.products.find((p) => p.code === r.productCode);
      const child = db.materials.find((m) => m.code === r.childCode);
      if (!product) throw new Error(`产品「${r.productCode}」不存在`);
      if (!child) throw new Error(`物料「${r.childCode}」不存在`);
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
  workCenters: {
    label: '工作中心',
    kind: 'MASTER',
    key: 'code',
    fields: [
      { key: 'code', label: '编码', type: 'text', required: true },
      { key: 'name', label: '名称', type: 'text', required: true },
      { key: 'capacityMode', label: '产能模式', type: 'enum', enums: ['DAILY_QTY', 'STD_HOURS'], required: true },
      { key: 'dailyCapacity', label: '日产能(件/日)', type: 'number', required: false },
      { key: 'dailyHours', label: '日可用工时', type: 'number', required: false },
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
  capabilities: {
    label: '工序与工作中心适配',
    kind: 'MASTER',
    key: null,
    fields: [
      { key: 'wcCode', label: '工作中心编码', type: 'text', required: true, ref: 'workCenters' },
      { key: 'opName', label: '工序名称', type: 'text', required: true },
    ],
    toEntity: (r, db) => {
      const wc = db.workCenters.find((w) => w.code === r.wcCode);
      if (!wc) throw new Error(`工作中心「${r.wcCode}」不存在`);
      return { id: uid('CAP'), workCenterId: wc.id, opName: r.opName, opId: '' };
    },
  },
  inventory: {
    label: '库存',
    kind: 'MASTER',
    key: null,
    fields: [
      { key: 'materialCode', label: '物料编号', type: 'text', required: true, ref: 'materials' },
      { key: 'qty', label: '数量', type: 'number', required: true },
      { key: 'warehouse', label: '仓库', type: 'text', required: false, def: '主仓' },
    ],
    toEntity: (r, db) => {
      const m = db.materials.find((x) => x.code === r.materialCode);
      if (!m) throw new Error(`物料「${r.materialCode}」不存在`);
      return { id: uid('INV'), materialId: m.id, qty: Number(r.qty), warehouse: r.warehouse || '主仓' };
    },
  },
  inbounds: {
    label: '采购到货',
    kind: 'DOC',
    key: null,
    fields: [
      { key: 'materialCode', label: '物料编号', type: 'text', required: true, ref: 'materials' },
      { key: 'qty', label: '数量', type: 'number', required: true },
      { key: 'expectedDate', label: '预计到货日', type: 'date', required: true },
      { key: 'confirmed', label: '是否确认', type: 'bool', required: true },
      { key: 'supplier', label: '供应商', type: 'text', required: false },
    ],
    toEntity: (r, db) => {
      const m = db.materials.find((x) => x.code === r.materialCode);
      if (!m) throw new Error(`物料「${r.materialCode}」不存在`);
      return {
        id: uid('IB'),
        materialId: m.id,
        materialCode: m.code,
        qty: Number(r.qty),
        expectedDate: r.expectedDate,
        confirmed: /^(y|yes|true|1|是)$/i.test(String(r.confirmed)),
        supplier: r.supplier || '',
        actualArrivalDate: '',
      };
    },
  },
  salesOrderLines: {
    label: '销售订单行',
    kind: 'DOC',
    key: 'lineCode',
    fields: [
      { key: 'lineCode', label: '销售订单行号', type: 'text', required: true },
      { key: 'customer', label: '客户名称', type: 'text', required: true },
      { key: 'productCode', label: '产品编号', type: 'text', required: true, ref: 'products' },
      { key: 'qty', label: '数量', type: 'number', required: true },
      { key: 'dueDate', label: '客户要求完工日', type: 'date', required: true },
      { key: 'priority', label: '订单优先级', type: 'number', required: false },
    ],
    toEntity: (r, db) => {
      const p = db.products.find((x) => x.code === r.productCode);
      if (!p) throw new Error(`产品「${r.productCode}」不存在`);
      return {
        so: { id: uid('SO'), code: r.lineCode.split('-')[0], customer: r.customer, orderDate: r.dueDate, priority: Number(r.priority) || 1, status: 'CONFIRMED', note: '' },
        line: {
          id: r.lineCode,
          salesOrderId: '',
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
    kind: 'DOC',
    key: 'code',
    fields: [
      { key: 'code', label: '生产订单号', type: 'text', required: true },
      { key: 'lineCode', label: '销售订单行号', type: 'text', required: true, ref: 'salesOrderLines' },
      { key: 'qty', label: '生产数量', type: 'number', required: true },
      { key: 'manualPriority', label: '人工优先级', type: 'number', required: false },
    ],
    toEntity: (r, db) => {
      const line = db.salesOrderLines.find((l) => l.id === r.lineCode);
      if (!line) throw new Error(`销售订单行「${r.lineCode}」不存在`);
      return {
        id: uid('PO'),
        code: r.code,
        salesOrderLineId: line.id,
        productId: line.productId,
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
      };
    },
  },
};

/* ───────────── 模板 ───────────── */

export function templateCsv(specKey) {
  const spec = IMPORT_SPECS[specKey];
  const headers = spec.fields.map((f) => f.label).join(',');
  const sample = spec.fields.map((f) => {
    if (f.enums) return f.enums[0];
    if (f.type === 'date') return '2026-12-31';
    if (f.type === 'number') return '1';
    if (f.type === 'bool') return '是';
    return `示例${f.label}`;
  });
  return `${headers}\n${sample.join(',')}\n`;
}

/* ───────────── CSV 解析 ───────────── */

export function parseCsv(text) {
  const rows = [];
  let cur = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/^\ufeff/, '');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      cur.push(field);
      field = '';
    } else if (c === '\n') {
      cur.push(field);
      rows.push(cur);
      cur = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field.length || cur.length) {
    cur.push(field);
    rows.push(cur);
  }
  const clean = rows.filter((r) => r.some((x) => String(x).trim() !== ''));
  if (!clean.length) return { headers: [], rows: [] };
  const headers = clean[0].map((h) => String(h).trim());
  const data = clean.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => {
      o[h] = (r[i] ?? '').trim();
    });
    return o;
  });
  return { headers, rows: data };
}

/* ───────────── XLSX 解析（原生解压，无第三方库） ───────────── */

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持原生解压，请改用 CSV 模板');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buffer) {
  const buf = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件');
  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true);
  const files = {};
  for (let i = 0; i < count; i += 1) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) break;
    const method = dv.getUint16(ptr + 10, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const localOff = dv.getUint32(ptr + 42, true);
    const name = new TextDecoder('utf-8').decode(buf.subarray(ptr + 46, ptr + 46 + nameLen));
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    files[name] = { method, data: buf.subarray(dataStart, dataStart + compSize) };
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  const out = {};
  for (const [name, f] of Object.entries(files)) {
    if (/^(xl\/worksheets\/sheet1\.xml|xl\/sharedStrings\.xml|xl\/workbook\.xml)$/.test(name)) {
      out[name] = f.method === 0 ? f.data : await inflateRaw(f.data);
    }
  }
  return out;
}

const colIndex = (ref) => {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** 读取 xlsx 首个工作表 → {headers, rows} */
export async function parseXlsx(buffer) {
  const files = await unzip(buffer);
  const dec = new TextDecoder('utf-8');
  const parser = new DOMParser();

  let shared = [];
  if (files['xl/sharedStrings.xml']) {
    const doc = parser.parseFromString(dec.decode(files['xl/sharedStrings.xml']), 'application/xml');
    shared = [...doc.getElementsByTagName('si')].map((si) =>
      [...si.getElementsByTagName('t')].map((t) => t.textContent).join('')
    );
  }

  if (!files['xl/worksheets/sheet1.xml']) throw new Error('文件中未找到第一个工作表');
  const sheet = parser.parseFromString(dec.decode(files['xl/worksheets/sheet1.xml']), 'application/xml');
  const grid = [];
  for (const row of [...sheet.getElementsByTagName('row')]) {
    const cells = [];
    for (const c of [...row.getElementsByTagName('c')]) {
      const ref = c.getAttribute('r') || '';
      const t = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0];
      const isV = c.getElementsByTagName('is')[0];
      let val = '';
      if (t === 's' && v) val = shared[Number(v.textContent)] || '';
      else if (t === 'inlineStr' && isV) val = isV.textContent || '';
      else if (v) val = v.textContent || '';
      cells[colIndex(ref)] = String(val).trim();
    }
    if (cells.some((x) => x !== undefined && x !== '')) grid.push(cells);
  }

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

/* ───────────── 校验 ───────────── */

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/**
 * 校验导入行
 * @returns { errors: [{line, field, message}], entities:[], headers }
 */
export function validateImport(specKey, parsed, db) {
  const spec = IMPORT_SPECS[specKey];
  const errors = [];
  const entities = [];

  // 表头校验
  const missing = spec.fields.filter((f) => f.required && !parsed.headers.includes(f.label));
  if (missing.length) {
    return {
      errors: missing.map((f) => ({ line: 1, field: f.label, message: `表头缺少必填列「${f.label}」` })),
      entities: [],
      headers: parsed.headers,
    };
  }

  const seenKeys = new Set();

  parsed.rows.forEach((row, i) => {
    const line = i + 2;
    let bad = false;
    const rec = {};

    for (const f of spec.fields) {
      const raw = row[f.label];
      if (f.required && (raw === undefined || String(raw).trim() === '')) {
        errors.push({ line, field: f.label, message: '必填项为空' });
        bad = true;
        continue;
      }
      if (raw === undefined || raw === '') continue;
      if (f.type === 'number' && !Number.isFinite(Number(raw))) {
        errors.push({ line, field: f.label, message: `不是有效数字：${raw}` });
        bad = true;
      }
      if (f.type === 'date' && !isDate(raw)) {
        errors.push({ line, field: f.label, message: `日期格式应为 YYYY-MM-DD：${raw}` });
        bad = true;
      }
      if (f.enums && !f.enums.map(String).includes(String(raw))) {
        errors.push({ line, field: f.label, message: `取值必须是 ${f.enums.join(' / ')}：${raw}` });
        bad = true;
      }
      rec[f.key] = raw;
    }
    if (bad) return;

    // 重复识别
    if (spec.key && rec[spec.key]) {
      if (seenKeys.has(rec[spec.key])) {
        errors.push({ line, field: spec.fields.find((f) => f.key === spec.key).label, message: `文件内编码重复：${rec[spec.key]}` });
        return;
      }
      seenKeys.add(rec[spec.key]);
    }

    try {
      const entity = spec.toEntity(rec, db);
      entities.push({ line, entity, rec });
    } catch (e) {
      errors.push({ line, field: '关联关系', message: e.message });
    }
  });

  return { errors, entities, headers: parsed.headers };
}

/**
 * 应用导入
 * MASTER：按编码覆盖（无编码的追加）
 * DOC：重复即拒绝
 */
export function applyImport(specKey, entities, db) {
  const spec = IMPORT_SPECS[specKey];
  let created = 0;
  let updated = 0;
  const rejected = [];

  const targetMap = {
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
  const coll = targetMap[specKey];

  if (specKey === 'salesOrderLines') {
    for (const { entity } of entities) {
      if (db.salesOrderLines.some((l) => l.id === entity.line.id)) {
        rejected.push({ id: entity.line.id, reason: '单据已存在（单据统计不接受覆盖）' });
        continue;
      }
      const soId = entity.so.id;
      entity.so.id = soId;
      entity.line.salesOrderId = soId;
      if (!db.salesOrders.some((s) => s.code === entity.so.code)) db.salesOrders.push(entity.so);
      db.salesOrderLines.push(entity.line);
      created += 1;
    }
    return { created, updated, rejected };
  }

  for (const { entity } of entities) {
    if (spec.kind === 'MASTER' && spec.key && entity[spec.key]) {
      const exist = db[coll].find((x) => x[spec.key] === entity[spec.key]);
      if (exist) {
        Object.assign(exist, entity, { id: exist.id });
        updated += 1;
        continue;
      }
      db[coll].push(entity);
      created += 1;
      continue;
    }

    if (spec.kind === 'DOC') {
      const key = spec.key ? entity[spec.key] : null;
      if (key && db[coll].some((x) => x[spec.key] === key)) {
        rejected.push({ id: key, reason: '单据已存在（重复即拒绝，需人工确认）' });
        continue;
      }
    }
    db[coll].push(entity);
    created += 1;
  }

  return { created, updated, rejected };
}

/** 导出任意实体集合为 CSV（列由 fields 指定） */
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
