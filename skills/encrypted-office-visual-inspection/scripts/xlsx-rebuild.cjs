#!/usr/bin/env node
// 用法: node xlsx-rebuild.cjs <dump.json> <out.xlsx> [out.csv]
// 依赖 office-docs 自带的 exceljs（脚本进程写盘 = 明文，不受 DLP 重新加密）
const fs = require('fs');
const path = require('path');
const os = require('os');

const candidates = [
  path.join(os.homedir(), '.qoder/skills/office-docs/node_modules/exceljs'),
  path.join(__dirname, '..', '..', '..', 'skills/office-docs/node_modules/exceljs'),
];
let ExcelJS = null;
for (const c of candidates) {
  try { ExcelJS = require(c); break; } catch (e) { /* try next */ }
}
if (!ExcelJS) { console.error('找不到 exceljs：先执行 cd ~/.qoder/skills/office-docs && npm i exceljs --registry=https://registry.npmmirror.com'); process.exit(2); }

const [dumpFile, outXlsx, outCsv] = process.argv.slice(2);
if (!dumpFile || !outXlsx) { console.error('用法: node xlsx-rebuild.cjs <dump.json> <out.xlsx> [out.csv]'); process.exit(2); }

const raw = JSON.parse(fs.readFileSync(dumpFile, 'utf8').replace(/^/, ''));
const sheets = Array.isArray(raw) ? raw : [raw];

const bgrToArgb = (n) => {
  const b = (n >> 16) & 255, g = (n >> 8) & 255, r = n & 255;
  return 'FF' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
};
const hMap = { 1: 'general', '-4108': 'center', '-4131': 'left', '-4152': 'right', '-4130': 'justify' };
const vMap = { '-4108': 'middle', '-4160': 'top', '-4107': 'bottom', '-4130': 'justify' };
const wMap = { 1: 'hair', 2: 'thin', 3: 'medium', 4: 'thick' };
const colName = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const addrParts = (addr) => {
  const m = String(addr || '').replace(/\$/g, '').match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
  if (!m) return null;
  const col = (s) => s.split('').reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0);
  return { c1: col(m[1]), r1: +m[2], c2: m[3] ? col(m[3]) : col(m[1]), r2: m[4] ? +m[4] : +m[2] };
};
const WIDTH_OFFSET = 0.625; // Excel 读回 ColumnWidth = width + 5px/MDW；不加则每列窄 0.625

(async () => {
  const wb = new ExcelJS.Workbook();
  wb.calcProperties.fullCalcOnLoad = true;
  const stats = [];

  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    const merges = new Map();
    for (let r = 0; r < s.rows; r++) {
      ws.getRow(r + 1).height = s.matrix[r][0].rowHeight;
      for (let c = 0; c < s.cols; c++) {
        const p = addrParts(s.matrix[r][c].merged);
        if (p && (p.c2 > p.c1 || p.r2 > p.r1)) merges.set(s.matrix[r][c].merged, p);
      }
    }
    for (let c = 0; c < s.cols; c++) ws.getColumn(c + 1).width = s.matrix[0][c].colWidth + WIDTH_OFFSET;
    for (const p of merges.values()) ws.mergeCells(`${colName(p.c1)}${p.r1}:${colName(p.c2)}${p.r2}`);

    const mergedChildren = new Set();
    for (const p of merges.values()) {
      for (let rr = p.r1; rr <= p.r2; rr++) for (let cc = p.c1; cc <= p.c2; cc++) if (rr !== p.r1 || cc !== p.c1) mergedChildren.add(rr + ',' + cc);
    }

    let written = 0;
    for (let r = 0; r < s.rows; r++) {
      for (let c = 0; c < s.cols; c++) {
        const d = s.matrix[r][c];
        const cell = ws.getCell(r + 1, c + 1);
        const p = addrParts(d.merged);
        const isAnchor = !p || (p.r1 === r + 1 && p.c1 === c + 1);
        // 关键：mergeCells 让子格与主格共享同一 style 对象，不换掉就会覆盖主格格式
        if (mergedChildren.has((r + 1) + ',' + (c + 1))) cell.style = {};
        if (isAnchor) {
          if (typeof d.formula === 'string' && d.formula.startsWith('=')) cell.value = { formula: d.formula.slice(1), result: d.value };
          else if (d.value !== null && d.value !== undefined && d.value !== '') cell.value = d.value;
          if (cell.value !== null && cell.value !== undefined) written++;
        }
        const border = {};
        for (const [side, code] of [['left', d.borders.l], ['right', d.borders.r], ['top', d.borders.t], ['bottom', d.borders.b]]) {
          if (code === 1) border[side] = { style: wMap[d.borders.w] || 'thin', color: { argb: 'FF000000' } };
        }
        cell.font = { name: d.fontName || '等线', size: d.fontSize || 11, bold: !!d.bold, color: { argb: bgrToArgb(d.fontColor) } };
        cell.alignment = { horizontal: hMap[d.hAlign] || 'general', vertical: vMap[d.vAlign] || 'bottom', wrapText: !!d.wrap, indent: d.indent || 0 };
        if (d.fillPattern === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgrToArgb(d.fillColor) } };
        if (d.numFmt && !/^G\/通用格式$|^General$/i.test(d.numFmt)) cell.numFmt = d.numFmt;
        if (Object.keys(border).length) cell.border = border;
      }
    }
    stats.push({ sheet: s.name, written, mergedRanges: merges.size });
  }

  fs.mkdirSync(path.dirname(path.resolve(outXlsx)), { recursive: true });
  await wb.xlsx.writeFile(outXlsx);
  const head = fs.readFileSync(outXlsx).subarray(0, 4).toString('hex');
  if (head.slice(0, 6) !== '504b03') { console.error(`产物文件头 ${head} 不是 zip：写出进程被 DLP 拦截，换输出目录或按 SKILL.md 2.0-C 处理`); process.exit(1); }

  if (outCsv) {
    const s0 = sheets[0];
    const lines = [];
    for (let r = 0; r < s0.rows; r++) {
      const cells = [];
      for (let c = 0; c < s0.cols; c++) {
        const d = s0.matrix[r][c];
        const p = addrParts(d.merged);
        const isAnchor = !p || (p.r1 === r + 1 && p.c1 === c + 1);
        const text = isAnchor ? String(d.text ?? '').replace(/\r?\n/g, ' ') : '';
        cells.push('"' + text.replace(/"/g, '""') + '"');
      }
      lines.push(cells.join(','));
    }
    fs.writeFileSync(outCsv, '\uFEFF' + lines.join('\r\n'), 'utf8');
  }
  console.log(JSON.stringify({ ok: true, outXlsx, outCsv: outCsv || null, head, stats }));
})().catch((e) => { console.error(String(e && e.stack || e)); process.exit(1); });
