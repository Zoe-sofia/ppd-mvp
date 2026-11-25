/**
 * 计划版本（V1.0 §4.4.10 / §4.4.11）
 * 正式计划 / 模拟方案 / 历史版本；方案比较；应用与放弃；计划冻结与解冻
 */

import { badge, esc, modal, num, table, toast, confirmDialog, options } from '../dom.js';
import { VERSION_KIND, VERSION_STATUS, label, ORDER_STATUS } from '../../core/constants.js';
import { comparePlans } from '../../core/ai.js';
import { frozenTasks, unfreeze, inFreezeWindow } from '../../core/freeze.js';
import { diffCalendarDays } from '../../core/calendar.js';
import { uid } from '../../core/store.js';

export default {
  render(view, ctx) {
    const { db, asOf } = ctx;
    const versions = db.planVersions;
    const active = versions.find((v) => v.id === db.activeVersionId) || versions[0];
    const formal = versions.find((v) => v.kind === 'FORMAL' && v.status === 'ACTIVE');
    const activeTasks = db.tasks.filter((t) => t.versionId === (active ? active.id : ''));
    const formalTasks = db.tasks.filter((t) => t.versionId === (formal ? formal.id : ''));
    const frozen = frozenTasks(db, asOf);

    view.innerHTML = `
      <div class="grid g4">
        <div class="kpi"><div class="k-label">正式计划</div><div class="k-val fs-18">${esc(formal ? formal.code : '—')}</div><div class="k-sub">${formal ? `应用日 ${esc(formal.appliedAt || '—')}` : '无生效版本'}</div></div>
        <div class="kpi"><div class="k-label">当前工作版本</div><div class="k-val fs-18">${esc(active ? active.code : '—')}</div><div class="k-sub">${active ? label(VERSION_KIND, active.kind) : ''} · ${activeTasks.length} 条任务</div></div>
        <div class="kpi ${frozen.length ? 'warn' : 'ok'}"><div class="k-label">冻结窗口内任务</div><div class="k-val">${frozen.length}</div><div class="k-sub">窗口 ${db.settings.freezeDays} 天（0~10 可配）</div></div>
        <div class="kpi"><div class="k-label">历史版本</div><div class="k-val">${versions.filter((v) => v.status === 'ARCHIVED').length}</div><div class="k-sub">已失效版本保留可查</div></div>
      </div>

      <div class="split">
        <div>
          <div class="card">
            <div class="card-h">
              <h3>计划版本</h3>
              <span class="desc">正式计划与模拟方案分开存储；模拟方案不得影响正式计划（BR-17）</span>
              <div class="right">
                <button class="btn sm" data-act="new-scenario">复制为模拟方案</button>
                <button class="btn sm primary" data-act="apply">应用为正式版本</button>
              </div>
            </div>
            <div class="card-b tight">
              ${table(
                [
                  { title: '版本', render: (v) => `<b>${esc(v.code)}</b>${v.id === db.activeVersionId ? badge('当前工作版本', 'info') : ''}<div class="small">${esc(v.name || '')}</div>` },
                  { title: '类型', render: (v) => badge(label(VERSION_KIND, v.kind), v.kind === 'FORMAL' ? 'ok' : 'warn') },
                  { title: '状态', render: (v) => badge(label(VERSION_STATUS, v.status), v.status === 'ACTIVE' ? 'info' : 'muted') },
                  { title: '策略', render: (v) => (v.strategy ? esc(v.strategy) : '—') },
                  { title: '任务数', cls: 'num', render: (v) => db.tasks.filter((t) => t.versionId === v.id).length },
                  { title: '创建 / 应用', cls: 'mono', render: (v) => `${esc(v.createdAt || '—')}<br/>${esc(v.appliedAt || '—')}` },
                  {
                    title: '操作',
                    cls: 'nowrap',
                    render: (v) =>
                      `<button class="btn sm ghost" data-switch="${v.id}">设为工作版本</button>${
                        v.kind === 'SCENARIO' ? `<button class="btn sm ghost" data-drop="${v.id}">放弃</button>` : ''
                      }`,
                  },
                ],
                [...versions].reverse()
              )}
            </div>
          </div>

          ${
            active && active.kind === 'SCENARIO' && formal
              ? `<div class="card">
                  <div class="card-h">
                    <h3>方案比较</h3>
                    <span class="desc">${esc(formal.code)}（正式） vs ${esc(active.code)}（模拟）</span>
                  </div>
                  <div class="card-b tight">${renderCompare(db, formalTasks, activeTasks, formal.code, active.code)}</div>
                </div>`
              : `<div class="card"><div class="card-b"><div class="notice info m-0">如需比较两种排产结果，请先「复制为模拟方案」，在模拟方案中调整后再对比。模拟期间正式计划保持不变。</div></div></div>`
          }
        </div>

        <div class="side-panel">
          <div class="card">
            <div class="card-h"><h3>计划冻结</h3></div>
            <div class="card-b">
              <div class="field">
                <label>冻结周期（天）</label>
                <input type="number" id="fd" value="${db.settings.freezeDays}" min="0" max="10" />
                <div class="hint">自基准日起 N 天内的任务不可直接修改；范围为 0~10 天</div>
              </div>
              <button class="btn w-100" data-act="save-freeze">保存冻结配置</button>
              <div class="hr"></div>
              ${
                frozen.length
                  ? frozen
                      .slice(0, 8)
                      .map((t) => {
                        const o = db.productionOrders.find((x) => x.id === t.orderId);
                        return `<div class="rowline">
                          <div><b>${esc(o ? o.code : '')}</b> ${esc(t.opName)}<div class="small">${esc(t.startDate)}</div></div>
                          <div class="r"><button class="btn sm" data-unfreeze="${t.orderId}">解冻</button></div>
                        </div>`;
                      })
                      .join('')
                  : '<div class="empty">冻结窗口内无任务</div>'
              }
            </div>
          </div>

          <div class="card">
            <div class="card-h"><h3>解冻记录</h3></div>
            <div class="card-b">
              ${
                (db.freezeLogs || []).length
                  ? [...db.freezeLogs]
                      .reverse()
                      .slice(0, 8)
                      .map(
                        (l) => `<div class="rowline">
                          <div><b>${esc(l.orderId)}</b><div class="small">${esc(l.reason)}</div></div>
                          <div class="r mono-s">${esc(l.date)}</div>
                        </div>`
                      )
                      .join('')
                  : '<div class="empty">暂无解冻记录</div>'
              }
            </div>
          </div>
        </div>
      </div>`;

    /* ── 事件 ── */
    view.querySelectorAll('[data-switch]').forEach((b) =>
      b.addEventListener('click', () => {
        db.activeVersionId = b.dataset.switch;
        ctx.commit('已切换工作版本');
      })
    );
    view.querySelectorAll('[data-drop]').forEach((b) =>
      b.addEventListener('click', async () => {
        const ok = await confirmDialog('放弃模拟方案', '该模拟方案及其任务将被删除，正式计划不受影响。确认？', '放弃');
        if (!ok) return;
        const id = b.dataset.drop;
        db.planVersions = db.planVersions.filter((v) => v.id !== id);
        db.tasks = db.tasks.filter((t) => t.versionId !== id);
        if (db.activeVersionId === id) db.activeVersionId = formal.id;
        ctx.commit('模拟方案已删除');
      })
    );
    view.querySelector('[data-act="new-scenario"]').addEventListener('click', () => createScenario(ctx));
    view.querySelector('[data-act="apply"]').addEventListener('click', () => applyScenario(ctx));
    view.querySelector('[data-act="save-freeze"]').addEventListener('click', () => {
      const v = Number(view.querySelector('#fd').value);
      if (!(v >= 0 && v <= 10)) {
        toast('冻结周期需在 0~10 天之间', 'danger');
        return;
      }
      db.settings.freezeDays = v;
      ctx.commit(`冻结周期已设为 ${v} 天`);
    });
    view.querySelectorAll('[data-unfreeze]').forEach((b) =>
      b.addEventListener('click', () => doUnfreeze(ctx, b.dataset.unfreeze))
    );
  },
};

/* ───────── 复制为模拟方案 ───────── */
function createScenario(ctx) {
  const { db, asOf } = ctx;
  const srcId = db.activeVersionId;
  const src = db.planVersions.find((v) => v.id === srcId);
  if (!src) return;

  modal({
    title: '复制为模拟方案',
    body: `
      <div class="notice info">将从「${esc(src.code)}」复制订单选择、工序日期、工作中心与优先级；<b>不复制</b>实际执行数据与物料预留确认。</div>
      <div class="field"><label>方案名称</label><input type="text" id="nm" value="情景模拟 ${new Date().toLocaleDateString('zh-CN')}" /></div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn primary" data-ok>创建</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').addEventListener('click', close);
      root.querySelector('[data-ok]').addEventListener('click', () => {
        const code = `SC-${String(db.planVersions.filter((v) => v.kind === 'SCENARIO').length + 1).padStart(3, '0')}`;
        const id = uid('PV');
        db.planVersions.push({
          id,
          code,
          name: root.querySelector('#nm').value.trim() || code,
          kind: 'SCENARIO',
          status: 'ACTIVE',
          strategy: src.strategy,
          weights: src.weights,
          createdAt: asOf,
          appliedAt: '',
          originVersionId: src.id,
          note: '由正式计划复制',
        });
        const clones = db.tasks
          .filter((t) => t.versionId === src.id)
          .map((t) => ({
            ...t,
            id: `${t.id}-${code}`,
            versionId: id,
            actualStartQty: 0,
            actualDoneQty: 0,
            goodQty: 0,
            scrapQty: 0,
            scrapReasons: {},
            actualStart: '',
            actualEnd: '',
            status: 'PLANNED',
            dailyPlan: (t.dailyPlan || []).map((d) => ({ ...d })),
          }));
        db.tasks.push(...clones);
        db.activeVersionId = id;
        close();
        ctx.commit(`已创建模拟方案 ${code}（${clones.length} 条任务），当前工作版本已切换`);
      });
    },
  });
}

/* ───────── 应用为正式版本 ───────── */
async function applyScenario(ctx) {
  const { db } = ctx;
  const active = db.planVersions.find((v) => v.id === db.activeVersionId);
  if (!active) return;
  if (active.kind === 'FORMAL' && active.status === 'ACTIVE') {
    toast('当前工作版本已是正式计划', 'warn');
    return;
  }

  // 冻结校验：模拟方案中若改动了冻结窗口内的任务，应用前必须提示
  const formal = db.planVersions.find((v) => v.kind === 'FORMAL' && v.status === 'ACTIVE');
  const formalTasks = db.tasks.filter((t) => t.versionId === (formal ? formal.id : ''));
  const scenarioTasks = db.tasks.filter((t) => t.versionId === active.id);
  const changed = scenarioTasks.filter((t) => {
    const before = formalTasks.find((x) => x.orderId === t.orderId && x.seq === t.seq);
    if (!before) return false;
    return before.startDate !== t.startDate || before.workCenterId !== t.workCenterId;
  });
  const frozenChanged = changed.filter((t) => {
    const order = db.productionOrders.find((o) => o.id === t.orderId);
    return isFrozenOrderTask(db, order, t, ctx.asOf);
  });

  const ok = await confirmDialog(
    '应用为正式版本',
    `${frozenChanged.length ? `<b>注意：</b>本次应用改动了冻结窗口内 ${frozenChanged.length} 条任务。<br/>` : ''}应用后「${esc(active.code)}」将成为正式计划，原正式计划置为已失效但保留可查。确认继续？`,
    '应用'
  );
  if (!ok) return;

  if (formal) formal.status = 'ARCHIVED';
  active.kind = 'FORMAL';
  active.status = 'ACTIVE';
  active.appliedAt = ctx.asOf;
  db.activeVersionId = active.id;

  for (const o of db.productionOrders) {
    const list = db.tasks.filter((t) => t.versionId === active.id && t.orderId === o.id).sort((a, b) => a.seq - b.seq);
    if (!list.length) continue;
    o.versionId = active.id;
    o.planStart = list[0].startDate;
    o.planEnd = list[list.length - 1].endDate;
    o.forecastEnd = o.planEnd;
    if (['DRAFT', 'SCHEDULED'].includes(o.status)) o.status = 'RELEASED';
  }
  ctx.commit(`已应用为正式版本 ${active.code}；旧版本已归档`);
}

function isFrozenOrderTask(db, order, task, asOf) {
  if (!order || !['RELEASED', 'IN_PROGRESS'].includes(order.status)) return false;
  return inFreezeWindow(db, task.startDate, asOf);
}

/* ───────── 方案比较 ───────── */
function renderCompare(db, tasksA, tasksB, labelA, labelB) {
  const cmp = comparePlans(db, tasksA, tasksB, labelA, labelB);
  const changed = cmp.delivery.filter((r) => r.aEnd !== r.bEnd || r.aStart !== r.bStart);
  return `
    <div class="card-b pb-0">
      <div class="grid g3">
        ${cmp.capacity
          .map(
            (m) => `<div class="kpi"><div class="k-label">${esc(m.metric)}</div>
              <div class="k-val fs-18">${m.a} → ${m.b}
              <span class="small">${m.b < m.a ? '↓ 更优' : m.b > m.a ? '↑ 变差' : '持平'}</span></div></div>`
          )
          .join('')}
        <div class="kpi"><div class="k-label">延期订单数</div>
          <div class="k-val fs-18">${cmp.material[0].a} → ${cmp.material[0].b}
          <span class="small">${cmp.material[0].b < cmp.material[0].a ? '↓ 更优' : cmp.material[0].b > cmp.material[0].a ? '↑ 变差' : '持平'}</span></div></div>
      </div>
    </div>
    ${table(
      [
        { title: '订单', render: (r) => `<b>${esc(r.code)}</b>` },
        { title: '客户交期', cls: 'mono', render: (r) => esc(r.due) },
        { title: 'A 起止', cls: 'mono', render: (r) => `${esc(r.aStart)} → ${esc(r.aEnd)}` },
        { title: 'B 起止', cls: 'mono', render: (r) => `${esc(r.bStart)} → ${esc(r.bEnd)}` },
        { title: '完工变化', cls: 'num', render: (r) => (r.shift === 0 ? '—' : r.shift > 0 ? `<span class="c-danger">+${r.shift} 天</span>` : `<span class="c-ok">${r.shift} 天</span>`) },
        { title: 'A 延期', cls: 'num', render: (r) => (r.aDelay > 0 ? r.aDelay : '—') },
        { title: 'B 延期', cls: 'num', render: (r) => (r.bDelay > 0 ? r.bDelay : '—') },
      ],
      changed.length ? changed : cmp.delivery.slice(0, 20),
      { empty: '两个版本的订单安排完全一致' }
    )}`;
}

/* ───────── 解冻 ───────── */
function doUnfreeze(ctx, orderId) {
  const { db, asOf } = ctx;
  const order = db.productionOrders.find((o) => o.id === orderId);
  const affected = frozenTasks(db, asOf).filter((t) => t.orderId === orderId).map((t) => t.id);

  modal({
    title: `解冻 · ${order ? order.code : orderId}`,
    body: `
      <div class="notice warn">解冻将影响 ${affected.length} 条处于冻结窗口内的任务。解冻原因必须填写并留痕。</div>
      <div class="field"><label>解冻原因 <span class="req">*</span></label>
        <textarea id="rs" rows="3" placeholder="如：客户催单，需将首工序提前 2 天"></textarea></div>
      <div class="hint">MVP 只记录解冻原因，不设审批流程（§4.4.11）。</div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn primary" data-ok>确认解冻</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').addEventListener('click', close);
      root.querySelector('[data-ok]').addEventListener('click', () => {
        const reason = root.querySelector('#rs').value.trim();
        if (!reason) {
          toast('解冻原因不能为空', 'danger');
          return;
        }
        unfreeze(db, orderId, reason, asOf, affected);
        close();
        ctx.commit('已解冻并记录原因');
      });
    },
  });
}
