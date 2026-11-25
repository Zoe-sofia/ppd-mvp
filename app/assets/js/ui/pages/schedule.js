/**
 * 生产排程（V1.0 §4.4）—— MVP 核心模块
 * 自动排产（三策略 + 可解释评分）、计划表格、甘特图、调整辅助面板、硬/软约束检查
 */

import { badge, esc, modal, num, table, toast, options, bar, sortRows, bindSort } from '../dom.js';
import { STRATEGIES, HARD_CONSTRAINTS, SOFT_CONSTRAINTS, label } from '../../core/constants.js';
import { runSchedule, replanTask, scoreOrder, committedUtilization } from '../../core/scheduler.js';
import { checkConstraints, hasHard } from '../../core/constraints.js';
import { capacityFor, candidateCenters, routingOpsOf } from '../../core/rules.js';
import { addDays, diffCalendarDays, isWorkday, today } from '../../core/calendar.js';
import { isTaskFrozen } from '../../core/freeze.js';

let state = {
  strategy: 'DELIVERY',
  scope: 'UNPLANNED',
  show: 'table', // table | gantt
  selectedTask: '',
  lastScores: [],
  lastWarnings: [],
  /** 计划表格筛选条件 */
  filter: { order: '', op: '', wc: '', status: '', from: '', to: '' },
  /** 计划表格排序 */
  sort: { key: 'order', dir: 'asc' },
  /** 当日计划查询日期 */
  dayQuery: '',
};

/** 计划表格的排序取值：把行拍平成可比较的字段 */
function taskSortValue(r, key) {
  const t = r.t;
  switch (key) {
    case 'order': return (r.o ? r.o.code : '') || '';
    case 'seq': return r.t.seq;
    case 'op': return r.t.opName || '';
    case 'wc': return (r.wc || {}).name || '';
    case 'qty': return Number(t.planQty) || 0;
    case 'start': return t.startDate || '';
    case 'end': return t.endDate || '';
    case 'days': return (t.dailyPlan || []).length;
    case 'status': return t.status || '';
    default: return '';
  }
}

const TASK_STATUS_LABEL = { COMPLETED: '已完成', IN_PROGRESS: '进行中', PLANNED: '已计划', CANCELLED: '已取消' };

export default {
  render(view, ctx) {
    const { db } = ctx;
    const versionId = db.activeVersionId;
    const allTasks = db.tasks.filter((t) => t.versionId === versionId);
    const violations = checkConstraints(allTasks, db, db.settings);
    const hard = violations.filter((v) => v.level === 'HARD');
    const soft = violations.filter((v) => v.level === 'SOFT');
    const strategy = STRATEGIES[state.strategy];

    const schedulable = db.productionOrders.filter((o) => ['DRAFT', 'SCHEDULED', 'RELEASED'].includes(o.status));
    const orderMap = Object.fromEntries(db.productionOrders.map((o) => [o.id, o]));
    const wcMap = Object.fromEntries(db.workCenters.map((w) => [w.id, w]));

    // 过滤 + 排序（只影响"看"，不影响约束检查：检查永远针对全量计划）
    const f = state.filter;
    const filtered = allTasks
      .filter((t) => !f.order || t.orderId === f.order)
      .filter((t) => !f.op || t.opName === f.op)
      .filter((t) => !f.wc || t.workCenterId === f.wc)
      .filter((t) => !f.status || t.status === f.status)
      .filter((t) => (!f.from || t.endDate >= f.from) && (!f.to || t.startDate <= f.to));
    const rows = sortRows(
      filtered.map((t) => ({ t, o: orderMap[t.orderId], wc: wcMap[t.workCenterId] })),
      state.sort,
      taskSortValue
    );

    if (!state.selectedTask && rows.length) state.selectedTask = rows[0].t.id;
    const selTask = db.tasks.find((t) => t.id === state.selectedTask) || null;

    const filterActive = Object.values(f).some(Boolean);
    const dayDate = state.dayQuery || ctx.asOf;
    const dayRows = allTasks
      .flatMap((t) => (t.dailyPlan || []).filter((d) => d.date === dayDate).map((d) => ({ t, d, o: orderMap[t.orderId], wc: wcMap[t.workCenterId] })))
      .sort((a, b) => (a.t.startDate < b.t.startDate ? -1 : 1));

    view.innerHTML = `
      <div class="card">
        <div class="card-h">
          <h3>自动排产</h3>
          <span class="desc">硬约束检查 + 多目标综合评分 + 启发式排产（不承诺全局最优）</span>
        </div>
        <div class="card-b">
          <div class="form-row three">
            <div class="field">
              <label>排产策略</label>
              <select id="strategy">${options(
                Object.values(STRATEGIES).map((s) => ({ value: s.code, label: s.name })),
                state.strategy
              )}</select>
              <div class="hint">${esc(strategy.desc)}</div>
            </div>
            <div class="field">
              <label>订单范围</label>
              <select id="scope">${options(
                [
                  { value: 'UNPLANNED', label: '仅未排产订单（推荐）' },
                  { value: 'ALL', label: '全部可排产订单（重排）' },
                ],
                state.scope
              )}</select>
              <div class="hint">可排产订单 ${schedulable.length} 张；重排会覆盖现有计划任务</div>
            </div>
            <div class="field">
              <label>权重配置（静态，可解释）</label>
              <div class="pill-list mt-1">
                ${Object.entries(strategy.weights)
                  .map(([k, v]) => `<span class="tag">${k === 'DELIVERY' ? '交期' : k === 'MATERIAL' ? '物料' : '产能'} ${v}%</span>`)
                  .join('')}
              </div>
              <div class="hint">九因素→三桶映射见统计分析页口径说明</div>
            </div>
          </div>
          <div class="inline wrap">
            <button class="btn primary" data-act="run">执行自动排产</button>
            <button class="btn" data-act="confirm">确认计划</button>
            <span class="spacer"></span>
            ${
              hard.length
                ? `<span class="badge danger">硬约束 ${hard.length} 处 · 不可确认</span>`
                : `<span class="badge ok">硬约束通过</span>`
            }
            <span class="badge ${soft.length ? 'warn' : 'muted'}">软约束 ${soft.length} 处</span>
          </div>
          ${
            state.lastWarnings.length
              ? `<div class="notice warn mt-4">${state.lastWarnings
                  .slice(0, 5)
                  .map((w) => esc(w.msg))
                  .join('；')}${state.lastWarnings.length > 5 ? `（共 ${state.lastWarnings.length} 条）` : ''}</div>`
              : ''
          }
        </div>
      </div>

      <div class="split">
        <div>
          <div class="card">
            <div class="card-h">
              <h3>${state.show === 'table' ? '计划表格' : '甘特图'}</h3>
              <span class="desc">${state.show === 'table' ? '可逐工序修改日期、工作中心与数量；修改后立即重校验' : '任务时间、工序关系与工作中心负荷'}</span>
              <div class="right">
                <button class="btn sm ${state.show === 'table' ? 'primary' : ''}" data-show="table">表格</button>
                <button class="btn sm ${state.show === 'gantt' ? 'primary' : ''}" data-show="gantt">甘特图</button>
              </div>
            </div>
            ${
              state.show === 'table'
                ? `<div class="toolbar divider-bottom">
                    <span class="small">筛选：</span>
                    <select class="filter" id="f-order" ><option value="">全部订单</option>${[...new Set(allTasks.map((t) => t.orderId))]
                      .map((id) => orderMap[id])
                      .filter(Boolean)
                      .sort((a, b) => a.code.localeCompare(b.code))
                      .map((o) => `<option value="${o.id}" ${o.id === f.order ? 'selected' : ''}>${esc(o.code)}</option>`)
                      .join('')}</select>
                    <select class="filter" id="f-op" ><option value="">全部工序</option>${[...new Set(allTasks.map((t) => t.opName))]
                      .sort()
                      .map((n) => `<option value="${esc(n)}" ${n === f.op ? 'selected' : ''}>${esc(n)}</option>`)
                      .join('')}</select>
                    <select class="filter" id="f-wc" ><option value="">全部工作中心</option>${db.workCenters
                      .map((w) => `<option value="${w.id}" ${w.id === f.wc ? 'selected' : ''}>${esc(w.name)}</option>`)
                      .join('')}</select>
                    <select class="filter" id="f-status" ><option value="">全部状态</option>${Object.entries(TASK_STATUS_LABEL)
                      .filter(([k]) => k !== 'CANCELLED')
                      .map(([k, v]) => `<option value="${k}" ${k === f.status ? 'selected' : ''}>${v}</option>`)
                      .join('')}</select>
                    <span class="filter-group">
                      <span class="small">日期</span>
                      <input class="filter" type="date" id="f-from" value="${esc(f.from)}"  title="结束日不早于" />
                      <span class="small">~</span>
                      <input class="filter" type="date" id="f-to" value="${esc(f.to)}"  title="开始日不晚于" />
                    </span>
                    <button class="btn sm ghost" data-act="filter-reset" ${filterActive ? '' : 'disabled'}>重置</button>
                    <span class="spacer"></span>
                    <span class="small muted count">显示 ${rows.length} / ${allTasks.length} 条</span>
                  </div>`
                : ''
            }
            <div class="card-b tight">
              ${state.show === 'table' ? renderTable(rows) : renderGantt(db, allTasks, orderMap)}
            </div>
          </div>

          <div class="card">
            <div class="card-h">
              <h3>当日计划查询</h3>
              <span class="desc">按日期查看当天要做什么：工序、工作中心、当日数量</span>
              <div class="right right-wide">
                <input class="filter" type="date" id="day-date" value="${esc(dayDate)}"  />
                <button class="btn sm ghost" data-act="day-today">今天</button>
              </div>
            </div>
            <div class="card-b tight">
              <div class="inline pad-tight pb-3">
                <b>${esc(dayDate)}</b>
                <span class="small muted">${dayRows.length} 道工序 · 合计 ${dayRows.reduce((s, r) => s + num(r.d.qty), 0)} 件</span>
              </div>
              ${table(
                [
                  { title: '订单', render: (r) => `<b>${esc(r.o ? r.o.code : '')}</b>` },
                  { title: '序', cls: 'mono', render: (r) => r.t.seq },
                  { title: '工序', render: (r) => esc(r.t.opName) },
                  { title: '工作中心', render: (r) => esc(r.wc ? r.wc.name : '—') },
                  { title: '当日数量', cls: 'num', render: (r) => num(r.d.qty) },
                  { title: '计划区间', cls: 'mono', render: (r) => `${esc(r.t.startDate)} → ${esc(r.t.endDate)}` },
                  { title: '状态', render: (r) => badge(TASK_STATUS_LABEL[r.t.status] || r.t.status, r.t.status === 'COMPLETED' ? 'ok' : r.t.status === 'IN_PROGRESS' ? 'info' : 'muted') },
                ],
                dayRows,
                { empty: '该日期没有排产任务（可能是非工作日，或计划尚未覆盖该日）' }
              )}
            </div>
          </div>

          <div class="card">
            <div class="card-h">
              <h3>约束检查结果</h3>
              <span class="desc">硬约束违反不允许确认；软约束允许保存但须显示风险</span>
            </div>
            <div class="card-b tight">
              ${table(
                [
                  { title: '级别', render: (v) => badge(v.level === 'HARD' ? '硬约束' : '软约束', v.level === 'HARD' ? 'danger' : 'warn') },
                  { title: '编号', cls: 'mono', render: (v) => esc(v.code) },
                  { title: '对象', render: (v) => esc(v.object) },
                  { title: '原因', render: (v) => esc(v.msg) },
                  { title: '影响', render: (v) => `<span class="small">${esc(v.impact)}</span>` },
                  { title: '调整位置', render: (v) => `<span class="small muted">${esc(v.where)}</span>` },
                ],
                [...hard, ...soft].slice(0, 40),
                { empty: '当前计划未发现约束违规' }
              )}
            </div>
            ${constraintGuideHtml(hard, soft)}
          </div>
        </div>

        <div class="side-panel">${renderAdjustPanel(ctx, selTask, allTasks, orderMap)}</div>
      </div>`;

    /* ── 事件 ── */
    view.querySelector('#strategy').addEventListener('change', (e) => {
      state.strategy = e.target.value;
      ctx.redraw();
    });
    view.querySelector('#scope').addEventListener('change', (e) => {
      state.scope = e.target.value;
      ctx.redraw();
    });
    view.querySelectorAll('[data-show]').forEach((b) =>
      b.addEventListener('click', () => {
        state.show = b.dataset.show;
        ctx.redraw();
      })
    );
    view.querySelector('[data-act="run"]').addEventListener('click', () => runNow(ctx));
    view.querySelector('[data-act="confirm"]').addEventListener('click', () => confirmPlan(ctx, violations));
    view.querySelectorAll('[data-task]').forEach((b) =>
      b.addEventListener('click', () => {
        state.selectedTask = b.dataset.task;
        ctx.redraw();
      })
    );
    view.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => editTask(ctx, b.dataset.edit))
    );
    view.querySelectorAll('[data-apply-center]').forEach((b) =>
      b.addEventListener('click', () => applyCenter(ctx, b.dataset.applyCenter, b.dataset.wc))
    );

    /* 计划表格筛选 */
    const bindFilter = (id, key) => {
      const el = view.querySelector(id);
      if (el)
        el.addEventListener('change', () => {
          state.filter[key] = el.value;
          ctx.redraw();
        });
    };
    bindFilter('#f-order', 'order');
    bindFilter('#f-op', 'op');
    bindFilter('#f-wc', 'wc');
    bindFilter('#f-status', 'status');
    bindFilter('#f-from', 'from');
    bindFilter('#f-to', 'to');
    const resetBtn = view.querySelector('[data-act="filter-reset"]');
    if (resetBtn)
      resetBtn.addEventListener('click', () => {
        state.filter = { order: '', op: '', wc: '', status: '', from: '', to: '' };
        ctx.redraw();
      });

    /* 当日计划查询 */
    const dayInput = view.querySelector('#day-date');
    if (dayInput)
      dayInput.addEventListener('change', () => {
        state.dayQuery = dayInput.value;
        ctx.redraw();
      });
    const dayToday = view.querySelector('[data-act="day-today"]');
    if (dayToday)
      dayToday.addEventListener('click', () => {
        state.dayQuery = today();
        ctx.redraw();
      });

    bindSort(
      view,
      () => state.sort,
      (s) => {
        state.sort = s;
      },
      () => ctx.redraw()
    );
  },
};

/** 约束规则说明：把"为什么报、怎么改"讲清楚，而不是只给编号 */
function constraintGuideHtml(hard, soft) {
  const countOf = (code) => [...hard, ...soft].filter((v) => v.code === code).length;
  const row = (c, level) => `
    <tr>
      <td class="mono">${esc(c.code)}</td>
      <td>${badge(level === 'HARD' ? '硬' : '软', level === 'HARD' ? 'danger' : 'warn')}</td>
      <td><b>${esc(c.name)}</b><div class="small muted">${esc(c.desc)}</div></td>
      <td class="small">${esc(c.basis || '')}</td>
      <td class="small">${esc(c.effect || '')}</td>
      <td class="small muted">${esc(c.fix || '')}</td>
      <td class="num">${countOf(c.code) || '<span class="muted">0</span>'}</td>
    </tr>`;
  return `
    <details class="card-b divider-top">
      <summary class="summary-btn">
        约束规则说明（HC-01~05 / SC-01~05 判定口径、影响与处理位置）
      </summary>
      <div class="small muted mt-3 mb-4">
        硬约束（HC）违反时「确认计划」被禁用，必须调到不违反为止；软约束（SC）只提示风险，允许保存。
        下表最后一列是当前计划命中该规则的条数，点编号列可对照上表定位具体对象。
      </div>
      <div class="table-wrap maxh-none">
        <table class="tb fs-12">
          <thead><tr>
            <th>编号</th><th>级别</th><th>规则</th><th>判定口径</th><th>命中后的影响</th><th>怎么改</th><th class="num">命中</th>
          </tr></thead>
          <tbody>
            ${HARD_CONSTRAINTS.map((c) => row(c, 'HARD')).join('')}
            ${SOFT_CONSTRAINTS.map((c) => row(c, 'SOFT')).join('')}
          </tbody>
        </table>
      </div>
    </details>`;
}

/* ───────── 计划表格 ───────── */
function renderTable(rows) {
  return table(
    [
      { title: '订单', sortKey: 'order', render: (r) => `<b>${esc(r.o ? r.o.code : '')}</b>` },
      { title: '序', cls: 'mono', sortKey: 'seq', render: (r) => r.t.seq },
      { title: '工序', sortKey: 'op', render: (r) => esc(r.t.opName) },
      { title: '工作中心', sortKey: 'wc', render: (r) => esc(r.wc ? r.wc.name : '—') },
      { title: '数量', cls: 'num', sortKey: 'qty', render: (r) => num(r.t.planQty) },
      { title: '开始', cls: 'mono', sortKey: 'start', render: (r) => esc(r.t.startDate) },
      { title: '结束', cls: 'mono', sortKey: 'end', render: (r) => esc(r.t.endDate) },
      { title: '工作日', cls: 'num', sortKey: 'days', render: (r) => (r.t.dailyPlan || []).length },
      {
        title: '状态',
        sortKey: 'status',
        render: (r) =>
          badge(
            r.t.status === 'COMPLETED' ? '已完成' : r.t.status === 'IN_PROGRESS' ? '进行中' : '已计划',
            r.t.status === 'COMPLETED' ? 'ok' : r.t.status === 'IN_PROGRESS' ? 'info' : 'muted'
          ),
      },
      {
        title: '',
        cls: 'nowrap',
        render: (r) =>
          `<button class="btn sm ghost" data-task="${r.t.id}">选中</button><button class="btn sm ghost" data-edit="${r.t.id}">调整</button>`,
      },
    ],
    rows,
    { empty: '没有符合条件的工序任务（可重置筛选，或点击「执行自动排产」）', sort: state.sort }
  );
}

/* ───────── 甘特图 ───────── */
function renderGantt(db, tasks, orderMap) {
  if (!tasks.length) return '<div class="empty">尚无排产任务</div>';
  const allDates = [];
  for (const t of tasks) for (const d of t.dailyPlan || []) allDates.push(d.date);
  if (!allDates.length) return '<div class="empty">任务没有按日分解</div>';
  allDates.sort();
  const from = allDates[0];
  const span = Math.min(45, Math.max(1, diffCalendarDays(from, allDates[allDates.length - 1]) + 1));
  const dates = Array.from({ length: span }, (_, i) => addDays(from, i));
  const dateIdx = Object.fromEntries(dates.map((d, i) => [d, i]));

  const head = dates
    .map((d) => {
      const wk = !isWorkday(d, db.calendar);
      const holiday = (db.calendar.holidays || []).some((h) => h.date === d);
      return `<th class="cell ${wk ? 'wk' : ''} ${holiday ? 'hd' : ''}" title="${d}">${d.slice(8)}</th>`;
    })
    .join('');

  const byOrder = {};
  for (const t of tasks) {
    byOrder[t.orderId] = byOrder[t.orderId] || [];
    byOrder[t.orderId].push(t);
  }

  const body = Object.entries(byOrder)
    .map(([orderId, list]) => {
      const o = orderMap[orderId];
      const sorted = [...list].sort((a, b) => a.seq - b.seq);
      const opRows = sorted
        .map((t) => {
          const cells = dates
            .map((d, i) => {
              const has = (t.dailyPlan || []).some((x) => x.date === d);
              const cls = has ? `bar ${t.status === 'COMPLETED' ? 'done' : ''} ${i === 0 ? '' : ''}` : `cell ${!isWorkday(d, db.calendar) ? 'wk' : ''}`;
              const qty = has ? (t.dailyPlan.find((x) => x.date === d) || {}).qty : '';
              return `<td class="${has ? 'cell bar ' + (t.status === 'COMPLETED' ? 'done' : '') : 'cell ' + (!isWorkday(d, db.calendar) ? 'wk' : '')}" title="${has ? `${d} · ${qty} 件` : d}" data-task="${t.id}">${has ? ' ' : ''}</td>`;
            })
            .join('');
          return `<tr class="g-row"><td class="g-label pl-6">${esc(t.opName)} <span class="small">${esc(
            (db.workCenters.find((w) => w.id === t.workCenterId) || {}).code || ''
          )}</span></td>${cells}</tr>`;
        })
        .join('');
      return `<tr class="g-row"><td class="g-label grow-title">${esc(o ? o.code : orderId)} <span class="small">${esc(
        (db.products.find((p) => p.id === (o ? o.productId : '')) || {}).name || ''
      )}</span></td>${dates.map(() => '<td class="cell bg-sub"></td>').join('')}</tr>${opRows}`;
    })
    .join('');

  return `<div class="gantt"><table>
    <thead><tr><th class="g-label">订单 / 工序</th>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table></div>
  <div class="card-b pad-tight">
    <div class="legend">
      <span><i class="sw bar"></i>已计划</span>
      <span><i class="sw done"></i>已完成</span>
      <span><i class="sw panel"></i>非工作日</span>
      <span>显示窗口：${esc(from)} 起 ${span} 天（超出部分可调整日期后查看）</span>
    </div>
  </div>`;
}

/* ───────── 调整辅助面板 ───────── */
function renderAdjustPanel(ctx, t, tasks, orderMap) {
  if (!t) return '<div class="card"><div class="card-b"><div class="empty">选中一条工序任务后可查看替代工作中心与产能情况</div></div></div>';
  const { db } = ctx;
  const o = orderMap[t.orderId];
  const op = (db.routingOps || []).find((x) => x.id === t.opId) || { stdHoursPerUnit: t.stdHoursPerUnit || 1 };
  const cands = candidateCenters(op, db);
  const wc = db.workCenters.find((w) => w.id === t.workCenterId);

  const loadByCenterDate = {};
  for (const x of tasks) for (const d of x.dailyPlan || []) {
    loadByCenterDate[`${x.workCenterId}|${d.date}`] = (loadByCenterDate[`${x.workCenterId}|${d.date}`] || 0) + d.qty;
  }

  return `
    <div class="card">
      <div class="card-h"><h3>调整辅助</h3><span class="desc">${esc(o ? o.code : '')} · ${esc(t.opName)}</span></div>
      <div class="card-b">
        <dl class="kv">
          <dt>当前工作中心</dt><dd>${esc(wc ? wc.name : '—')}</dd>
          <dt>计划日期</dt><dd class="mono-s">${esc(t.startDate)} → ${esc(t.endDate)}</dd>
          <dt>计划数量</dt><dd>${num(t.planQty)} 件</dd>
          <dt>日产能</dt><dd>${num(capacityFor(wc, op))} 件/日</dd>
        </dl>
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h3>候选工作中心</h3><span class="desc">具备该工序能力</span></div>
      <div class="card-b tight">
        ${table(
          [
            {
              title: '工作中心',
              render: (c) => `<b>${esc(c.name)}</b>${c.id === t.workCenterId ? badge('当前', 'info') : ''}<div class="small">${num(capacityFor(c, op))} 件/日</div>`,
            },
            {
              title: '近日负荷',
              render: (c) => {
                const cap = capacityFor(c, op);
                const used = loadByCenterDate[`${c.id}|${t.startDate}`] || 0;
                return `<div class="bar-w-sm">${bar(cap ? used / cap : 0, cap && used > cap ? 'danger' : '')}</div>`;
              },
            },
            {
              title: '',
              render: (c) =>
                c.id === t.workCenterId
                  ? '<span class="small muted">—</span>'
                  : `<button class="btn sm" data-apply-center="${t.id}" data-wc="${c.id}">改派</button>`,
            },
          ],
          cands
        )}
      </div>
    </div>
    <div class="card">
      <div class="card-b">
        <div class="small mb-2">可调整项：工序日期、工作中心、数量。修改后系统重新校验硬约束，命中则不允许保存。</div>
        <button class="btn w-100" data-edit="${t.id}">调整该工序</button>
      </div>
    </div>`;
}

/* ───────── 执行排产 ───────── */
function runNow(ctx) {
  const { db, asOf } = ctx;
  const orders =
    state.scope === 'ALL'
      ? db.productionOrders.filter((o) => ['DRAFT', 'SCHEDULED', 'RELEASED'].includes(o.status))
      : db.productionOrders.filter((o) => o.status === 'DRAFT');

  if (!orders.length) {
    toast(state.scope === 'ALL' ? '没有可排产的订单' : '没有待排产订单；可将范围切换为「全部可排产订单」', 'warn');
    return;
  }

  const versionId = db.activeVersionId;
  // 重排前清掉这些订单在本版本的旧任务（保留已开工的实际数据所在任务）
  const keepIds = new Set(
    db.tasks
      .filter((t) => t.versionId === versionId && orders.some((o) => o.id === t.orderId) && (t.actualStartQty > 0 || t.status !== 'PLANNED'))
      .map((t) => t.orderId)
  );
  const effective = orders.filter((o) => !keepIds.has(o.id));
  if (!effective.length) {
    toast('所选订单均已开工，不能重排（避免覆盖实际执行数据）', 'danger');
    return;
  }

  db.tasks = db.tasks.filter((t) => !(t.versionId === versionId && effective.some((o) => o.id === t.orderId)));

  const res = runSchedule({ db, orders: effective, strategy: state.strategy, versionId, asOf });
  db.tasks.push(...res.tasks);

  for (const o of effective) {
    const list = res.tasks.filter((t) => t.orderId === o.id).sort((a, b) => a.seq - b.seq);
    if (!list.length) continue;
    o.versionId = versionId;
    o.planStart = list[0].startDate;
    o.planEnd = list[list.length - 1].endDate;
    o.forecastEnd = o.planEnd;
    o.status = o.status === 'DRAFT' ? 'SCHEDULED' : o.status;
  }

  state.lastScores = res.scores;
  state.lastWarnings = res.warnings;
  const kept = keepIds.size ? `；${keepIds.size} 张已开工订单保持原计划` : '';
  ctx.commit(`排产完成：${effective.length} 张订单、${res.tasks.length} 条工序任务${kept}`, 'ok');
}

/* ───────── 确认计划 ───────── */
function confirmPlan(ctx, violations) {
  const hard = violations.filter((v) => v.level === 'HARD');
  if (hard.length) {
    toast(`存在 ${hard.length} 处硬约束违规（如 ${hard[0].code} ${hard[0].name}），不允许确认计划`, 'danger');
    return;
  }
  const { db } = ctx;
  const versionId = db.activeVersionId;
  const orders = db.productionOrders.filter((o) => o.status === 'SCHEDULED');
  orders.forEach((o) => {
    o.status = 'RELEASED';
  });
  const v = db.planVersions.find((x) => x.id === versionId);
  if (v) v.appliedAt = ctx.asOf;
  ctx.commit(`计划已确认：${orders.length} 张订单转为「已确认」，可进入生产执行`);
}

/* ───────── 调整单条工序 ───────── */
function editTask(ctx, taskId) {
  const { db } = ctx;
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const versionTasks = db.tasks.filter((t) => t.versionId === task.versionId);
  const order = db.productionOrders.find((o) => o.id === task.orderId);

  // 冻结校验（§4.4.11）
  if (isTaskFrozen(db, order, task, ctx.asOf)) {
    toast(`该任务位于冻结窗口内（自基准日起 ${db.settings.freezeDays} 天），请先在「计划版本」页登记解冻原因`, 'danger');
    return;
  }

  const centers = db.workCenters;

  modal({
    title: `调整工序 · ${task.opName}`,
    body: `
      <div class="notice info">修改后系统会重新校验 HC-01~HC-05；命中硬约束将不予保存。</div>
      <div class="form-row three">
        <div class="field"><label>计划开始日</label><input type="date" id="sd" value="${esc(task.startDate)}" /></div>
        <div class="field"><label>计划结束日</label><input type="date" id="ed" value="${esc(task.endDate)}" /></div>
        <div class="field"><label>计划数量</label><input type="number" id="pq" value="${task.planQty}" min="1" /></div>
      </div>
      <div class="field"><label>工作中心</label><select id="wc">${options(
        centers.map((c) => ({ value: c.id, label: `${c.name}（${capacityFor(c, (db.routingOps || []).find((o) => o.id === task.opId) || { stdHoursPerUnit: 1 })} 件/日）` })),
        task.workCenterId
      )}</select></div>
      <div id="err"></div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn primary" data-ok>校验并保存</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').addEventListener('click', close);
      root.querySelector('[data-ok]').addEventListener('click', () => {
        const draft = {
          ...task,
          startDate: root.querySelector('#sd').value,
          endDate: root.querySelector('#ed').value,
          workCenterId: root.querySelector('#wc').value,
          planQty: Number(root.querySelector('#pq').value),
        };
        if (!draft.startDate || !draft.endDate) {
          root.querySelector('#err').innerHTML = '<div class="notice danger">日期不能为空</div>';
          return;
        }
        if (draft.startDate > draft.endDate) {
          root.querySelector('#err').innerHTML = '<div class="notice danger">开始日不能晚于结束日</div>';
          return;
        }
        const re = replanTask(draft, db, versionTasks);
        const next = re.task;
        const check = checkConstraints(
          versionTasks.map((t) => (t.id === next.id ? next : t)),
          db,
          db.settings
        ).filter((v) => v.taskId === next.id && v.level === 'HARD');

        if (check.length) {
          root.querySelector('#err').innerHTML = check
            .map((v) => `<div class="notice danger"><b>${esc(v.code)} ${esc(v.name)}</b>：${esc(v.msg)}<br/><span class="small">建议：${esc(v.where)}</span></div>`)
            .join('');
          return;
        }
        Object.assign(task, next);
        if (re.warning) toast(re.warning, 'warn');
        close();
        ctx.commit('工序已调整并通过硬约束校验');
      });
    },
  });
}

/* ───────── 改派工作中心 ───────── */
function applyCenter(ctx, taskId, wcId) {
  const { db } = ctx;
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const versionTasks = db.tasks.filter((t) => t.versionId === task.versionId);
  const re = replanTask({ ...task, workCenterId: wcId }, db, versionTasks);
  const check = checkConstraints(
    versionTasks.map((t) => (t.id === task.id ? re.task : t)),
    db,
    db.settings
  ).filter((v) => v.taskId === task.id && v.level === 'HARD');
  if (check.length) {
    toast(`改派被拒绝：${check[0].code} ${check[0].msg}`, 'danger');
    return;
  }
  Object.assign(task, re.task);
  ctx.commit(`已改派至 ${(db.workCenters.find((w) => w.id === wcId) || {}).name}`);
}
