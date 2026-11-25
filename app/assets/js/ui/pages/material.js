/**
 * 物料管理（V1.0 §4.3）
 * 齐套分析（五状态 + 最大可开工）、库存与到货、物料预留（系统建议 → PMC 确认）、物料需求
 *
 * 交互约定：
 *   齐套分析默认「未筛选」，此时不展开明细；选中订单后，该订单的物料明细**置顶**显示，
 *   列表同时高亮这一行 —— 用户不必滚到表格底部再找。
 *   物料预留与物料需求必须绑定一张订单，默认取列表第一张。
 */

import { badge, esc, modal, num, table, tabs, toast, sortRows, bindSort } from '../dom.js';
import { KITTING_STATUS, label, toneOf } from '../../core/constants.js';
import {
  kittingOf,
  explodeBomTree,
  allocatableStock,
  stockOf,
  reservedOf,
} from '../../core/rules.js';
import { dueDateOf } from '../../core/metrics.js';
import { today } from '../../core/calendar.js';

let tab = 'kitting';
/** 齐套分析筛选的订单：'' = 未筛选（明细为空） */
let kittingOrder = '';
/** 物料预留 / 物料需求 的当前订单 */
let selectedOrder = '';
/** 各表排序状态（模块级，切换 tab 后保留） */
const sorts = { kitting: { key: 'code', dir: 'asc' }, stock: null, inbound: null, req: null };

const productOf = (db, id) => db.products.find((p) => p.id === id) || {};
const materialOf = (db, id) => db.materials.find((m) => m.id === id) || {};

export default {
  render(view, ctx) {
    const { db } = ctx;
    const orders = db.productionOrders.filter((o) => !['CANCELLED', 'CLOSED'].includes(o.status));
    if (!selectedOrder || !orders.some((o) => o.id === selectedOrder)) selectedOrder = orders[0] ? orders[0].id : '';
    if (kittingOrder && !orders.some((o) => o.id === kittingOrder)) kittingOrder = '';

    const kittingRows = orders.map((o) => {
      const k = kittingOf(o, db, o.planStart);
      const product = productOf(db, o.productId);
      return {
        order: o,
        k,
        product,
        due: dueDateOf(db, o) || '',
        /** 缺料类别数：有缺口的物料行数（同一物料只算一类） */
        shortCount: new Set(k.lines.filter((l) => l.gap > 0).map((l) => l.materialId)).size,
      };
    });

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
      <div class="card attached">
        ${renderBody(ctx, orders, kittingRows)}
      </div>`;

    view.querySelectorAll('[data-action="switch-tab"]').forEach((el) =>
      el.addEventListener('click', () => {
        tab = el.dataset.tab;
        ctx.redraw();
      })
    );

    view.querySelectorAll('[data-order]').forEach((el) =>
      el.addEventListener('change', () => {
        if (tab === 'kitting') kittingOrder = el.value;
        else selectedOrder = el.value;
        ctx.redraw();
      })
    );

    view.querySelectorAll('[data-confirm-res]').forEach((b) =>
      b.addEventListener('click', () => confirmReservation(ctx, b.dataset.confirmRes, b.dataset.mat))
    );
    view.querySelectorAll('[data-cancel-res]').forEach((b) =>
      b.addEventListener('click', () => cancelReservation(ctx, b.dataset.cancelRes, b.dataset.mat))
    );
    view.querySelectorAll('[data-pick]').forEach((b) =>
      b.addEventListener('click', () => {
        kittingOrder = b.dataset.pick;
        ctx.redraw();
      })
    );
    view.querySelectorAll('[data-order-clear]').forEach((b) =>
      b.addEventListener('click', () => {
        kittingOrder = '';
        ctx.redraw();
      })
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

    bindSort(
      view,
      () => sorts[tab],
      (s) => {
        sorts[tab] = s;
      },
      () => ctx.redraw()
    );
  },
};

/* ─────────────────────────── 主体 ─────────────────────────── */

function renderBody(ctx, orders, kittingRows) {
  const { db } = ctx;
  const orderOptions = (sel, withAll) =>
    `${withAll ? `<option value="" ${sel === '' ? 'selected' : ''}>全部订单（不展开明细）</option>` : ''}${orders
      .map(
        (o) =>
          `<option value="${o.id}" ${o.id === sel ? 'selected' : ''}>${esc(o.code)} · ${esc(productOf(db, o.productId).name || '')} × ${num(o.qty)}</option>`
      )
      .join('')}`;

  if (tab === 'kitting') {
    const sel = kittingRows.find((r) => r.order.id === kittingOrder) || null;
    const rows = sortRows(kittingRows, sorts.kitting, (r, key) => {
      switch (key) {
        case 'code': return r.order.code;
        case 'productCode': return r.product.code || '';
        case 'product': return r.product.name || '';
        case 'qty': return Number(r.order.qty) || 0;
        case 'due': return r.due;
        case 'status': return r.k.status;
        case 'byStock': return r.k.maxStartByStock;
        case 'byInbound': return r.k.maxStartByInbound;
        case 'shortCount': return r.shortCount;
        default: return '';
      }
    });

    return `
      <div class="card-h">
        <h3>齐套分析</h3>
        <span class="desc">按生产订单计算；整单状态取最差项（短板原则）</span>
        <div class="right right-wide">
          <select class="filter-lg" data-order >${orderOptions(kittingOrder, true)}</select>
        </div>
      </div>
      ${sel ? kittingDetailHtml(db, sel) : `<div class="card-b"><div class="notice info m-0">未选择订单：物料明细为空。在上方下拉选择一张生产订单即可查看它的物料齐套明细。</div></div>`}
      ${table(
        [
          { title: '生产订单', sortKey: 'code', render: (r) => `<b>${esc(r.order.code)}</b>` },
          { title: '产品编号', sortKey: 'productCode', render: (r) => `<span class="mono-s">${esc(r.product.code || '—')}</span>` },
          { title: '产品', sortKey: 'product', render: (r) => esc(r.product.name || '') },
          { title: '数量', cls: 'num', sortKey: 'qty', render: (r) => num(r.order.qty) },
          { title: '交期', cls: 'mono', sortKey: 'due', render: (r) => esc(r.due || '—') },
          { title: '齐套状态', sortKey: 'status', render: (r) => badge(label(KITTING_STATUS, r.k.status), toneOf(KITTING_STATUS, r.k.status)) },
          { title: '最大可开工', cls: 'num', sortKey: 'byStock', render: (r) => `<b>${r.k.maxStartByStock}</b>` },
          { title: '含到货可开工', cls: 'num', sortKey: 'byInbound', render: (r) => r.k.maxStartByInbound },
          { title: '缺料类别数', cls: 'num', sortKey: 'shortCount', render: (r) => (r.shortCount ? `<b class="c-danger">${r.shortCount}</b>` : '0') },
          {
            title: '',
            cls: 'nowrap',
            render: (r) =>
              r.order.id === kittingOrder
                ? `<span class="badge info">已选中</span>`
                : `<button class="btn sm ghost" data-pick="${r.order.id}">查看明细</button>`,
          },
        ],
        rows,
        {
          sort: sorts.kitting,
          empty: '当前没有在制订单（已完工 / 已取消不计入）',
          rowAttr: (r) => (r.order.id === kittingOrder ? 'class="sel"' : ''),
        }
      )}`;
  }

  if (tab === 'reserve') {
    const order = db.productionOrders.find((o) => o.id === selectedOrder) || null;
    const rows = order ? reservationRows(db, order) : [];
    const confirmedRows = rows.filter((r) => r.confirmed > 0);
    const deductTotal = confirmedRows.reduce((s, r) => s + r.confirmed, 0);

    return `
      <div class="card-h">
        <h3>物料预留</h3>
        <span class="desc">系统给出建议，PMC 确认后才生效；确认即从可用库存扣除</span>
        <div class="right right-wide">
          <select class="filter-lg" data-order >${orderOptions(selectedOrder, false)}</select>
          <button class="btn sm primary" data-confirm-res="${selectedOrder}">确认全部建议</button>
          <button class="btn sm" data-cancel-res="${selectedOrder}">取消本单全部预留</button>
        </div>
      </div>
      ${
        confirmedRows.length
          ? `<div class="notice ok mx-4 mb-3">本单已确认预留 <b>${deductTotal}</b>（${confirmedRows
              .map((r) => `${esc(r.materialCode)} ${r.confirmed}`)
              .join('、')}），这些数量已从「其他订单可分配库存」中扣除。</div>`
          : `<div class="notice info mx-4 mb-3">本单尚未确认任何预留，库存暂未扣减。确认后，「其他订单可分配库存」会相应减少。</div>`
      }
      ${table(
        [
          { title: '物料', render: (r) => `<b>${esc(r.materialCode)}</b> <span class="small">${esc(r.materialName)}</span>` },
          { title: '总需求', cls: 'num', render: (r) => num(r.required) },
          { title: '系统建议预留', cls: 'num', render: (r) => `<b>${num(r.suggestQty)}</b>` },
          { title: 'PMC 已确认', cls: 'num', render: (r) => (r.confirmed ? num(r.confirmed) : '<span class="muted">未确认</span>') },
          { title: '本次扣减', cls: 'num', render: (r) => (r.deductNow ? `<b class="c-brand">−${r.deductNow}</b>` : '0') },
          { title: '库存总量', cls: 'num', render: (r) => num(r.stockTotal) },
          { title: '其他订单可用', cls: 'num', render: (r) => `<b>${num(r.availableAfter)}</b>${r.confirmed ? `<div class="small muted">扣减前 ${num(r.availableBefore)}</div>` : ''}` },
          {
            title: '说明',
            render: (r) => {
              const parts = [];
              if (r.confirmed) parts.push(`<span class="c-ok">已确认并扣减 ${r.confirmed}</span>`);
              else parts.push('<span class="c-warn">未确认：建议未生效，库存未扣减</span>');
              if (r.suggestQty < r.required) parts.push(`库存仅能覆盖 ${r.suggestQty}，缺口 ${r.required - r.suggestQty} 需等到货`);
              return `<span class="small">${parts.join('；')}</span>`;
            },
          },
          {
            title: '操作',
            cls: 'nowrap',
            render: (r) => {
              if (r.confirmed) return `<button class="btn sm ghost" data-cancel-res="${selectedOrder}" data-mat="${r.materialId}">取消确认</button>`;
              if (r.suggestQty <= 0) return '<span class="small muted">无可预留库存</span>';
              return `<button class="btn sm" data-confirm-res="${selectedOrder}" data-mat="${r.materialId}">确认预留</button>`;
            },
          },
        ],
        rows,
        { empty: '该订单没有需要预留的物料' }
      )}
      <div class="card-b">
        <div class="notice warn m-0">
          订单取消、改期或调整数量时，系统只会<b>提示</b>相关物料分配影响，<b>不自动执行</b>跨订单重新分配（BR-09）。
        </div>
      </div>`;
  }

  if (tab === 'stock') {
    const rows = sortRows(
      db.inventory.map((i) => {
        const m = materialOf(db, i.materialId);
        const reserved = reservedOf(i.materialId, db, '') || 0;
        return { i, m, reserved, alloc: Math.max(0, num(i.qty) - reserved) };
      }),
      sorts.stock,
      (r, key) => (key === 'code' ? r.m.code : key === 'qty' ? num(r.i.qty) : key === 'reserved' ? r.reserved : key === 'alloc' ? r.alloc : r.m[key] ?? '')
    );
    return `
      <div class="card-h"><h3>库存</h3><span class="desc">当前可用库存参与物料可用量计算；已被预留 = 其他订单已确认的预留合计</span></div>
      ${table(
        [
          { title: '物料', sortKey: 'code', render: (r) => `<b>${esc(r.m.code)}</b> <span class="small">${esc(r.m.name)}</span>` },
          { title: '类型', render: (r) => badge(r.m.type === 'SEMI' ? '半成品' : r.m.type === 'RAW' ? '原材料' : '采购件', r.m.type === 'SEMI' ? 'info' : 'muted') },
          { title: '仓库', render: (r) => esc(r.i.warehouse) },
          { title: '数量', cls: 'num', sortKey: 'qty', render: (r) => num(r.i.qty) },
          { title: '单位', render: (r) => esc(r.m.unit) },
          { title: '已被预留', cls: 'num', sortKey: 'reserved', render: (r) => num(r.reserved) },
          { title: '可分配', cls: 'num', sortKey: 'alloc', render: (r) => `<b>${num(r.alloc)}</b>` },
        ],
        rows,
        { sort: sorts.stock }
      )}`;
  }

  if (tab === 'inbound') {
    const rows = sortRows(db.inbounds, sorts.inbound, (i, key) => {
      if (key === 'material') return materialOf(db, i.materialId).code || i.materialCode || '';
      if (key === 'qty') return num(i.qty);
      if (key === 'expected') return i.expectedDate || '';
      if (key === 'confirmed') return i.confirmed ? 1 : 0;
      if (key === 'actual') return i.actualArrivalDate || '';
      return i[key] ?? '';
    });
    return `
      <div class="card-h"><h3>采购到货</h3><span class="desc">已确认到货按预计到货日期参与未来可用量；未确认仅作风险分析</span></div>
      ${table(
        [
          { title: '物料', sortKey: 'material', render: (i) => `<b>${esc(materialOf(db, i.materialId).code || i.materialCode || '')}</b>` },
          { title: '数量', cls: 'num', sortKey: 'qty', render: (i) => num(i.qty) },
          { title: '供应商', sortKey: 'supplier', render: (i) => esc(i.supplier || '—') },
          { title: '预计到货', cls: 'mono', sortKey: 'expected', render: (i) => esc(i.expectedDate) },
          { title: '确认状态', sortKey: 'confirmed', render: (i) => badge(i.confirmed ? '已确认' : '未确认', i.confirmed ? 'ok' : 'warn') },
          { title: '实际到货', cls: 'mono', sortKey: 'actual', render: (i) => esc(i.actualArrivalDate || '—') },
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
        rows,
        { sort: sorts.inbound }
      )}`;
  }

  /* 物料需求：树形展开，保留半成品 → 下级材料的所属关系 */
  const order = db.productionOrders.find((o) => o.id === selectedOrder) || null;
  const tree = order ? explodeBomTree(order.productId, order.qty, db) : [];
  const rows = sortRows(tree, sorts.req, (r, key) =>
    key === 'required' ? r.required : key === 'code' ? r.code : key === 'qtyPer' ? r.qtyPer : ''
  );
  const leafCount = tree.filter((r) => r.kind === 'MATERIAL').length;

  return `
    <div class="card-h">
      <h3>物料需求（两级 BOM 展开）</h3>
      <span class="desc">成品 → 半成品/物料 → 原材料；半成品有下级 BOM 时只计下级材料</span>
      <div class="right">
        <select class="filter-lg" data-order >${orderOptions(selectedOrder, false)}</select>
      </div>
    </div>
    ${table(
      [
        {
          title: '物料',
          sortKey: 'code',
          render: (r) =>
            r.indent
              ? `<span class="tree-indent">└─</span> <b>${esc(r.code)}</b> <span class="small">${esc(r.name)}</span>`
              : `<b>${esc(r.code)}</b> <span class="small">${esc(r.name)}</span>`,
        },
        {
          title: '层级',
          render: (r) =>
            r.kind === 'SEMI'
              ? badge('半成品 · 展开下级', 'info')
              : r.indent
              ? `<span class="small">二级（${esc(r.parentCode)} 下级）</span>`
              : badge('一级', 'muted'),
        },
        { title: '需求量', cls: 'num', sortKey: 'required', render: (r) => num(r.required) },
        { title: '单位用量', cls: 'num', sortKey: 'qtyPer', render: (r) => r.qtyPer },
        {
          title: '可用库存',
          cls: 'num',
          render: (r) => (r.kind === 'SEMI' ? `<span class="muted">—</span>` : num(allocatableStock(r.materialId, db, selectedOrder))),
        },
        {
          title: '库存总量',
          cls: 'num',
          render: (r) => (r.kind === 'SEMI' ? num(stockOf(r.materialId, db)) : num(stockOf(r.materialId, db))),
        },
        {
          title: '状态',
          render: (r) => {
            if (r.kind === 'SEMI') return badge('半成品（自制）', 'info');
            const a = allocatableStock(r.materialId, db, selectedOrder);
            return a >= r.required ? badge('充足', 'ok') : a > 0 ? badge('不足', 'warn') : badge('无库存', 'danger');
          },
        },
        {
          title: '所属 / 说明',
          render: (r) =>
            r.kind === 'SEMI'
              ? `<span class="small muted">由 ${r.childCount} 项下级材料构成，半成品本身不计入需求</span>`
              : r.indent
              ? `<span class="tree-parent">属于 ${esc(r.parentCode)}</span>`
              : r.note
              ? `<span class="small muted">${esc(r.note)}</span>`
              : '',
        },
      ],
      rows,
      {
        sort: sorts.req,
        empty: order ? '该产品没有 BOM 明细' : '请先选择生产订单',
      }
    )}
    <div class="card-b">
      <div class="notice info m-0">
        当前共 ${rows.length} 行，其中需采购/领用的物料 ${leafCount} 项。半成品（如 SE-GEAR、SE-PUMP）有下级 BOM 时，
        需求由其下级材料承接，半成品本身仍有库存与到货记录（可在「库存」「到货信息」查看），但不重复计入本表。
        MVP 实现两级 BOM，数据模型预留多级扩展；不做复杂多级 MRP 与自动采购建议。
      </div>
    </div>`;
}

/** 齐套明细（置顶展示） */
function kittingDetailHtml(db, sel) {
  const readyDate = sel.k.orderReadyDate;
  return `<div class="card-b subhead">
    <div class="inline mb-3">
      <h4 class="sec-title first">${esc(sel.order.code)} 物料明细</h4>
      ${badge(label(KITTING_STATUS, sel.k.status), toneOf(KITTING_STATUS, sel.k.status))}
      <span class="small muted">整单齐套日：${
        readyDate ? esc(readyDate) : sel.k.lines.some((l) => l.gap > 0) ? '到货计划无法覆盖全部缺口' : '库存已齐套'
      }</span>
      <span class="spacer"></span>
      <button class="btn sm ghost" data-order-clear>收起明细</button>
    </div>
    ${table(
      [
        {
          title: '物料',
          render: (l) => `<b>${esc(l.materialCode)}</b> <span class="small">${esc(l.materialName)}</span>${l.materialType === 'SEMI' ? ' ' + badge('半成品', 'info') : ''}`,
        },
        { title: '需求量', cls: 'num', render: (l) => num(l.required) },
        { title: '可用库存', cls: 'num', render: (l) => num(l.stock) },
        { title: '已确认到货', cls: 'num', render: (l) => num(l.confirmedQty) },
        { title: '未确认到货', cls: 'num', render: (l) => `<span class="muted">${num(l.unconfirmedQty)}</span>` },
        { title: '缺口', cls: 'num', render: (l) => (l.gap > 0 ? `<b class="c-danger">${l.gap}</b>` : '0') },
        { title: '最早到货', cls: 'mono', render: (l) => esc(l.earliestInbound || '—') },
        {
          title: '累计达需日',
          cls: 'mono',
          render: (l) =>
            l.gap === 0
              ? '<span class="muted">库存已够</span>'
              : l.readyDate
              ? `${esc(l.readyDate)}${l.inboundInTime ? '' : ' <span class="small c-warn">晚于开工</span>'}`
              : '<span class="c-danger">到货不足</span>',
        },
        { title: '判定', render: (l) => badge(label(KITTING_STATUS, l.status), toneOf(KITTING_STATUS, l.status)) },
      ],
      sel.k.lines
    )}
    <div class="notice info mt-3">
      可用量按「当前库存 + 预计到货日 ≤ 当日 的已确认到货」逐日累计，取首次达到需求量的日期；
      整单齐套日取全部缺料物料中最晚的一个。未确认到货<b>不计入</b>确定可用量，仅用于风险分析。
    </div>
  </div>`;
}

/* ─────────────────────────── 预留 ─────────────────────────── */

/** 计算某订单的预留行（供表格与确认/取消共用，口径一致） */
function reservationRows(db, order) {
  const k = kittingOf(order, db, order.planStart);
  const reserved = order.reservations || [];
  return k.lines.map((l) => {
    const confirmed = Number((reserved.find((r) => r.materialId === l.materialId) || {}).qty || 0);
    const stockTotal = stockOf(l.materialId, db);
    const othersReserved = reservedOf(l.materialId, db, order.id);
    // 本单可分配 = 库存总量 − 其他订单已确认预留
    const availableForOrder = Math.max(0, stockTotal - othersReserved);
    const suggestQty = Math.min(l.required, availableForOrder);
    return {
      materialId: l.materialId,
      materialCode: l.materialCode,
      materialName: l.materialName,
      required: l.required,
      stockTotal,
      suggestQty,
      confirmed,
      deductNow: Math.max(0, suggestQty - confirmed),
      availableBefore: Math.max(0, stockTotal - othersReserved),
      availableAfter: Math.max(0, stockTotal - othersReserved - confirmed),
    };
  });
}

function confirmReservation(ctx, orderId, materialId) {
  const { db } = ctx;
  const order = db.productionOrders.find((o) => o.id === orderId);
  if (!order) return;
  const rows = reservationRows(db, order);
  const targets = materialId ? rows.filter((r) => r.materialId === materialId) : rows.filter((r) => r.suggestQty > 0);
  const usable = targets.filter((r) => r.suggestQty > 0);
  if (!usable.length) {
    toast('没有可确认的预留：相关物料当前没有可分配库存', 'warn');
    return;
  }

  const before = db.productionOrders
    .filter((o) => o.id !== orderId && !['CANCELLED', 'CLOSED'].includes(o.status))
    .map((o) => ({ code: o.code, alloc: kittingOf(o, db, o.planStart).maxStartByStock }));

  order.reservations = order.reservations || [];
  for (const r of usable) {
    const exist = order.reservations.find((x) => x.materialId === r.materialId);
    if (exist) {
      exist.qty = r.suggestQty;
      exist.at = ctx.asOf;
    } else {
      order.reservations.push({ materialId: r.materialId, qty: r.suggestQty, at: ctx.asOf, by: 'PMC' });
    }
  }

  const after = db.productionOrders
    .filter((o) => o.id !== orderId && !['CANCELLED', 'CLOSED'].includes(o.status))
    .map((o) => ({ code: o.code, alloc: kittingOf(o, db, o.planStart).maxStartByStock }));

  const affected = before.filter((b, i) => after[i] && after[i].alloc < b.alloc);
  const total = usable.reduce((s, r) => s + r.suggestQty, 0);
  const detail = usable.map((r) => `${r.materialCode} ${r.suggestQty}`).join('、');
  ctx.commit(
    `已确认预留 ${detail}，合计扣减 ${total}；${affected.length ? `${affected.length} 张其他订单的可分配库存相应减少（如 ${affected[0].code}：${affected[0].alloc} → ${after.find((a) => a.code === affected[0].code).alloc}）` : '未影响其他订单'}`,
    affected.length ? 'warn' : 'ok'
  );
}

function cancelReservation(ctx, orderId, materialId) {
  const { db } = ctx;
  const order = db.productionOrders.find((o) => o.id === orderId);
  if (!order || !order.reservations) return;
  const before = order.reservations.reduce((s, r) => s + Number(r.qty || 0), 0);
  if (!before) {
    toast('本单当前没有已确认的预留', 'warn');
    return;
  }
  if (materialId) {
    const row = order.reservations.find((r) => r.materialId === materialId);
    const qty = row ? Number(row.qty || 0) : 0;
    order.reservations = order.reservations.filter((r) => r.materialId !== materialId);
    ctx.commit(`已取消该物料预留，释放可用库存 ${qty}`, 'ok');
    return;
  }
  order.reservations = [];
  ctx.commit(`已取消本单全部预留，释放可用库存 ${before}`, 'ok');
}
