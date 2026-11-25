/**
 * 数据入口的两个弹窗：
 * 1. openBatchImport  —— Excel / CSV 批量导入（多文件、按场景合并，不整库替换）
 * 2. openDataManager  —— 数据管理（内置场景 / 整库 JSON / 导入履历 / 清空全部）
 *
 * 为什么集中在这里：
 * 原来"导入"分散在基础数据页与顶栏「场景」两处，前者选了 Excel 也按 CSV 解析，
 * 后者只认 JSON 且是整库覆盖。两条入口行为不一致，用户很难判断"这次导入到底动了什么"。
 * 现在按"合并导入"与"整库替换"两类明确分开，界面上写清楚后果。
 */

import { esc, modal, confirmDialog, toast, download, downloadRaw, readBuffer } from './dom.js';
import {
  IMPORT_SPECS,
  SPEC_ORDER,
  importSheetFiles,
  detectSpec,
  normalizeSheet,
  sheetSummary,
  allTemplates,
} from '../io.js';
import { readTableFile, trimGrid } from '../core/sheet.js';
import { importDataset, templateDataset } from '../core/dataset.js';
import { exportJson, replaceDb, clearAllData } from '../core/store.js';
import { buildSeed, SCENARIOS } from '../core/seed.js';

const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 整库替换类操作的收尾：先落盘，再刷新（顶栏标识与页面缓存都随之重置） */
function saveAndReload(ctx) {
  if (!ctx.persist()) toast('保存失败：本地存储可能已满，请先导出备份并清理', 'danger');
  location.hash = '#/dashboard';
  location.reload();
}

const collectionCounts = (db) => [
  ['产品 / 物料', `${db.products.length} / ${db.materials.length}`],
  ['BOM / 工作中心', `${db.bomItems.length} / ${db.workCenters.length}`],
  ['库存 / 到货', `${db.inventory.length} / ${db.inbounds.length}`],
  ['销售订单行', `${db.salesOrderLines.length}`],
  ['生产订单', `${db.productionOrders.length}`],
  ['工序任务 / 计划版本', `${db.tasks.length} / ${db.planVersions.length}`],
];

const sourceLabel = (db) => {
  if (db.seedScenario && SCENARIOS[db.seedScenario]) return `内置场景 · ${SCENARIOS[db.seedScenario].name}`;
  if (db.datasetLabel) return `外部数据集 · ${db.datasetLabel}`;
  const total = db.products.length + db.materials.length + db.productionOrders.length;
  return total ? '手工录入 / 导入合并' : '空库（尚未导入数据）';
};

/* ═══════════════ 批量导入（Excel / CSV） ═══════════════ */

export function openBatchImport(ctx, opts = {}) {
  const entries = [];
  let busy = false;

  const specOptions = (selected) =>
    `<option value="">自动识别</option>` +
    SPEC_ORDER.map(
      (k) =>
        `<option value="${k}" ${k === selected ? 'selected' : ''}>${esc(IMPORT_SPECS[k].label)}（${
          IMPORT_SPECS[k].kind === 'MASTER' ? '主数据' : '单据'
        }）</option>`
    ).join('');

  const body = `
    <div class="notice info">
      <b>支持 Excel（.xlsx / .xls）与 CSV</b>，可一次选多份文件。导入是<b>合并</b>，不是替换：
      主数据按编码更新（保留历史 id）、单据重复即跳过，<b>不会清空已有数据，也不会影响其他场景</b>。
      手工录入的记录只要不在本次文件里，就不会被改动。
    </div>
    <div class="field">
      <label>选择文件（可多选，支持 .xlsx / .xls / .csv）</label>
      <input type="file" id="bi-files" accept=".xlsx,.xls,.csv,.txt" multiple />
    </div>
    <div id="bi-list"><div class="empty">还没有选择文件</div></div>
    <div class="inline mt-4">
      <label class="small inline">
        <input type="checkbox" id="bi-backup" checked /> 导入前自动导出当前数据备份
      </label>
      <span class="spacer"></span>
      <select class="filter" id="bi-tpl" >
        ${SPEC_ORDER.map((k) => `<option value="${k}">${esc(IMPORT_SPECS[k].label)}</option>`).join('')}
      </select>
      <button class="btn sm" data-tpl>下载模板</button>
      <button class="btn sm" data-all-tpl>下载全部模板</button>
    </div>
    <div id="bi-out"></div>`;

  const m = modal({
    title: '导入 Excel / CSV（可多文件）',
    body,
    wide: true,
    footer: `<button class="btn" data-close2>关闭</button><button class="btn primary" data-run disabled>校验并导入</button>`,
    onMount(root, close) {
      const listEl = root.querySelector('#bi-list');
      const outEl = root.querySelector('#bi-out');
      const runBtn = root.querySelector('[data-run]');
      const input = root.querySelector('#bi-files');
      const backupEl = root.querySelector('#bi-backup');

      const peeked = new Set();

      const statusOf = (e) => {
        if (e.error) return { tone: 'danger', text: '读取失败' };
        if (!e.rows) return { tone: 'danger', text: '解析到 0 行' };
        if (e.detected && !e.detected.ambiguous) return { tone: 'ok', text: '已识别' };
        if (e.detected && e.detected.ambiguous) return { tone: 'warn', text: '建议确认' };
        return { tone: 'warn', text: '待指定' };
      };

      /** 解析结果预览：用户能直接看到"我到底读到了什么"，不用靠猜 */
      const peekHtml = (e) => {
        const head = `<div class="small muted mt-1 mb-2">下面是解析后读到的前 3 行（已去掉纯空行）。若与 Excel 里看到的不一致，说明该文件的存储方式特殊，请另存为 CSV 后重试。</div>`;
        const table = (e.sample || []).length
          ? `<div class="table-wrap"><table class="tb fs-12"><tbody>${e.sample
              .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
              .join('')}</tbody></table></div>`
          : '<div class="small muted">没有读到任何单元格内容</div>';
        return `<div class="pb-3">${head}${table}</div>`;
      };

      const renderList = () => {
        if (!entries.length) {
          listEl.innerHTML = '<div class="empty">还没有选择文件</div>';
          runBtn.disabled = true;
          return;
        }
        const rows = entries
          .map((e, i) => {
            const st = statusOf(e);
            const info = e.error
              ? ''
              : `识别到 ${e.recognized.length} 列${e.headerRow ? ` · 表头第 ${e.headerRow} 行` : ''}`;
            const cand =
              e.detected && e.detected.ambiguous
                ? `<div class="small muted">候选：${e.detected.candidates.map((c) => esc(c.label)).join(' / ')}</div>`
                : '';
            const notes = !e.error && (e.notes || []).length
              ? `<div class="small c-danger">${e.notes.map((n) => esc(n)).join('<br>')}</div>`
              : '';
            const peek = peeked.has(i) ? peekHtml(e) : '';
            return `<tr>
              <td>${esc(e.name)}<div class="small muted">${info}</div></td>
              <td>${e.error ? '—' : `<span class="mono">${esc(e.format.toUpperCase())}</span> · ${esc(e.sheetName || '')}`}</td>
              <td><select class="filter" data-spec="${i}" >${specOptions(e.specKey)}</select></td>
              <td class="num">${e.error ? '—' : e.rows}</td>
              <td><span class="badge ${st.tone}">${st.text}</span>
              ${e.error ? `<div class="small c-danger">${esc(e.error)}</div>` : ''}
              ${cand}${notes}
              ${e.error ? '' : `<div><button class="btn sm ghost mt-1" data-peek="${i}">${peeked.has(i) ? '收起' : '前 3 行'}</button></div>`}
              </td>
            </tr>
            <tr data-peek-row="${i}" ${peeked.has(i) ? '' : 'hidden'}><td colspan="5" class="border-top-0">${peek}</td></tr>`;
          })
          .join('');
        listEl.innerHTML = `<div class="table-wrap"><table class="tb"><thead><tr>
          <th>文件</th><th>格式 / 工作表</th><th>数据场景</th><th class="num">行数</th><th>识别结果</th>
        </tr></thead><tbody>${rows}</tbody></table></div>`;
        listEl.querySelectorAll('[data-spec]').forEach((sel) => {
          sel.addEventListener('change', () => {
            entries[Number(sel.dataset.spec)].specKey = sel.value;
          });
        });
        listEl.querySelectorAll('[data-peek]').forEach((btn) =>
          btn.addEventListener('click', () => {
            const i = Number(btn.dataset.peek);
            if (peeked.has(i)) peeked.delete(i);
            else peeked.add(i);
            renderList();
          })
        );
        runBtn.disabled = busy || !entries.some((e) => !e.error);
      };

      input.addEventListener('change', async () => {
        entries.length = 0;
        peeked.clear();
        outEl.innerHTML = '';
        listEl.innerHTML = '<div class="empty">正在读取文件…</div>';
        for (const file of [...(input.files || [])]) {
          const entry = {
            name: file.name,
            file,
            buffer: null,
            format: '',
            sheetName: '',
            rows: 0,
            sample: [],
            notes: [],
            recognized: [],
            headerRow: 0,
            specKey: '',
            detected: null,
            error: '',
          };
          try {
            entry.buffer = await readBuffer(file);
            const read = await readTableFile({ name: entry.name, buffer: entry.buffer });
            entry.notes = read.notes || [];
            const sheets = read.sheets || [];
            const withRows = sheets.filter((s) => trimGrid(s.grid).length > 1);
            const sheet = withRows[0] || sheets[0];
            if (!sheet) throw new Error('文件里没有可读的工作表');
            entry.format = read.format;
            entry.sheetName = sheet.name;
            const sum = sheetSummary(sheet);
            entry.rows = Math.max(0, sum.rows - 1);
            entry.sample = sum.sample;
            entry.detected = detectSpec(entry.name, sheet);
            if (entry.detected) {
              const norm = normalizeSheet(entry.detected.key, sheet);
              entry.headerRow = norm.found ? norm.headerRow : 0;
              entry.recognized = norm.found ? norm.headers : [];
            }
            // 歧义时不预选：按错误规格校验会报一堆看不懂的字段错误
            entry.specKey = entry.detected && !entry.detected.ambiguous ? entry.detected.key : '';
          } catch (e) {
            entry.error = e.message;
          }
          entries.push(entry);
        }
        // 从"导入：某类数据"按钮进入且只选一份文件时，用页面上的场景作为默认值
        if (opts.specKey && entries.length === 1 && !entries[0].error) entries[0].specKey = opts.specKey;
        renderList();
      });

      root.querySelector('[data-tpl]').addEventListener('click', () => {
        const key = root.querySelector('#bi-tpl').value;
        const t = allTemplates().find((x) => x.key === key);
        download(t.name, t.content);
        toast('模板已下载，可直接用 Excel 填写', 'ok');
      });
      root.querySelector('[data-all-tpl]').addEventListener('click', () => {
        allTemplates().forEach((t, i) => setTimeout(() => download(t.name, t.content), i * 250));
        toast(`已开始下载 ${SPEC_ORDER.length} 份模板`, 'ok');
      });

      root.querySelector('[data-run]').addEventListener('click', async () => {
        if (busy) return;
        const usable = entries.filter((e) => !e.error);
        if (!usable.length) {
          outEl.innerHTML = '<div class="notice warn">没有可导入的文件</div>';
          return;
        }
        // "自动识别"选项留空时，用非歧义的识别结果兜底
        usable.forEach((e) => {
          if (!e.specKey && e.detected && !e.detected.ambiguous) e.specKey = e.detected.key;
        });
        const zero = usable.filter((e) => !e.rows);
        if (zero.length) {
          outEl.innerHTML = `<div class="notice danger"><b>有 ${zero.length} 份文件解析到 0 行</b>，没有数据可导入：${zero
            .map((e) => esc(e.name))
            .join('、')}。请点「前 3 行」确认读到的内容；若和 Excel 里不一致，请另存为 CSV 后重试。</div>`;
          return;
        }
        const unassigned = usable.filter((e) => !e.specKey);
        if (unassigned.length) {
          const detail = unassigned
            .map((e) => {
              const cand = e.detected && e.detected.candidates.length
                ? `（候选：${e.detected.candidates.map((c) => esc(c.label)).join(' / ')}）`
                : '';
              return `${esc(e.name)}${cand}`;
            })
            .join('、');
          outEl.innerHTML = `<div class="notice warn">有 ${unassigned.length} 份文件没确定数据场景，请在上表手动选择：${detail}</div>`;
          return;
        }
        busy = true;
        runBtn.disabled = true;
        runBtn.textContent = '正在导入…';
        outEl.innerHTML = '<div class="notice info">正在校验并写入…文件较多时需要几秒</div>';
        try {
          if (backupEl.checked) {
            downloadRaw(`导入前备份_${ctx.asOf}.json`, exportJson(ctx.db), 'application/json');
          }
          const res = await importSheetFiles(
            usable.map((e) => ({ name: e.name, buffer: e.buffer, specKey: e.specKey })),
            ctx.db
          );
          outEl.innerHTML = batchReportHtml(res);
          if (res.ok) {
            replaceDb(ctx.db, res.db);
            ctx.commit(
              `导入完成：新增 ${res.totals.created}，更新 ${res.totals.updated}${
                res.totals.rejected ? `，跳过重复 ${res.totals.rejected}` : ''
              }（批次 ${res.batchId}）`
            );
            runBtn.textContent = '再次导入';
          } else {
            runBtn.textContent = '校验并导入';
          }
        } catch (e) {
          outEl.innerHTML = `<div class="notice danger"><b>导入失败：</b>${esc(e.message)}</div>`;
          runBtn.textContent = '校验并导入';
        } finally {
          busy = false;
          runBtn.disabled = false;
        }
      });

      root.querySelector('[data-close2]').addEventListener('click', close);
      renderList();
    },
  });

  return m;
}

function batchReportHtml(res) {
  const statusTone = { ok: 'ok', error: 'danger', empty: 'warn' };
  const statusText = { ok: '成功', error: '失败（未写入）', empty: '无有效数据行' };
  const rows = res.results
    .map((r) => {
      const errs = r.errors.length
        ? `<div class="small c-danger mt-1">${r.errors
            .slice(0, 4)
            .map((e) => `第 ${e.line || '—'} 行 · ${esc(e.field)}：${esc(e.message)}`)
            .join('<br>')}${r.errors.length > 4 ? `<br>…另有 ${r.errors.length - 4} 条` : ''}</div>`
        : '';
      const warns = r.warnings.length
        ? `<div class="small muted mt-1">${r.warnings.slice(0, 3).map((w) => esc(w)).join('<br>')}</div>`
        : '';
      return `<tr>
        <td>${esc(r.file)}<div class="small muted">${esc(r.specLabel || '—')}${r.sheetName ? ` · ${esc(r.sheetName)}` : ''}</div></td>
        <td><span class="badge ${statusTone[r.status]}">${statusText[r.status]}</span></td>
        <td class="num">${r.created}</td>
        <td class="num">${r.updated}</td>
        <td class="num">${r.skipped}</td>
        <td class="num">${r.autoLines || 0}</td>
      </tr>
      <tr><td colspan="6" class="border-top-0 pt-0">${errs}${warns}</td></tr>`;
    })
    .join('');

  const summary = res.ok
    ? `<div class="notice ok"><b>已写入（批次 ${esc(res.batchId)}）</b>：新增 ${res.totals.created} 条，更新 ${res.totals.updated} 条${
        res.totals.rejected ? `，跳过重复 ${res.totals.rejected} 条` : ''
      }${res.totals.failed ? `，${res.totals.failed} 份文件失败` : ''}。</div>`
    : `<div class="notice danger"><b>没有任何文件写入</b>：请按下面每份文件的错误修正后重试（已有数据未被改动）。</div>`;

  return `${summary}
    <div class="table-wrap mt-4"><table class="tb"><thead><tr>
      <th>文件 / 场景</th><th>结果</th><th class="num">新增</th><th class="num">更新</th><th class="num">跳过</th><th class="num">补建销售行</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    <div class="small muted mt-3">导入的生产订单为「待排产」，需要到生产排程页执行自动排产；主数据更新不会改变已有订单的关联。</div>`;
}

/* ═══════════════ 数据管理（场景 / 整库 JSON / 清空） ═══════════════ */

export function openDataManager(ctx) {
  const db = ctx.db;
  const counts = collectionCounts(db)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`)
    .join('');
  const logs = (db.importLogs || [])
    .slice(-8)
    .reverse()
    .map(
      (l) => `<tr>
        <td class="mono">${esc(l.batch || '—')}</td>
        <td>${esc(fmtTime(l.at))}</td>
        <td>${(l.files || []).map((f) => esc(f.file || f.spec || '')).join('<br>') || '—'}</td>
        <td class="num">${l.created ?? 0}</td>
        <td class="num">${l.updated ?? 0}</td>
        <td class="num">${l.rejected ?? 0}</td>
      </tr>`
    )
    .join('');

  const body = `
    <div class="notice info">
      当前数据来源：<b>${esc(sourceLabel(db))}</b>。导入 Excel/CSV 是<b>合并</b>；载入场景与载入整库 JSON 会<b>替换全部数据</b>。
    </div>
    <div class="grid g2">
      <div>
        <h4 class="sec-title">数据概况</h4>
        <table class="tb"><tbody>${counts}</tbody></table>
      </div>
      <div>
        <h4 class="sec-title">常用操作</h4>
        <div class="flexcol">
          <button class="btn primary" data-import>导入 Excel / CSV（可多文件）</button>
          <button class="btn" data-backup>导出当前数据备份（JSON）</button>
          <div class="small muted">备份文件可用「恢复」或下方「载入整库 JSON」还原。</div>
        </div>
        <h4 class="sec-title spaced">内置演示场景</h4>
        <div class="small muted mb-2">载入会重建整套演示数据，当前数据被替换；导入前建议先备份。</div>
        ${Object.values(SCENARIOS)
          .map(
            (s) => `<div class="rowline">
              <div><b>${esc(s.name)}</b><div class="small">${esc(s.desc)}</div></div>
              <div class="r"><button class="btn sm" data-sc="${s.code}">载入</button></div>
            </div>`
          )
          .join('')}
      </div>
    </div>
    <div class="hr"></div>
    <h4 class="sec-title">载入整库 JSON（替换全部数据）</h4>
    <div class="small muted mb-3">
      用于导入测试数据集或还原备份。文件需包含 <b>productionOrders</b>（可为空数组），可包在
      <code>data</code> / <code>dataset</code> / <code>db</code> 里；缺计划版本会自动建工作版本并重连工序任务。
    </div>
    <div class="field"><input type="file" id="dm-file" accept=".json,application/json" /></div>
    <div id="dm-out"></div>
    <div class="inline mt-3">
      <button class="btn sm" data-tpl>下载示例数据集</button>
    </div>
    <div class="hr"></div>
    <h4 class="sec-title">导入履历（最近 8 批）</h4>
    ${
      logs
        ? `<div class="table-wrap"><table class="tb"><thead><tr><th>批次</th><th>时间</th><th>文件</th><th class="num">新增</th><th class="num">更新</th><th class="num">跳过</th></tr></thead><tbody>${logs}</tbody></table></div>`
        : '<div class="empty">还没有导入记录</div>'
    }
    <div class="hr"></div>
    <h4 class="sec-title danger">危险操作：清空全部数据</h4>
    <div class="notice danger mt-2">
      清空后本地库为空（不会自动重建演示数据），<b>不可撤销</b>。清空前会自动导出一份 JSON 备份。
    </div>
    <div class="inline mt-3">
      <button class="btn danger" data-clear>清空全部数据…</button>
    </div>`;

  const m = modal({ title: '数据管理', body, wide: true, footer: '<button class="btn" data-close3>关闭</button>' });
  m.root.querySelector('[data-close3]').addEventListener('click', m.close);

  m.root.querySelector('[data-import]').addEventListener('click', () => {
    openBatchImport(ctx);
  });

  m.root.querySelector('[data-backup]').addEventListener('click', () => {
    downloadRaw(`生产计划数据备份_${ctx.asOf}.json`, exportJson(ctx.db), 'application/json');
    toast('备份已导出', 'ok');
  });

  m.root.querySelectorAll('[data-sc]').forEach((b) =>
    b.addEventListener('click', async () => {
      const code = b.dataset.sc;
      const ok = await confirmDialog(
        '载入内置场景',
        `将用「${esc(SCENARIOS[code].name)}」重建整套数据，当前所有数据（含手工录入与已导入数据）都会被替换。建议先用「导出当前数据备份」。确认继续？`,
        '重建数据'
      );
      if (!ok) return;
      replaceDb(ctx.db, buildSeed(code, ctx.asOf));
      saveAndReload(ctx);
      m.close();
    })
  );

  const out = m.root.querySelector('#dm-out');
  let pending = null;
  const fileEl = m.root.querySelector('#dm-file');
  const loadBtn = document.createElement('button');
  fileEl.addEventListener('change', async () => {
    pending = null;
    out.innerHTML = '';
    const file = fileEl.files && fileEl.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const res = importDataset(text, { fileName: file.name });
      pending = res.ok ? res : null;
      out.innerHTML = datasetReportHtml(res.report);
      if (res.ok) {
        const c = res.report.counts;
        loadBtn.className = 'btn sm primary';
        loadBtn.textContent = '载入该数据集（替换全部）';
        loadBtn.style.marginTop = '8px';
        loadBtn.onclick = async () => {
          const ok = await confirmDialog(
            '载入整库数据集',
            `将用「${esc(res.db.datasetLabel)}」替换当前全部数据（${c.productionOrders} 张生产订单 / ${c.tasks} 道工序）。建议先备份，确认继续？`,
            '载入'
          );
          if (!ok) return;
          replaceDb(ctx.db, res.db);
          saveAndReload(ctx);
          m.close();
        };
        out.appendChild(loadBtn);
      }
    } catch (e) {
      out.innerHTML = `<div class="notice danger"><b>读取失败：</b>${esc(e.message)}</div>`;
    }
  });

  m.root.querySelector('[data-tpl]').addEventListener('click', () => {
    downloadRaw('外部测试数据集模板.json', JSON.stringify(templateDataset(ctx.asOf), null, 2), 'application/json');
    toast('示例数据集已导出', 'ok');
  });

  m.root.querySelector('[data-clear]').addEventListener('click', () => clearAllDialog(ctx, m));
  return m;
}

function clearAllDialog(ctx, parent) {
  const counts = collectionCounts(ctx.db)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`)
    .join('');
  const m = modal({
    title: '清空全部数据',
    body: `
      <div class="notice danger">
        将删除浏览器本地库中的<b>全部业务数据</b>（订单、任务、库存、报工履历、异常、导入记录），
        且不会自动重建演示数据。<b>此操作不可撤销。</b>
      </div>
      <table class="tb mt-4"><tbody>${counts}</tbody></table>
      <label class="small inline mt-5">
        <input type="checkbox" id="cl-backup" checked /> 清空前导出 JSON 备份（可事后用「恢复」还原）
      </label>
      <div class="field mt-4">
        <label>请输入「清空」以确认</label>
        <input id="cl-word" placeholder="清空" autocomplete="off" data-autofocus />
      </div>
      <div id="cl-out"></div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn danger" data-ok disabled>确认清空</button>`,
    onMount(root, close) {
      const word = root.querySelector('#cl-word');
      const okBtn = root.querySelector('[data-ok]');
      word.addEventListener('input', () => {
        okBtn.disabled = word.value.trim() !== '清空';
      });
      root.querySelector('[data-c]').addEventListener('click', close);
      okBtn.addEventListener('click', () => {
        if (word.value.trim() !== '清空') return;
        if (root.querySelector('#cl-backup').checked) {
          downloadRaw(`清空前备份_${ctx.asOf}.json`, exportJson(ctx.db), 'application/json');
        }
        const empty = clearAllData();
        replaceDb(ctx.db, empty);
        close();
        if (parent) parent.close();
        location.hash = '#/dashboard';
        location.reload();
      });
    },
  });
  return m;
}

/* ── 整库 JSON 校验结果 ── */
export function datasetReportHtml(rep) {
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
        ? `<div class="notice warn mt-4"><b>提示：</b><br>${rep.warnings.map((w) => `· ${esc(w)}`).join('<br>')}</div>`
        : ''
    }`;
}
