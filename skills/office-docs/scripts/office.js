#!/usr/bin/env node
// office.js — 无 Python 环境下用 Node 读写 xlsx / docx。
//
// 用法:
//   node office.js read-xlsx <file.xlsx|file.csv> [--sheet <名>] [--json]
//                              [--range A1:C10] [--limit N] [--list-sheets] [--formulas]
//   node office.js write-xlsx <spec.json> -o <out.xlsx>
//   node office.js read-docx <file.docx> [--json]
//   node office.js write-docx <spec.json> -o <out.docx>
//   node office.js write-docx --md <md文件|-> -o <out.docx>
//   node office.js --selftest
// 退出码: 0 成功 / 1 运行失败 / 2 用法或前置错误
//
// 依赖解析：脚本放在 <skill>/scripts/ 下，Node 会向上找到 <skill>/node_modules，
// 所以不需要 NODE_PATH，也不依赖全局安装。
'use strict';
const fs = require('fs');
const path = require('path');

const EXIT_USAGE = 2, EXIT_FAIL = 1;
const NUM_REF = 'office-num';   // docx 有序列表引用的编号定义名

// 缺依赖时直接把**完整**安装命令给出去：只报缺的那一个，收包人会"装一个跑一次"来回四趟。
const INSTALL_CMD = 'npm i exceljs docx jszip fast-xml-parser --registry=https://registry.npmmirror.com';
function need(mod) {
  try { return require(mod); } catch (e) {
    console.error(`缺少依赖 ${mod}。本技能的四个依赖一起装（缺哪个都装这一条）：`);
    console.error(`  cd "${path.resolve(__dirname, '..')}" && ${INSTALL_CMD}`);
    process.exit(EXIT_USAGE);
  }
}

function usage(msg) {
  if (msg) console.error(`错误: ${msg}`);
  console.error('用法:');
  console.error('  node office.js read-xlsx <file.xlsx|file.csv> [--sheet <名>] [--json]');
  console.error('             [--range A1:C10] [--limit N] [--list-sheets] [--formulas]');
  console.error('  node office.js write-xlsx <spec.json> -o <out.xlsx>');
  console.error('  node office.js set-xlsx <file.xlsx> <工作表> <单元格> <值>');
  console.error('  node office.js read-docx <file.docx> [--json]');
  console.error('  node office.js write-docx <spec.json> -o <out.docx>');
  console.error('  node office.js write-docx --md <md文件|-> -o <out.docx>');
  console.error('  node office.js --selftest');
  process.exit(EXIT_USAGE);
}

// ---------- 公共 ----------

// exceljs 的单元格值可能是裸值，也可能是 richText / formula / hyperlink / Date 对象。
// 不归一化就直接 JSON.stringify，读出来是一坨对象而不是内容。
function cellVal(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v !== 'object') return v;
  if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
  if (v.text !== undefined && v.hyperlink !== undefined) return v.text;
  if (v.result !== undefined) return cellVal(v.result);
  if (v.formula !== undefined) return null;            // 无缓存结果的公式：读不到值
  if (v.error !== undefined) return `#${v.error}`;
  return String(v);
}

const s = (x) => (x === null || x === undefined ? '' : String(x));
const mdCell = (x) => s(x).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function readJsonSpec(file) {
  if (!fs.existsSync(file)) { console.error(`spec 不存在: ${file}`); process.exit(EXIT_USAGE); }
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`spec 不是合法 JSON: ${e.message}`); process.exit(EXIT_USAGE); }
  return j;
}

function outPathOf(argv, i) {
  const oi = argv.indexOf('-o');
  if (oi < 0 || !argv[oi + 1]) usage('缺少 -o <输出文件>');
  return argv[oi + 1];
}

// A1:C10 → { r1, c1, r2, c2 }（1-based 闭区间）；不合法返回 null
function parseRange(spec) {
  const m = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/.exec(String(spec || '').trim());
  if (!m) return null;
  const col = (letters) => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
  const r1 = Number(m[2]), r2 = Number(m[4]), c1 = col(m[1]), c2 = col(m[3]);
  if (r1 < 1 || c1 < 1 || r2 < r1 || c2 < c1) return null;
  return { r1, c1, r2, c2 };
}

// 简版 CSV 解析：支持引号包裹（"" 转义）与字段内换行，够日常数据用。
// 数字串归一成 Number——否则 CSV 导出的 "12" 与手写 12 在全表里类型不一致。
function parseCsv(text) {
  const rows = []; let row = [], field = '', inQ = false;
  const src = String(text).replace(/^\uFEFF/, '');   // 去 BOM（Excel 导出的 CSV 常带）
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows.map((r) => r.map((v) => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v)));
}

// 从 PNG / JPEG 文件头读像素尺寸（md 插图按原尺寸用）；读不出返回 null
function imgDims(file) {
  const b = fs.readFileSync(file);
  if (b.length > 24 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) {   // JPEG：扫描 SOF 段
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

// 图片尺寸：宽超过上限就等比缩小（避免一页塞不下）；读不出尺寸时给保守默认值
function fitImage(file, maxW) {
  const lim = maxW || 600;
  const d = imgDims(file);
  if (!d || !d.w || !d.h) return { width: lim, height: Math.round(lim * 0.6) };
  if (d.w <= lim) return { width: d.w, height: d.h };
  const k = lim / d.w;
  return { width: Math.round(d.w * k), height: Math.round(d.h * k) };
}

const IMG_TYPES = { '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg', '.gif': 'gif', '.bmp': 'bmp' };

// 读 Office 文件前的 zip 头预检。不查这一下，JSZip 会抛一句看不懂的
// "Can't find end of central directory"，排查成本高（2026-09-23 实遇：企业安全软件会把
// Office 文件透明加密存储，文件头被改成非 zip，读出来必然是这句）。
function assertOfficeZip(file, kind) {
  const fh = Buffer.alloc(4);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, fh, 0, 4, 0); } finally { fs.closeSync(fd); }
  if (fh[0] === 0x50 && fh[1] === 0x4b) return;
  const hex = [...fh].map((x) => x.toString(16).padStart(2, '0')).join(' ');
  console.error(`不是有效的 .${kind}（文件头 ${hex}，不是 zip）：${file}`);
  if (fh[0] === 0xd0 && fh[1] === 0xcf) {
    console.error(`  这是旧版格式（.${kind === 'xlsx' ? 'xls' : 'doc'}）——请先用 Office 打开并另存为 .${kind}。`);
  } else {
    console.error('  文件头不像 zip：常见原因是**被企业安全软件透明加密**（本机实测：桌面上的 .xlsx/.docx 即为加密态），也可能是文件损坏。');
    console.error('  直接「另存为」不可行：本机实测 DLP 会把 Office 写盘的文件重新加密。按技能 encrypted-office-visual-inspection 处理（Excel 见其 2.0-C：COM 读内容 → 脚本重建明文）。');
  }
  process.exit(EXIT_USAGE);
}

// ---------- xlsx ----------

// opts: { sheet, json, range, limit, listSheets, formulas }
// 大表防护：--range / --limit / --list-sheets 三个读闸门，避免整表灌进上下文。
async function readXlsx(file, opts) {
  const o = opts || {};
  if (!fs.existsSync(file)) { console.error(`文件不存在: ${file}`); process.exit(EXIT_USAGE); }

  let result;
  if (/\.csv$/i.test(file)) {
    const rows = parseCsv(fs.readFileSync(file, 'utf8'));
    result = [{ name: path.basename(file, path.extname(file)), rowCount: rows.length, colCount: Math.max(0, ...rows.map((r) => r.length)), rows }];
  } else {
    assertOfficeZip(file, 'xlsx');
    const ExcelJS = need('exceljs', 'exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const sheets = o.sheet ? wb.worksheets.filter((w) => w.name === o.sheet) : wb.worksheets;
    if (sheets.length === 0) {
      console.error(`没有名为 "${o.sheet}" 的工作表。现有：${wb.worksheets.map((w) => w.name).join(' / ')}`);
      process.exit(EXIT_USAGE);
    }
    result = sheets.map((ws) => {
      const rows = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        const vals = [];
        // row.values 是 1-based 的稀疏数组：vals[0] 恒为 undefined，必须按列数补齐
        for (let c = 1; c <= ws.columnCount; c++) {
          const cell = row.getCell(c);
          vals.push(o.formulas && cell.formula ? `=${cell.formula.replace(/^=/, '')}` : cellVal(cell.value));
        }
        rows.push(vals);
      });
      return { name: ws.name, rowCount: rows.length, colCount: ws.columnCount, rows };
    });
  }

  if (o.range) {
    const rg = parseRange(o.range);
    if (!rg) usage(`--range 格式应为 A1:C10（1-based 闭区间），实得 "${o.range}"`);
    for (const sh of result) {
      sh.rows = sh.rows.slice(rg.r1 - 1, rg.r2).map((r) => r.slice(rg.c1 - 1, rg.c2));
      sh.rowCount = sh.rows.length;
      sh.colCount = Math.max(0, ...sh.rows.map((r) => r.length));
    }
  }
  if (o.listSheets) {
    const meta = result.map(({ name, rowCount, colCount }) => ({ name, rowCount, colCount }));
    if (o.json) { console.log(JSON.stringify(meta, null, 2)); return; }
    for (const m of meta) console.log(`${m.name}\t${m.rowCount} 行 × ${m.colCount} 列`);
    return;
  }
  if (o.limit > 0) {
    for (const sh of result) {
      if (sh.rows.length > o.limit) { sh.truncated = sh.rows.length - o.limit; sh.rows = sh.rows.slice(0, o.limit); }
    }
  }

  if (o.json) { console.log(JSON.stringify(result, null, 2)); return; }
  for (const sh of result) {
    const note = sh.truncated ? `（已截断：仅前 ${sh.rows.length} 行，余 ${sh.truncated} 行；需要更多用 --range）` : '';
    console.log(`### ${sh.name}（${sh.rowCount} 行 × ${sh.colCount} 列）${note}`);
    if (sh.rows.length === 0) { console.log('（空表）'); continue; }
    const head = sh.rows[0];
    console.log('| ' + head.map(mdCell).join(' | ') + ' |');
    console.log('|' + head.map(() => '---').join('|') + '|');
    for (const r of sh.rows.slice(1)) console.log('| ' + r.map(mdCell).join(' | ') + ' |');
  }
}

// spec 每一表可选：columns/rows 内联，或 "csv": "<path>"（首行当表头）；
// 另支持 "widths": [...]、"freeze": true|"A2"|{row,col}、"numFmt": [null, "#,##0.00"]、"headerBold": false。
async function writeXlsx(specFile, outFile) {
  const spec = readJsonSpec(specFile);
  const sheets = Array.isArray(spec.sheets) ? spec.sheets : null;
  if (!sheets || sheets.length === 0) usage('spec 需要 { "sheets": [ { "name", "columns", "rows" } ] }');
  const ExcelJS = need('exceljs', 'exceljs');
  const wb = new ExcelJS.Workbook();
  sheets.forEach((def, i) => {
    const ws = wb.addWorksheet(def.name || `Sheet${i + 1}`);
    let columns = def.columns, rows = def.rows;
    if (def.csv) {
      if (!fs.existsSync(def.csv)) { console.error(`CSV 不存在: ${def.csv}`); process.exit(EXIT_USAGE); }
      const parsed = parseCsv(fs.readFileSync(def.csv, 'utf8'));
      if (parsed.length === 0) { console.error(`CSV 无数据: ${def.csv}`); process.exit(EXIT_USAGE); }
      columns = columns || parsed[0];
      rows = rows || parsed.slice(1);
    }
    if (Array.isArray(columns)) {
      ws.addRow(columns);
      ws.getRow(1).font = { bold: def.headerBold !== false };
    }
    for (const r of rows || []) ws.addRow(r);
    // 列宽：显式 widths 优先；否则按内容自适应（中文按双宽）
    const cols = Math.max(ws.columnCount, ...(rows || []).map((r) => r.length), 1);
    for (let c = 1; c <= cols; c++) {
      if (Array.isArray(def.widths) && def.widths[c - 1] > 0) { ws.getColumn(c).width = def.widths[c - 1]; continue; }
      let w = 8;
      ws.getColumn(c).eachCell({ includeEmpty: false }, (cell) => {
        const t = s(cellVal(cell.value));
        const len = [...t].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
        if (len + 2 > w) w = len + 2;
      });
      ws.getColumn(c).width = Math.min(w, 60);
    }
    if (Array.isArray(def.numFmt)) {
      def.numFmt.forEach((fmt, ci) => { if (fmt) ws.getColumn(ci + 1).numFmt = fmt; });
    }
    if (def.freeze) {
      const f = def.freeze;
      if (f === true) ws.views = [{ state: 'frozen', ySplit: 1 }];
      else if (typeof f === 'string') {
        const rg = parseRange(`${f}:${f}`);
        if (!rg) { console.error(`freeze 格式应为 true / "A2" / { "row": 1, "col": 0 }，实得 ${JSON.stringify(f)}`); process.exit(EXIT_USAGE); }
        ws.views = [{ state: 'frozen', xSplit: rg.c1 - 1, ySplit: rg.r1 - 1 }];
      } else if (typeof f === 'object') ws.views = [{ state: 'frozen', xSplit: Number(f.col) || 0, ySplit: Number(f.row) || 0 }];
    }
  });
  await wb.xlsx.writeFile(outFile);
  console.log(`已写出 ${outFile}（${sheets.length} 个工作表）`);
}

// 改既有工作簿里的一个格：write-xlsx 是"整份重生成"（会丢样式与其它工作表），
// 只想动一个格时用它。值是 `=` 开头按公式、纯数字按数值，其余按文本。
async function setXlsx(file, sheet, addr, value) {
  if (!fs.existsSync(file)) { console.error(`文件不存在: ${file}`); process.exit(EXIT_USAGE); }
  const ExcelJS = need('exceljs', 'exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(sheet) || wb.worksheets[Number(sheet)] || null;
  if (!ws) {
    console.error(`工作表不存在: ${sheet}。现有：${wb.worksheets.map((w) => w.name).join(' / ')}`);
    process.exit(EXIT_USAGE);
  }
  const cell = ws.getCell(addr);
  const before = cellVal(cell.value);
  cell.value = /^=/.test(value) ? { formula: value.slice(1) } : (/^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value);
  await wb.xlsx.writeFile(file);
  console.log(`已改 ${ws.name}!${addr}: ${JSON.stringify(before)} → ${JSON.stringify(value)}（${file} 已保存）`);
}

// ---------- docx ----------

// 取元素数组：fast-xml-parser 遇到单个子元素时给对象、多个才给数组。
// 注意：裸空元素（如 <w:p/>）会被解析为空字符串 ''，必须视作空数组——
// 否则 arr('')=[''] 会让 runText 对 '' 反复递归（w:hyperlink 分支）触发栈溢出。
const arr = (x) => (x === undefined || x === null || x === '' ? [] : Array.isArray(x) ? x : [x]);

// 递归取 w:t 文本，遇到 w:tab / w:br 补空白
function runText(node) {
  let out = '';
  for (const r of arr(node && node['w:r'])) {
    for (const t of arr(r['w:t'])) out += typeof t === 'object' ? s(t['#text']) : s(t);
    for (const ch of arr(r['w:tab'])) out += '\t';
    for (const ch of arr(r['w:br'])) out += '\n';
  }
  // 段落里可能直接嵌 hyperlink（w:hyperlink 包着 w:r）
  for (const h of arr(node && node['w:hyperlink'])) out += runText(h);
  return out;
}

async function readDocx(file, asJson) {
  if (!fs.existsSync(file)) { console.error(`文件不存在: ${file}`); process.exit(EXIT_USAGE); }
  assertOfficeZip(file, 'docx');
  const JSZip = need('jszip', 'jszip');
  const { XMLParser } = need('fast-xml-parser', 'fast-xml-parser');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const docXml = zip.file('word/document.xml');
  if (!docXml) { console.error('不是有效的 .docx（缺 word/document.xml）'); process.exit(EXIT_FAIL); }
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(await docXml.async('string'));
  const body = doc && doc['w:document'] && doc['w:document']['w:body'];
  if (!body) { console.error('document.xml 里没有 w:body'); process.exit(EXIT_FAIL); }

  const blocks = [];
  for (const node of arr(body['w:p'])) {
    const text = runText(node).trim();
    if (text) blocks.push({ type: 'paragraph', text });
  }
  for (const tbl of arr(body['w:tbl'])) {
    const rows = arr(tbl['w:tr']).map((tr) => arr(tr['w:tc']).map((tc) => {
      // 单元格里可能有多个段落与嵌套表；这里只取段落文本并用空格连
      const parts = arr(tc['w:p']).map((p) => runText(p).trim()).filter(Boolean);
      return parts.join(' ');
    }));
    blocks.push({ type: 'table', rows });
  }

  if (asJson) { console.log(JSON.stringify(blocks, null, 2)); return; }
  for (const b of blocks) {
    if (b.type === 'paragraph') { console.log(b.text); continue; }
    console.log('');
    console.log('| ' + b.rows[0].map(mdCell).join(' | ') + ' |');
    console.log('|' + b.rows[0].map(() => '---').join('|') + '|');
    for (const r of b.rows.slice(1)) console.log('| ' + r.map(mdCell).join(' | ') + ' |');
    console.log('');
  }
}

async function writeDocx(specFile, outFile) {
  const spec = readJsonSpec(specFile);
  const blocks = Array.isArray(spec.blocks) ? spec.blocks : null;
  if (!blocks || blocks.length === 0) {
    usage('spec 需要 { "blocks": [ {"type":"heading|paragraph|table|bullet|number", ...} ] }');
  }
  await renderDocx(blocks, spec.title, outFile);
}

// ---------- markdown → docx（写文档最常见的一步：手上是 md，要交的是 Word） ----------

// 只认文档里真正会用的四类块：# 标题、有序/无序列表、| 表格 |、其余按段落。
function mdToBlocks(md) {
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/^\s*$/.test(ln)) { i++; continue; }
    let m;
    if ((m = ln.match(/^(#{1,4})\s+(.*)$/))) { blocks.push({ type: 'heading', level: m[1].length, text: m[2] }); i++; continue; }
    if (/^\s*\|/.test(ln)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        // 跳过分隔行（| --- | --- |）
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) {
          rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((t) => t.trim()));
        }
        i++;
      }
      if (rows.length) blocks.push({ type: 'table', rows, headerBold: true });
      continue;
    }
    // 图片：![alt](path) 或 ![alt](path "宽度px")——宽度省略时按原图（超宽自动缩放）
    if ((m = ln.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"(\d+)")?\)\s*$/))) {
      blocks.push({ type: 'image', path: m[2], alt: m[1] || '', ...(m[3] ? { width: Number(m[3]) } : {}) });
      i++; continue;
    }
    if ((m = ln.match(/^\s*[-*]\s+(.*)$/))) { blocks.push({ type: 'bullet', text: m[1] }); i++; continue; }
    if ((m = ln.match(/^\s*\d+\.\s+(.*)$/))) { blocks.push({ type: 'number', text: m[1] }); i++; continue; }
    blocks.push({ type: 'paragraph', text: ln }); i++;
  }
  return blocks;
}

async function writeDocxMd(mdPath, outFile) {
  let md;
  if (mdPath === '-') md = fs.readFileSync(0, 'utf8');
  else if (fs.existsSync(mdPath)) md = fs.readFileSync(mdPath, 'utf8');
  else { console.error(`文件不存在: ${mdPath}`); process.exit(EXIT_USAGE); }
  const blocks = mdToBlocks(md);
  if (blocks.length === 0) { console.error('Markdown 内容为空（只有空行？）'); process.exit(EXIT_USAGE); }
  await renderDocx(blocks, null, outFile);
}

async function renderDocx(blocks, title, outFile) {
  const D = need('docx', 'docx');
  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun, AlignmentType, WidthType, ImageRun, PageBreak } = D;

  const children = blocks.map((b) => {
    if (b.type === 'image') {
      if (!fs.existsSync(b.path)) { console.error(`图片不存在: ${b.path}`); process.exit(EXIT_USAGE); }
      const ext = IMG_TYPES[path.extname(b.path).toLowerCase()];
      if (!ext) { console.error(`不支持的图片格式（支持 png / jpg / gif / bmp）: ${b.path}`); process.exit(EXIT_USAGE); }
      return new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({ data: fs.readFileSync(b.path), transformation: fitImage(b.path, b.width || 600), type: ext })],
      });
    }
    if (b.type === 'pagebreak') return new Paragraph({ children: [new PageBreak()] });
    if (b.type === 'table') {
      // 首行加粗 + 铺满页宽：Markdown 表格的首行是表头（与 write-xlsx 的列头同口径）。
      // 这两条是**实机截图比对**出来的——只做回读断言时，一张没表头、被 Word 压成窄条的表格照样"全绿"。
      const rows = (b.rows || []).map((r, ri) => new TableRow({
        children: r.map((c) => new TableCell({
          children: [new Paragraph({
            children: [new TextRun({ text: s(c), ...(b.headerBold && ri === 0 ? { bold: true } : {}) })],
          })],
        })),
      }));
      return new Table({ rows, ...(b.headerBold ? { width: { size: 100, type: WidthType.PERCENTAGE } } : {}) });
    }
    const run = {
      text: s(b.text),
      ...(b.bold ? { bold: true } : {}),
      ...(b.italic ? { italics: true } : {}),
      ...(b.underline ? { underline: {} } : {}),
      ...(b.size ? { size: Number(b.size) * 2 } : {}),                       // spec 单位是磅，docx 库要半磅
      ...(b.color ? { color: String(b.color).replace(/^#/, '') } : {}),
    };
    const para = {
      children: [new TextRun(run)],
      ...(b.bold ? { bold: true } : {}),
      ...(b.align === 'center' ? { alignment: AlignmentType.CENTER } : {}),
    };
    if (b.type === 'heading') {
      const lv = Math.min(Math.max(Number(b.level) || 1, 1), 3);
      para.heading = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][lv - 1];
    }
    if (b.type === 'bullet') return new Paragraph({ ...para, bullet: { level: 0 } });
    if (b.type === 'number') return new Paragraph({ ...para, numbering: { reference: NUM_REF, level: 0 } });
    return new Paragraph(para);
  });

  const doc = new Document({
    ...(title ? { title: s(title) } : {}),
    // 有序列表要引用一处编号定义；没有它 docx 库会渲染成普通段落
    numbering: { config: [{ reference: NUM_REF, levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START }] }] },
    sections: [{ children }],
  });
  fs.writeFileSync(outFile, await Packer.toBuffer(doc));
  console.log(`已写出 ${outFile}（${blocks.length} 个块）`);
}

// ---------- 自测 ----------

async function selftest() {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-selftest-'));
  let pass = 0, fail = 0;
  const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); } };

  const xlsxSpec = path.join(tmp, 'x.json');
  const xlsxOut = path.join(tmp, 'out.xlsx');
  fs.writeFileSync(xlsxSpec, JSON.stringify({
    sheets: [{
      name: '数据',
      columns: ['名称', '数量', '启用'],
      rows: [['甲', 12, true], ['乙', 3.5, false], ['丙', null, '文本']],
    }],
  }));
  await writeXlsx(xlsxSpec, xlsxOut);
  ok(fs.existsSync(xlsxOut) && fs.statSync(xlsxOut).size > 0, 'write-xlsx 产出非空文件');

  // 读回来断言：这才是"真的写对了"的判据，而不是"没报错"
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxOut);
  const ws = wb.getWorksheet('数据');
  ok(!!ws, 'read-xlsx 能取到同名工作表');
  if (ws) {
    const v = (r, c) => cellVal(ws.getRow(r).getCell(c).value);
    ok(v(1, 1) === '名称', `表头回读一致（实得 ${JSON.stringify(v(1, 1))}）`);
    ok(v(2, 2) === 12, `数字回读一致（实得 ${JSON.stringify(v(2, 2))}）`);
    ok(v(3, 2) === 3.5, `小数回读一致（实得 ${JSON.stringify(v(3, 2))}）`);
    ok(v(4, 3) === '文本', `空单元格未错位、其右邻列回读一致（实得 ${JSON.stringify(v(4, 3))}）`);
    ok(v(4, 2) === null, `空单元格回读为 null（实得 ${JSON.stringify(v(4, 2))}）`);
  }

  const docxSpec = path.join(tmp, 'd.json');
  const docxOut = path.join(tmp, 'out.docx');
  fs.writeFileSync(docxSpec, JSON.stringify({
    blocks: [
      { type: 'heading', level: 1, text: '季度报告' },
      { type: 'paragraph', text: '本文由 office-docs 生成。' },
      { type: 'bullet', text: '第一条' },
      { type: 'table', rows: [['区域', '金额'], ['华东', '1200'], ['华南', '800']] },
    ],
  }));
  await writeDocx(docxSpec, docxOut);
  ok(fs.existsSync(docxOut) && fs.statSync(docxOut).size > 0, 'write-docx 产出非空文件');

  const origLog = console.log; const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  await readDocx(docxOut, true);
  console.log = origLog;
  const blocks = JSON.parse(lines.join('\n'));
  const texts = blocks.filter((b) => b.type === 'paragraph').map((b) => b.text);
  ok(blocks.some((b) => b.type === 'paragraph' && b.text === '季度报告'), 'docx 标题文本回读一致');
  ok(blocks.some((b) => b.type === 'paragraph' && b.text === '本文由 office-docs 生成。'), 'docx 段落文本回读一致');
  const tbl = blocks.find((b) => b.type === 'table');
  ok(!!tbl, 'docx 表格被识别为表格块');
  if (tbl) {
    ok(tbl.rows.length === 3, `docx 表格 3 行（实得 ${tbl.rows.length}）`);
    ok(tbl.rows[2][0] === '华南' && tbl.rows[2][1] === '800', `docx 单元格回读一致（实得 ${JSON.stringify(tbl.rows[2])}）`);
  }
  ok(texts.length >= 2, 'docx 至少回读到 2 个非空段落');

  // 负对照：判据必须能红——不存在的文件要给出非零退出，而不是静默当空文档
  const before = process.exitCode;
  let exited = null;
  const realExit = process.exit;
  process.exit = (code) => { exited = code; throw new Error('__exit__'); };
  try { await readXlsx(path.join(tmp, 'nope.xlsx'), null, true); }
  catch (e) { if (e.message !== '__exit__') throw e; }
  process.exit = realExit; process.exitCode = before;
  ok(exited === EXIT_USAGE, `读不存在的 xlsx 退 ${EXIT_USAGE}（实得 ${exited}）`);

  // 负对照：非 docx 的 zip 结构要被识别为无效，而不是当成空文档
  const zipOut = path.join(tmp, 'fake.docx');
  fs.writeFileSync(zipOut, Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'binary'));
  exited = null; process.exit = (code) => { exited = code; throw new Error('__exit__'); };
  try { await readDocx(zipOut, true); }
  catch (e) { if (e.message !== '__exit__') throw e; }
  process.exit = realExit; process.exitCode = before;
  ok(typeof exited === 'number' && exited !== 0, `无效 docx 给出非零退出（实得 ${exited}）`);

  // set-xlsx：改一个格再读回来，判据是"值真的变了"而不是"没报错"
  await setXlsx(xlsxOut, '数据', 'B2', '99');
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.readFile(xlsxOut);
  const after = cellVal(wb2.getWorksheet('数据').getCell('B2').value);
  ok(after === 99, `set-xlsx 写入后回读一致（实得 ${JSON.stringify(after)}）`);
  exited = null; process.exit = (code) => { exited = code; throw new Error('__exit__'); };
  try { await setXlsx(xlsxOut, '不存在的表', 'A1', 'x'); }
  catch (e) { if (e.message !== '__exit__') throw e; }
  process.exit = realExit; process.exitCode = before;
  ok(exited === EXIT_USAGE, `set-xlsx 工作表不存在退 ${EXIT_USAGE}（实得 ${exited}）`);

  // write-docx --md：markdown 进、docx 出，回读断言四类块都在
  const mdFile = path.join(tmp, 'r.md');
  fs.writeFileSync(mdFile, ['# 季度报告', '', '- 第一条', '- 第二条', '', '1. 步骤一', '2. 步骤二', '', '| 区域 | 金额 |', '| --- | --- |', '| 华东 | 1200 |'].join('\n'));
  const mdOut = path.join(tmp, 'md.docx');
  await writeDocxMd(mdFile, mdOut);
  ok(fs.existsSync(mdOut) && fs.statSync(mdOut).size > 0, 'write-docx --md 产出非空文件');
  const lines2 = [];
  console.log = (...a) => lines2.push(a.join(' '));
  await readDocx(mdOut, true);
  console.log = origLog;
  const blocks2 = JSON.parse(lines2.join('\n'));
  const texts2 = blocks2.filter((b) => b.type === 'paragraph').map((b) => b.text);
  ok(texts2.includes('季度报告'), 'md 一级标题回读一致');
  ok(texts2.includes('第一条') && texts2.includes('第二条'), 'md 无序列表回读一致');
  ok(texts2.includes('步骤一') && texts2.includes('步骤二'), 'md 有序列表回读一致');
  const tbl2 = blocks2.find((b) => b.type === 'table');
  ok(!!tbl2 && tbl2.rows.length === 2 && tbl2.rows[1][0] === '华东', `md 表格回读一致（实得 ${JSON.stringify(tbl2 && tbl2.rows)}）`);
  exited = null; process.exit = (code) => { exited = code; throw new Error('__exit__'); };
  try { await writeDocxMd(path.join(tmp, '不存在的.md'), path.join(tmp, 'x.docx')); }
  catch (e) { if (e.message !== '__exit__') throw e; }
  process.exit = realExit; process.exitCode = before;
  ok(exited === EXIT_USAGE, `write-docx --md 源文件不存在退 ${EXIT_USAGE}（实得 ${exited}）`);

  // ---------- 增强能力自测（2026-09-23：读闸门 / CSV / 样式 / 图片）----------

  ok(parseRange('B2:D5').c1 === 2 && parseRange('B2:D5').r2 === 5, 'parseRange 正确解析 B2:D5');
  ok(parseRange('3:5') === null && parseRange('A0:B1') === null && parseRange('D2:B5') === null, '负对照：非法 range 全部返回 null');
  const csvRows = parseCsv('a,b\n1,"x,y"\n"多\n行",2\n');
  ok(csvRows.length === 3 && csvRows[1][1] === 'x,y' && csvRows[2][0] === '多\n行' && csvRows[1][0] === 1, 'parseCsv：引号内逗号 / 字段内换行 / 数字归一');

  const cap = async (fn) => {
    const lines = []; const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try { await fn(); } finally { console.log = orig; }
    return lines.join('\n');
  };

  const listOut = await cap(() => readXlsx(xlsxOut, { listSheets: true }));
  ok(/数据\t4 行 × 3 列/.test(listOut), `--list-sheets 列出层级与行列（实得 ${JSON.stringify(listOut.trim())}）`);
  const limOut = await cap(() => readXlsx(xlsxOut, { limit: 2 }));
  ok(limOut.includes('已截断：仅前 2 行') && !limOut.includes('丙'), '--limit 2 截断并提示余量');
  const rgOut = await cap(() => readXlsx(xlsxOut, { range: 'B2:C3', json: true }));
  const rg = JSON.parse(rgOut);
  // 注意：B2 在前面的 set-xlsx 用例里已被改成 99
  ok(rg[0].rows.length === 2 && rg[0].rows[0][0] === 99 && rg[0].rows[1][1] === false, `--range B2:C3 取到正确子矩阵（实得 ${JSON.stringify(rg[0].rows)}）`);

  const fxlsx = path.join(tmp, 'formula.xlsx');
  {
    const wbF = new ExcelJS.Workbook();
    const wsF = wbF.addWorksheet('F');
    wsF.addRow(['a', 1]); wsF.addRow(['b', 2]);
    wsF.getCell('C1').value = { formula: 'A1', result: 'a' };
    await wbF.xlsx.writeFile(fxlsx);
  }
  const f1 = JSON.parse(await cap(() => readXlsx(fxlsx, { formulas: true, json: true })));
  ok(f1[0].rows[0][2] === '=A1', `--formulas 读到公式原文（实得 ${JSON.stringify(f1[0].rows[0][2])}）`);
  const f2 = JSON.parse(await cap(() => readXlsx(fxlsx, { json: true })));
  ok(f2[0].rows[0][2] === 'a', `默认读缓存值（实得 ${JSON.stringify(f2[0].rows[0][2])}）`);

  const csvFile = path.join(tmp, 'data.csv');
  fs.writeFileSync(csvFile, '名称,数量\n甲,12\n乙,"x,y"\n');
  const csvRead = JSON.parse(await cap(() => readXlsx(csvFile, { json: true })));
  ok(csvRead[0].name === 'data' && csvRead[0].rows[1][1] === 12 && csvRead[0].rows[2][1] === 'x,y', 'read-xlsx 直读 CSV（表名 / 数字归一 / 引号字段）');
  const csvSpecP = path.join(tmp, 'c.json');
  const csvXlsx = path.join(tmp, 'c.xlsx');
  fs.writeFileSync(csvSpecP, JSON.stringify({ sheets: [{ name: 'CSV', csv: csvFile, widths: [20], freeze: true, numFmt: [null, '0.00'] }] }));
  await writeXlsx(csvSpecP, csvXlsx);
  const wbC = new ExcelJS.Workbook(); await wbC.xlsx.readFile(csvXlsx);
  const wsC = wbC.getWorksheet('CSV');
  ok(!!wsC && cellVal(wsC.getRow(2).getCell(1).value) === '甲' && cellVal(wsC.getRow(3).getCell(2).value) === 'x,y', 'csv→xlsx 数据落表正确');
  ok(wsC.getColumn(1).width === 20, `widths 生效（实得 ${wsC.getColumn(1).width}）`);
  ok(!!wsC.views && wsC.views[0].ySplit === 1, 'freeze:true 生成冻结首行视图');
  ok(wsC.getColumn(2).numFmt === '0.00', `numFmt 按列生效（实得 ${wsC.getColumn(2).numFmt}）`);

  const png = path.join(tmp, 'dot.png');
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  ok(imgDims(png) && imgDims(png).w === 1 && imgDims(png).h === 1, `imgDims 读 PNG 尺寸（实得 ${JSON.stringify(imgDims(png))}）`);
  const styleSpecP = path.join(tmp, 's.json');
  const styleDocx = path.join(tmp, 's.docx');
  fs.writeFileSync(styleSpecP, JSON.stringify({ blocks: [
    { type: 'paragraph', text: '红色加粗斜体', bold: true, italic: true, size: 14, color: 'FF0000', align: 'center' },
    { type: 'pagebreak' },
    { type: 'image', path: png, width: 100 },
  ] }));
  await writeDocx(styleSpecP, styleDocx);
  const JSZip = require('jszip');
  const zx = await JSZip.loadAsync(fs.readFileSync(styleDocx));
  const dxml = await zx.file('word/document.xml').async('string');
  ok(/w:color w:val="FF0000"/.test(dxml), 'docx 颜色写入（w:color=FF0000）');
  ok(/w:sz w:val="28"/.test(dxml), 'docx 字号写入（14 磅 → w:sz=28）');
  ok(/<w:i\/>|<w:i\s/.test(dxml), 'docx 斜体写入（w:i）');
  ok(/w:type="page"/.test(dxml), 'docx 分页写入（w:br type=page）');
  ok(Object.keys(zx.files).some((f) => f.startsWith('word/media/')), 'docx 内嵌图片（word/media/）');

  const mdImg = path.join(tmp, 'img.md');
  const mdImgOut = path.join(tmp, 'img.docx');
  fs.writeFileSync(mdImg, `# 题\n\n![示意](${png.replace(/\\/g, '/')} "120")\n`);
  await writeDocxMd(mdImg, mdImgOut);
  const zx2 = await JSZip.loadAsync(fs.readFileSync(mdImgOut));
  ok(Object.keys(zx2.files).some((f) => f.startsWith('word/media/')), 'md 图片语法转内嵌图片');

  exited = null; process.exit = (code) => { exited = code; throw new Error('__exit__'); };
  try { await readXlsx(xlsxOut, { range: 'ZZ' }); } catch (e) { if (e.message !== '__exit__') throw e; }
  process.exit = realExit; process.exitCode = before;
  ok(exited === EXIT_USAGE, `负对照：非法 --range 退 ${EXIT_USAGE}（实得 ${exited}）`);

  const badImgSpec = path.join(tmp, 'b1.json');
  fs.writeFileSync(badImgSpec, JSON.stringify({ blocks: [{ type: 'image', path: path.join(tmp, '没有.png') }] }));
  exited = null; process.exit = (code) => { exited = code; throw new Error('__exit__'); };
  try { await writeDocx(badImgSpec, path.join(tmp, 'b1.docx')); } catch (e) { if (e.message !== '__exit__') throw e; }
  process.exit = realExit; process.exitCode = before;
  ok(exited === EXIT_USAGE, `负对照：图片不存在退 ${EXIT_USAGE}（实得 ${exited}）`);

  const badCsvSpec = path.join(tmp, 'b2.json');
  fs.writeFileSync(badCsvSpec, JSON.stringify({ sheets: [{ name: 'X', csv: path.join(tmp, '没有.csv') }] }));
  exited = null; process.exit = (code) => { exited = code; throw new Error('__exit__'); };
  try { await writeXlsx(badCsvSpec, path.join(tmp, 'b2.xlsx')); } catch (e) { if (e.message !== '__exit__') throw e; }
  process.exit = realExit; process.exitCode = before;
  ok(exited === EXIT_USAGE, `负对照：CSV 不存在退 ${EXIT_USAGE}（实得 ${exited}）`);

  // 非 zip 头（企业透明加密的文件就是这个形态）→ 给可操作提示，而不是 JSZip 的内部报错
  const fakeXlsx = path.join(tmp, 'fake.xlsx');
  fs.writeFileSync(fakeXlsx, Buffer.from('dd91c8343f0ab7ca', 'hex'));
  const errLines = []; const origErr = console.error;
  console.error = (...a) => errLines.push(a.join(' '));
  exited = null; process.exit = (code) => { exited = code; throw new Error('__exit__'); };
  try { await readXlsx(fakeXlsx, {}); } catch (e) { if (e.message !== '__exit__') { console.error = origErr; throw e; } }
  console.error = origErr; process.exit = realExit; process.exitCode = before;
  ok(exited === EXIT_USAGE && errLines.join('\n').includes('透明加密'), `非 zip 文件头：识别并给加密/旧格式提示，退 ${EXIT_USAGE}（实得 ${exited}）`);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\noffice-docs 自测：${pass + fail} 条，失败 ${fail}`);
  return fail === 0 ? 0 : EXIT_FAIL;
}

// ---------- 入口 ----------

(async () => {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') usage();
  try {
    if (cmd === '--selftest') process.exit(await selftest());
    if (cmd === 'read-xlsx') {
      const file = argv[1]; if (!file) usage('缺少 <file.xlsx>');
      const oi = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
      const lim = Number(oi('--limit'));
      await readXlsx(file, {
        sheet: oi('--sheet'), json: argv.includes('--json'),
        range: oi('--range'), limit: Number.isFinite(lim) && lim > 0 ? lim : 0,
        listSheets: argv.includes('--list-sheets'), formulas: argv.includes('--formulas'),
      });
    } else if (cmd === 'write-xlsx') {
      const spec = argv[1]; if (!spec) usage('缺少 <spec.json>');
      await writeXlsx(spec, outPathOf(argv, 1));
    } else if (cmd === 'set-xlsx') {
      const [file, sheet, addr, value] = argv.slice(1);
      if (!file || !sheet || !addr || value === undefined) usage('缺少 <file.xlsx> <工作表> <单元格> <值>');
      await setXlsx(file, sheet, addr, value);
    } else if (cmd === 'read-docx') {
      const file = argv[1]; if (!file) usage('缺少 <file.docx>');
      await readDocx(file, argv.includes('--json'));
    } else if (cmd === 'write-docx') {
      if (argv[1] === '--md') {
        const md = argv[2]; if (!md) usage('缺少 <md文件|->');
        await writeDocxMd(md, outPathOf(argv, 2));
      } else {
        const spec = argv[1]; if (!spec) usage('缺少 <spec.json>');
        await writeDocx(spec, outPathOf(argv, 1));
      }
    } else usage(`未知子命令 ${cmd}`);
  } catch (e) {
    console.error(`失败: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : e}`);
    process.exit(EXIT_FAIL);
  }
})();
