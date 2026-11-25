/**
 * 订单管理（V1.0 §4.2）
 * 销售订单 / 生产订单；生产订单为核心计划对象
 * 一拆多、多对一通过「行-单」关联层表达（P-02）
 */

import { badge, esc, modal, num, table, tabs, toast, confirmDialog, options, sortRows, bindSort } from '../dom.js';
import { ORDER_STATUS, KITTING_STATUS, RISK_STATUS, label, toneOf } from '../../core/constants.js';
import { scoreOrder, committedUtilization } from '../../core/scheduler.js';
import { kittingOf } from '../../core/rules.js';
import { riskOf, dueDateOf, finishDateOf } from '../../core/metrics.js';
import { orderProgress } from '../../core/execution.js';
import { uid } from '../../core/store.js';

let tab = 'po';
let kw = '';
let statusFilter = '';
/** 生产订单表排序：{ key, dir } | null */
let sort = { key: 'code', dir: 'desc' };

/**
 * 销售行已建立的生产订单
 *
 * 两处关联都要看：orderLinks 是标准关联表；salesOrderLineId 是订单上的冗余外键。
 * 历史导入数据可能只写了后者（导入补丁之前），只看 orderLinks 会误显示「建立生产订单」。
 */
function ordersOfLine(db, lineId) {
  const ids = new Set();
  for (const l of db.orderLinks || []) if (l.lineId === lineId) ids.add(l.orderId);
  for (const o of db.productionOrders || []) if (o.salesOrderLineId === lineId) ids.add(o.id);
  return [...ids].map((id) => db.productionOrders.find((o) => o.id === id)).filter(Boolean);
}

/** 生产订单行排序取值 */
function poSortValue(r, key) {
  const o = r;
  if (key === 'productCode') return (r.__product || {}).code || '';
  if (key === 'product') return (r.__product || {}).name || '';
  if (key === 'due') return dueDateOf(r.__db, o) || '';
  if (key === 'qty') return Number(o.qty) || 0;
  if (key === 'priority') return Number(o.manualPriority) || 0;
  if (key === 'status') return o.status || '';
  if (key === 'start') return o.planStart || '';
  if (key === 'finish') return r.__finish || '';
  return o[key] ?? '';
}

const store = { get: () => ({ tab, kw, statusFilter }), set: (p) => Object.assign({}, p) };

export default {
  render(view, ctx) {
    const { db, asOf } = ctx;

    const soRows = db.salesOrders.filter((s) => !kw || s.code.includes(kw) || s.customer.includes(kw));
    const poBase = db.productionOrders
      .filter((o) => !kw || o.code.includes(kw) || (o.remark || '').includes(kw))
      .filter((o) => !statusFilter || o.status === statusFilter)
      .map((o) => ({
        ...o,
        __db: db,
        __product: db.products.find((p) => p.id === o.productId) || {},
        __finish: finishDateOf(db, o).date || '',
      }));
    const poRows = sortRows(poBase, sort, poSortValue);

    const util = committedUtilization(db, db.activeVersionId);

    view.innerHTML = `
      ${tabs(
        [
          { key: 'po', label: '生产订单', count: db.productionOrders.length },
          { key: 'so', label: '销售订单', count: db.salesOrders.length },
        ],
        tab
      )}
      <div class="card" style="border-top:0;border-radius:0 0 6px 6px">
        <div class="toolbar">
          <input type="text" id="kw" placeholder="搜索订单号 / 客户 / 备注" value="${esc(kw)}" style="width:260px" />
          ${
            tab === 'po'
              ? `<select id="st" style="width:150px">${options(
                  Object.values(ORDER_STATUS).map((s) => ({ value: s.code, label: s.name })),
                  statusFilter,
                  '全部状态'
                )}</select>`
              : ''
          }
          <button class="btn sm" data-act="search">筛选</button>
          <button class="btn sm ghost" data-act="reset">重置</button>
          <span class="spacer"></span>
          <span class="small">生产订单为系统核心计划对象；销售订单行可拆分为多张生产订单，多行也可合并为一张</span>
        </div>

        ${
          tab === 'po'
            ? table(
                [
                  { title: '生产订单号', sortKey: 'code', render: (o) => `<b>${esc(o.code)}</b>${o.remark ? `<div class="small">${esc(o.remark)}</div>` : ''}` },
                  {
                    title: '关联销售行',
                    render: (o) => {
                      const links = db.orderLinks.filter((l) => l.orderId === o.id);
                      return links.length > 1
                        ? `${badge(`${links.length} 行合并`, 'info')}`
                        : `<span class="mono-s">${esc(links[0] ? links[0].lineId : o.salesOrderLineId || '—')}</span>`;
                    },
                  },
                  {
                    title: '产品编号',
                    sortKey: 'productCode',
                    render: (o) => `<span class="mono-s">${esc(o.__product.code || '—')}</span>`,
                  },
                  { title: '产品', sortKey: 'product', render: (o) => esc(o.__product.name || o.productId) },
                  { title: '数量', cls: 'num', sortKey: 'qty', render: (o) => num(o.qty) },
                  { title: '人工优先级', sortKey: 'priority', render: (o) => `P${o.manualPriority || 3}` },
                  { title: '客户交期', cls: 'mono', sortKey: 'due', render: (o) => esc(dueDateOf(db, o) || '—') },
                  { title: '计划起止', cls: 'mono', sortKey: 'start', render: (o) => `${esc(o.planStart || '—')}<br/>${esc(o.planEnd || '—')}` },
                  { title: '预计完工', cls: 'mono', sortKey: 'finish', render: (o) => esc(o.__finish || '—') },
                  { title: '状态', sortKey: 'status', render: (o) => badge(label(ORDER_STATUS, o.status), o.status === 'COMPLETED' ? 'ok' : o.status === 'IN_PROGRESS' ? 'info' : 'muted') },
                  {
                    title: '齐套',
                    render: (o) => {
                      const k = kittingOf(o, db, o.planStart);
                      return badge(label(KITTING_STATUS, k.status), toneOf(KITTING_STATUS, k.status));
                    },
                  },
                  {
                    title: '交付风险',
                    render: (o) => {
                      const r = riskOf(db, o);
                      return badge(label(RISK_STATUS, r.code), toneOf(RISK_STATUS, r.code));
                    },
                  },
                  {
                    title: '操作',
                    cls: 'nowrap',
                    render: (o) =>
                      `<button class="btn sm ghost" data-detail="${o.id}">详情</button><button class="btn sm ghost" data-pri="${o.id}">优先级</button>`,
                  },
                ],
                poRows,
                { empty: '没有符合条件的生产订单。可从「销售订单」页为订单行建立生产订单。', sort }
              )
            : table(
                [
                  { title: '销售订单', render: (s) => `<b>${esc(s.code)}</b>` },
                  { title: '客户', render: (s) => esc(s.customer) },
                  { title: '下单日期', cls: 'mono', render: (s) => esc(s.orderDate) },
                  {
                    title: '订单行',
                    render: (s) => {
                      const lines = db.salesOrderLines.filter((l) => l.salesOrderId === s.id);
                      return lines
                        .map(
                          (l) =>
                            `<div class="rowline" style="padding:3px 0">
                              <span class="mono-s">${esc(l.id)}</span>
                              <span>${esc((db.products.find((p) => p.id === l.productId) || {}).name || '')} × ${num(l.qty)}</span>
                              <span class="r">${esc(l.dueDate)}</span>
                            </div>`
                        )
                        .join('');
                    },
                  },
                  {
                    title: '生产订单',
                    render: (s) => {
                      const lines = db.salesOrderLines.filter((l) => l.salesOrderId === s.id);
                      return lines
                        .map((l) => {
                          const pos = ordersOfLine(db, l.id);
                          return `<div class="rowline" style="padding:3px 0">
                            <span class="mono-s">${esc(l.id)}</span>
                            <span class="r">${
                              pos.length
                                ? pos.map((o) => `<span class="badge info" title="${esc(o.status)}">${esc(o.code)}</span>`).join(' ')
                                : `<button class="btn sm" data-mk="${l.id}">建立生产订单</button>`
                            }</span>
                          </div>`;
                        })
                        .join('');
                    },
                  },
                ],
                soRows,
                { empty: '没有符合条件的销售订单' }
              )
        }
      </div>`;

    /* ── 事件 ── */
    view.querySelectorAll('[data-action="switch-tab"]').forEach((el) =>
      el.addEventListener('click', () => {
        tab = el.dataset.tab;
        ctx.redraw();
      })
    );
    const search = () => {
      kw = view.querySelector('#kw').value.trim();
      const st = view.querySelector('#st');
      statusFilter = st ? st.value : '';
      ctx.redraw();
    };
    view.querySelector('[data-act="search"]').addEventListener('click', search);
    view.querySelector('#kw').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') search();
    });
    view.querySelector('[data-act="reset"]').addEventListener('click', () => {
      kw = '';
      statusFilter = '';
      ctx.redraw();
    });

    view.querySelectorAll('[data-detail]').forEach((b) =>
      b.addEventListener('click', () => showDetail(ctx, b.dataset.detail, util))
    );
    view.querySelectorAll('[data-pri]').forEach((b) =>
      b.addEventListener('click', () => editPriority(ctx, b.dataset.pri))
    );
    view.querySelectorAll('[data-mk]').forEach((b) =>
      b.addEventListener('click', () => makeOrder(ctx, b.dataset.mk))
    );
    bindSort(
      view,
      () => sort,
      (s) => {
        sort = s;
      },
      () => ctx.redraw()
    );
  },
};

/* ───────── 详情 ───────── */
function showDetail(ctx, orderId, util) {
  const { db } = ctx;
  const o = db.productionOrders.find((x) => x.id === orderId);
  if (!o) return;
  const links = db.orderLinks.filter((l) => l.orderId === o.id);
  const k = kittingOf(o, db, o.planStart);
  const r = riskOf(db, o);
  const p = orderProgress(db, o, o.versionId);
  const sc = scoreOrder(o, db, ctx.asOf, 'DELIVERY', util);
  const tasks = db.tasks.filter((t) => t.orderId === o.id && t.status !== 'CANCELLED').sort((a, b) => a.seq - b.seq);

  const body = `
    <dl class="kv" style="margin-bottom:14px">
      <dt>生产订单</dt><dd><b>${esc(o.code)}</b> ${badge(label(ORDER_STATUS, o.status), 'info')}</dd>
      <dt>产品 / 数量</dt><dd>${esc((db.products.find((x) => x.id === o.productId) || {}).name || '')} × ${num(o.qty)}</dd>
      <dt>客户交期</dt><dd>${esc(dueDateOf(db, o) || '—')}（客户要求生产完工日）</dd>
      <dt>计划 / 预计完工</dt><dd>${esc(o.planEnd || '—')} / ${esc(finishDateOf(db, o).date || '—')}</dd>
      <dt>交付风险</dt><dd>${badge(label(RISK_STATUS, r.code), toneOf(RISK_STATUS, r.code))}${r.delayDays ? ` 延迟 ${r.delayDays} 天` : ''}</dd>
      <dt>物料齐套</dt><dd>${badge(label(KITTING_STATUS, k.status), toneOf(KITTING_STATUS, k.status))}　最大可开工 <b>${k.maxStartByStock}</b> 件（含已确认到货 ${k.maxStartByInbound} 件）</dd>
      <dt>数量进度</dt><dd>已开工 ${p.startedQty} · 合格完成 ${p.goodQty} · 待生产 ${p.toProduce} · 剩余 ${p.remaining}</dd>
    </dl>

    <h4 style="margin:14px 0 6px;font-size:12.5px">关联销售行（一拆多 / 多对一）</h4>
    ${
      links.length
        ? table(
            [
              { title: '销售行', render: (l) => `<span class="mono-s">${esc(l.lineId)}</span>` },
              {
                title: '客户 / 产品',
                render: (l) => {
                  const line = db.salesOrderLines.find((x) => x.id === l.lineId) || {};
                  const so = db.salesOrders.find((s) => s.id === line.salesOrderId) || {};
                  return `${esc(so.customer || '')} / ${esc((db.products.find((p2) => p2.id === line.productId) || {}).name || '')}`;
                },
              },
              { title: '行数量', cls: 'num', render: (l) => num(l.qty) },
              { title: '行交期', cls: 'mono', render: (l) => esc((db.salesOrderLines.find((x) => x.id === l.lineId) || {}).dueDate || '') },
            ],
            links
          )
        : '<div class="small">无关联记录</div>'
    }

    <h4 style="margin:14px 0 6px;font-size:12.5px">优先级评分（当前策略：交付优先）</h4>
    <div class="notice info" style="margin-bottom:8px">
      综合得分 <b>${sc.total}</b>　交期桶 ${sc.buckets.DELIVERY} × ${sc.weights.DELIVERY}%
      　物料桶 ${sc.buckets.MATERIAL} × ${sc.weights.MATERIAL}%
      　产能桶 ${sc.buckets.CAPACITY} × ${sc.weights.CAPACITY}%
    </div>
    ${table(
      [
        { title: '评分因素', render: (f) => esc(f.name) },
        { title: '得分', cls: 'num', render: (f) => f.value },
        { title: '依据', render: (f) => `<span class="small">${esc(f.note)}</span>` },
      ],
      sc.factors
    )}

    <h4 style="margin:14px 0 6px;font-size:12.5px">工序任务</h4>
    ${
      tasks.length
        ? table(
            [
              { title: '序', cls: 'mono', render: (t) => t.seq },
              { title: '工序', render: (t) => esc(t.opName) },
              { title: '工作中心', render: (t) => esc((db.workCenters.find((w) => w.id === t.workCenterId) || {}).name || '') },
              { title: '计划量', cls: 'num', render: (t) => num(t.planQty) },
              { title: '计划日期', cls: 'mono', render: (t) => `${esc(t.startDate)} → ${esc(t.endDate)}` },
              { title: '开工/合格', cls: 'num', render: (t) => `${num(t.actualStartQty)} / ${num(t.goodQty)}` },
              { title: '状态', render: (t) => badge(t.status === 'COMPLETED' ? '已完成' : t.status === 'IN_PROGRESS' ? '进行中' : '已计划', t.status === 'COMPLETED' ? 'ok' : t.status === 'IN_PROGRESS' ? 'info' : 'muted') },
            ],
            tasks
          )
        : '<div class="small">尚未排产</div>'
    }`;

  modal({
    title: `生产订单 ${o.code}`,
    body,
    wide: true,
    footer: `<button class="btn" data-close2>关闭</button><button class="btn primary" data-go-sched>查看排程</button>`,
    onMount(root, close) {
      root.querySelector('[data-close2]').addEventListener('click', close);
      root.querySelector('[data-go-sched]').addEventListener('click', () => {
        close();
        ctx.go('#/schedule');
      });
    },
  });
}

/* ───────── 调整优先级 ───────── */
function editPriority(ctx, orderId) {
  const o = ctx.db.productionOrders.find((x) => x.id === orderId);
  if (!o) return;
  modal({
    title: `调整人工优先级 · ${o.code}`,
    body: `<div class="field"><label>人工优先级（P5 最高）</label>
      <select id="pri">${options(
        [1, 2, 3, 4, 5].map((n) => ({ value: n, label: `P${n}` })),
        o.manualPriority || 3
      )}</select>
      <div class="hint">人工优先级参与排产评分（交期桶内权重 20%），调整后需重新排产才会改变计划顺序。</div></div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn primary" data-ok>保存</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').addEventListener('click', close);
      root.querySelector('[data-ok]').addEventListener('click', () => {
        o.manualPriority = Number(root.querySelector('#pri').value);
        close();
        ctx.commit(`${o.code} 人工优先级已更新`);
      });
    },
  });
}

/* ───────── 从销售行建立生产订单 ───────── */
function makeOrder(ctx, lineId) {
  const { db } = ctx;
  const line = db.salesOrderLines.find((l) => l.id === lineId);
  if (!line) return;
  const exists = db.orderLinks.filter((l) => l.lineId === lineId).reduce((s, l) => s + Number(l.qty), 0);
  const left = Number(line.qty) - exists;

  modal({
    title: `建立生产订单 · 销售行 ${lineId}`,
    body: `
      <div class="notice info">该销售行数量 ${line.qty}，已建立 ${exists}，剩余可建 ${left}。允许一拆多（分批投产）。</div>
      <div class="form-row">
        <div class="field"><label>生产数量 <span class="req">*</span></label><input type="number" id="qty" value="${Math.max(1, left)}" min="1" max="${Math.max(1, left)}" /></div>
        <div class="field"><label>人工优先级</label><select id="pri">${options(
          [1, 2, 3, 4, 5].map((n) => ({ value: n, label: `P${n}` })),
          3
        )}</select></div>
      </div>
      <div class="field"><label>备注</label><input type="text" id="rmk" placeholder="如：第 2 批投产" /></div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn primary" data-ok>建立</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').addEventListener('click', close);
      root.querySelector('[data-ok]').addEventListener('click', () => {
        const qty = Number(root.querySelector('#qty').value);
        if (!(qty > 0) || qty > left) {
          toast(`数量必须大于 0 且不超过剩余可建数量 ${left}`, 'danger');
          return;
        }
        const code = `PO-${String(db.productionOrders.length + 1).padStart(3, '0')}`;
        const po = {
          id: uid('PO'),
          code,
          salesOrderLineId: line.id,
          productId: line.productId,
          qty,
          planStart: '',
          planEnd: '',
          forecastEnd: '',
          actualStart: '',
          actualEnd: '',
          status: 'DRAFT',
          manualPriority: Number(root.querySelector('#pri').value),
          versionId: '',
          reservations: [],
          remark: root.querySelector('#rmk').value.trim(),
        };
        db.productionOrders.push(po);
        db.orderLinks.push({ id: uid('LK'), orderId: po.id, lineId: line.id, qty });
        close();
        ctx.commit(`已建立生产订单 ${code}，可在生产排程中参与排产`);
      });
    },
  });
}
