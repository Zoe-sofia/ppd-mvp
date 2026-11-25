/**
 * 交付管理（V1.0 §4.6；P-01：客户承诺止于生产完工，发货为内部节点）
 */

import { badge, esc, modal, num, table, toast } from '../dom.js';
import { RISK_STATUS, SHIPMENT_STATUS, label, toneOf } from '../../core/constants.js';
import { riskOf, dueDateOf, finishDateOf } from '../../core/metrics.js';
import { diffCalendarDays } from '../../core/calendar.js';

export default {
  render(view, ctx) {
    const { db, asOf } = ctx;
    const orders = db.productionOrders.filter((o) => o.status !== 'CANCELLED');
    const rows = orders.map((o) => {
      const ship = db.shipments.find((s) => s.orderId === o.id) || {};
      return { o, ship, r: riskOf(db, o), due: dueDateOf(db, o), fin: finishDateOf(db, o) };
    });

    const cnt = {
      forecastDelay: rows.filter((x) => x.r.code === 'DELAYED').length,
      actualDelay: rows.filter((x) => x.r.code === 'DONE_LATE').length,
      pendingShip: rows.filter((x) => x.ship.status === 'PENDING' && x.o.status === 'COMPLETED').length,
      planShipDelay: rows.filter((x) => x.ship.planDate && x.fin.date && x.ship.planDate < x.fin.date).length,
      actualShipDelay: rows.filter((x) => x.ship.actualDate && x.ship.planDate && x.ship.actualDate > x.ship.planDate).length,
    };

    view.innerHTML = `
      <div class="notice info">
        <b>交期口径：</b>客户要求交期按「生产完工日期」理解（P-02）。客户承诺止于生产完工，发货与运输为<b>内部节点</b>，
        「准时发货率」仅作内部执行指标，不构成客户履约口径。
      </div>

      <div class="grid g4">
        <div class="kpi ${cnt.forecastDelay ? 'danger' : 'ok'}"><div class="k-label">预计生产延期</div><div class="k-val">${cnt.forecastDelay}</div><div class="k-sub">按当前计划推算</div></div>
        <div class="kpi ${cnt.actualDelay ? 'danger' : 'ok'}"><div class="k-label">实际生产延期</div><div class="k-val">${cnt.actualDelay}</div><div class="k-sub">已完工且晚于交期</div></div>
        <div class="kpi ${cnt.planShipDelay ? 'warn' : ''}"><div class="k-label">计划发货延期</div><div class="k-val">${cnt.planShipDelay}</div><div class="k-sub">计划发货早于完工</div></div>
        <div class="kpi ${cnt.actualShipDelay ? 'warn' : ''}"><div class="k-label">实际发货延期</div><div class="k-val">${cnt.actualShipDelay}</div><div class="k-sub">内部节点口径</div></div>
      </div>

      <div class="card">
        <div class="card-h">
          <h3>交付跟踪</h3>
          <span class="desc">日期链：客户要求完工 → 计划完工 → 系统预计完工 → 实际完工 → 计划发货 → 实际发货</span>
        </div>
        <div class="card-b tight">
          ${table(
            [
              { title: '生产订单', render: (x) => `<b>${esc(x.o.code)}</b>` },
              { title: '客户要求完工', cls: 'mono', render: (x) => esc(x.due || '—') },
              { title: '计划完工', cls: 'mono', render: (x) => esc(x.o.planEnd || '—') },
              { title: '系统预计完工', cls: 'mono', render: (x) => esc(x.fin.actual ? '' : x.fin.date || '—') + (x.fin.actual ? '<span class="small muted">已完工</span>' : '') },
              { title: '实际完工', cls: 'mono', render: (x) => esc(x.o.actualEnd || '—') },
              { title: '计划发货', cls: 'mono', render: (x) => esc(x.ship.planDate || '—') },
              { title: '实际发货', cls: 'mono', render: (x) => esc(x.ship.actualDate || '—') },
              { title: '发货状态', render: (x) => badge(label(SHIPMENT_STATUS, x.ship.status || 'PENDING'), (x.ship.status || 'PENDING') === 'SHIPPED' ? 'ok' : 'muted') },
              {
                title: '风险',
                render: (x) => {
                  const r = x.r;
                  return `${badge(label(RISK_STATUS, r.code), toneOf(RISK_STATUS, r.code))}${r.delayDays ? `<div class="small">延迟 ${r.delayDays} 天</div>` : ''}`;
                },
              },
              {
                title: '操作',
                cls: 'nowrap',
                render: (x) => `<button class="btn sm ghost" data-ship="${x.o.id}">发货登记</button>`,
              },
            ],
            rows.sort((a, b) => (a.due < b.due ? -1 : 1)),
            { empty: '暂无订单' }
          )}
        </div>
      </div>`;

    view.querySelectorAll('[data-ship]').forEach((b) =>
      b.addEventListener('click', () => shipModal(ctx, b.dataset.ship))
    );
  },
};

function shipModal(ctx, orderId) {
  const { db, asOf } = ctx;
  const order = db.productionOrders.find((o) => o.id === orderId);
  if (!order) return;
  let ship = db.shipments.find((s) => s.orderId === orderId);
  if (!ship) {
    ship = { id: `SH-${orderId}`, orderId, planDate: '', actualDate: '', qty: order.qty, status: 'PENDING', note: '' };
    db.shipments.push(ship);
  }

  modal({
    title: `发货登记 · ${order.code}`,
    body: `
      <div class="notice info">发货是内部节点：仅记录执行情况，不改变客户履约口径。系统不自动推算发货日期，只提供建议值。</div>
      <div class="form-row">
        <div class="field">
          <label>计划发货日</label>
          <input type="date" id="pd" value="${esc(ship.planDate || (order.planEnd ? ctx.asOf : ''))}" />
          <div class="hint">建议值 = 计划完工日 + 1 天（需人工确认后写入）</div>
        </div>
        <div class="field"><label>实际发货日</label><input type="date" id="ad" value="${esc(ship.actualDate || '')}" /></div>
      </div>
      <div class="form-row">
        <div class="field"><label>发货数量</label><input type="number" id="q" value="${num(ship.qty || order.qty)}" /></div>
        <div class="field"><label>发货状态</label>
          <select id="st">
            <option value="PENDING" ${ship.status === 'PENDING' ? 'selected' : ''}>待发货</option>
            <option value="PARTIAL" ${ship.status === 'PARTIAL' ? 'selected' : ''}>部分发货</option>
            <option value="SHIPPED" ${ship.status === 'SHIPPED' ? 'selected' : ''}>已发货</option>
          </select>
        </div>
      </div>
      <div class="field"><label>备注</label><input type="text" id="nt" value="${esc(ship.note || '')}" /></div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn primary" data-ok>保存</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').addEventListener('click', close);
      root.querySelector('[data-ok]').addEventListener('click', () => {
        ship.planDate = root.querySelector('#pd').value;
        ship.actualDate = root.querySelector('#ad').value;
        ship.qty = Number(root.querySelector('#q').value);
        ship.status = root.querySelector('#st').value;
        ship.note = root.querySelector('#nt').value;
        if (ship.actualDate && !ship.qty) ship.qty = order.qty;
        close();
        ctx.commit('发货信息已保存');
      });
    },
  });
}
