/**
 * 应用外壳：路由、导航、全局操作
 * 分层：本文件只负责装配与状态分发，业务规则全部在 core/ 下，页面渲染在 ui/pages/ 下。
 */

import { loadDb, saveDb, exportJson, storageInfo } from './core/store.js';
import { buildSeed, SCENARIOS, SEED_REV } from './core/seed.js';
import { importDataset, templateDataset } from './core/dataset.js';
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

/**
 * 只有"由内置种子生成、且版本号不一致"的数据才提示重建。
 * 旧判断只看 productionOrders 非空，导入的外部数据集（seedRev 为空）会被误判成旧演示数据，
 * 提示条一出现，用户一点"重建演示数据"就把刚导入的数据覆盖回内置场景。
 */
const staleSeed = !!db.seedRev && db.seedRev !== SEED_REV;

/** 顶栏场景标识：内置场景显示场景名，外部数据优先显示文件名 */
function scenarioLabel() {
  if (db.seedScenario && SCENARIOS[db.seedScenario]) return SCENARIOS[db.seedScenario].name;
  return db.datasetLabel || '外部数据';
}

/** 导入校验结果的可视化：错误给字段定位，通过则给集合条数与提示 */
function datasetReportHtml(rep) {
  if (!rep.ok) {
    const shown = rep.errors
      .slice(0, 8)
      .map((e) => `· <b>${esc(e.path)}</b>：${esc(e.message)}`)
      .join('<br>');
    const more = rep.errors.length > 8 ? `<br>…另有 ${rep.errors.length - 8} 项` : '';
    return `<div class="notice danger"><b>校验未通过（${rep.errors.length} 项），数据不会载入：</b><br>${shown}${more}</div>`;
  }
  const c = rep.counts;
  const rows = [
    ['生产订单', c.productionOrders],
    ['销售订单行', c.salesOrderLines],
    ['工序任务', c.tasks],
    ['计划版本', c.planVersions],
    ['产品 / 物料', `${c.products} / ${c.materials}`],
    ['工作中心 / BOM', `${c.workCenters} / ${c.bomItems}`],
    ['库存 / 到货', `${c.inventory} / ${c.inbounds}`],
  ]
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(String(v))}</td></tr>`)
    .join('');
  return `
    <div class="notice ok"><b>校验通过</b>：${esc(rep.meta.datasetLabel)} · 工作版本 ${esc(rep.meta.versionCode)}</div>
    <table class="tb"><thead><tr><th>集合</th><th>条数</th></tr></thead><tbody>${rows}</tbody></table>
    ${
      rep.warnings.length
        ? `<div class="notice warn" style="margin-top:10px"><b>提示：</b><br>${rep.warnings.map((w) => `· ${esc(w)}`).join('<br>')}</div>`
        : ''
    }`;
}

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
      <button class="btn sm" data-act="scenario" title="切换内置场景，或导入外部测试数据">场景：${esc(scenarioLabel())}</button>
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
      <div class="notice info">载入场景会<b>重建整套内置测试数据</b>，当前数据将被覆盖。建议先「备份」。</div>
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
        .join('')}
      <div class="hr"></div>
      <h4 style="margin:0 0 6px">导入外部测试数据</h4>
      <div class="small muted" style="margin-bottom:10px">
        支持 JSON。文件需包含 <b>productionOrders</b>（生产订单）；其余集合可缺省。
        可接受三种信封：直接放数据集对象，或包在 <code>data</code> / <code>dataset</code> / <code>db</code> 里。
        缺少计划版本时会自动建立工作版本，脱链的工序任务会重新挂到该版本上，避免"导入成功但计划页空白"。
      </div>
      <div class="field">
        <label>选择数据集文件</label>
        <input type="file" id="ds-file" accept=".json,application/json" />
      </div>
      <div id="ds-out"></div>
      <div class="inline" style="margin-top:10px">
        <button class="btn sm" data-ds-tpl>下载示例数据集</button>
        <button class="btn sm primary" data-ds-load disabled>载入该数据集</button>
      </div>`;
    const m = modal({ title: '测试数据：内置场景与外部导入', body, wide: true });
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

    /* ── 外部数据集：选文件即校验，校验通过才允许载入 ── */
    let pending = null;
    const fileInput = m.root.querySelector('#ds-file');
    const out = m.root.querySelector('#ds-out');
    const loadBtn = m.root.querySelector('[data-ds-load]');

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      pending = null;
      loadBtn.disabled = true;
      out.innerHTML = '';
      if (!file) return;
      try {
        const text = await readText(file);
        const res = importDataset(text, { fileName: file.name });
        pending = res.ok ? res : null;
        out.innerHTML = datasetReportHtml(res.report);
        loadBtn.disabled = !res.ok;
      } catch (e) {
        out.innerHTML = `<div class="notice danger"><b>读取失败：</b>${esc(e.message)}</div>`;
      }
    });

    loadBtn.addEventListener('click', async () => {
      if (!pending || !pending.db) return;
      const c = pending.report.counts;
      const ok = await confirmDialog(
        '载入外部测试数据',
        `将用「${pending.db.datasetLabel}」覆盖当前全部数据（${c.productionOrders} 张生产订单 / ${c.tasks} 道工序），确认继续？建议先「备份」。`,
        '载入'
      );
      if (!ok) return;
      if (!saveDb(pending.db)) {
        toast('保存失败：本地存储可能已满，请先备份并减少数据量', 'danger');
        return;
      }
      db = pending.db;
      m.close();
      location.hash = '#/dashboard';
      location.reload();
    });

    m.root.querySelector('[data-ds-tpl]').addEventListener('click', () => {
      downloadRaw('外部测试数据集模板.json', JSON.stringify(templateDataset(AS_OF), null, 2), 'application/json');
      toast('示例数据集已导出，改完可通过「选择数据集文件」载入', 'ok');
    });
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
      let res;
      try {
        res = importDataset(await readText(f), { fileName: f.name });
      } catch (e) {
        toast(`读取失败：${e.message}`, 'danger');
        return;
      }
      // 恢复与「导入外部测试数据」共用同一套校验，避免两条路径行为不一致
      if (!res.ok) {
        modal({ title: '恢复失败：数据校验未通过', body: datasetReportHtml(res.report), wide: true });
        return;
      }
      const c = res.report.counts;
      const ok = await confirmDialog(
        '确认恢复',
        `将载入「${res.db.datasetLabel}」（${c.productionOrders} 张生产订单 / ${c.tasks} 道工序），覆盖当前全部数据。`,
        '恢复'
      );
      if (!ok) return;
      if (!saveDb(res.db)) {
        toast('保存失败：本地存储可能已满，请先备份并减少数据量', 'danger');
        return;
      }
      db = res.db;
      location.reload();
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
