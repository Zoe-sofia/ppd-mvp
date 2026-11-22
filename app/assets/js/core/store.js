/**
 * 数据持久层（V1.0 §8.2 数据持久层）
 * 当前实现：浏览器 localStorage 单库存储，供单用户本机使用。
 * 设计约束：所有业务代码只通过本模块读写，替换为关系型数据库时只需替換本文件的实现。
 */

const KEY = 'ppd-mvp-v1';
const SCHEMA = 1;

export const uid = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function emptyDb() {
  return {
    schema: SCHEMA,
    seedRev: '',
    seedScenario: '',
    factory: { id: 'F1', name: '示范机械制造厂', code: 'DEMO' },
    users: [{ id: 'U1', name: 'PMC 计划员', role: 'PMC' }],
    settings: {
      bufferDays: 2,
      freezeDays: 3,
      freezeMax: 10,
      materialMode: 'UPDATE',
      dateBasis: { scheduling: 'WORKDAY', delayDays: 'CALENDAR' },
      aiEnabled: false,
    },
    calendar: { id: 'CAL1', name: '标准工作日历', workdays: [1, 2, 3, 4, 5], holidays: [] },
    products: [],
    materials: [],
    bomItems: [],
    routings: [],
    routingOps: [],
    workCenters: [],
    capabilities: [],
    downtimes: [],
    inventory: [],
    inbounds: [],
    salesOrders: [],
    salesOrderLines: [],
    productionOrders: [],
    orderLinks: [],
    planVersions: [],
    tasks: [],
    actuals: [],
    shipments: [],
    exceptions: [],
    freezeLogs: [],
    blockedLog: [],
    importLogs: [],
    activeVersionId: '',
  };
}

export function loadDb() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const db = JSON.parse(raw);
    if (!db || db.schema !== SCHEMA) return null;
    return { ...emptyDb(), ...db };
  } catch (e) {
    console.error('读取本地数据失败', e);
    return null;
  }
}

export function saveDb(db) {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
    return true;
  } catch (e) {
    console.error('保存失败（可能超出本地存储上限）', e);
    return false;
  }
}

export function clearDb() {
  localStorage.removeItem(KEY);
}

/** 备份：导出为 JSON 文本 */
export function exportJson(db) {
  return JSON.stringify(
    { schema: SCHEMA, exportedAt: new Date().toISOString(), factory: db.factory, data: db },
    null,
    2
  );
}

/** 恢复：从 JSON 文本导入 */
export function importJson(text) {
  const parsed = JSON.parse(text);
  const db = parsed.data || parsed;
  if (!db || !Array.isArray(db.productionOrders)) throw new Error('文件结构不符合要求：缺少 productionOrders');
  return { ...emptyDb(), ...db, schema: SCHEMA };
}

export function storageInfo() {
  const raw = localStorage.getItem(KEY) || '';
  return { bytes: new Blob([raw]).size, exists: !!raw };
}
