/**
 * 应用外壳：路由、导航、全局操作
 * 分层：本文件只负责装配与状态分发，业务规则全部在 core/ 下，页面渲染在 ui/pages/ 下。
 */

import { loadDb, saveDb, clearDb, emptyDb, exportJson, importJson, storageInfo } from './core/store.js';
import { buildSeed, SCENARIOS, SEED_REV } from './core/seed.js';
import { today } from './core/calendar.js';
import { syncExceptions } from './core/exceptions.js';
import { toast, confirmDialog, modal, downloadRaw, readText, esc } from './ui/dom.js';

import dashboard from './ui/pages/dashboard.js';
import orders from './ui/pages/orders.js';
import material from './ui/pages/material.js';
import schedule from './ui/pages/schedule.js';
import versions from './ui/pages/versions.js';
import exec from './ui/pages/exec.js';
import delivery from './ui/pages/delivery.js';
import exceptions from './ui/pages/exceptions.js';
import base from './ui/pages/base.js';
import stats from './ui/pages/stats.js';

const PAGES = [
  { key: 'dashboard', label: 'PMC 工作台', page: dashboard },
  { key: 'orders', label: '订单管理', page: orders },
  { key: 'material', label: '物料管理', page: material },
  { key: 'schedule', label: '生产排程', page: schedule },
  { key: 'versions', label: '计划版本', page: versions },
  { key: 'exec', label: '执行跟踪', page: exec },
  { key: 'delivery', label: '交付管理', page: delivery },
  { key: 'exceptions', label: '异常中心', page: exceptions },
  { key: 'base', label: '基础数据', page: base },
  { key: 'stats', label: '统计分析', page: stats },
];

const AS_OF = today();

let db = loadDb();
if (!db) {
  db = buildSeed('medium', AS_OF);
  saveDb(db);
}

/** 演示数据版本不一致：存量数据可能"半新半旧"，页面数字会失真，需要用户确认后重建 */
const staleSeed = (db.productionOrders || []).length > 0 && db.seedRev !== SEED_REV;

const ctx = {
  db,
  asOf: AS_OF,
  scenario: db.seedScenario || 'medium',
  /** 变更数据：保存并重绘 */
  commit(message, tone = 'ok') {
    const ok = saveDb(this.db);
    if (!ok) toast('保存失败：本地存储可能已满，请先备份并清理', 'danger');
    else if (message) toast(message, tone);
    render();
  },
  /** 只重绘不保存 */
  redraw() {
    render();
  },
  /** 只保存不重绘（用于弹窗内的中间状态） */
  persist() {
    return saveDb(this.db);
  },
  go(hash) {
    location.hash = hash;
  },
  /** 重新扫描异常并入库 */
  syncExceptions() {
    const r = syncExceptions(this.db, this.asOf);
    return r;
  },
};

/* ───────── 外壳 ───────── */
function shellHtml() {
  const openExc = db.exceptions.filter((e) => ['OPEN', 'PROCESSING'].includes(e.status)).length;
  const nav = PAGES.map((p, i) => {
    const badgeHtml = p.key === 'exceptions' && openExc ? `<span class="dot">${openExc}</span>` : '';
    return `<div class="nav-item" data-nav="${p.key}" role="link" tabindex="0">
      <span class="idx">${String(i + 1).padStart(2, '0')}</span>${esc(p.label)}${badgeHtml}
    </div>`;
  }).join('');

  const info = storageInfo();
  return `
  <div class="sidebar">
    <div class="brand">
      <h1>生产计划与交付管理</h1>
      <span>MVP · 单工厂 · 工序级按日排产</span>
    </div>
    <nav class="nav" aria-label="主导航">${nav}</nav>
    <div class="sidebar-foot">
      <div>工厂：<b>${esc(db.factory.name)}</b></div>
      <div>数据量：<b>${(info.bytes / 1024).toFixed(0)} KB</b></div>
      <div>AI：<b>${db.settings.aiEnabled ? '已接入' : '未接入（规则摘要）'}</b></div>
    </div>
  </div>
  <div class="main">
    <div class="topbar">
      <h2 id="page-title">PMC 工作台</h2>
      <span class="crumb" id="page-crumb"></span>
      <span class="spacer"></span>
      <span class="asof" title="系统基准日：所有日期口径以此为参照">基准日 ${AS_OF}</span>
      <button class="btn sm" data-act="scenario">场景：${esc(SCENARIOS[ctx.scenario].name)}</button>
      <button class="btn sm" data-act="backup">备份</button>
      <button class="btn sm" data-act="restore">恢复</button>
    </div>
    ${
      staleSeed
        ? `<div class="stale-bar">
            <span>本地数据由旧版演示数据生成（${esc(db.seedRev)} → ${esc(SEED_REV)}），数字可能与当前规则不一致。</span>
            <span class="spacer"></span>
            <button class="btn sm" data-act="rebuild">重建演示数据</button>
            <button class="btn sm ghost" data-act="dismiss-stale">保留现状</button>
          </div>`
        : ''
    }
    <div class="view" id="view"></div>
  </div>`;
}

function currentPage() {
  const key = (location.hash || '#/dashboard').replace('#/', '') || 'dashboard';
  return PAGES.find((p) => p.key === key) || PAGES[0];
}

function render() {
  const app = document.getElementById('app');
  if (!app.dataset.shell) {
    app.innerHTML = shellHtml();
    app.dataset.shell = '1';
    bindShell();
  } else {
    // 仅更新导航徽标与侧栏信息
    const openExc = db.exceptions.filter((e) => ['OPEN', 'PROCESSING'].includes(e.status)).length;
    const dot = app.querySelector('[data-nav="exceptions"] .dot');
    if (dot) dot.textContent = openExc || '';
    else if (openExc) {
      const el = app.querySelector('[data-nav="exceptions"]');
      if (el) el.insertAdjacentHTML('beforeend', `<span class="dot">${openExc}</span>`);
    }
    const foot = app.querySelector('.sidebar-foot b:last-of-type');
    if (foot) foot.textContent = db.settings.aiEnabled ? '已接入' : '未接入（规则摘要）';
  }

  const p = currentPage();
  document.getElementById('page-title').textContent = p.label;
  document.getElementById('page-crumb').textContent = `首页 / ${p.label}`;
  document.title = `${p.label} · 生产计划与交付管理`;
  app.querySelectorAll('.nav-item').forEach((el) => {
    const active = el.dataset.nav === p.key;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });

  const view = document.getElementById('view');
  view.innerHTML = '';
  try {
    p.page.render(view, ctx);
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="notice danger"><b>页面渲染出错：</b>${esc(err.message)}</div>`;
  }
  window.scrollTo({ top: 0 });
}

function bindShell() {
  document.querySelectorAll('[data-nav]').forEach((el) => {
    const go = () => {
      location.hash = `#/${el.dataset.nav}`;
    };
    el.addEventListener('click', go);
    // 键盘可达：Enter / Space 等同点击
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  });

  document.querySelector('[data-act="scenario"]').addEventListener('click', () => {
    const body = `
      <div class="notice info">切换场景会<b>重建整套测试数据</b>，当前数据将被覆盖。建议先「备份」。</div>
      ${Object.values(SCENARIOS)
        .map(
          (s) => `<div class="rowline">
            <div>
              <b>${esc(s.name)}</b>
              <div class="small">${esc(s.desc)}</div>
            </div>
            <div class="r"><button class="btn sm primary" data-sc="${s.code}">载入</button></div>
          </div>`
        )
        .join('')}`;
    const m = modal({ title: '切换测试数据场景', body });
    m.root.querySelectorAll('[data-sc]').forEach((b) =>
      b.addEventListener('click', async () => {
        const ok = await confirmDialog('确认覆盖', '当前所有数据将被重建，确认继续？', '重建数据');
        if (!ok) return;
        db = buildSeed(b.dataset.sc, AS_OF);
        saveDb(db);
        m.close();
        location.hash = '#/dashboard';
        location.reload();
      })
    );
  });

  document.querySelector('[data-act="backup"]').addEventListener('click', () => {
    downloadRaw(`生产计划数据备份_${AS_OF}.json`, exportJson(db), 'application/json');
    toast('备份文件已导出', 'ok');
  });

  document.querySelector('[data-act="restore"]').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      try {
        const text = await readText(f);
        const next = importJson(text);
        const ok = await confirmDialog('确认恢复', '恢复将覆盖当前全部数据，确认继续？', '恢复');
        if (!ok) return;
        db = next;
        saveDb(db);
        location.reload();
      } catch (e) {
        toast(`恢复失败：${e.message}`, 'danger');
      }
    };
    input.click();
  });

  const rebuild = document.querySelector('[data-act="rebuild"]');
  if (rebuild)
    rebuild.addEventListener('click', async () => {
      const ok = await confirmDialog('重建演示数据', '当前数据将被整套演示数据覆盖，确认继续？建议先「备份」。', '重建');
      if (!ok) return;
      db = buildSeed(ctx.scenario, AS_OF);
      saveDb(db);
      location.reload();
    });

  const dismiss = document.querySelector('[data-act="dismiss-stale"]');
  if (dismiss)
    dismiss.addEventListener('click', () => {
      db.seedRev = SEED_REV;
      saveDb(db);
      const bar = document.querySelector('.stale-bar');
      if (bar) bar.remove();
      toast('已保留现有数据', 'warn');
    });
}

window.addEventListener('hashchange', render);
render();

// 首次进入时扫描一次异常（不提示，避免干扰）
try {
  const r = syncExceptions(db, AS_OF);
  if (r.created > 0) saveDb(db);
} catch (e) {
  console.error(e);
}
