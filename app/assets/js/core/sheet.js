/**
 * 表格文件解析：CSV / XLSX / XLS（BIFF8）
 *
 * 为什么单独成模块：
 * 1. 原 `io.js` 把 CSV 与 XLSX 解析、字段校验、落库语义混在一个文件里，且 XLSX 解析依赖
 *    `DOMParser`，Node 环境无法覆盖正向路径，测试只能验错误分支；
 * 2. 导入入口虽然写了 `accept=".xlsx"`，实际一律走 `file.text()` + `parseCsv()`，
 *    选了 Excel 只会得到一堆乱码 —— 等于"只支持 CSV/JSON"；
 * 3. 项目零依赖，不能引 SheetJS。这里用原生 zip + 原生解压读 XLSX，
 *    用 OLE2 + BIFF8 记录级解析读旧版 XLS（Excel 97-2003），不联网、不加载第三方库。
 *
 * 设计约束：
 * - 纯函数、不碰 DOM、不碰 localStorage：浏览器与 `node tests/*.mjs` 共用同一份实现；
 * - 只负责"把文件变成二维网格"，不知道任何业务字段（字段含义在 io.js 的 IMPORT_SPECS 里）；
 * - 错误信息面向用户，说清"哪个文件、哪种格式、怎么办"，不抛底层异常文本。
 */

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/* ═══════════════ 通用工具 ═══════════════ */

const decodeUtf8 = (bytes) => new TextDecoder('utf-8').decode(bytes);

/** XML 实体还原：XLSX 里的中文与 & 都可能是实体 */
function unescapeXml(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, g) => {
    if (g === 'amp') return '&';
    if (g === 'lt') return '<';
    if (g === 'gt') return '>';
    if (g === 'quot') return '"';
    if (g === 'apos') return "'";
    const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

/** A1 形式列号 → 0 基索引 */
export function colIndex(ref) {
  const m = /^([A-Z]+)/i.exec(String(ref || ''));
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* ═══════════════ 文本 / CSV ═══════════════ */

/**
 * 字节 → 文本。中文环境最常见的三种"Excel 另存为 CSV"：
 * UTF-8（可能带 BOM）、UTF-16（带 BOM）、GBK/GB18030（无 BOM，用 GB18030 兼容）。
 * 先严格按 UTF-8 解，失败再退回 GB18030，避免"能打开但全是问号"。
 */
export function decodeBytes(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    return decodeUtf8(u8.subarray(3));
  }
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8);
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(u8);
    } catch {
      return decodeUtf8(u8);
    }
  }
}

/**
 * 分隔符嗅探：Excel 在部分区域设置下另存 CSV 会用分号，ERP 导出常用制表符。
 * 只在首个非空行、引号外统计，取出现次数最多的候选。
 */
export function sniffDelimiter(text) {
  const line = String(text).split(/\r?\n/).find((l) => l.trim() !== '') || '';
  const count = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in count) count[ch] += 1;
  }
  const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

/**
 * 解析分隔文本 → { headers, rows, grid, delimiter }
 * grid 是原始二维数组（保留 Excel 行号位置），rows 是"表头→值"的对象数组（向后兼容旧调用）。
 */
export function parseDelimitedText(text, delimiter) {
  const d = delimiter || sniffDelimiter(text);
  const grid = [];
  let cur = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/^\ufeff/, '');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === d) {
      cur.push(field);
      field = '';
    } else if (c === '\n') {
      cur.push(field);
      grid.push(cur);
      cur = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field.length || cur.length) {
    cur.push(field);
    grid.push(cur);
  }
  const clean = grid.filter((r) => r.some((x) => String(x).trim() !== ''));
  if (!clean.length) return { headers: [], rows: [], grid: [], delimiter: d };
  const width = Math.max(...clean.map((r) => r.length));
  const headers = (clean[0] || []).map((h) => String(h).trim());
  const rows = clean.slice(1).map((r) => {
    const o = {};
    for (let i = 0; i < width; i += 1) o[headers[i] === undefined ? `__col${i}` : headers[i]] = String(r[i] ?? '').trim();
    return o;
  });
  return { headers, rows, grid: clean, delimiter: d };
}

/* ═══════════════ ZIP / XLSX ═══════════════ */

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持原生解压（DecompressionStream），请另存为 CSV 后再导入');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 读 zip 中央目录 → Map(文件名 → 字节)；只要 xlsx 需要的几个部件 */
async function unzip(buffer) {
  const buf = new Uint8Array(buffer);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件（未找到 zip 目录，可能已加密或其实是 xls）');
  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true);
  const files = new Map();
  for (let i = 0; i < count; i += 1) {
    if (ptr + 46 > buf.length || dv.getUint32(ptr, true) !== 0x02014b50) break;
    const method = dv.getUint16(ptr + 10, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const localOff = dv.getUint32(ptr + 42, true);
    const name = decodeUtf8(buf.subarray(ptr + 46, ptr + 46 + nameLen));
    if (compSize === 0xffffffff) throw new Error('不支持 ZIP64 格式的超大 xlsx，请另存为 CSV');
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    files.set(name, { method, data: buf.subarray(dataStart, dataStart + compSize) });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/**
 * 属性解析：同时接受双引号与单引号。
 * 少数导出工具（含部分 WPS / 第三方报表引擎）会把 XML 属性写成单引号，
 * 只认双引号时整张表会被读成 0 行 —— 表现为"行数 0、场景待指定、没有识别到表头"。
 */
const tagAttrs = (tag) => {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = m[2] === undefined ? m[3] : m[2];
  return out;
};

/**
 * 命名空间前缀：OOXML 允许 `<x:row>` 这种带前缀的写法。
 * 前缀无关匹配，避免"标准写法能读、带前缀就 0 行"。
 */
const NS = '(?:[A-Za-z_][A-Za-z0-9_.-]*:)?';
const reTag = (name, flags = 'g') => new RegExp(`<${NS}${name}\\b`, flags);
const rePair = (name, flags = 'g') => new RegExp(`<${NS}${name}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${NS}${name}>)`, flags);
const reText = (name) => new RegExp(`<${NS}${name}\\b[^>]*>([\\s\\S]*?)<\\/${NS}${name}>`);
const reOpen = (name) => new RegExp(`<${NS}${name}\\b[^>]*\\/>`);

/** <si> 里的可见文本：拼接所有 <t>，忽略注音 <rPh> */
function siText(xml) {
  const body = String(xml).replace(new RegExp(`<${NS}rPh\\b[\\s\\S]*?<\\/${NS}rPh>`, 'g'), '');
  const parts = [];
  const re = reText('t');
  const g = new RegExp(re.source, 'g');
  let m;
  while ((m = g.exec(body))) parts.push(m[1]);
  if (!parts.length && reOpen('t').test(body)) return '';
  return unescapeXml(parts.join(''));
}

/**
 * 全部工作表（顺序按 workbook.xml 声明）
 * @returns {Promise<{sheets: Array<{name:string, grid:Array}>, notes: string[]}>}
 */
async function readXlsx(buffer) {
  const files = await unzip(buffer);
  const notes = [];
  const get = async (name) => {
    const f = files.get(name);
    if (!f) return null;
    return f.method === 0 ? f.data : inflateRaw(f.data);
  };

  const wbBytes = await get('xl/workbook.xml');
  if (!wbBytes) throw new Error('不是有效的 xlsx 文件（缺少 xl/workbook.xml）');
  const wbXml = decodeUtf8(wbBytes);
  const relBytes = await get('xl/_rels/workbook.xml.rels');
  const rels = new Map();
  if (relBytes) {
    const relXml = decodeUtf8(relBytes);
    let m;
    const re = reTag('Relationship');
    while ((m = re.exec(relXml))) {
      const tag = relXml.slice(m.index, relXml.indexOf('>', m.index) + 1);
      const a = tagAttrs(tag);
      if (a.Id && a.Target) rels.set(a.Id, a.Target);
    }
  }

  const listed = [];
  const sheetRe = reTag('sheet');
  let ms;
  while ((ms = sheetRe.exec(wbXml))) {
    const tag = wbXml.slice(ms.index, wbXml.indexOf('>', ms.index) + 1);
    const a = tagAttrs(tag);
    if (!a.name) continue;
    const rid = a['r:id'] || '';
    let target = rels.get(rid) || '';
    if (target) {
      target = target.replace(/^\/?xl\//, '').replace(/^\/+/, '');
      if (!target.startsWith('xl/')) target = `xl/${target}`;
    }
    listed.push({ name: unescapeXml(a.name), path: target });
  }

  // 没有 rels 时退回"按文件名排序的 sheetN.xml"
  if (!listed.length || listed.every((s) => !s.path)) {
    const numeric = [...files.keys()]
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
    listed.length = 0;
    numeric.forEach((n, i) => listed.push({ name: `Sheet${i + 1}`, path: n }));
  }

  const shared = [];
  const sstBytes = await get('xl/sharedStrings.xml');
  if (sstBytes) {
    const xml = decodeUtf8(sstBytes);
    const re = rePair('si');
    let m;
    while ((m = re.exec(xml))) shared.push(m[2] ? siText(m[2]) : '');
    if (!shared.length && /<\w*:?si\b/.test(xml)) {
      notes.push('共享字符串表解析到 0 条，文本单元格可能为空');
    }
  } else {
    // 没有 sharedStrings 但单元格引用它 → 文本会全部为空，必须让调用方知道原因
    let usesShared = false;
    for (const s of listed) {
      if (!s.path) continue;
      const bytes = await get(s.path);
      if (bytes && /\bt\s*=\s*["']s["']/.test(decodeUtf8(bytes))) {
        usesShared = true;
        break;
      }
    }
    if (usesShared) notes.push('文件缺少 sharedStrings.xml，但单元格引用了共享字符串，文本无法还原');
  }

  const sheets = [];
  for (const s of listed) {
    const bytes = await get(s.path);
    if (!bytes) continue;
    const xml = decodeUtf8(bytes);
    const grid = xlsxSheetGrid(xml, shared);
    if (!grid.length) {
      const emptySheetData = rePair('sheetData').exec(xml);
      notes.push(
        `工作表「${s.name}」解析到 0 行` +
          (emptySheetData && !(emptySheetData[2] || '').trim()
            ? '（sheetData 为空，数据可能在图表/图片或未保存）'
            : '（可能使用了不常见的 XML 写法）')
      );
    }
    sheets.push({ name: s.name, grid });
  }
  if (!sheets.length) throw new Error('xlsx 中未找到任何工作表');
  return { sheets, notes };
}

function xlsxSheetGrid(xml, shared) {
  const grid = [];
  const rowRe = rePair('row');
  const vRe = reText('v');
  const isRe = reText('is');
  let rm;
  let autoRow = 0;
  while ((rm = rowRe.exec(xml))) {
    const attrs = tagAttrs(rm[1] || '');
    const rIdx = attrs.r ? Number(attrs.r) : ++autoRow;
    if (!Number.isFinite(rIdx)) continue;
    autoRow = rIdx;
    const cells = [];
    const body = rm[2] || '';
    const cellRe = rePair('c');
    let cm;
    let autoCol = -1;
    while ((cm = cellRe.exec(body))) {
      const ca = tagAttrs(cm[1] || '');
      let ci = ca.r ? colIndex(ca.r) : autoCol + 1;
      if (ci < 0) ci = autoCol + 1;
      autoCol = ci;
      const inner = cm[2] || '';
      let val = '';
      if (ca.t === 's') {
        const v = vRe.exec(inner);
        val = v ? shared[Number(v[1])] ?? '' : '';
        // 引用越界时退回内联文本，避免整格丢失
        if (!val) {
          const is = isRe.exec(inner);
          if (is) val = siText(is[1]);
        }
      } else if (ca.t === 'inlineStr') {
        const is = isRe.exec(inner);
        val = is ? siText(is[1]) : '';
      } else if (ca.t === 'str' || ca.t === 'd' || ca.t === 'e') {
        const v = vRe.exec(inner);
        val = v ? unescapeXml(v[1]) : '';
      } else {
        const v = vRe.exec(inner);
        if (v) val = unescapeXml(v[1]);
        else {
          const is = isRe.exec(inner);
          if (is) val = siText(is[1]);
        }
      }
      cells[ci] = String(val).trim();
    }
    if (cells.some((x) => x !== undefined && x !== '')) grid[rIdx - 1] = cells;
  }
  // 补成规则二维数组：避免稀疏下标影响表头定位
  const dense = [];
  for (let i = 0; i < grid.length; i += 1) dense.push(grid[i] || []);
  return dense;
}

/* ═══════════════ XLS（OLE2 + BIFF8） ═══════════════ */

/**
 * 读 OLE2 复合文档中的 Workbook 流。
 * 只实现 BIFF8 需要的部分：FAT / DIFAT / 目录 / 迷你流。够用即可，不做通用 CFB 库。
 */
function readCfbWorkbook(buffer) {
  const buf = new Uint8Array(buffer);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 512) throw new Error('不是有效的 xls 文件（文件过小）');
  for (let i = 0; i < 8; i += 1) {
    if (buf[i] !== CFB_MAGIC[i]) throw new Error('不是有效的 xls 文件（缺少 OLE2 文件头）');
  }
  const secSize = 1 << dv.getUint16(0x1e, true);
  const miniSize = 1 << dv.getUint16(0x20, true);
  const dirStart = dv.getUint32(0x30, true);
  const miniCutoff = dv.getUint32(0x38, true);
  const miniFatStart = dv.getUint32(0x3c, true);
  const difatStart = dv.getUint32(0x44, true);
  const numDifat = dv.getUint32(0x48, true);
  const secOff = (id) => (id + 1) * secSize;

  /* DIFAT → FAT 扇区列表（前 109 项在文件头里） */
  const fatSectors = [];
  for (let i = 0; i < 109; i += 1) {
    const v = dv.getUint32(0x4c + i * 4, true);
    if (v !== 0xffffffff) fatSectors.push(v);
  }
  let difat = difatStart;
  const perSector = secSize / 4 - 1;
  for (let n = 0; n < numDifat && difat !== 0xffffffff && difat !== 0xfffffffe; n += 1) {
    const off = secOff(difat);
    if (off + secSize > buf.length) break;
    for (let i = 0; i < perSector; i += 1) {
      const v = dv.getUint32(off + i * 4, true);
      if (v !== 0xffffffff) fatSectors.push(v);
    }
    difat = dv.getUint32(off + perSector * 4, true);
  }

  const fat = [];
  for (const sid of fatSectors) {
    const off = secOff(sid);
    if (off + secSize > buf.length) continue;
    for (let i = 0; i < secSize; i += 4) fat.push(dv.getUint32(off + i, true));
  }
  if (!fat.length) throw new Error('不是有效的 xls 文件（FAT 为空）');

  const chain = (start, table) => {
    const out = [];
    const seen = new Set();
    let cur = start;
    while (cur !== 0xfffffffe && cur !== 0xffffffff && cur < table.length && !seen.has(cur)) {
      seen.add(cur);
      out.push(cur);
      cur = table[cur];
    }
    return out;
  };
  const readChain = (start, size) => {
    const secs = chain(start, fat);
    const out = new Uint8Array(secs.length * secSize);
    secs.forEach((sid, i) => out.set(buf.subarray(secOff(sid), secOff(sid) + secSize), i * secSize));
    return size ? out.subarray(0, Math.min(size, out.length)) : out;
  };

  /* 目录项 */
  const dirBytes = readChain(dirStart, 0);
  const ddv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const entries = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const nameLen = ddv.getUint16(off + 64, true);
    const type = ddv.getUint8(off + 66);
    if (!type || nameLen < 2 || nameLen > 64) continue;
    let name = '';
    for (let i = 0; i + 1 < nameLen - 1; i += 2) name += String.fromCharCode(ddv.getUint16(off + i, true));
    entries.push({
      name,
      type,
      start: ddv.getUint32(off + 116, true),
      size: ddv.getUint32(off + 120, true),
    });
  }

  const root = entries.find((e) => e.type === 5);
  const target = entries
    .filter((e) => e.type === 2)
    .find((e) => /^(workbook|book)$/i.test(e.name));
  if (!target) throw new Error('不是有效的 xls 工作簿（未找到 Workbook 流）');

  if (target.size < miniCutoff && root) {
    /* 小流走迷你 FAT：先取出根流作为迷你流容器 */
    const miniStream = readChain(root.start, root.size);
    const miniFatBytes = readChain(miniFatStart, 0);
    const mdv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
    const miniFat = [];
    for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(mdv.getUint32(i, true));
    const secs = chain(target.start, miniFat);
    const out = new Uint8Array(secs.length * miniSize);
    secs.forEach((sid, i) => out.set(miniStream.subarray(sid * miniSize, sid * miniSize + miniSize), i * miniSize));
    return out.subarray(0, Math.min(target.size, out.length));
  }
  return readChain(target.start, target.size);
}

function biffRecords(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const recs = [];
  let p = 0;
  while (p + 4 <= data.length) {
    const id = dv.getUint16(p, true);
    const len = dv.getUint16(p + 2, true);
    recs.push({ id, data: data.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
  }
  return recs;
}

/** RK 压缩数字：低 2 位是标志，高 30 位是 IEEE754 高位或整数 */
function rkToNumber(rk) {
  let val;
  if (rk & 0x02) val = rk >> 2;
  else {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setUint32(0, 0, true);
    dv.setUint32(4, (rk & 0xfffffffc) >>> 0, true);
    val = dv.getFloat64(0, true);
  }
  return rk & 0x01 ? val / 100 : val;
}

const numToCell = (n) => {
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(10)));
};

/**
 * 共享字符串表：字符串可能跨 CONTINUE 记录，跨记录时新记录首字节是新的编码标志。
 * 这是 xls 解析最容易出错的地方，单独用"分块游标"处理。
 */
function makeSstReader(chunks) {
  let ci = 0;
  let pos = 0;
  const need = () => {
    while (ci < chunks.length && pos >= chunks[ci].length) {
      ci += 1;
      pos = 0;
    }
    return ci < chunks.length;
  };
  const u8 = () => {
    if (!need()) return 0;
    return chunks[ci][pos++];
  };
  const u16 = () => u8() | (u8() << 8);
  const u32 = () => (u16() | (u16() << 16)) >>> 0;
  const skip = (n) => {
    let remain = n;
    while (remain > 0 && need()) {
      const take = Math.min(remain, chunks[ci].length - pos);
      pos += take;
      remain -= take;
    }
  };
  const string = () => {
    const cch = u16();
    // 长度为 0 或超出 BIFF8 上限（32767）说明已经错位，直接放弃，避免用垃圾长度死循环
    if (!cch || cch > 32767) return '';
    const grbit = u8();
    const rich = grbit & 0x08;
    const farEast = grbit & 0x04;
    const runs = rich ? u16() : 0;
    const extSize = farEast ? u32() : 0;
    let compressed = !(grbit & 0x01);
    let out = '';
    while (out.length < cch) {
      // 注意：这里不能用 need()，它会把跨记录"自动跳过"，从而漏掉 CONTINUE 首字节的
      // 编码标志，导致后续所有字符串错位（表现为大表里从某一行开始全是乱码）
      if (ci >= chunks.length) break;
      if (pos >= chunks[ci].length) {
        ci += 1;
        pos = 0;
        if (ci >= chunks.length) break;
        compressed = !(chunks[ci][pos++] & 0x01);
        continue;
      }
      if (compressed) {
        out += String.fromCharCode(chunks[ci][pos++]);
      } else {
        if (pos + 2 > chunks[ci].length) {
          ci += 1;
          pos = 0;
          if (ci >= chunks.length) break;
          compressed = !(chunks[ci][pos++] & 0x01);
          continue;
        }
        out += String.fromCharCode(chunks[ci][pos] | (chunks[ci][pos + 1] << 8));
        pos += 2;
      }
    }
    skip(runs * 4 + extSize);
    return out;
  };
  return { string };
}

function parseBiffWorkbook(data) {
  const recs = biffRecords(data);
  if (!recs.length || recs[0].id !== 0x0809) throw new Error('不是有效的 xls 工作簿（缺少 BOF 记录）');

  /* 全局段：SST + BOUNDSHEET */
  const sstChunks = [];
  const bounds = [];
  let inSst = false;
  for (const rec of recs) {
    if (rec.id === 0x002f) throw new Error('该 xls 已加密，无法读取。请在 Excel 中取消密码后另存为 xlsx');
    if (rec.id === 0x00fc) {
      inSst = true;
      sstChunks.push(rec.data);
      continue;
    }
    if (rec.id === 0x003c && inSst) {
      sstChunks.push(rec.data);
      continue;
    }
    if (inSst && rec.id !== 0x003c) inSst = false;
    if (rec.id === 0x0085) {
      const dv = new DataView(rec.data.buffer, rec.data.byteOffset, rec.data.byteLength);
      const offset = dv.getUint32(0, true);
      const type = dv.getUint8(5);
      const cch = dv.getUint8(6);
      const flags = dv.getUint8(7);
      let name = '';
      // BIFF8：grbit 的 bit0（fHighByte）= 1 表示 16 位 Unicode，= 0 表示 8 位压缩
      if (flags & 0x01) {
        for (let i = 0; i < cch; i += 1) name += String.fromCharCode(dv.getUint16(8 + i * 2, true));
      } else {
        for (let i = 0; i < cch; i += 1) name += String.fromCharCode(rec.data[8 + i]);
      }
      bounds.push({ offset, name, type });
    }
    if (rec.id === 0x000a && bounds.length) break;
  }

  const shared = [];
  if (sstChunks.length) {
    // SST 头 8 字节：前 4 字节是引用总数，后 4 字节才是真正的字符串条数（unique）
    const first = sstChunks[0];
    const dv = new DataView(first.buffer, first.byteOffset, first.byteLength);
    const unique = dv.getUint32(4, true);
    const reader = makeSstReader([first.subarray(8), ...sstChunks.slice(1)]);
    for (let i = 0; i < unique && i < 1000000; i += 1) shared.push(reader.string());
  }

  const sheets = bounds.filter((b) => b.type === 0);
  if (!sheets.length) throw new Error('xls 中未找到工作表');

  return sheets.map((s) => ({ name: s.name, grid: biffSheetGrid(recs, s.offset, shared) }));
}

function biffSheetGrid(recs, startOffset, shared) {
  const grid = [];
  const put = (row, col, value) => {
    if (!Number.isFinite(row) || !Number.isFinite(col) || row < 0 || col < 0) return;
    if (!grid[row]) grid[row] = [];
    grid[row][col] = value;
  };
  // 用记录在流中的位置过滤本表：BOUNDSHEET 给的是字节偏移，这里按记录累计长度对齐
  let offset = 0;
  let inside = false;
  const dvOf = (d) => new DataView(d.buffer, d.byteOffset, d.byteLength);
  for (let i = 0; i < recs.length; i += 1) {
    const rec = recs[i];
    if (offset === startOffset) inside = true;
    offset += 4 + rec.data.length;
    if (!inside) continue;
    const dv = dvOf(rec.data);
    switch (rec.id) {
      case 0x0203: // NUMBER
        put(dv.getUint16(0, true), dv.getUint16(2, true), numToCell(dv.getFloat64(6, true)));
        break;
      case 0x027e: // RK
        put(dv.getUint16(0, true), dv.getUint16(2, true), numToCell(rkToNumber(dv.getUint32(6, true))));
        break;
      case 0x00bd: {
        // MULRK
        const row = dv.getUint16(0, true);
        const first = dv.getUint16(2, true);
        const n = (rec.data.length - 6) / 6;
        for (let k = 0; k < n; k += 1) {
          put(row, first + k, numToCell(rkToNumber(dv.getUint32(4 + k * 6 + 2, true))));
        }
        break;
      }
      case 0x00fd: // LABELSST
        put(dv.getUint16(0, true), dv.getUint16(2, true), shared[dv.getUint32(6, true)] ?? '');
        break;
      case 0x0204: {
        // LABEL（BIFF8 一般不用，兼容老文件）
        const row = dv.getUint16(0, true);
        const col = dv.getUint16(2, true);
        const cch = dv.getUint16(6, true);
        const flags = dv.getUint8(8);
        let s = '';
        if (flags & 0x01) for (let k = 0; k < cch; k += 1) s += String.fromCharCode(dv.getUint16(9 + k * 2, true));
        else for (let k = 0; k < cch; k += 1) s += String.fromCharCode(rec.data[9 + k]);
        put(row, col, s);
        break;
      }
      case 0x0006: {
        // FORMULA：结果可能是数字，也可能指向后续 STRING 记录
        const row = dv.getUint16(0, true);
        const col = dv.getUint16(2, true);
        const b6 = rec.data[6];
        const b12 = rec.data[12];
        const b13 = rec.data[13];
        if (b12 === 0xff && b13 === 0xff) {
          if (b6 === 0x00) {
            const nxt = recs[i + 1];
            if (nxt && nxt.id === 0x0207) {
              const ndv = dvOf(nxt.data);
              const cch = ndv.getUint16(0, true);
              const flags = ndv.getUint8(2);
              let s = '';
              if (flags & 0x01) for (let k = 0; k < cch; k += 1) s += String.fromCharCode(ndv.getUint16(3 + k * 2, true));
              else for (let k = 0; k < cch; k += 1) s += String.fromCharCode(nxt.data[3 + k]);
              put(row, col, s);
            }
          } else if (b6 === 0x01) {
            put(row, col, rec.data[8] ? 'TRUE' : 'FALSE');
          }
        } else {
          put(row, col, numToCell(dv.getFloat64(6, true)));
        }
        break;
      }
      case 0x0205: // BOOLERR
        put(dv.getUint16(0, true), dv.getUint16(2, true), dv.getUint8(6) ? 'TRUE' : 'FALSE');
        break;
      case 0x000a: // EOF
        inside = false;
        return denseGrid(grid);
      default:
        break;
    }
  }
  return denseGrid(grid);
}

function denseGrid(sparse) {
  const out = [];
  for (let i = 0; i < sparse.length; i += 1) out.push(sparse[i] || []);
  return out;
}

/* ═══════════════ 对外入口 ═══════════════ */

/** 按扩展名 + 文件头判断格式：PK=xlsx，D0CF11E0=xls，其余按文本 */
export function detectFormat(fileName, bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (u8.length >= 2 && u8[0] === 0x50 && u8[1] === 0x4b) return 'xlsx';
  if (u8.length >= 8 && CFB_MAGIC.every((b, i) => u8[i] === b)) return 'xls';
  const ext = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  if (ext && ext[1] === 'xlsx') return 'xlsx';
  if (ext && ext[1] === 'xls') return 'xls';
  return 'csv';
}

/**
 * 读任意受支持的表格文件 → { format, sheets: [{name, grid}], notes: string[] }
 * notes 是"解析告警"：读到了文件但内容可疑时给出可操作的原因，界面直接展示，
 * 避免用户只看到"行数 0 / 待指定"却不知道是文件问题还是数据问题。
 * @param {{name:string, buffer?:ArrayBuffer|Uint8Array, text?:string}} file
 */
export async function readTableFile(file) {
  const name = String((file && file.name) || '');
  const hasBuffer = file && file.buffer !== undefined && file.buffer !== null;
  const format = hasBuffer ? detectFormat(name, file.buffer) : 'csv';
  if (format === 'xlsx') {
    const { sheets, notes } = await readXlsx(file.buffer);
    return { format, sheets, notes };
  }
  if (format === 'xls') {
    const sheets = parseBiffWorkbook(readCfbWorkbook(file.buffer));
    const notes = sheets.every((s) => !s.grid.length) ? ['工作表解析到 0 行（可能是加密、损坏或非 BIFF8 格式）'] : [];
    return { format, sheets, notes };
  }
  const text = file.text !== undefined && file.text !== null ? String(file.text) : decodeBytes(file.buffer || new Uint8Array());
  const parsed = parseDelimitedText(text);
  const notes = parsed.grid.length ? [] : ['文本内容解析到 0 行（文件可能为空或不是分隔文本）'];
  return {
    format: 'csv',
    sheets: [{ name: name.replace(/\.[^.]+$/, '') || 'CSV', grid: parsed.grid }],
    notes,
  };
}

/** 把网格裁掉纯空行/空列（表头定位时用） */
export function trimGrid(grid) {
  const rows = (grid || []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
  if (!rows.length) return [];
  let min = Infinity;
  let max = -1;
  for (const r of rows) {
    for (let i = 0; i < r.length; i += 1) {
      if (String(r[i] ?? '').trim() !== '') {
        if (i < min) min = i;
        if (i > max) max = i;
      }
    }
  }
  return rows.map((r) => {
    const out = [];
    for (let i = min; i <= max; i += 1) out.push(String(r[i] ?? '').trim());
    return out;
  });
}
