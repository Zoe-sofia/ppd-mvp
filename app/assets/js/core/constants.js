/**
 * 冻结口径（执行方案 §2.5 / §2.4 / P-01 ~ P-06）
 * 单一事实来源：任何页面与业务逻辑都只能引用此处的枚举与常量，不得自行定义同义状态。
 */

/* ───────────── 一、状态枚举总表（S-B02） ───────────── */

/** 生产订单状态 */
export const ORDER_STATUS = {
  DRAFT: { code: 'DRAFT', name: '待排产' },
  SCHEDULED: { code: 'SCHEDULED', name: '已排产' },
  RELEASED: { code: 'RELEASED', name: '已确认' },
  IN_PROGRESS: { code: 'IN_PROGRESS', name: '生产中' },
  COMPLETED: { code: 'COMPLETED', name: '已完工' },
  CLOSED: { code: 'CLOSED', name: '已关闭' },
  CANCELLED: { code: 'CANCELLED', name: '已取消' },
};

/** 工序任务状态 */
export const TASK_STATUS = {
  PLANNED: { code: 'PLANNED', name: '已计划' },
  IN_PROGRESS: { code: 'IN_PROGRESS', name: '进行中' },
  COMPLETED: { code: 'COMPLETED', name: '已完成' },
  CANCELLED: { code: 'CANCELLED', name: '已取消' },
};

/** 物料齐套状态（O-05：全局唯一枚举） */
export const KITTING_STATUS = {
  KITTED: { code: 'KITTED', name: '齐套', tone: 'ok' },
  PARTIAL: { code: 'PARTIAL', name: '部分齐套', tone: 'warn' },
  SHORT: { code: 'SHORT', name: '缺料', tone: 'danger' },
  EXPECTED_KITTED: { code: 'EXPECTED_KITTED', name: '预计齐套', tone: 'info' },
  INBOUND_RISK: { code: 'INBOUND_RISK', name: '到货风险', tone: 'danger' },
};

/** 交付风险状态 */
export const RISK_STATUS = {
  PENDING: { code: 'PENDING', name: '未评估', tone: 'muted' },
  ON_TIME: { code: 'ON_TIME', name: '按期', tone: 'ok' },
  AT_RISK: { code: 'AT_RISK', name: '有风险', tone: 'warn' },
  DELAYED: { code: 'DELAYED', name: '预计延期', tone: 'danger' },
  DONE_ON_TIME: { code: 'DONE_ON_TIME', name: '准时完工', tone: 'ok' },
  DONE_LATE: { code: 'DONE_LATE', name: '实际延期', tone: 'danger' },
};

/** 发货状态（P-01：内部节点，非客户履约口径） */
export const SHIPMENT_STATUS = {
  PENDING: { code: 'PENDING', name: '待发货' },
  PARTIAL: { code: 'PARTIAL', name: '部分发货' },
  SHIPPED: { code: 'SHIPPED', name: '已发货' },
};

/** 异常处理状态 */
export const EXCEPTION_STATUS = {
  OPEN: { code: 'OPEN', name: '待处理' },
  PROCESSING: { code: 'PROCESSING', name: '处理中' },
  RESOLVED: { code: 'RESOLVED', name: '已解决' },
  CLOSED: { code: 'CLOSED', name: '已关闭' },
};

/** 异常等级（D-13：三级） */
export const EXCEPTION_LEVEL = {
  URGENT: { code: 'URGENT', name: '紧急', tone: 'danger', rank: 1 },
  IMPORTANT: { code: 'IMPORTANT', name: '重要', tone: 'warn', rank: 2 },
  NORMAL: { code: 'NORMAL', name: '一般', tone: 'muted', rank: 3 },
};

/** 异常类型 */
export const EXCEPTION_TYPE = {
  MATERIAL: { code: 'MATERIAL', name: '物料异常' },
  CAPACITY: { code: 'CAPACITY', name: '产能异常' },
  PRODUCTION: { code: 'PRODUCTION', name: '生产异常' },
  DELIVERY: { code: 'DELIVERY', name: '交付异常' },
};

/** 计划版本状态：正式计划 / 模拟方案 / 已失效 */
export const VERSION_KIND = {
  FORMAL: { code: 'FORMAL', name: '正式计划' },
  SCENARIO: { code: 'SCENARIO', name: '模拟方案' },
};
export const VERSION_STATUS = {
  ACTIVE: { code: 'ACTIVE', name: '生效' },
  ARCHIVED: { code: 'ARCHIVED', name: '已失效' },
};

/* ───────────── 二、数量口径（O-04，S-B03） ───────────── */

/**
 * 待生产 = 计划总量 − 已开工量
 * 剩余   = 计划总量 − 合格完成量
 */
export const QTY_DEF = {
  toProduce: (planQty, startedQty) => Math.max(0, planQty - startedQty),
  remaining: (planQty, goodQty) => Math.max(0, planQty - goodQty),
};

/** 取整规则：数量按件计，允许小数时保留两位，不允许时向下取整（默认按件） */
export const QTY_ROUNDING = 'FLOOR';

/** 不良原因枚举（D-13 冻结） */
export const SCRAP_REASONS = [
  { code: 'DIMENSION', name: '尺寸超差' },
  { code: 'ASSEMBLY', name: '装配不良' },
  { code: 'INCOMING', name: '来料不良' },
  { code: 'EQUIPMENT', name: '设备故障' },
  { code: 'OTHER', name: '其他' },
];

/* ───────────── 三、日期口径（S-B03） ───────────── */

/** 排产推进按工作日历；延期天数按自然日计算（二者不得混用） */
export const DATE_BASIS = {
  scheduling: 'WORKDAY',
  delayDays: 'CALENDAR',
};

/** 默认缓冲天数（软约束 SC-03） */
export const DEFAULT_BUFFER_DAYS = 2;

/* ───────────── 四、产能与权重（P-03 / P-04 / D-09） ───────────── */

export const CAPACITY_MODE = {
  DAILY_QTY: 'DAILY_QTY', // 件/日
  STD_HOURS: 'STD_HOURS', // 小时/件 → 日可用工时 ÷ 单位标准工时
};

/**
 * 九因素三桶映射（P-04）
 * 进评分：交期桶 / 物料桶 / 产能桶
 * 进日期推算：预计生产周期、工序等待时间
 * 进硬性前置：工序前后关系
 */
export const SCORE_BUCKETS = {
  DELIVERY: { code: 'DELIVERY', name: '交期' },
  MATERIAL: { code: 'MATERIAL', name: '物料' },
  CAPACITY: { code: 'CAPACITY', name: '产能' },
};

/** 三套策略权重（D-09：明显区分，合计 100） */
export const STRATEGIES = {
  DELIVERY: {
    code: 'DELIVERY',
    name: '交付优先',
    desc: '优先保障交期临近、延期风险高的订单',
    weights: { DELIVERY: 60, MATERIAL: 20, CAPACITY: 20 },
  },
  MATERIAL: {
    code: 'MATERIAL',
    name: '物料优先',
    desc: '优先安排物料齐套或即将齐套的订单',
    weights: { DELIVERY: 25, MATERIAL: 60, CAPACITY: 15 },
  },
  BALANCE: {
    code: 'BALANCE',
    name: '产能均衡',
    desc: '尽量减少工作中心负荷不均，避免部分中心积压',
    weights: { DELIVERY: 30, MATERIAL: 20, CAPACITY: 50 },
  },
};

/* ───────────── 五、约束编号（S-A06） ───────────── */

export const HARD_CONSTRAINTS = [
  { code: 'HC-01', name: '工序顺序错误', desc: '下游工序计划开始日不得早于上游工序计划结束日' },
  { code: 'HC-02', name: '工作中心不具备加工能力', desc: '分配的工作中心必须声明具备该工序的加工能力' },
  { code: 'HC-03', name: '安排在不可生产日期', desc: '任务不得安排在周末、法定节假日或工作中心计划停机日' },
  { code: 'HC-04', name: '超出硬性最大产能', desc: '同一工作中心同一日的负荷不得超过日产能（不含加班）' },
  { code: 'HC-05', name: '下游数量超过上游可流转量', desc: '下游工序计划数量不得超过上游工序计划数量' },
];

export const SOFT_CONSTRAINTS = [
  { code: 'SC-01', name: '预计无法满足客户交期', desc: '预计完工日晚于客户要求完工日' },
  { code: 'SC-02', name: '工作中心负荷不均', desc: '某中心负荷率显著高于全厂均值' },
  { code: 'SC-03', name: '生产计划缓冲不足', desc: '预计完工日至客户交期的余量小于缓冲天数' },
  { code: 'SC-04', name: '未确认到货物料风险', desc: '缺口依赖未确认到货，数量不计入确定可用量' },
  { code: 'SC-05', name: '预计到货晚于计划开工', desc: '已确认到货日晚于原计划开工日' },
];

/** 约束提示四要素模板（S-A06） */
export const constraintMessage = (v) => ({
  object: v.object || '',
  reason: v.msg || '',
  impact: v.impact || '',
  where: v.where || '',
});

/* ───────────── 六、红线（验收不可协商，§6.2） ───────────── */

export const RED_LINES = [
  '硬约束冲突可被确认',
  '下游超量流转可被录入',
  '物料不足仍可开工',
  '模拟方案影响正式计划',
  'AI 直接修改正式计划、预留或执行记录',
  'AI 不可用导致核心功能不可用',
  '未校验的导入数据进入排产计算',
];

/* ───────────── 七、工具 ───────────── */

export const label = (dict, code) => (dict[code] ? dict[code].name : code || '—');

export const toneOf = (dict, code) => (dict[code] && dict[code].tone) || 'muted';

export const isWorkingMode = (wc) => (wc && wc.capacityMode) || CAPACITY_MODE.DAILY_QTY;
