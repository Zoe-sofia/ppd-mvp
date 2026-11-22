/**
 * 统计分析（V1.0 §4.10）
 * 12 项指标：交付 4 / 生产 4 / 物料 4；口径唯一，可下钻至业务记录
 */

import { bar, esc, modal, num, table, options } from '../dom.js';
import { computeMetrics, defaultPeriod } from '../../core/metrics.js';

let filter = null;

export default {
  render(view, ctx) {
    const { db, asOf } = ctx;
    if (!filter) filter = defaultPeriod(asOf);

    const metrics = computeMetrics(db, filter);
    const groups = ['交付', '生产', '物料'];

    view.innerHTML = `
      <div class="card">
        <div class="card-h">
          <h3>统计条件</h3>
          <span class="desc">所有指标共用同一口径字典；页面间不允许出现不同算法</span>
        </div>
        <div class="toolbar">
          <label class="small">统计期</label>
          <input type="date" id="from" value="${esc(filter.from)}" style="width:150px" />
          <span class="small">至</span>
          <input type="date" id="to" value="${esc(filter.to)}" style="width:150px" />
          <select id="prod" style="width:170px">${options(
            db.products.map((p) => ({ value: p.id, label: p.name })),
            filter.productId,
            '全部产品'
          )}</select>
          <select id="wc" style="width:170px">${options(
            db.workCenters.map((p) => ({ value: p.id, label: p.name })),
            filter.workCenterId,
            '全部工作中心'
          )}</select>
          <button class="btn sm primary" data-act="apply">应用</button>
          <span class="spacer"></span>
          <span class="small">交付 4 项 · 生产 4 项 · 物料 4 项</span>
        </div>
      </div>

      ${groups
        .map(
          (g) => `
        <div class="card">
          <div class="card-h"><h3>${g}指标</h3></div>
          <div class="card-b">
            <div class="grid g4" style="margin-bottom:12px">
              ${metrics
                .filter((m) => m.group === g)
                .map(
                  (m) => `<div class="kpi" data-metric="${m.key}">
                    <div class="k-label">${esc(m.name)}</div>
                    <div class="k-val" style="font-size:22px">${esc(m.display)}<span class="small" style="font-weight:400"> ${esc(m.unit)}</span></div>
                    <div class="k-sub">${esc(m.formula)}</div>
                  </div>`
                )
                .join('')}
            </div>
            ${table(
              [
                { title: '指标', render: (m) => `<b>${esc(m.name)}</b>` },
                { title: '数值', cls: 'num', render: (m) => `${esc(m.display)} ${esc(m.unit)}` },
                {
                  title: '可视化',
                  render: (m) => {
                    if (m.unit !== '%') return '<span class="muted small">—</span>';
                    return `<div style="min-width:100px">${bar(m.value / 100, m.value >= 90 ? '' : m.value >= 70 ? 'warn' : 'danger')}</div>`;
                  },
                },
                { title: '计算口径', render: (m) => `<span class="small">${esc(m.basis)}</span>` },
                { title: '明细', cls: 'num', render: (m) => `${m.detail.length} 条` },
                { title: '', render: (m) => `<button class="btn sm ghost" data-drill="${m.key}">下钻</button>` },
              ],
              metrics.filter((m) => m.group === g)
            )}
          </div>
        </div>`
        )
        .join('')}`;

    view.querySelector('[data-act="apply"]').addEventListener('click', () => {
      filter = {
        from: view.querySelector('#from').value,
        to: view.querySelector('#to').value,
        productId: view.querySelector('#prod').value,
        workCenterId: view.querySelector('#wc').value,
      };
      ctx.redraw();
    });

    view.querySelectorAll('[data-drill]').forEach((b) =>
      b.addEventListener('click', () => drill(ctx, metrics.find((m) => m.key === b.dataset.drill)))
    );
    view.querySelectorAll('[data-metric]').forEach((el) =>
      el.addEventListener('click', () => drill(ctx, metrics.find((m) => m.key === el.dataset.metric)))
    );
  },
};

function drill(ctx, m) {
  if (!m) return;
  const cols = m.detail.length ? Object.keys(m.detail[0]) : [];
  const body = `
    <div class="notice info"><b>${esc(m.name)} = ${esc(m.display)} ${esc(m.unit)}</b><br/>
    公式：${esc(m.formula)}<br/>口径：${esc(m.basis)}</div>
    ${
      cols.length
        ? table(
            cols.map((c) => ({
              title: c,
              render: (r) => esc(typeof r[c] === 'boolean' ? (r[c] ? '是' : '否') : r[c]),
            })),
            m.detail
          )
        : '<div class="empty">该指标在当前条件下没有可下钻的记录</div>'
    }`;
  modal({ title: `下钻 · ${m.name}`, body, wide: true });
}
