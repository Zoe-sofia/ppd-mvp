/**
 * 物料管理（V1.0 §4.3）
 * 齐套分析（五状态 + 最大可开工）、库存与到货、物料预留（系统建议 → PMC 确认）
 */

import { badge, esc, modal, num, table, tabs, toast } from '../dom.js';
import { KITTING_STATUS, label, toneOf } from '../../core/constants.js';
import { kittingOf, explodeBom, allocatableStock, stockOf } from '../../core/rules.js';
import { dueDateOf } from '../../core/metrics.js';
import { today } from '../../core/calendar.js';

let tab = 'kitting';
let selectedOrder = '';

export default {
  render(view, ctx) {
    const { db, asOf } = ctx;
    const orders = db.productionOrders.filter((o) => !['CANCELLED', 'CLOSED'].includes(o.status));
    if (!selectedOrder || !orders.some((o) => o.id === selectedOrder)) selectedOrder = orders[0] ? orders[0].id : '';

    const kittingRows = orders.map((o) => ({ order: o, k: kittingOf(o, db, o.planStart) }));
    const sel = kittingRows.find((r) => r.order.id === selectedOrder);

    view.innerHTML = `
      ${tabs(
        [
          { key: 'kitting', label: '齐套分析', count: orders.length },
          { key: 'reserve', label: '物料预留' },
          { key: 'stock', label: '库存', count: db.inventory.length },
          { key: 'inbound', label: '到货信息', count: db.inbounds.length },
          { key: 'req', label: '物料需求' },
        ],
        tab
      )}
      <div class="card" style="border-top:0;border-radius:0 0 6px 6px">
        ${renderBody(ctx, sel, kittingRows)}
      </div>`;

    view.querySelectorAll('[data-action="switch-tab"]').forEach((el) =>
      el.addEventListener('click', () => {
        tab = el.dataset.tab;
        ctx.redraw();
      })
    );

    view.querySelectorAll('[data-order]').forEach((el) =>
      el.addEventListener('change', () => {
        selectedOrder = el.value;
        ctx.redraw();
      })
    );

    view.querySelectorAll('[data-confirm-res]').forEach((b) =>
      b.addEventListener('click', () => confirmReservation(ctx, b.dataset.confirmRes))
    );
    view.querySelectorAll('[data-toggle-confirmed]').forEach((b) =>
      b.addEventListener('click', () => {
        const ib = db.inbounds.find((x) => x.id === b.dataset.toggleConfirmed);
        if (!ib) return;
        ib.confirmed = !ib.confirmed;
        ctx.commit(`到货记录已标记为「${ib.confirmed ? '已确认' : '未确认'}」`);
      })
    );
    view.querySelectorAll('[data-arrive]').forEach((b) =>
      b.addEventListener('click', () => {
        const ib = db.inbounds.find((x) => x.id === b.dataset.arrive);
        if (!ib) return;
        modal({
          title: '登记到货',
          body: `<div class="field"><label>实际到货日</label><input type="date" id="d" value="${today()}" /></div>
                 <div class="hint">实际到货日晚于预计到货日时，「到料准时率」将下降。</div>`,
          footer: `<button class="btn" data-c>取消</button><button class="btn primary" data-ok>保存</button>`,
          onMount(root, close) {
            root.querySelector('[data-c]').addEventListener('click', close);
            root.querySelector('[data-ok]').addEventListener('click', () => {
              ib.actualArrivalDate = root.querySelector('#d').value;
              close();
              ctx.commit('到货已登记');
            });
          },
        });
      })
    );
  },
};

function renderBody(ctx, sel, rows) {
  const { db } = ctx;

  if (tab === 'kitting') {
    return `
      <div class="card-h">
        <h3>齐套分析</h3>
        <span class="desc">按生产订单计算；整单状态取最差项（短板原则）</span>
        <div class="right">
          <select data-order style="width:320px">
            ${rows
              .map((r) => `<option value="${r.order.id}" ${r.order.id === selectedOrder ? 'selected' : ''}>${esc(r.order.code)} · ${esc((db.products.find((p) => p.id === r.order.productId) || {}).name || '')} × ${r.order.qty}</option>`)
              .join('')}
          </select>
        </div>
      </div>
      ${table(
        [
          { title: '生产订单', render: (r) => `<b>${esc(r.order.code)}</b>` },
          { title: '产品', render: (r) => esc((db.products.find((p) => p.id === r.order.productId) || {}).name || '') },
          { title: '数量', cls: 'num', render: (r) => num(r.order.qty) },
          { title: '交期', cls: 'mono', render: (r) => esc(dueDateOf(db, r.order) || '—') },
          { title: '齐套状态', render: (r) => badge(label(KITTING_STATUS, r.k.status), toneOf(KITTING_STATUS, r.k.status)) },
          { title: '最大可开工', cls: 'num', render: (r) => `<b>${r.k.maxStartByStock}</b>` },
          { title: '含到货可开工', cls: 'num', render: (r) => r.k.maxStartByInbound },
          { title: '缺口项数', cls: 'num', render: (r) => r.k.lines.filter((l) => l.gap > 0).length },
        ],
        rows
      )}
      ${
        sel
          ? `<div class="card-b" style="border-top:1px solid var(--line)">
              <h4 style="margin:0 0 8px;font-size:12.5px">${esc(sel.order.code)} 物料明细</h4>
              ${table(
                [
                  { title: '物料', render: (l) => `<b>${esc(l.materialCode)}</b> <span class="small">${esc(l.materialName)}</span>` },
                  { title: '需求量', cls: 'num', render: (l) => num(l.required) },
                  { title: '可用库存', cls: 'num', render: (l) => num(l.stock) },
                  { title: '已确认到货', cls: 'num', render: (l) => num(l.confirmedQty) },
                  { title: '未确认到货', cls: 'num', render: (l) => `<span class="muted">${num(l.unconfirmedQty)}</span>` },
                  { title: '缺口', cls: 'num', render: (l) => (l.gap > 0 ? `<b style="color:var(--danger)">${l.gap}</b>` : '0') },
                  { title: '最早到货', cls: 'mono', render: (l) => esc(l.earliestInbound || '—') },
                  { title: '判定', render: (l) => badge(label(KITTING_STATUS, l.status), toneOf(KITTING_STATUS, l.status)) },
                ],
                sel.k.lines
              )}
              <div class="notice info" style="margin:12px 0 0">
                未确认到货<b>不计入</b>确定可用量，仅用于风险分析；实际开工时系统会再次校验库存，不足部分不得开工。
              </div>
            </div>`
          : ''
      }`;
  }

  if (tab === 'reserve') {
    const k = sel ? sel.k : null;
    const reserved = sel && sel.order.reservations ? sel.order.reservations : [];
    const suggest = k
      ? k.lines
          .filter((l) => l.stock > 0)
          .map((l) => ({
            materialId: l.materialId,
            materialCode: l.materialCode,
            materialName: l.materialName,
            required: l.required,
            suggestQty: Math.min(l.required, l.stock),
            stock: l.stock,
            confirmed: (reserved.find((r) => r.materialId === l.materialId) || {}).qty || 0,
          }))
      : [];

    return `
      <div class="card-h">
        <h3>物料预留</h3>
        <span class="desc">系统给出建议，PMC 确认后才生效；确认后从其他订单可分配库存中扣除</span>
        <div class="right">
          <select data-order style="width:320px">
            ${rows.map((r) => `<option value="${r.order.id}" ${r.order.id === selectedOrder ? 'selected' : ''}>${esc(r.order.code)}</option>`).join('')}
          </select>
          <button class="btn sm primary" data-confirm-res="${selectedOrder}">确认建议预留</button>
        </div>
      </div>
      ${table(
        [
          { title: '物料', render: (l) => `<b>${esc(l.materialCode)}</b> <span class="small">${esc(l.materialName)}</span>` },
          { title: '总需求', cls: 'num', render: (l) => num(l.required) },
          { title: '系统建议预留', cls: 'num', render: (l) => `<b>${num(l.suggestQty)}</b>` },
          { title: 'PMC 已确认', cls: 'num', render: (l) => (l.confirmed ? num(l.confirmed) : '<span class="muted">未确认</span>') },
          { title: '当前可用库存', cls: 'num', render: (l) => num(l.stock) },
          {
            title: '说明',
            render: (l) =>
              l.suggestQty < l.required
                ? `<span class="small" style="color:var(--warn)">库存仅能覆盖 ${l.suggestQty}，缺口 ${l.required - l.suggestQty} 需等到货</span>`
                : '<span class="small">可全额预留</span>',
          },
        ],
        suggest
      )}
      <div class="card-b">
        <div class="notice warn" style="margin:0">
          订单取消、改期或调整数量时，系统只会<b>提示</b>相关物料分配影响，<b>不自动执行</b>跨订单重新分配（BR-09）。
        </div>
      </div>`;
  }

  if (tab === 'stock') {
    return `
      <div class="card-h"><h3>库存</h3><span class="desc">当前可用库存参与物料可用量计算</span></div>
      ${table(
        [
          { title: '物料', render: (r) => `<b>${esc(r.m.code)}</b> <span class="small">${esc(r.m.name)}</span>` },
          { title: '类型', render: (r) => badge(r.m.type, r.m.type === 'SEMI' ? 'info' : 'muted') },
          { title: '仓库', render: (r) => esc(r.i.warehouse) },
          { title: '数量', cls: 'num', render: (r) => num(r.i.qty) },
          { title: '单位', render: (r) => esc(r.m.unit) },
          { title: '已被预留', cls: 'num', render: (r) => num(r.reserved) },
          { title: '可分配', cls: 'num', render: (r) => `<b>${num(r.alloc)}</b>` },
        ],
        db.inventory
          .map((i) => {
            const m = db.materials.find((x) => x.id === i.materialId) || { code: i.materialId, name: '', unit: '' };
            const reserved = db.productionOrders.reduce((s, o) => {
              const r = (o.reservations || []).find((x) => x.materialId === i.materialId);
              return s + (r ? Number(r.qty) : 0);
            }, 0);
            return { i, m, reserved, alloc: Math.max(0, Number(i.qty) - reserved) };
          })
      )}`;
  }

  if (tab === 'inbound') {
    return `
      <div class="card-h"><h3>采购到货</h3><span class="desc">已确认到货按预计到货日期参与未来可用量；未确认仅作风险分析</span></div>
      ${table(
        [
          { title: '物料', render: (i) => `<b>${esc(i.materialCode || '')}</b>` },
          { title: '数量', cls: 'num', render: (i) => num(i.qty) },
          { title: '供应商', render: (i) => esc(i.supplier || '—') },
          { title: '预计到货', cls: 'mono', render: (i) => esc(i.expectedDate) },
          { title: '确认状态', render: (i) => badge(i.confirmed ? '已确认' : '未确认', i.confirmed ? 'ok' : 'warn') },
          { title: '实际到货', cls: 'mono', render: (i) => esc(i.actualArrivalDate || '—') },
          {
            title: '准时',
            render: (i) =>
              i.actualArrivalDate
                ? i.actualArrivalDate <= i.expectedDate
                  ? badge('准时', 'ok')
                  : badge('延期', 'danger')
                : '<span class="muted">—</span>',
          },
          {
            title: '操作',
            cls: 'nowrap',
            render: (i) =>
              `<button class="btn sm ghost" data-toggle-confirmed="${i.id}">${i.confirmed ? '置为未确认' : '确认'}</button>${
                i.actualArrivalDate ? '' : `<button class="btn sm ghost" data-arrive="${i.id}">登记到货</button>`
              }`,
          },
        ],
        db.inbounds
      )}`;
  }

  // 物料需求
  const reqs = sel ? explodeBom(sel.order.productId, sel.order.qty, db) : [];
  return `
    <div class="card-h">
      <h3>物料需求（两级 BOM 展开）</h3>
      <span class="desc">成品 → 半成品/物料 → 原材料；按生产订单数量与单位用量计算</span>
      <div class="right">
        <select data-order style="width:320px">
          ${rows.map((r) => `<option value="${r.order.id}" ${r.order.id === selectedOrder ? 'selected' : ''}>${esc(r.order.code)}</option>`).join('')}
        </select>
      </div>
    </div>
    ${table(
      [
        { title: '物料', render: (r) => `<b>${esc((db.materials.find((m) => m.id === r.materialId) || {}).code || r.materialId)}</b> <span class="small">${esc((db.materials.find((m) => m.id === r.materialId) || {}).name || '')}</span>` },
        { title: '总需求', cls: 'num', render: (r) => num(r.qty) },
        { title: '可用库存', cls: 'num', render: (r) => num(allocatableStock(r.materialId, db, selectedOrder)) },
        { title: '库存总量', cls: 'num', render: (r) => num(stockOf(r.materialId, db)) },
        {
          title: '状态',
          render: (r) => {
            const a = allocatableStock(r.materialId, db, selectedOrder);
            return a >= r.qty ? badge('充足', 'ok') : a > 0 ? badge('不足', 'warn') : badge('无库存', 'danger');
          },
        },
      ],
      reqs
    )}
    <div class="card-b"><div class="notice info" style="margin:0">MVP 实现两级 BOM，数据模型预留多级扩展；不做复杂多级 MRP 与自动采购建议。</div></div>`;
}

/* ───────── 确认预留 ───────── */
function confirmReservation(ctx, orderId) {
  const { db } = ctx;
  const order = db.productionOrders.find((o) => o.id === orderId);
  if (!order) return;
  const k = kittingOf(order, db, order.planStart);
  const next = k.lines
    .filter((l) => l.stock > 0)
    .map((l) => ({ materialId: l.materialId, qty: Math.min(l.required, l.stock) }));

  const before = db.productionOrders
    .filter((o) => o.id !== orderId && !['CANCELLED', 'CLOSED'].includes(o.status))
    .map((o) => ({ code: o.code, alloc: kittingOf(o, db, o.planStart).maxStartByStock }));

  order.reservations = next;
  const after = db.productionOrders
    .filter((o) => o.id !== orderId && !['CANCELLED', 'CLOSED'].includes(o.status))
    .map((o) => ({ code: o.code, alloc: kittingOf(o, db, o.planStart).maxStartByStock }));

  const affected = before.filter((b, i) => after[i] && after[i].alloc < b.alloc);
  ctx.commit(
    affected.length
      ? `已确认预留；${affected.length} 张其他订单的可分配库存相应减少（如 ${affected[0].code}：${affected[0].alloc} → ${after.find((a) => a.code === affected[0].code).alloc}）`
      : '已确认预留，未影响其他订单',
    affected.length ? 'warn' : 'ok'
  );
}
