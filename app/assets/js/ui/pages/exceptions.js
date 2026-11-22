/**
 * 异常中心（V1.0 §4.7）
 * 统一异常池 → 原因与受影响对象 → 处理建议 → 模拟方案 → 人工决策 → 记录闭环
 * AI 分析为降级态（规则摘要），明确区分事实与推测。
 */

import { badge, esc, modal, num, table, toast, options } from '../dom.js';
import { EXCEPTION_TYPE, EXCEPTION_LEVEL, EXCEPTION_STATUS, label, toneOf } from '../../core/constants.js';
import { analyzeException, AI_STATUS } from '../../core/ai.js';

let filter = { type: '', level: '', status: 'OPEN' };

export default {
  render(view, ctx) {
    const { db, asOf } = ctx;
    const all = db.exceptions;
    const rows = all
      .filter((e) => (!filter.type || e.type === filter.type) && (!filter.level || e.level === filter.level) && (!filter.status || e.status === filter.status))
      .sort((a, b) => {
        const lv = EXCEPTION_LEVEL[a.level].rank - EXCEPTION_LEVEL[b.level].rank;
        if (lv !== 0) return lv;
        return b.foundAt.localeCompare(a.foundAt);
      });

    const cnt = (s) => all.filter((e) => e.status === s).length;

    view.innerHTML = `
      <div class="notice info">
        <b>${esc(AI_STATUS.label)}</b>：${esc(AI_STATUS.notice)}
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        <div class="kpi ${cnt('OPEN') ? 'danger' : 'ok'}"><div class="k-label">待处理</div><div class="k-val">${cnt('OPEN')}</div></div>
        <div class="kpi"><div class="k-label">处理中</div><div class="k-val">${cnt('PROCESSING')}</div></div>
        <div class="kpi ok"><div class="k-label">已解决</div><div class="k-val">${cnt('RESOLVED')}</div></div>
        <div class="kpi"><div class="k-label">已关闭</div><div class="k-val">${cnt('CLOSED')}</div></div>
      </div>

      <div class="card">
        <div class="card-h">
          <h3>异常列表</h3>
          <span class="desc">同一对象重复触发时合并，不重复刷屏</span>
          <div class="right"><button class="btn sm primary" data-act="scan">重新扫描</button></div>
        </div>
        <div class="toolbar">
          <select id="ft" style="width:130px">${options(
            Object.values(EXCEPTION_TYPE).map((t) => ({ value: t.code, label: t.name })),
            filter.type,
            '全部类型'
          )}</select>
          <select id="fl" style="width:120px">${options(
            Object.values(EXCEPTION_LEVEL).map((t) => ({ value: t.code, label: t.name })),
            filter.level,
            '全部等级'
          )}</select>
          <select id="fs" style="width:130px">${options(
            Object.values(EXCEPTION_STATUS).map((t) => ({ value: t.code, label: t.name })),
            filter.status,
            '全部状态'
          )}</select>
          <button class="btn sm" data-act="apply">筛选</button>
          <span class="spacer"></span>
          <span class="small">共 ${rows.length} 条</span>
        </div>
        ${table(
          [
            { title: '编号', cls: 'mono', render: (e) => esc(e.id) },
            { title: '等级', render: (e) => badge(label(EXCEPTION_LEVEL, e.level), toneOf(EXCEPTION_LEVEL, e.level)) },
            { title: '类型', render: (e) => esc(label(EXCEPTION_TYPE, e.type)) },
            { title: '异常现象', render: (e) => `<b>${esc(e.name)}</b>` },
            {
              title: '关联对象',
              render: (e) => {
                const o = db.productionOrders.find((x) => x.id === e.orderId);
                const wc = db.workCenters.find((x) => x.id === e.workCenterId);
                return [o ? o.code : '', wc ? wc.name : ''].filter(Boolean).join(' · ') || '<span class="muted">—</span>';
              },
            },
            { title: '原因', render: (e) => `<span class="small">${esc((e.reason || '').slice(0, 64))}</span>` },
            { title: '发现时间', cls: 'mono', render: (e) => esc(e.foundAt) },
            { title: '状态', render: (e) => badge(label(EXCEPTION_STATUS, e.status), e.status === 'RESOLVED' || e.status === 'CLOSED' ? 'ok' : e.status === 'PROCESSING' ? 'info' : 'warn') },
            { title: '', cls: 'nowrap', render: (e) => `<button class="btn sm ghost" data-exc="${e.id}">处理</button>` },
          ],
          rows,
          { empty: '没有符合条件的异常' }
        )}
      </div>`;

    view.querySelector('[data-act="apply"]').addEventListener('click', () => {
      filter = {
        type: view.querySelector('#ft').value,
        level: view.querySelector('#fl').value,
        status: view.querySelector('#fs').value,
      };
      ctx.redraw();
    });
    view.querySelector('[data-act="scan"]').addEventListener('click', () => {
      const r = ctx.syncExceptions();
      ctx.commit(`扫描完成：新增 ${r.created} 条，更新 ${r.merged} 条`);
    });
    view.querySelectorAll('[data-exc]').forEach((b) =>
      b.addEventListener('click', () => detailModal(ctx, b.dataset.exc))
    );
  },
};

function detailModal(ctx, excId) {
  const { db } = ctx;
  const exc = db.exceptions.find((e) => e.id === excId);
  if (!exc) return;
  const analysis = analyzeException(db, exc);
  const order = db.productionOrders.find((o) => o.id === exc.orderId);

  const body = `
    <dl class="kv" style="margin-bottom:12px">
      <dt>异常编号</dt><dd>${esc(exc.id)}　${badge(label(EXCEPTION_LEVEL, exc.level), toneOf(EXCEPTION_LEVEL, exc.level))}</dd>
      <dt>类型 / 现象</dt><dd>${esc(label(EXCEPTION_TYPE, exc.type))} · <b>${esc(exc.name)}</b></dd>
      <dt>关联订单</dt><dd>${order ? esc(order.code) : '—'}</dd>
      <dt>发现时间</dt><dd>${esc(exc.foundAt)}（最近命中 ${esc(exc.lastSeen || '')}）</dd>
      <dt>原因</dt><dd>${esc(exc.reason)}</dd>
      ${exc.detail && exc.detail.length ? `<dt>明细</dt><dd class="small">${exc.detail.map((d) => esc(d)).join('；')}</dd>` : ''}
    </dl>

    <div class="notice info" style="margin-bottom:10px">以下为<b>${esc(analysis.aiLabel)}</b>，由系统基于业务数据生成，不替代人工决策，也不会修改任何计划数据。</div>

    <h4 style="margin:10px 0 6px;font-size:12.5px">已知事实（引用系统数据）</h4>
    <ul style="margin:0;padding-left:18px;font-size:12.5px;line-height:1.8">
      ${analysis.facts.map((f) => `<li>${esc(f)}</li>`).join('')}
    </ul>

    ${
      analysis.inferences.length
        ? `<h4 style="margin:12px 0 6px;font-size:12.5px">推测（需人工确认）</h4>
           <ul style="margin:0;padding-left:18px;font-size:12.5px;line-height:1.8;color:var(--warn)">
             ${analysis.inferences.map((f) => `<li>${esc(f)}</li>`).join('')}
           </ul>`
        : ''
    }

    <h4 style="margin:12px 0 6px;font-size:12.5px">处理建议</h4>
    ${
      analysis.suggestions.length
        ? analysis.suggestions
            .map(
              (s, i) => `<div class="rowline">
                <div style="flex:1">
                  <b>${i + 1}. ${esc(s.title)}</b>
                  <div class="small">${esc(s.detail)}</div>
                  <div class="small" style="color:var(--info)">预期效果：${esc(s.expected)}</div>
                </div>
                <div class="r"><button class="btn sm" data-adopt="${i}">采纳并记录</button></div>
              </div>`
            )
            .join('')
        : '<div class="small">该异常暂无规则化建议</div>'
    }

    <h4 style="margin:14px 0 6px;font-size:12.5px">处理记录</h4>
    ${
      (exc.records || []).length
        ? (exc.records || [])
            .map(
              (r) => `<div class="rowline"><div><b>${esc(r.action)}</b><div class="small">${esc(r.note || '')}</div></div><div class="r mono-s">${esc(r.at)}</div></div>`
            )
            .join('')
        : '<div class="small">尚无处理记录</div>'
    }

    <div class="field" style="margin-top:12px"><label>处理说明</label><textarea id="note" rows="2" placeholder="记录处置动作与结果"></textarea></div>
    <div class="field"><label>责任人</label><input type="text" id="owner" value="${esc(exc.owner || '')}" placeholder="自由文本，不建用户关联" /></div>`;

  const footer = `
    <button class="btn" data-c>关闭</button>
    <button class="btn" data-set="PROCESSING">标记处理中</button>
    <button class="btn primary" data-set="RESOLVED">标记已解决</button>
    <button class="btn danger" data-set="CLOSED">关闭异常</button>`;

  modal({
    title: `异常处理 · ${exc.id}`,
    body,
    wide: true,
    footer,
    onMount(root, close) {
      root.querySelector('[data-c]').addEventListener('click', close);
      root.querySelectorAll('[data-adopt]').forEach((b) =>
        b.addEventListener('click', () => {
          const s = analysis.suggestions[Number(b.dataset.adopt)];
          exc.records = exc.records || [];
          exc.records.push({ at: ctx.asOf, action: `采纳建议：${s.title}`, note: s.expected });
          exc.status = 'PROCESSING';
          close();
          ctx.commit(`已记录采纳建议；请在排程或物料页按建议调整，系统不会自动改计划`);
        })
      );
      root.querySelectorAll('[data-set]').forEach((b) =>
        b.addEventListener('click', () => {
          const note = root.querySelector('#note').value.trim();
          const owner = root.querySelector('#owner').value.trim();
          if (!note) {
            toast('请先填写处理说明', 'danger');
            return;
          }
          exc.status = b.dataset.set;
          exc.owner = owner;
          exc.records = exc.records || [];
          exc.records.push({ at: ctx.asOf, action: label(EXCEPTION_STATUS, b.dataset.set), note });
          close();
          ctx.commit(`异常已更新为「${label(EXCEPTION_STATUS, b.dataset.set)}」`);
        })
      );
    },
  });
}
