/**
 * 通用界面构件（不含业务逻辑）
 */

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const num = (v, digits = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return digits ? n.toFixed(digits) : String(Math.round(n));
};

export const badge = (text, tone = 'muted') => `<span class="badge ${tone}">${esc(text)}</span>`;

export const bar = (ratio, tone = '') => {
  const pct = Math.max(0, Math.min(1, ratio || 0)) * 100;
  return `<div class="bar-mini ${tone}"><i style="width:${pct.toFixed(0)}%"></i></div>`;
};

/**
 * 表格渲染
 * columns: [{ key, title, cls, render(row) }]
 */
export function table(columns, rows, opts = {}) {
  if (!rows || rows.length === 0) {
    return `<div class="empty">${esc(opts.empty || '暂无数据')}</div>`;
  }
  const head = columns.map((c) => `<th class="${c.cls || ''}">${c.title}</th>`).join('');
  const body = rows
    .map((r, i) => {
      const tds = columns
        .map((c) => `<td class="${c.cls || ''}">${c.render ? c.render(r, i) : esc(r[c.key] ?? '')}</td>`)
        .join('');
      return `<tr data-idx="${i}" ${opts.rowAttr ? opts.rowAttr(r, i) : ''}>${tds}</tr>`;
    })
    .join('');
  return `<div class="table-wrap"><table class="tb"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function options(list, selected, placeholder) {
  const ph = placeholder ? `<option value="">${esc(placeholder)}</option>` : '';
  return (
    ph +
    list
      .map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const t = typeof o === 'string' ? o : o.label;
        return `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(t)}</option>`;
      })
      .join('')
  );
}

export function tabs(items, active, action = 'switch-tab') {
  return `<div class="tabs">${items
    .map(
      (t) =>
        `<div class="tab ${t.key === active ? 'active' : ''}" data-action="${action}" data-tab="${esc(t.key)}">${esc(
          t.label
        )}${t.count != null ? `<span class="cnt">${t.count}</span>` : ''}</div>`
    )
    .join('')}</div>`;
}

/* ───────── 事件委托 ───────── */
export function on(root, selector, type, handler) {
  root.querySelectorAll(selector).forEach((el) => el.addEventListener(type, (e) => handler(e, el)));
}

/** 按 data-action 统一绑定 */
export function bindActions(root, map) {
  root.querySelectorAll('[data-action]').forEach((el) => {
    const fn = map[el.dataset.action];
    if (fn) el.addEventListener('click', (e) => fn(e, el));
  });
}

/* ───────── 弹窗 ───────── */
let modalSeq = 0;
/** 已打开弹窗的关闭函数栈：保证 Esc 只关最上层、Tab 只在层内循环 */
const modalStack = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function modal({ title, body, footer, wide = false, onMount }) {
  const id = `m${++modalSeq}`;
  const titleId = `${id}-title`;
  const prevFocus = document.activeElement;

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <div class="modal-h"><h3 id="${titleId}">${esc(title)}</h3><button type="button" class="x" data-close aria-label="关闭">×</button></div>
      <div class="modal-b">${body}</div>
      ${footer ? `<div class="modal-f">${footer}</div>` : ''}
    </div>`;
  document.body.appendChild(mask);

  const root = mask.querySelector('.modal');
  const visible = (el) => el.offsetParent !== null || el === document.activeElement;
  const focusables = () => [...root.querySelectorAll(FOCUSABLE)].filter(visible);

  const onKey = (e) => {
    if (e.key === 'Escape') {
      // 只关闭最上层弹窗，避免嵌套弹窗被一起清掉
      if (modalStack[modalStack.length - 1] === close) {
        e.stopPropagation();
        close();
      }
      return;
    }
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (list.length === 0) {
      e.preventDefault();
      root.focus();
      return;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const inside = root.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  };

  function close() {
    if (!mask.isConnected) return;
    mask.remove();
    document.removeEventListener('keydown', onKey, true);
    const i = modalStack.indexOf(close);
    if (i >= 0) modalStack.splice(i, 1);
    // 关闭后还焦到打开前的元素，键盘用户不会"丢失位置"
    if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') prevFocus.focus();
  }

  mask.querySelector('[data-close]').addEventListener('click', close);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });
  document.addEventListener('keydown', onKey, true);
  modalStack.push(close);
  if (onMount) onMount(root, close);

  // 打开即聚焦：优先显式标记的元素，其次第一个可聚焦元素，最后落在对话框自身
  const initial = root.querySelector('[data-autofocus]') || focusables()[0];
  if (initial) initial.focus();
  else {
    root.setAttribute('tabindex', '-1');
    root.focus();
  }

  return { root, close, id };
}

export function confirmDialog(title, message, okText = '确定') {
  return new Promise((resolve) => {
    const m = modal({
      title,
      body: `<p style="margin:0;font-size:13px;line-height:1.7">${message}</p>`,
      footer: `<button class="btn" data-cancel>取消</button><button class="btn primary" data-ok>${esc(okText)}</button>`,
    });
    m.root.querySelector('[data-cancel]').addEventListener('click', () => {
      m.close();
      resolve(false);
    });
    m.root.querySelector('[data-ok]').addEventListener('click', () => {
      m.close();
      resolve(true);
    });
  });
}

/* ───────── 提示 ───────── */
export function toast(message, tone = '') {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const t = document.createElement('div');
  t.className = `toast ${tone}`;
  t.textContent = message;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), tone === 'danger' ? 6000 : 3200);
}

/* ───────── 下载 ───────── */
export function download(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob(['\ufeff' + content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

export function downloadRaw(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

/** 读文件为文本 */
export function readText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('文件读取失败'));
    r.readAsText(file, 'utf-8');
  });
}

/** 读文件为 ArrayBuffer */
export function readBuffer(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('文件读取失败'));
    r.readAsArrayBuffer(file);
  });
}
