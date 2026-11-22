/**
 * 三项自动化校验（执行方案 §3.8 纪律二）
 * 1. 算法可复现性：同输入同配置连跑 3 次，输出完全一致
 * 2. 数量勾稽：订单级汇总 = 工序级明细，且每日切分合计 = 工序计划量
 * 3. 约束拦截：构造违规数据，必须被判定并拒绝
 *
 * 运行：node app/tests/verify.mjs
 */

import { buildSeed } from '../assets/js/core/seed.js';
import { runSchedule } from '../assets/js/core/scheduler.js';
import { checkConstraints } from '../assets/js/core/constraints.js';
import { validateStart, validateComplete, orderProgress } from '../assets/js/core/execution.js';
import { computeMetrics } from '../assets/js/core/metrics.js';
import { kittingOf } from '../assets/js/core/rules.js';
import { detect } from '../assets/js/core/exceptions.js';
import { addDays } from '../assets/js/core/calendar.js';

const AS_OF = '2026-11-22';
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

/* ═══════════ 0. 数据构建 ═══════════ */
section('0. 三套测试数据构建');
const dbs = {};
for (const kind of ['simple', 'medium', 'complex']) {
  const db = buildSeed(kind, AS_OF);
  dbs[kind] = db;
  const incomplete = db.tasks.filter((t) => {
    const sum = (t.dailyPlan || []).reduce((s, d) => s + d.qty, 0);
    return sum !== t.planQty;
  });
  check(
    `${kind}：订单 ${db.productionOrders.length} 张、任务 ${db.tasks.length} 条、工作中心 ${db.workCenters.length} 个`,
    db.tasks.length > 0 && db.productionOrders.length > 0
  );
  check(`${kind}：全部工序每日切分合计等于计划量`, incomplete.length === 0, `${incomplete.length} 条不相等`);
}

/* ═══════════ 1. 算法可复现性 ═══════════ */
section('1. 算法可复现性（同输入连跑 3 次）');
for (const kind of ['simple', 'medium', 'complex']) {
  const db = dbs[kind];
  const runs = [1, 2, 3].map(() =>
    JSON.stringify(
      runSchedule({ db, orders: db.productionOrders, strategy: 'DELIVERY', versionId: 'PV-TEST', asOf: AS_OF }).tasks
    )
  );
  check(`${kind}：3 次运行结果完全一致`, runs[0] === runs[1] && runs[1] === runs[2]);
}

// 三种策略必须产出可区分的结果（D-09 / Gate 2 判据 2）
{
  const db = dbs.medium;
  const outs = ['DELIVERY', 'MATERIAL', 'BALANCE'].map((s) =>
    runSchedule({ db, orders: db.productionOrders, strategy: s, versionId: 'PV-TEST', asOf: AS_OF }).tasks
  );
  const sig = (tasks) => tasks.map((t) => `${t.orderId}:${t.startDate}`).join('|');
  const distinct = new Set(outs.map(sig)).size;
  check('三策略产出可区分的排序结果', distinct >= 2, `可区分方案数 ${distinct}`);
}

/* ═══════════ 2. 数量勾稽 ═══════════ */
section('2. 数量勾稽（订单级 = 工序级汇总）');
for (const kind of ['simple', 'medium', 'complex']) {
  const db = dbs[kind];
  let mismatch = 0;
  let downstreamOver = 0;
  for (const o of db.productionOrders) {
    const p = orderProgress(db, o, o.versionId);
    if (p.tasks.length === 0) continue;
    const first = p.tasks[0];
    const last = p.tasks[p.tasks.length - 1];
    if (p.startedQty !== Number(first.actualStartQty || 0)) mismatch += 1;
    if (p.goodQty !== Number(last.goodQty || 0)) mismatch += 1;
    for (let i = 1; i < p.tasks.length; i += 1) {
      if (Number(p.tasks[i].actualStartQty) > Number(p.tasks[i - 1].goodQty)) downstreamOver += 1;
    }
  }
  check(`${kind}：订单级与工序级汇总一致`, mismatch === 0, `${mismatch} 处不一致`);
  check(`${kind}：无下游超上游合格量`, downstreamOver === 0, `${downstreamOver} 处超量`);
}

/* ═══════════ 3. 约束拦截 ═══════════ */
section('3. 约束拦截（构造违规，必须被拒）');
{
  const db = dbs.medium;
  const baseTasks = db.tasks.filter((t) => t.versionId === db.activeVersionId).slice(0, 40);
  const orderWithTwo = Object.values(
    baseTasks.reduce((acc, t) => {
      acc[t.orderId] = acc[t.orderId] || [];
      acc[t.orderId].push(t);
      return acc;
    }, {})
  ).find((list) => list.length >= 2);

  // HC-01：把下游工序提前到上游开始日之前
  {
    const sorted = [...orderWithTwo].sort((a, b) => a.seq - b.seq);
    const early = addDays(sorted[0].startDate, -3);
    const tampered = baseTasks.map((t) =>
      t.id === sorted[1].id ? { ...t, startDate: early, endDate: early, dailyPlan: [{ date: early, qty: t.planQty }] } : t
    );
    const v = checkConstraints(tampered, db, db.settings);
    check('HC-01 工序顺序违规被识别', v.some((x) => x.code === 'HC-01'));
  }

  // HC-02：改派到无能力声明的工作中心
  {
    const t0 = baseTasks[0];
    const capable = new Set(db.capabilities.filter((c) => c.opId === t0.opId).map((c) => c.workCenterId));
    const bad = db.workCenters.find((w) => !capable.has(w.id));
    const v = checkConstraints(
      baseTasks.map((t) => (t.id === t0.id ? { ...t, workCenterId: bad.id } : t)),
      db,
      db.settings
    );
    check('HC-02 无加工能力被识别', v.some((x) => x.code === 'HC-02'));
  }

  // HC-03：安排到周六
  {
    const t0 = baseTasks[0];
    const saturday = '2026-11-28';
    const v = checkConstraints(
      baseTasks.map((t) => (t.id === t0.id ? { ...t, startDate: saturday, endDate: saturday, dailyPlan: [{ date: saturday, qty: t.planQty }] } : t)),
      db,
      db.settings
    );
    check('HC-03 不可生产日期被识别', v.some((x) => x.code === 'HC-03'));
  }

  // HC-04：单日负荷翻倍
  {
    const t0 = baseTasks[0];
    const day = t0.dailyPlan[0].date;
    const v = checkConstraints(
      baseTasks.map((t) => (t.id === t0.id ? { ...t, dailyPlan: [{ date: day, qty: t.planQty * 5 }] } : t)),
      db,
      db.settings
    );
    check('HC-04 超出日产能被识别', v.some((x) => x.code === 'HC-04'));
  }

  // HC-05：下游数量超上游
  {
    const sorted = [...orderWithTwo].sort((a, b) => a.seq - b.seq);
    const v = checkConstraints(
      baseTasks.map((t) => (t.id === sorted[1].id ? { ...t, planQty: sorted[0].planQty + 1000 } : t)),
      db,
      db.settings
    );
    check('HC-05 下游超量被识别', v.some((x) => x.code === 'HC-05'));
  }

  // 合法计划不应产生硬约束
  {
    const v = checkConstraints(baseTasks, db, db.settings);
    check('合法计划无硬约束违规', !v.some((x) => x.level === 'HARD'), v.filter((x) => x.level === 'HARD').map((x) => x.code).join(','));
  }

  // 判定结果不得依赖任务数组顺序（回归：曾因逐条累加产能出现 0/15/19 三种结论）
  {
    const sig = (arr) => {
      const v = checkConstraints(arr, db, db.settings);
      const by = {};
      v.forEach((x) => {
        const k = `${x.level}|${x.code}`;
        by[k] = (by[k] || 0) + 1;
      });
      return Object.keys(by)
        .sort()
        .map((k) => `${k}=${by[k]}`)
        .join(',');
    };
    const sorted = [...baseTasks].sort((a, b) => (a.orderId !== b.orderId ? a.orderId.localeCompare(b.orderId) : a.seq - b.seq));
    const a = sig(baseTasks);
    const b = sig(sorted);
    const c = sig([...baseTasks].reverse());
    check('约束判定与任务顺序无关', a === b && b === c, `${a} / ${b} / ${c}`);
  }
}

/* ═══════════ 4. 开工/完工闸门 ═══════════ */
section('4. 执行闸门（红线 2、3）');
{
  // 物料不足不得开工
  const db = dbs.complex;
  const shortOrder = db.productionOrders.find(
    (o) => kittingOf(o, db, o.planStart).maxStartByStock < o.qty && o.status !== 'COMPLETED'
  );
  if (shortOrder) {
    const tasks = db.tasks.filter((t) => t.orderId === shortOrder.id).sort((a, b) => a.seq - b.seq);
    const first = tasks[0];
    const r = validateStart(db, { ...first, actualStartQty: 0 }, first.planQty, '2026-11-24');
    check('物料不足时超量开工被拒（红线 3）', r.ok === false, r.message);
  } else {
    check('物料不足时超量开工被拒（红线 3）', false, '未找到缺料订单');
  }

  // 下游超上游合格量不得开工
  const order = db.productionOrders.find((o) => {
    const list = db.tasks.filter((t) => t.orderId === o.id).sort((a, b) => a.seq - b.seq);
    return list.length >= 2 && list[0].goodQty > 0 && list[1].goodQty < list[1].planQty;
  });
  if (order) {
    const list = db.tasks.filter((t) => t.orderId === order.id).sort((a, b) => a.seq - b.seq);
    const second = list[1];
    const overQty = Number(list[0].goodQty) + 50;
    const r = validateStart(db, second, overQty, second.startDate);
    check('下游超上游可流转量被拒（红线 2）', r.ok === false, r.message);
  } else {
    check('下游超上游可流转量被拒（红线 2）', false, '未找到可用于验证的订单');
  }

  // 完工申报超已开工
  {
    const t = db.tasks.find((x) => x.actualStartQty > 0 && x.actualStartQty > x.actualDoneQty);
    if (t) {
      const r = validateComplete(db, t, t.actualStartQty, 1);
      check('完工申报超过已开工量被拒', r.ok === false, r.message);
    } else {
      const t2 = db.tasks.find((x) => x.actualStartQty > 0);
      const r = validateComplete(db, t2, 999999, 0);
      check('完工申报超过已开工量被拒', r.ok === false, r.message);
    }
  }
}

/* ═══════════ 5. 指标与异常 ═══════════ */
section('5. 指标口径与异常识别');
for (const kind of ['simple', 'medium', 'complex']) {
  const db = dbs[kind];
  const m = computeMetrics(db, { from: '2026-01-01', to: '2027-12-31' });
  const bad = m.filter((x) => !Number.isFinite(Number(x.value)) || x.display.includes('NaN'));
  check(`${kind}：12 项指标计算无 NaN`, m.length === 12 && bad.length === 0, `${m.length} 项，异常 ${bad.length}`);
}

{
  const db = dbs.complex;
  const ex = detect(db, AS_OF);
  const types = new Set(ex.map((e) => e.type));
  check(`复杂场景识别到异常 ${ex.length} 条，覆盖 ${types.size} 类`, ex.length > 0 && types.size >= 3);
  check('异常去重生效（无重复 dedupeKey）', new Set(ex.map((e) => `${e.code}|${e.orderId}|${e.taskId}|${e.workCenterId}`)).size === ex.length);
}

/* ═══════════ 输出 ═══════════ */
console.log(results.join('\n'));
console.log(`\n${'='.repeat(60)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
