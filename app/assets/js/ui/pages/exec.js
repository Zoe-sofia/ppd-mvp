/**
 * 生产执行跟踪（V1.0 §4.5）
 * 订单级 + 工序级进度、部分数量开工、数量守恒拦截、报工导入
 */

import { badge, esc, modal, num, table, toast, download, options } from '../dom.js';
import { ORDER_STATUS, SCRAP_REASONS, TASK_STATUS, label } from '../../core/constants.js';
import {
  orderProgress,
  validateStart,
  validateComplete,
  applyStart,
  applyComplete,
  validateReportRows,
  appendActual,
} from '../../core/execution.js';
import { kittingOf } from '../../core/rules.js';
import { parseCsv } from '../../io.js';

let selected = '';

export default {
  render(view, ctx) {
    const { db, asOf } = ctx;
    const orders = db.productionOrders
      .filter((o) => !['CANCELLED', 'CLOSED'].includes(o.status))
      // 在制的排前面：进入页面先看到正在做的事，而不是最末尾一张还没开工的单
      .sort((a, b) => {
        const rank = (o) => (o.status === 'IN_PROGRESS' ? 0 : 1);
        return rank(a) - rank(b) || b.code.localeCompare(a.code);
      });
    if (!selected || !orders.some((o) => o.id === selected)) selected = orders[0] ? orders[0].id : '';
    const order = orders.find((o) => o.id === selected);
    const prog = order ? orderProgress(db, order, order.versionId) : null;

    view.innerHTML = `
      <div class="card">
        <div class="card-h">
          <h3>订单级进度</h3>
          <span class="desc">待生产 = 计划量 − 已开工；剩余 = 计划量 − 合格完成</span>
          <div class="right"><button class="btn sm" data-act="import">Excel 报工导入</button><button class="btn sm" data-act="tpl">下载报工模板</button></div>
        </div>
        <div class="card-b tight">
          ${table(
            [
              { title: '生产订单', render: (o) => `<b>${esc(o.code)}</b>` },
              { title: '产品', render: (o) => esc((db.products.find((p) => p.id === o.productId) || {}).name || '') },
              { title: '计划量', cls: 'num', render: (o) => num(o.qty) },
              {
                title: '已开工',
                cls: 'num',
                render: (o) => {
                  const p = orderProgress(db, o, o.versionId);
                  return num(p.startedQty);
                },
              },
              {
                title: '合格完成',
                cls: 'num',
                render: (o) => {
                  const p = orderProgress(db, o, o.versionId);
                  return num(p.goodQty);
                },
              },
              {
                title: '不良',
                cls: 'num',
                render: (o) => {
                  const p = orderProgress(db, o, o.versionId);
                  return p.scrapQty ? `<span style="color:var(--danger)">${p.scrapQty}</span>` : '0';
                },
              },
              {
                title: '待生产',
                cls: 'num',
                render: (o) => {
                  const p = orderProgress(db, o, o.versionId);
                  return num(p.toProduce);
                },
              },
              {
                title: '状态',
                render: (o) => badge(label(ORDER_STATUS, o.status), o.status === 'COMPLETED' ? 'ok' : o.status === 'IN_PROGRESS' ? 'info' : 'muted'),
              },
              { title: '', render: (o) => `<button class="btn sm ghost" data-sel="${o.id}">录入</button>` },
            ],
            orders,
            { empty: '没有可执行的订单' }
          )}
        </div>
      </div>

      ${
        order
          ? `<div class="card">
              <div class="card-h">
                <h3>工序级进度 · ${esc(order.code)}</h3>
                <span class="desc">下游开工不得超过上游合格可流转量；开工时校验物料库存</span>
                <div class="right">
                  <span class="small">物料最多可开工 <b>${kittingOf(order, db, order.planStart).maxStartByStock}</b> 件</span>
                </div>
              </div>
              <div class="card-b tight">
                ${table(
                  [
                    { title: '序', cls: 'mono', render: (t) => t.seq },
                    { title: '工序', render: (t) => esc(t.opName) },
                    { title: '工作中心', render: (t) => esc((db.workCenters.find((w) => w.id === t.workCenterId) || {}).name || '') },
                    { title: '计划量', cls: 'num', render: (t) => num(t.planQty) },
                    { title: '已开工', cls: 'num', render: (t) => num(t.actualStartQty) },
                    { title: '已完成', cls: 'num', render: (t) => num(t.actualDoneQty) },
                    { title: '合格', cls: 'num', render: (t) => num(t.goodQty) },
                    {
                      title: '不良',
                      cls: 'num',
                      render: (t) =>
                        t.scrapQty
                          ? `<span style="color:var(--danger)" title="${esc(
                              Object.entries(t.scrapReasons || {})
                                .map(([k, v]) => `${(SCRAP_REASONS.find((r) => r.code === k) || {}).name || k}: ${v}`)
                                .join('，')
                            )}">${t.scrapQty}</span>`
                          : '0',
                    },
                    { title: '状态', render: (t) => badge(label(TASK_STATUS, t.status), t.status === 'COMPLETED' ? 'ok' : t.status === 'IN_PROGRESS' ? 'info' : 'muted') },
                    {
                      title: '操作',
                      cls: 'nowrap',
                      render: (t) =>
                        `<button class="btn sm ghost" data-start="${t.id}">开工</button><button class="btn sm ghost" data-done="${t.id}">完工</button>`,
                    },
                  ],
                  prog ? prog.tasks : []
                )}
              </div>
              <div class="card-b">
                <div class="notice info" style="margin:0">
                  数量勾稽：订单已开工 = 首道工序累计开工量（${prog ? prog.startedQty : 0}）；订单合格完成 = 末道工序累计合格量（${prog ? prog.goodQty : 0}）。
                  报废、返工与返修流程不在 MVP 范围，不良数量仅隔离，不参与下游流转。
                </div>
              </div>
            </div>
            ${renderHistory(db, order)}`
          : ''
      }`;

    view.querySelectorAll('[data-sel]').forEach((b) =>
      b.addEventListener('click', () => {
        selected = b.dataset.sel;
        ctx.redraw();
      })
    );
    view.querySelectorAll('[data-start]').forEach((b) =>
      b.addEventListener('click', () => startModal(ctx, b.dataset.start))
    );
    view.querySelectorAll('[data-done]').forEach((b) =>
      b.addEventListener('click', () => completeModal(ctx, b.dataset.done))
    );
    view.querySelector('[data-act="tpl"]').addEventListener('click', () => {
      download(
        '报工导入模板.csv',
        '生产订单号,工序号,日期,合格数,不良数,不良原因\nPO-001,10,2026-11-24,20,2,DIMENSION\n'
      );
    });
    view.querySelector('[data-act="import"]').addEventListener('click', () => importModal(ctx));
  },
};

/* ───────── 报工履历 ───────── */
function renderHistory(db, order) {
  const rows = (db.actuals || [])
    .filter((a) => a.orderId === order.id)
    .sort((a, b) => `${b.date}|${b.createdAt}`.localeCompare(`${a.date}|${a.createdAt}`));

  return `<div class="card">
    <div class="card-h">
      <h3>报工履历 · ${esc(order.code)}</h3>
      <span class="desc">只增不改：每次申报都留痕，用于追溯与对账（共 ${rows.length} 条）</span>
    </div>
    <div class="card-b tight">
      ${table(
        [
          { title: '日期', cls: 'mono', render: (a) => esc(a.date) },
          { title: '类型', render: (a) => badge(a.type === 'START' ? '开工' : '完工', a.type === 'START' ? 'info' : 'ok') },
          { title: '工序', render: (a) => `${a.seq} ${esc(a.opName)}` },
          { title: '工作中心', render: (a) => esc((db.workCenters.find((w) => w.id === a.workCenterId) || {}).name || '') },
          { title: '开工量', cls: 'num', render: (a) => (a.qty ? num(a.qty) : '—') },
          { title: '合格', cls: 'num', render: (a) => (a.type === 'COMPLETE' ? num(a.good) : '—') },
          { title: '不良', cls: 'num', render: (a) => (a.scrap ? `<span style="color:var(--danger)">${a.scrap}</span>` : '—') },
          {
            title: '不良原因',
            render: (a) =>
              a.scrap ? esc((SCRAP_REASONS.find((r) => r.code === a.reason) || {}).name || a.reason || '') : '—',
          },
          { title: '录入', render: (a) => `<span class="small">${esc(a.operator || '')} ${esc(a.createdAt || '')}</span>` },
        ],
        rows.slice(0, 15),
        { empty: '该订单暂无报工记录' }
      )}
    </div>
    ${rows.length > 15 ? `<div class="card-b"><div class="small">仅显示最近 15 条，共 ${rows.length} 条。</div></div>` : ''}
  </div>`;
}

/* ───────── 开工 ───────── */
function startModal(ctx, taskId) {
  const { db, asOf } = ctx;
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const order = db.productionOrders.find((o) => o.id === task.orderId);
  const k = kittingOf(order, db, order.planStart);

  modal({
    title: `开工 · ${task.opName}`,
    body: `
      <dl class="kv" style="margin-bottom:12px">
        <dt>计划数量</dt><dd>${num(task.planQty)} 件</dd>
        <dt>已开工</dt><dd>${num(task.actualStartQty)} 件</dd>
        <dt>物料可开工上限</dt><dd>${k.maxStartByStock} 件（按当前库存）</dd>
      </dl>
      <div class="form-row">
        <div class="field"><label>开工日期</label><input type="date" id="d" value="${esc(asOf)}" /></div>
        <div class="field"><label>开工数量 <span class="req">*</span></label><input type="number" id="q" value="${Math.max(
          1,
          Math.min(task.planQty - task.actualStartQty, k.maxStartByStock - num(task.actualStartQty))
        )}" min="1" /></div>
      </div>
      <div id="err"></div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn primary" data-ok>校验并开工</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').addEventListener('click', close);
      root.querySelector('[data-ok]').addEventListener('click', () => {
        const qty = Number(root.querySelector('#q').value);
        const date = root.querySelector('#d').value;
        const r = validateStart(db, task, qty, date);
        if (!r.ok) {
          // 缺料停工自动记录（用于"缺料停工次数"指标）
          if (/物料不足/.test(r.message)) {
            db.blockedLog = db.blockedLog || [];
            db.blockedLog.push({ date, orderId: task.orderId, taskId: task.id, qty, reason: r.message });
          }
          root.querySelector('#err').innerHTML = `<div class="notice danger"><b>开工被拒绝：</b>${esc(r.message)}</div>`;
          ctx.persist();
          return;
        }
        Object.assign(task, applyStart(task, qty, date));
        appendActual(db, { task, type: 'START', qty, date });
        order.actualStart = order.actualStart || date;
        if (order.status === 'RELEASED' || order.status === 'SCHEDULED') order.status = 'IN_PROGRESS';
        close();
        ctx.commit(`已开工 ${qty} 件`);
      });
    },
  });
}

/* ───────── 完工申报 ───────── */
function completeModal(ctx, taskId) {
  const { db, asOf } = ctx;
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const left = num(task.actualStartQty) - num(task.actualDoneQty);

  modal({
    title: `完工申报 · ${task.opName}`,
    body: `
      <div class="notice info">已开工未完成 ${left} 件；本次申报（合格 + 不良）不得超过该数量。</div>
      <div class="form-row">
        <div class="field"><label>合格数量</label><input type="number" id="g" value="${Math.max(0, left)}" min="0" /></div>
        <div class="field"><label>不良数量</label><input type="number" id="s" value="0" min="0" /></div>
      </div>
      <div class="form-row">
        <div class="field"><label>不良原因</label><select id="r">${options(
          SCRAP_REASONS.map((x) => ({ value: x.code, label: x.name })),
          'DIMENSION'
        )}</select></div>
        <div class="field"><label>日期</label><input type="date" id="d" value="${esc(asOf)}" /></div>
      </div>
      <div id="err"></div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn primary" data-ok>提交</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').addEventListener('click', close);
      root.querySelector('[data-ok]').addEventListener('click', () => {
        const good = Number(root.querySelector('#g').value);
        const scrap = Number(root.querySelector('#s').value);
        const reason = root.querySelector('#r').value;
        const date = root.querySelector('#d').value;
        const r = validateComplete(db, task, good, scrap);
        if (!r.ok) {
          root.querySelector('#err').innerHTML = `<div class="notice danger">${esc(r.message)}</div>`;
          return;
        }
        Object.assign(task, applyComplete(task, good, scrap, reason, date));
        appendActual(db, { task, type: 'COMPLETE', good, scrap, reason, date });
        const order = db.productionOrders.find((o) => o.id === task.orderId);
        if (order) {
          const p = orderProgress(db, order, order.versionId);
          if (p.remaining === 0) {
            order.actualEnd = date;
            order.status = 'COMPLETED';
          }
        }
        close();
        ctx.commit(`已申报：合格 ${good}，不良 ${scrap}`);
      });
    },
  });
}

/* ───────── 报工导入 ───────── */
function importModal(ctx) {
  const { db } = ctx;
  modal({
    title: 'Excel 报工导入',
    body: `
      <div class="notice info">支持 CSV（UTF-8）与 XLSX。列：生产订单号、工序号、日期、合格数、不良数、不良原因。
      单据类导入<b>重复即拒绝</b>，且逐行校验数量流转关系，错误行不会入库。</div>
      <div class="field"><label>选择文件</label><input type="file" id="f" accept=".csv,.xlsx" /></div>
      <div id="out"></div>`,
    footer: `<button class="btn" data-c>关闭</button><button class="btn primary" data-ok>校验并导入</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').addEventListener('click', close);
      root.querySelector('[data-ok]').addEventListener('click', async () => {
        const f = root.querySelector('#f').files[0];
        const out = root.querySelector('#out');
        if (!f) {
          out.innerHTML = '<div class="notice warn">请先选择文件</div>';
          return;
        }
        try {
          const text = await f.text();
          const parsed = parseCsv(text);
          const rows = parsed.rows.map((r) => ({
            orderCode: r['生产订单号'],
            seq: r['工序号'],
            date: r['日期'],
            good: Number(r['合格数'] || 0),
            scrap: Number(r['不良数'] || 0),
            reason: r['不良原因'] || 'OTHER',
          }));
          const errors = validateReportRows(rows, db);
          if (errors.length) {
            out.innerHTML = `<div class="notice danger"><b>${errors.length} 行未通过校验，整批未导入：</b><br/>${errors
              .slice(0, 8)
              .map((e) => `第 ${e.line} 行 · ${esc(e.field)}：${esc(e.message)}`)
              .join('<br/>')}</div>`;
            return;
          }
          let applied = 0;
          for (const r of rows) {
            const o = db.productionOrders.find((x) => x.code === r.orderCode);
            const t = db.tasks.find((x) => x.orderId === o.id && String(x.seq) === String(r.seq));
            if (!t) continue;
            Object.assign(t, applyComplete(t, r.good, r.scrap, r.reason, r.date));
            appendActual(db, { task: t, type: 'COMPLETE', good: r.good, scrap: r.scrap, reason: r.reason, date: r.date });
            applied += 1;
          }
          close();
          ctx.commit(`报工导入成功：${applied} 行`);
        } catch (e) {
          out.innerHTML = `<div class="notice danger">解析失败：${esc(e.message)}</div>`;
        }
      });
    },
  });
}
