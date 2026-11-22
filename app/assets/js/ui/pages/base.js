/**
 * 基础数据（V1.0 §4.9）
 * 14 类基础数据的手工维护 + Excel 双路径导入（主数据覆盖 / 单据拒绝）+ 模板下载与导出
 */

import { badge, esc, modal, num, table, tabs, toast, download, confirmDialog } from '../dom.js';
import { IMPORT_SPECS, templateCsv, parseCsv, validateImport, applyImport, exportCsv } from '../../io.js';
import { uid } from '../../core/store.js';

let tab = 'products';
let spec = 'products';

const TABS = [
  { key: 'products', label: '产品' },
  { key: 'materials', label: '物料' },
  { key: 'bom', label: 'BOM' },
  { key: 'routing', label: '工艺路线' },
  { key: 'centers', label: '工作中心' },
  { key: 'caps', label: '工序适配' },
  { key: 'calendar', label: '工作日历' },
  { key: 'downtime', label: '计划停机' },
  { key: 'inventory', label: '库存' },
  { key: 'inbound', label: '到货' },
];

export default {
  render(view, ctx) {
    const { db } = ctx;
    view.innerHTML = `
      ${tabs(TABS.map((t) => ({ ...t, count: countOf(db, t.key) })), tab)}
      <div class="card" style="border-top:0;border-radius:0 0 6px 6px">
        <div class="toolbar">
          <button class="btn sm primary" data-act="add">新增</button>
          <button class="btn sm" data-act="export">导出当前表</button>
          <span style="border-left:1px solid var(--line);height:18px"></span>
          <select id="spec" style="width:190px">
            ${Object.entries(IMPORT_SPECS)
              .map(([k, s]) => `<option value="${k}" ${k === spec ? 'selected' : ''}>导入：${s.label}（${s.kind === 'MASTER' ? '主数据' : '单据'}）</option>`)
              .join('')}
          </select>
          <button class="btn sm" data-act="tpl">下载模板</button>
          <button class="btn sm" data-act="import">导入文件</button>
          <span class="spacer"></span>
          <span class="small">主数据按编码覆盖更新；业务单据重复即拒绝</span>
        </div>
        ${renderTab(db, tab)}
      </div>`;

    view.querySelectorAll('[data-action="switch-tab"]').forEach((el) =>
      el.addEventListener('click', () => {
        tab = el.dataset.tab;
        ctx.redraw();
      })
    );
    view.querySelector('#spec').addEventListener('change', (e) => {
      spec = e.target.value;
    });
    view.querySelector('[data-act="add"]').addEventListener('click', () => addEntity(ctx, tab));
    view.querySelector('[data-act="export"]').addEventListener('click', () => exportTab(ctx, tab));
    view.querySelector('[data-act="tpl"]').addEventListener('click', () => {
      download(`${IMPORT_SPECS[spec].label}_导入模板.csv`, templateCsv(spec));
      toast('模板已下载，可直接用 Excel 填写后另存为 CSV 或 XLSX', 'ok');
    });
    view.querySelector('[data-act="import"]').addEventListener('click', () => importDialog(ctx, spec));

    view.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => editEntity(ctx, tab, b.dataset.edit))
    );
    view.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        const ok = await confirmDialog('删除确认', '删除后不可恢复，且可能影响已引用该数据的基础关系。确认删除？', '删除');
        if (!ok) return;
        const [coll, id] = b.dataset.del.split(':');
        db[coll] = db[coll].filter((x) => x.id !== id);
        ctx.commit('已删除');
      })
    );
    view.querySelectorAll('[data-toggle-hd]').forEach((b) =>
      b.addEventListener('click', () => toggleHoliday(ctx, b.dataset.toggleHd))
    );
  },
};

function countOf(db, key) {
  const map = { products: 'products', materials: 'materials', bom: 'bomItems', routing: 'routingOps', centers: 'workCenters', caps: 'capabilities', calendar: null, downtime: 'downtimes', inventory: 'inventory', inbound: 'inbounds' };
  const coll = map[key];
  return coll ? db[coll].length : '';
}

function renderTab(db, key) {
  if (key === 'products') {
    return table(
      [
        { title: '产品编号', render: (r) => `<b>${esc(r.code)}</b>` },
        { title: '产品名称', render: (r) => esc(r.name) },
        { title: '单位', render: (r) => esc(r.unit) },
        { title: 'BOM 项数', cls: 'num', render: (r) => db.bomItems.filter((b) => b.productId === r.id).length },
        { title: '工艺工序数', cls: 'num', render: (r) => (db.routings.find((x) => x.productId === r.id) ? db.routingOps.filter((o) => o.routingId === db.routings.find((x) => x.productId === r.id).id).length : 0) },
        { title: '', cls: 'nowrap', render: (r) => `<button class="btn sm ghost" data-edit="${r.id}">编辑</button><button class="btn sm ghost" data-del="products:${r.id}">删除</button>` },
      ],
      db.products
    );
  }
  if (key === 'materials') {
    return table(
      [
        { title: '物料编号', render: (r) => `<b>${esc(r.code)}</b>` },
        { title: '名称', render: (r) => esc(r.name) },
        { title: '单位', render: (r) => esc(r.unit) },
        { title: '类型', render: (r) => badge(r.type === 'SEMI' ? '半成品' : r.type === 'RAW' ? '原材料' : '采购件', r.type === 'SEMI' ? 'info' : 'muted') },
        { title: '', cls: 'nowrap', render: (r) => `<button class="btn sm ghost" data-edit="${r.id}">编辑</button><button class="btn sm ghost" data-del="materials:${r.id}">删除</button>` },
      ],
      db.materials
    );
  }
  if (key === 'bom') {
    return table(
      [
        { title: '产品', render: (r) => esc((db.products.find((p) => p.id === r.productId) || {}).code || '') },
        { title: '层级', render: (r) => (r.level === 1 ? '一级（成品→半成品/物料）' : '二级（半成品→原材料）') },
        { title: '父项', render: (r) => esc(r.parentType === 'PRODUCT' ? (db.products.find((p) => p.id === r.parentId) || {}).code || '' : (db.materials.find((m) => m.id === r.parentId) || {}).code || '') },
        { title: '子项', render: (r) => esc((db.materials.find((m) => m.id === r.childId) || {}).code || '') },
        { title: '类型', render: (r) => badge(r.childType === 'SEMI' ? '半成品' : '物料', r.childType === 'SEMI' ? 'info' : 'muted') },
        { title: '单位用量', cls: 'num', render: (r) => r.qtyPer },
        { title: '', render: (r) => `<button class="btn sm ghost" data-del="bomItems:${r.id}">删除</button>` },
      ],
      db.bomItems
    );
  }
  if (key === 'routing') {
    return table(
      [
        { title: '产品', render: (r) => esc((db.products.find((p) => p.id === (db.routings.find((x) => x.id === r.routingId) || {}).productId) || {}).code || '') },
        { title: '工序号', cls: 'mono', render: (r) => r.seq },
        { title: '工序名称', render: (r) => `<b>${esc(r.name)}</b>` },
        { title: '单位标准工时(小时/件)', cls: 'num', render: (r) => r.stdHoursPerUnit },
        { title: '', render: (r) => `<button class="btn sm ghost" data-del="routingOps:${r.id}">删除</button>` },
      ],
      [...db.routingOps].sort((a, b) => a.seq - b.seq)
    );
  }
  if (key === 'centers') {
    return table(
      [
        { title: '编码', render: (r) => `<b>${esc(r.code)}</b>` },
        { title: '名称', render: (r) => esc(r.name) },
        { title: '产能模式', render: (r) => (r.capacityMode === 'STD_HOURS' ? '标准工时' : '固定日产能') },
        { title: '日产能(件/日)', cls: 'num', render: (r) => (r.capacityMode === 'STD_HOURS' ? '—' : num(r.dailyCapacity)) },
        { title: '日可用工时', cls: 'num', render: (r) => num(r.dailyHours) },
        { title: '适配工序', render: (r) => `<span class="small">${db.capabilities.filter((c) => c.workCenterId === r.id).map((c) => c.opName || (db.routingOps.find((o) => o.id === c.opId) || {}).name || '').filter(Boolean).join('、')}</span>` },
        { title: '', cls: 'nowrap', render: (r) => `<button class="btn sm ghost" data-edit="${r.id}">编辑</button><button class="btn sm ghost" data-del="workCenters:${r.id}">删除</button>` },
      ],
      db.workCenters
    );
  }
  if (key === 'caps') {
    return table(
      [
        { title: '工作中心', render: (r) => esc((db.workCenters.find((w) => w.id === r.workCenterId) || {}).name || '') },
        { title: '工序', render: (r) => esc(r.opName || (db.routingOps.find((o) => o.id === r.opId) || {}).name || '') },
        { title: '', render: (r) => `<button class="btn sm ghost" data-del="capabilities:${r.id}">删除</button>` },
      ],
      db.capabilities
    );
  }
  if (key === 'calendar') {
    const c = db.calendar;
    const names = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' };
    return `<div class="card-b">
      <div class="inline" style="margin-bottom:10px">
        <b>工作日历：</b>
        ${[1, 2, 3, 4, 5, 6, 7]
          .map((d) => `<span class="badge ${c.workdays.includes(d) ? 'ok' : 'muted'}">周${names[d]}</span>`)
          .join('')}
        <span class="small">（绿色为工作日；排产推进与产能计算均扣除非工作日）</span>
      </div>
      <div class="hr"></div>
      <b>法定节假日</b>
      <div class="small" style="margin:4px 0 8px">点击日期可在「节假日 / 工作日」之间切换</div>
      <div class="pill-list">
        ${['2026-10-01', '2026-10-02', '2026-10-03', '2026-12-25', '2027-01-01']
          .map((d) => {
            const on = c.holidays.some((h) => h.date === d);
            return `<button class="btn sm ${on ? 'primary' : ''}" data-toggle-hd="${d}">${d}${on ? ' · 休' : ''}</button>`;
          })
          .join('')}
      </div>
    </div>`;
  }
  if (key === 'downtime') {
    return table(
      [
        { title: '工作中心', render: (r) => esc((db.workCenters.find((w) => w.id === r.workCenterId) || {}).name || '') },
        { title: '起', cls: 'mono', render: (r) => esc(r.dateFrom) },
        { title: '止', cls: 'mono', render: (r) => esc(r.dateTo) },
        { title: '原因', render: (r) => esc(r.reason) },
        { title: '', render: (r) => `<button class="btn sm ghost" data-del="downtimes:${r.id}">删除</button>` },
      ],
      db.downtimes,
      { empty: '暂无计划停机' }
    );
  }
  if (key === 'inventory') {
    return table(
      [
        { title: '物料', render: (r) => esc((db.materials.find((m) => m.id === r.materialId) || {}).code || '') },
        { title: '名称', render: (r) => esc((db.materials.find((m) => m.id === r.materialId) || {}).name || '') },
        { title: '仓库', render: (r) => esc(r.warehouse) },
        { title: '数量', cls: 'num', render: (r) => num(r.qty) },
        { title: '', render: (r) => `<button class="btn sm ghost" data-del="inventory:${r.id}">删除</button>` },
      ],
      db.inventory
    );
  }
  return table(
    [
      { title: '物料', render: (r) => esc(r.materialCode || '') },
      { title: '数量', cls: 'num', render: (r) => num(r.qty) },
      { title: '预计到货', cls: 'mono', render: (r) => esc(r.expectedDate) },
      { title: '确认', render: (r) => badge(r.confirmed ? '已确认' : '未确认', r.confirmed ? 'ok' : 'warn') },
      { title: '实际到货', cls: 'mono', render: (r) => esc(r.actualArrivalDate || '—') },
      { title: '', render: (r) => `<button class="btn sm ghost" data-del="inbounds:${r.id}">删除</button>` },
    ],
    db.inbounds
  );
}

/* ───────── 新增 ───────── */
function addEntity(ctx, key) {
  const { db } = ctx;
  if (key === 'products') {
    formDialog(ctx, '新增产品', [
      { key: 'code', label: '产品编号', required: true },
      { key: 'name', label: '产品名称', required: true },
      { key: 'unit', label: '单位', value: '台', required: true },
    ], (v) => {
      if (db.products.some((p) => p.code === v.code)) return '产品编号已存在';
      db.products.push({ id: uid('P'), ...v });
      return '';
    });
  } else if (key === 'materials') {
    formDialog(ctx, '新增物料', [
      { key: 'code', label: '物料编号', required: true },
      { key: 'name', label: '名称', required: true },
      { key: 'unit', label: '单位', value: '个', required: true },
      { key: 'type', label: '类型（RAW/PURCHASE/SEMI）', value: 'PURCHASE', required: true },
    ], (v) => {
      if (db.materials.some((m) => m.code === v.code)) return '物料编号已存在';
      if (!['RAW', 'PURCHASE', 'SEMI'].includes(v.type)) return '类型必须是 RAW / PURCHASE / SEMI';
      db.materials.push({ id: uid('M'), ...v });
      return '';
    });
  } else if (key === 'centers') {
    formDialog(ctx, '新增工作中心', [
      { key: 'code', label: '编码', required: true },
      { key: 'name', label: '名称', required: true },
      { key: 'capacityMode', label: '产能模式（DAILY_QTY / STD_HOURS）', value: 'DAILY_QTY', required: true },
      { key: 'dailyCapacity', label: '日产能（件/日）', value: '40', type: 'number' },
      { key: 'dailyHours', label: '日可用工时', value: '8', type: 'number' },
    ], (v) => {
      if (db.workCenters.some((w) => w.code === v.code)) return '编码已存在';
      db.workCenters.push({
        id: uid('C'),
        code: v.code,
        name: v.name,
        capacityMode: v.capacityMode,
        dailyCapacity: Number(v.dailyCapacity) || 0,
        dailyHours: Number(v.dailyHours) || 8,
      });
      return '';
    });
  } else if (key === 'downtime') {
    formDialog(ctx, '新增计划停机', [
      { key: 'dateFrom', label: '开始日期', type: 'date', required: true },
      { key: 'dateTo', label: '结束日期', type: 'date', required: true },
      { key: 'reason', label: '原因', required: true },
    ], (v) => {
      const wc = db.workCenters[0];
      if (!wc) return '请先维护工作中心';
      db.downtimes.push({ id: uid('DT'), workCenterId: wc.id, ...v });
      return '';
    });
  } else {
    toast('该类数据请通过模板导入维护（可下载对应模板）', 'warn');
  }
}

function formDialog(ctx, title, fields, onSubmit) {
  modal({
    title,
    body: `<div class="flexcol">${fields
      .map(
        (f) => `<div class="field"><label>${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</label>
          <input type="${f.type || 'text'}" id="f_${f.key}" value="${esc(f.value || '')}" /></div>`
      )
      .join('')}</div><div id="err"></div>`,
    footer: `<button class="btn" data-c>取消</button><button class="btn primary" data-ok>保存</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').addEventListener('click', close);
      root.querySelector('[data-ok]').addEventListener('click', () => {
        const v = {};
        for (const f of fields) {
          const val = root.querySelector(`#f_${f.key}`).value.trim();
          if (f.required && !val) {
            root.querySelector('#err').innerHTML = `<div class="notice danger">${esc(f.label)} 必填</div>`;
            return;
          }
          v[f.key] = val;
        }
        const err = onSubmit(v);
        if (err) {
          root.querySelector('#err').innerHTML = `<div class="notice danger">${esc(err)}</div>`;
          return;
        }
        close();
        ctx.commit('已保存');
      });
    },
  });
}

function editEntity(ctx, key, id) {
  const { db } = ctx;
  const coll = key === 'products' ? 'products' : key === 'materials' ? 'materials' : 'workCenters';
  const row = db[coll].find((x) => x.id === id);
  if (!row) return;
  const fields =
    key === 'products'
      ? [
          { key: 'code', label: '产品编号', value: row.code, required: true },
          { key: 'name', label: '产品名称', value: row.name, required: true },
          { key: 'unit', label: '单位', value: row.unit, required: true },
        ]
      : key === 'materials'
      ? [
          { key: 'code', label: '物料编号', value: row.code, required: true },
          { key: 'name', label: '名称', value: row.name, required: true },
          { key: 'unit', label: '单位', value: row.unit, required: true },
          { key: 'type', label: '类型（RAW/PURCHASE/SEMI）', value: row.type, required: true },
        ]
      : [
          { key: 'code', label: '编码', value: row.code, required: true },
          { key: 'name', label: '名称', value: row.name, required: true },
          { key: 'capacityMode', label: '产能模式', value: row.capacityMode, required: true },
          { key: 'dailyCapacity', label: '日产能', value: String(row.dailyCapacity || 0), type: 'number' },
          { key: 'dailyHours', label: '日可用工时', value: String(row.dailyHours || 8), type: 'number' },
        ];

  formDialog(ctx, `编辑 · ${row.code}`, fields, (v) => {
    const dup = db[coll].some((x) => x.id !== id && x.code === v.code);
    if (dup) return '编码已存在';
    Object.assign(row, v);
    if (key === 'centers') {
      row.dailyCapacity = Number(v.dailyCapacity) || 0;
      row.dailyHours = Number(v.dailyHours) || 8;
    }
    return '';
  });
}

/* ───────── 节假日切换 ───────── */
function toggleHoliday(ctx, date) {
  const c = ctx.db.calendar;
  const i = c.holidays.findIndex((h) => h.date === date);
  if (i >= 0) c.holidays.splice(i, 1);
  else c.holidays.push({ date, name: '节假日' });
  ctx.commit(`${date} 已设为${i >= 0 ? '工作日' : '节假日'}`);
}

/* ───────── 导出 ───────── */
function exportTab(ctx, key) {
  const { db } = ctx;
  const map = {
    products: { rows: db.products, cols: [{ label: '产品编号', key: 'code' }, { label: '产品名称', key: 'name' }, { label: '单位', key: 'unit' }], name: '产品' },
    materials: { rows: db.materials, cols: [{ label: '物料编号', key: 'code' }, { label: '物料名称', key: 'name' }, { label: '单位', key: 'unit' }, { label: '物料类型', key: 'type' }], name: '物料' },
    centers: { rows: db.workCenters, cols: [{ label: '编码', key: 'code' }, { label: '名称', key: 'name' }, { label: '产能模式', key: 'capacityMode' }, { label: '日产能(件/日)', key: 'dailyCapacity' }, { label: '日可用工时', key: 'dailyHours' }], name: '工作中心' },
    inventory: { rows: db.inventory, cols: [{ label: '物料', get: (r) => (db.materials.find((m) => m.id === r.materialId) || {}).code }, { label: '数量', key: 'qty' }, { label: '仓库', key: 'warehouse' }], name: '库存' },
  };
  const cfg = map[key];
  if (!cfg) {
    toast('该表暂不支持直接导出，可用模板导入维护', 'warn');
    return;
  }
  download(`${cfg.name}_导出_${ctx.asOf}.csv`, exportCsv(cfg.rows, cfg.cols));
  toast('已导出 CSV', 'ok');
}

/* ───────── 导入 ───────── */
function importDialog(ctx, specKey) {
  const s = IMPORT_SPECS[specKey];
  modal({
    title: `导入 ${s.label}（${s.kind === 'MASTER' ? '主数据 · 按编码覆盖' : '业务单据 · 重复即拒绝'}）`,
    body: `
      <div class="notice info">支持 CSV（UTF-8）与 XLSX。导入前会逐行校验：必填、编码唯一、关联存在、数据类型；
      <b>存在错误行时整批不入库</b>，并给出具体行号与原因。</div>
      <div class="field"><label>选择文件</label><input type="file" id="f" accept=".csv,.xlsx" /></div>
      <div id="out"></div>`,
    footer: `<button class="btn" data-c>关闭</button><button class="btn" data-check>校验</button><button class="btn primary" data-ok>校验并导入</button>`,
    onMount(root, close) {
      root.querySelector('[data-c]').addEventListener('click', close);
      const out = root.querySelector('#out');

      const doCheck = async (apply) => {
        const f = root.querySelector('#f').files[0];
        if (!f) {
          out.innerHTML = '<div class="notice warn">请先选择文件</div>';
          return null;
        }
        try {
          const text = await f.text();
          const parsed = parseCsv(text);
          const res = validateImport(specKey, parsed, ctx.db);
          if (res.errors.length) {
            out.innerHTML = `<div class="notice danger"><b>${res.errors.length} 处校验未通过，整批未导入：</b><br/>${res.errors
              .slice(0, 12)
              .map((e) => `第 ${e.line} 行 · ${esc(e.field)}：${esc(e.message)}`)
              .join('<br/>')}</div>`;
            return null;
          }
          if (!apply) {
            out.innerHTML = `<div class="notice ok">校验通过：共 ${res.entities.length} 行可导入。</div>`;
            return res;
          }
          const r = applyImport(specKey, res.entities, ctx.db);
          ctx.db.importLogs = ctx.db.importLogs || [];
          ctx.db.importLogs.push({ at: ctx.asOf, spec: specKey, created: r.created, updated: r.updated, rejected: r.rejected.length });
          close();
          ctx.commit(`导入完成：新增 ${r.created}，更新 ${r.updated}${r.rejected.length ? `，拒绝 ${r.rejected.length}` : ''}`);
          return r;
        } catch (e) {
          out.innerHTML = `<div class="notice danger">解析失败：${esc(e.message)}</div>`;
          return null;
        }
      };

      root.querySelector('[data-check]').addEventListener('click', () => doCheck(false));
      root.querySelector('[data-ok]').addEventListener('click', () => doCheck(true));
    },
  });
}
