/**
 * PMC 工作台（V1.0 §4.1）
 * 首页重点是业务信息与"今天要处理的事"，不做纯图表展示。
 */

import { badge, bar, esc, num, table, toast } from '../dom.js';
import { dashboardSummary, computeMetrics, defaultPeriod, riskOf, dueDateOf } from '../../core/metrics.js';
import { checkConstraints } from '../../core/constraints.js';
import { KITTING_STATUS, EXCEPTION_LEVEL, RISK_STATUS, label, toneOf } from '../../core/constants.js';
import { kittingOf } from '../../core/rules.js';

function kpi(labelText, value, sub, tone, nav) {
  return `<div class="kpi ${tone}" data-nav="${nav || ''}">
    <div class="k-label">${esc(labelText)}</div>
    <div class="k-val">${value}</div>
    <div class="k-sub">${esc(sub)}</div>
  </div>`;
}

export default {
  render(view, ctx) {
    const { db, asOf } = ctx;
    const s = dashboardSummary(db, asOf);

    const tasks = db.tasks.filter((t) => t.versionId === db.activeVersionId);
    const violations = checkConstraints(tasks, db, db.settings);
    const hardCap = violations.filter((v) => v.code === 'HC-04').length;
    const hardAll = violations.filter((v) => v.level === 'HARD').length;

    // 与统计分析共用同一默认统计期，避免同名指标出现两个数字
    const period = defaultPeriod(asOf);
    const metrics = computeMetrics(db, period);
    const pick = (k) => metrics.find((m) => m.key === k);

    const openExc = db.exceptions
      .filter((e) => ['OPEN', 'PROCESSING'].includes(e.status))
      .sort((a, b) => EXCEPTION_LEVEL[a.level].rank - EXCEPTION_LEVEL[b.level].rank)
      .slice(0, 6);

    const todayTasks = tasks
      .filter((t) => (t.dailyPlan || []).some((d) => d.date === asOf))
      .sort((a, b) => a.startDate.localeCompare(b.startDate))
      .slice(0, 8);

    view.innerHTML = `
      <div class="grid g6">
        ${kpi('在制订单', s.totalOrders, '未完工且未关闭', '', '#/orders')}
        ${kpi('待排产', s.toSchedule, '状态为「待排产」', s.toSchedule ? 'warn' : '', '#/schedule')}
        ${kpi('生产中', s.inProduction, '已开工未完工', '', '#/exec')}
        ${kpi('物料短缺订单', s.shortageOrders, '齐套状态为「缺料」', s.shortageOrders ? 'danger' : 'ok', '#/material')}
        ${kpi('产能冲突', hardCap, hardAll ? `硬约束合计 ${hardAll} 处` : '无硬约束违规', hardCap ? 'danger' : 'ok', '#/schedule')}
        ${kpi('交付风险订单', s.riskOrders, '预计延期或有风险', s.riskOrders ? 'danger' : 'ok', '#/delivery')}
      </div>

      <div class="split">
        <div>
          <div class="card">
            <div class="card-h">
              <h3>今日计划生产任务</h3>
              <span class="desc">${esc(asOf)} · 共 ${s.todayTaskCount} 道工序 · ${s.todayQty} 件</span>
              <div class="right"><button class="btn sm" data-act="goto-schedule">查看排程</button></div>
            </div>
            <div class="card-b tight">
              ${
                todayTasks.length
                  ? table(
                      [
                        { title: '订单', render: (t) => `<b>${esc((db.productionOrders.find((o) => o.id === t.orderId) || {}).code || '')}</b>` },
                        { title: '工序', render: (t) => esc(t.opName) },
                        {
                          title: '工作中心',
                          render: (t) => esc((db.workCenters.find((w) => w.id === t.workCenterId) || {}).name || '—'),
                        },
                        {
                          title: '今日数量',
                          cls: 'num',
                          render: (t) => {
                            const d = (t.dailyPlan || []).find((x) => x.date === asOf);
                            return d ? num(d.qty) : '—';
                          },
                        },
                        { title: '状态', render: (t) => badge(t.status === 'IN_PROGRESS' ? '进行中' : '已计划', t.status === 'IN_PROGRESS' ? 'info' : 'muted') },
                      ],
                      todayTasks
                    )
                  : '<div class="empty">今日无排程任务（可能是周末或节假日，或计划已全部排在未来）</div>'
              }
            </div>
          </div>

          <div class="card">
            <div class="card-h">
              <h3>各工作中心产能负荷</h3>
              <span class="desc">未来 14 天 · 负荷率 = 已排数量 ÷（日产能 × 可用工作日）</span>
              <div class="right"><button class="btn sm" data-act="goto-schedule">甘特图</button></div>
            </div>
            <div class="card-b tight">
              ${table(
                [
                  { title: '工作中心', render: (r) => `<b>${esc(r.wc.name)}</b> <span class="small">${esc(r.wc.code)}</span>` },
                  { title: '日产能', cls: 'num', render: (r) => (r.cap ? `${num(r.cap)} 件/日` : '—') },
                  { title: '已排数量', cls: 'num', render: (r) => num(r.load) },
                  {
                    title: '负荷率',
                    render: (r) => `<div class="inline"><div class="grow bar-w">${bar(r.util, r.util > 1 ? 'danger' : r.util > 0.85 ? 'warn' : '')}</div><span class="mono-s">${(r.util * 100).toFixed(0)}%</span></div>`,
                  },
                  {
                    title: '判断',
                    render: (r) => (r.util > 1 ? badge('超负荷', 'danger') : r.util > 0.85 ? badge('接近上限', 'warn') : badge('正常', 'ok')),
                  },
                ],
                s.wcLoad
              )}
            </div>
          </div>
        </div>

        <div class="side-panel">
          <div class="card">
            <div class="card-h">
              <h3>待处理异常</h3>
              <div class="right"><button class="btn sm" data-act="rescan">重新扫描</button></div>
            </div>
            <div class="card-b">
              ${
                openExc.length
                  ? openExc
                      .map(
                        (e) => `<div class="rowline">
                          <div>
                            ${badge(label(EXCEPTION_LEVEL, e.level), toneOf(EXCEPTION_LEVEL, e.level))}
                            <b class="ml-1">${esc(e.name)}</b>
                            <div class="small">${esc(e.reason || '').slice(0, 78)}</div>
                          </div>
                        </div>`
                      )
                      .join('')
                  : '<div class="empty">暂无待处理异常</div>'
              }
              <div class="mt-4"><button class="btn sm w-100" data-act="goto-exc">进入异常中心</button></div>
            </div>
          </div>

          <div class="card">
            <div class="card-h"><h3>关键指标</h3><span class="desc">${esc(period.from)} ~ ${esc(period.to)}<br/>口径见统计分析</span></div>
            <div class="card-b">
              ${['onTimeRate', 'kittingRate', 'utilization', 'attainment']
                .map((k) => {
                  const m = pick(k);
                  if (!m) return '';
                  return `<div class="rowline"><span>${esc(m.name)}</span><span class="r">${esc(m.display)}${esc(m.unit)}</span></div>`;
                })
                .join('')}
            </div>
          </div>

          <div class="card">
            <div class="card-h"><h3>近期完工与发货</h3></div>
            <div class="card-b">
              ${
                s.recentDone.length
                  ? s.recentDone
                      .map((o) => {
                        const r = riskOf(db, o);
                        return `<div class="rowline">
                          <div><b>${esc(o.code)}</b><div class="small">完工 ${esc(o.actualEnd)}</div></div>
                          <div class="r">${badge(label(RISK_STATUS, r.code), toneOf(RISK_STATUS, r.code))}</div>
                        </div>`;
                      })
                      .join('')
                  : '<div class="empty">近 7 天无完工记录</div>'
              }
            </div>
          </div>
        </div>
      </div>`;

    view.querySelectorAll('[data-nav]').forEach((el) => {
      if (!el.dataset.nav) return;
      el.addEventListener('click', () => ctx.go(el.dataset.nav));
    });
    const acts = {
      'goto-schedule': () => ctx.go('#/schedule'),
      'goto-exc': () => ctx.go('#/exceptions'),
      rescan: () => {
        const r = ctx.syncExceptions();
        ctx.commit(`扫描完成：新增 ${r.created} 条，更新 ${r.merged} 条`);
      },
    };
    view.querySelectorAll('[data-act]').forEach((b) => {
      const fn = acts[b.dataset.act];
      if (fn) b.addEventListener('click', fn);
    });
  },
};
