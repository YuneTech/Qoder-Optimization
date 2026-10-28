#!/usr/bin/env node
// office-styles.js —— 让 office-docs 生成的 Word **默认就好看**：主题化排版 + 目录域 + 页码。
//
// 为什么不塞进 office.js：那边在演进，样式层单独一个文件，互不覆盖；两边共用技能内 node_modules。
//
// 用法：
//   node office-styles.js themes                     列出主题与参数
//   node office-styles.js render --md <文件|-> -o <out.docx> [--theme gongwen|business|minimal]
//                                                    [--no-toc] [--title <文档标题>] [--author <名>]
//   node office-styles.js render --md <文件|-> -o <out.docx> --theme-json <theme.json>
//                                                    用提取出来的主题渲染（优先级高于 --theme）
//   node office-styles.js extract-theme --from <图片> [--name mybrand] [-o theme.json] [--verbose]
//                                                    从截图 / 品牌图 / LOGO 量化主色板 → 产出可直接喂给 render 的主题
//   node office-styles.js --selftest                 自测（写出去再读回来对得上）
// 退出码：0 成功 / 1 运行失败 / 2 用法或前置错误（图片不可解码、色板不足、theme.json 不合法）
//
// 目录说明：写进 docx 的是 **TOC 域**（Word / WPS 打开后按 F9 或"更新目录"生成页码），
// 这是 OOXML 的固有机制——没有哪个生成器能离线算出准确页码。标题一律用真正的
// HeadingLevel，所以目录能自动收录，正文里也不会出现"手打的目录"那份第二真相。
'use strict';
const fs = require('fs');
const path = require('path');

const EXIT_USAGE = 2, EXIT_FAIL = 1;
const CM = 567;                       // 1 cm = 567 twips（docx 页边距单位）
const PT2TW = 20;                     // 1 磅 = 20 twips

// ---------- 主题（排版参数有出处，不凭感觉填） ----------
// gongwen：GB/T 9704-2012《党政机关公文格式》——A4 上 3.7 / 下 3.5 / 左 2.8 / 右 2.6 cm，
//          正文 3 号（16pt）仿宋，行距 30 磅，标题序号「一、/（一）/1.」。
// business / minimal：通用办公与文档站习惯值（Word 默认边距 2.54/3.18 cm、1.5 倍行距）。
const THEMES = {
  gongwen: {
    label: '公文风（GB/T 9704-2012）',
    margin: { top: Math.round(3.7 * CM), bottom: Math.round(3.5 * CM), left: Math.round(2.8 * CM), right: Math.round(2.6 * CM) },
    body: { font: '仿宋', size: 16, line: Math.round(30 * PT2TW), lineRule: 'exact', firstLineChars: 200 },
    title: { font: '方正小标宋简体', size: 22, align: 'center', after: 320 },
    headings: [
      { font: '黑体', size: 16 },
      { font: '楷体', size: 16 },
      { font: '仿宋', size: 16, bold: true },
    ],
    table: { headerFill: 'E8EDF3', headerColor: '1F3864', zebra: 'F5F7FA', border: '9AA7B4' },
    numbering: ['一、', '（一）', '1.', '（1）'],
    tocTitle: '目　录',
  },
  business: {
    label: '商务蓝（汇报 / 方案 / 手册）',
    margin: { top: Math.round(2.54 * CM), bottom: Math.round(2.54 * CM), left: Math.round(3.18 * CM), right: Math.round(3.18 * CM) },
    body: { font: '等线', size: 11, line: 360, lineRule: 'auto', after: 140 },
    title: { font: '微软雅黑', size: 26, align: 'center', color: '1F4E79', after: 200 },
    headings: [
      { font: '微软雅黑', size: 18, color: '1F4E79', before: 320, after: 140 },
      { font: '微软雅黑', size: 14, color: '2E75B6', before: 240, after: 100 },
      { font: '微软雅黑', size: 12, color: '404040', before: 200, after: 80 },
    ],
    table: { headerFill: '1F4E79', headerColor: 'FFFFFF', zebra: 'F2F6FA', border: 'BFCEDD' },
    numbering: null,
    tocTitle: '目录',
  },
  minimal: {
    label: '极简（说明书 / 长文阅读）',
    margin: { top: Math.round(2.5 * CM), bottom: Math.round(2.5 * CM), left: Math.round(2.5 * CM), right: Math.round(2.5 * CM) },
    body: { font: '等线', size: 11, line: 330, lineRule: 'auto', after: 160 },
    title: { font: '等线', size: 24, align: 'left', color: '111111', after: 200 },
    headings: [
      { font: '等线', size: 17, color: '111111', before: 300, after: 120 },
      { font: '等线', size: 13.5, color: '333333', before: 220, after: 90 },
      { font: '等线', size: 12, color: '555555', before: 180, after: 70 },
    ],
    table: { headerFill: 'F2F2F2', headerColor: '111111', zebra: null, border: 'DDDDDD' },
    numbering: null,
    tocTitle: '目录',
  },
};

function need(mod) {
  try { return require(mod); } catch (e) {
    console.error(`缺少依赖 ${mod}。在本技能目录一次装齐五个依赖：`);
    console.error(`  cd "${path.resolve(__dirname, '..')}" && npm i exceljs docx jszip fast-xml-parser jimp --registry=https://registry.npmmirror.com`);
    process.exit(EXIT_USAGE);
  }
}

function usage(msg) {
  if (msg) console.error('错误: ' + msg);
  console.error('用法: node office-styles.js themes | render --md <文件|-> -o <out.docx> [--theme x | --theme-json f.json] [--no-toc] | extract-theme --from <图片> [-o theme.json] | --selftest');
  process.exit(EXIT_USAGE);
}

// ---------- Markdown → 块（只认文档真正常用的结构） ----------
function parseMarkdown(md) {
  const blocks = [];
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) continue;
    let m;
    if ((m = t.match(/^(#{1,6})\s+(.*)$/))) { blocks.push({ type: 'heading', level: Math.min(m[1].length, 3), text: m[2].trim() }); continue; }
    if ((m = t.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/))) {
      blocks.push({ type: 'image', src: m[2], alt: m[1] || '', width: m[3] ? Number(m[3]) || undefined : undefined }); continue;
    }
    if (t.startsWith('|') && t.endsWith('|')) {
      const rows = [];
      for (let j = i; j < lines.length; j += 1) {
        const r = lines[j].trim();
        if (!r.startsWith('|')) break;
        if (/^\|[\s:|-]+\|$/.test(r)) continue;                 // 分隔行
        rows.push(r.slice(1, -1).split('|').map((c) => c.trim()));
      }
      if (rows.length) blocks.push({ type: 'table', rows });
      i += (lines.slice(i).findIndex((l) => !l.trim().startsWith('|')) < 0 ? lines.length : lines.slice(i).findIndex((l) => !l.trim().startsWith('|'))) - 1;
      continue;
    }
    if ((m = t.match(/^[-*]\s+(.*)$/))) { blocks.push({ type: 'bullet', text: m[1] }); continue; }
    if ((m = t.match(/^\d+[.)]\s+(.*)$/))) { blocks.push({ type: 'numbered', text: m[1] }); continue; }
    if (/^(---|\*\*\*|___)$/.test(t)) { blocks.push({ type: 'divider' }); continue; }
    blocks.push({ type: 'paragraph', text: t });
  }
  return blocks;
}

// 行内 **粗体** / `代码` 拆成 TextRun（只处理这两种，够用且不误伤）
function runs(D, text, base) {
  const out = [];
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((s) => s !== '');
  for (const p of parts) {
    const bold = /^\*\*[^*]+\*\*$/.test(p), code = /^`[^`]+`$/.test(p);
    const txt = bold || code ? p.slice(2, -2) : p;
    const run = { text: txt, ...(base || {}) };
    if (bold) run.bold = true;
    if (code) run.font = 'Consolas';
    out.push(new D.TextRun(run));
  }
  return out.length ? out : [new D.TextRun({ text: '', ...(base || {}) })];
}

function render(mdText, opts) {
  const D = need('docx');
  const th = resolveTheme(opts);
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
    WidthType, AlignmentType, BorderStyle, TableOfContents, Header, Footer, PageNumber, ImageRun } = D;

  const blocks = opts.blocks || parseMarkdown(mdText);
  const align = (a) => (a === 'center' ? AlignmentType.CENTER : a === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT);
  const children = [];

  if (opts.title) {
    children.push(new Paragraph({
      alignment: align(th.title.align), spacing: { after: th.title.after },
      children: [new TextRun({ text: opts.title, bold: true, size: th.title.size * 2, font: th.title.font, color: th.title.color })],
    }));
  }

  if (opts.toc) {
    children.push(new Paragraph({
      spacing: { before: 200, after: 120 },
      children: [new TextRun({ text: th.tocTitle, bold: true, size: (th.headings[0].size || 16) * 2, font: th.headings[0].font, color: th.headings[0].color })],
    }));
    // 目录域：Word / WPS 打开后"更新目录"才会填页码（离线无人能算准页码，这是 OOXML 机制）
    children.push(new TableOfContents(th.tocTitle, { hyperlink: true, headingStyleRange: '1-3' }));
    children.push(new Paragraph({ pageBreakBefore: true, children: [new TextRun('')] }));
  }

  let hIdx = 0;
  for (const b of blocks) {
    if (b.type === 'heading') {
      const lv = Math.max(1, Math.min(3, b.level || 1));
      const hs = th.headings[lv - 1] || th.headings[th.headings.length - 1];
      const HL = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][lv - 1];
      let text = b.text;
      if (th.numbering) { text = (th.numbering[lv - 1] || '') + text.replace(/^(?:（[一二三四五六七八九十]+）|[一二三四五六七八九十]+、|\d+[.、])\s*/, ''); hIdx += 1; }
      children.push(new Paragraph({
        heading: HL, pageBreakBefore: lv === 1 && !!opts.chapterBreak && hIdx > 1,
        spacing: { before: hs.before || 240, after: hs.after || 120, line: th.body.line, lineRule: th.body.lineRule },
        children: [new TextRun({ text, bold: hs.bold !== false, size: hs.size * 2, font: hs.font, color: hs.color })],
      }));
      continue;
    }
    if (b.type === 'paragraph') {
      children.push(new Paragraph({
        alignment: b.align ? align(b.align) : undefined,
        indent: th.body.firstLineChars ? { firstLineChars: th.body.firstLineChars } : undefined,
        spacing: { line: th.body.line, lineRule: th.body.lineRule, after: th.body.after || 0 },
        children: runs(D, b.text, { size: th.body.size * 2, font: th.body.font, color: th.body.color }),
      }));
      continue;
    }
    if (b.type === 'bullet' || b.type === 'numbered') {
      children.push(new Paragraph({
        bullet: b.type === 'bullet' ? { level: 0 } : undefined,
        numbering: b.type === 'numbered' ? { reference: 'os-num', level: 0 } : undefined,
        spacing: { line: th.body.line, lineRule: th.body.lineRule },
        children: runs(D, b.text, { size: th.body.size * 2, font: th.body.font, color: th.body.color }),
      }));
      continue;
    }
    if (b.type === 'divider') {
      children.push(new Paragraph({
        spacing: { before: 120, after: 120 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: th.table.border, space: 1 } },
        children: [new TextRun('')],
      }));
      continue;
    }
    if (b.type === 'image') {
      let data = null;
      try { data = fs.readFileSync(b.src); } catch (e) {
        children.push(new Paragraph({ children: [new TextRun({ text: `[图片缺失：${b.src}]`, italics: true, color: 'C00000' })] }));
        continue;
      }
      const ext = path.extname(b.src).toLowerCase();
      const type = ext === '.png' ? 'png' : ext === '.gif' ? 'gif' : ext === '.bmp' ? 'bmp' : 'jpg';
      const w = b.width || 480, h = Math.round(w * 0.62);
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 },
        children: [new ImageRun({ type, data, transformation: { width: w, height: h } })],
      }));
      if (b.alt) children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: b.alt, italics: true, size: (th.body.size - 1) * 2, color: '595959' })] }));
      continue;
    }
    if (b.type === 'table' && b.rows && b.rows.length) {
      const cols = Math.max(...b.rows.map((r) => r.length));
      const bd = { style: BorderStyle.SINGLE, size: 4, color: th.table.border };
      const rows = b.rows.map((r, ri) => new TableRow({
        tableHeader: ri === 0,
        children: Array.from({ length: cols }, (_, ci) => new TableCell({
          width: { size: Math.floor(100 / cols), type: WidthType.PERCENTAGE },
          shading: ri === 0 ? { fill: th.table.headerFill } : (th.table.zebra && ri % 2 === 0 ? { fill: th.table.zebra } : undefined),
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          borders: { top: bd, bottom: bd, left: bd, right: bd },
          children: [new Paragraph({
            alignment: ri === 0 ? AlignmentType.CENTER : undefined,
            spacing: { line: th.body.line, lineRule: th.body.lineRule },
            children: runs(D, r[ci] == null ? '' : r[ci], ri === 0
              ? { bold: true, size: th.body.size * 2, font: th.body.font, color: th.table.headerColor }
              : { size: th.body.size * 2, font: th.body.font, color: th.body.color }),
          })],
        })),
      }));
      children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun('')] }));
      continue;
    }
  }

  const doc = new Document({
    creator: opts.author || 'office-styles',
    title: opts.title || undefined,
    numbering: { config: [{ reference: 'os-num', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.LEFT }] }] },
    styles: {
      default: { document: { run: { size: th.body.size * 2, font: th.body.font } } },
      paragraphStyles: th.headings.map((hs, i) => ({
        id: `Heading${i + 1}`, name: `Heading ${i + 1}`, basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: hs.size * 2, bold: true, font: hs.font, color: hs.color },
        paragraph: { spacing: { before: hs.before || 240, after: hs.after || 120 }, outlineLevel: i },
      })),
    },
    sections: [{
      properties: { page: { margin: th.margin } },
      headers: opts.headerText ? { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: opts.headerText, size: 18, color: '808080', font: th.body.font })] })] }) } : undefined,
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ children: ['第 ', PageNumber.CURRENT, ' 页 / 共 ', PageNumber.TOTAL_PAGES, ' 页'], size: 18, font: th.body.font, color: '595959' })],
          })],
        }),
      },
      children,
    }],
  });
  return { doc, D, theme: th, blocks };
}

async function writeOut(outFile, mdPath, opts) {
  let mdText = '';
  if (mdPath === '-' || mdPath == null) { mdText = fs.readFileSync(0, 'utf8'); }
  else if (/[\r\n]/.test(mdPath)) { mdText = mdPath; }             // 调用方直接给内容（自测 / 程序化调用）
  else { if (!fs.existsSync(mdPath)) usage(`md 源不存在：${mdPath}`); mdText = fs.readFileSync(mdPath, 'utf8'); }
  if (!mdText.trim()) usage('md 源为空');
  const { doc, D } = render(mdText, opts);
  const buf = await D.Packer.toBuffer(doc);
  fs.writeFileSync(outFile, buf);
  const label = opts.themeObj ? `自定义 theme-json` : `主题 ${opts.theme}`;
  console.log(`已生成 ${outFile}（${(buf.length / 1024).toFixed(1)} KB，${label}，目录 ${opts.toc ? '有（打开后 F9 更新页码）' : '无'}）`);
}

function listThemes() {
  console.log('可用主题（--theme 取键名）：');
  for (const [k, t] of Object.entries(THEMES)) {
    const m = t.margin;
    console.log(`  ${k.padEnd(9)} ${t.label}`);
    console.log(`            边距 上${(m.top / CM).toFixed(1)}/下${(m.bottom / CM).toFixed(1)}/左${(m.left / CM).toFixed(1)}/右${(m.right / CM).toFixed(1)} cm · 正文 ${t.body.font} ${t.body.size}pt · 行距 ${t.body.lineRule === 'exact' ? (t.body.line / PT2TW) + ' 磅固定' : (t.body.line / 240).toFixed(2) + ' 倍'}`);
  }
}

// ---------- 颜色 / 对比度工具（WCAG 2.1） ----------
// 色值一律用 6 位 hex —— docx 的 w:val / w:fill 就是这个形状，省掉一次转换也少出错。
// 阈值有出处：WCAG 2.1 AA，普通文字 4.5:1，大字（≥18pt 或 ≥14pt 粗体）3:1。
const AA_NORMAL = 4.5, AA_LARGE = 3.0;
const PAGE = 'FFFFFF';              // 主题不设页面背景，所以文字色必须对白底成立（docx 默认纸色）
class PreconditionError extends Error {
  constructor(msg) { super(msg); this.name = 'PreconditionError'; this.exitCode = EXIT_USAGE; }
}
function hexToRgb(hex) {
  const s = String(hex).replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new PreconditionError(`色值需是 6 位 hex（如 1F4E79）：${hex}`);
  return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
}
const hx = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
const rgbToHex = (c) => (hx(c.r) + hx(c.g) + hx(c.b)).toUpperCase();
function mix(a, b, t) {
  const x = hexToRgb(a), y = hexToRgb(b), k = Math.max(0, Math.min(1, t));
  return rgbToHex({ r: x.r + (y.r - x.r) * k, g: x.g + (y.g - x.g) * k, b: x.b + (y.b - x.b) * k });
}
const tint = (c, amt) => mix(c, 'FFFFFF', amt);          // 同色系提亮（往白里走）
const shade = (c, amt) => mix(c, '000000', amt);         // 同色系压暗（往黑里走）
function colorDist(a, b) {
  const x = typeof a === 'string' ? hexToRgb(a) : a, y = typeof b === 'string' ? hexToRgb(b) : b;
  return Math.sqrt((x.r - y.r) ** 2 + (x.g - y.g) ** 2 + (x.b - y.b) ** 2);
}
function relLum(hex) {
  const c = hexToRgb(hex);
  const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}
function contrast(a, b) {
  const l1 = relLum(a), l2 = relLum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function chromaOf(hex) { const c = hexToRgb(hex); const v = [c.r, c.g, c.b]; return (Math.max(...v) - Math.min(...v)) / 255; }
function hslOf(hex) {
  const c = hexToRgb(hex); const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0); else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}
function hexOfHsl(h, s, l) {
  const hp = ((((h % 360) + 360) % 360)) / 60;
  const i = Math.min(5, Math.floor(hp));
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((hp % 2) - 1)), m = l - c / 2;
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][i];
  return rgbToHex({ r: (seg[0] + m) * 255, g: (seg[1] + m) * 255, b: (seg[2] + m) * 255 });
}
const hueOf = (hex) => hslOf(hex).h;
const desat = (hex, maxS) => { const c = hslOf(hex); return hexOfHsl(c.h, Math.min(c.s, maxS), c.l); };

// 文字色不够就跑：往「两端里对比更高的那一端」加减明度（浅底→压暗文字，深底→提亮文字），保持色相不变。
// 不能按"比背景亮就压暗"判：白字配浅灰底时文字本就比底亮，往白推只会一路走到 1:1。
function ensureContrast(fg, bg, min) {
  const need0 = min || AA_NORMAL;
  const first = contrast(fg, bg);
  if (first >= need0) return { color: fg, ratio: first, adjusted: false };
  const toward = contrast('000000', bg) >= contrast('FFFFFF', bg) ? '000000' : 'FFFFFF';
  for (let i = 1; i <= 100; i += 1) {
    const c = mix(fg, toward, i / 100);
    if (contrast(c, bg) >= need0) return { color: c, ratio: contrast(c, bg), adjusted: true };
  }
  return { color: toward, ratio: contrast(toward, bg), adjusted: true };
}
// 表头这种「底色已定、字要看得见」的成对决定：先挑白/深黑里对比更高的一侧，
// 两边都不达 AA 时**改底纹明度**（改文字到不了 21:1，中灰底就是死区），仍留在同色系。
function ensurePair(fill, min) {
  const need0 = min || AA_NORMAL;
  const wr = contrast('FFFFFF', fill), dr = contrast('1A1A1A', fill);
  const useWhite = wr >= dr;
  const text = useWhite ? 'FFFFFF' : '1A1A1A';
  if (Math.max(wr, dr) >= need0) return { fill, text, ratio: Math.max(wr, dr), adjusted: false };
  const toward = useWhite ? '000000' : 'FFFFFF';
  for (let i = 1; i <= 100; i += 1) {
    const f = mix(fill, toward, i / 100);
    if (contrast(text, f) >= need0) return { fill: f, text, ratio: contrast(text, f), adjusted: true };
  }
  return { fill: toward, text, ratio: contrast(text, toward), adjusted: true };
}

// ---------- 从图片提取主题 ----------
// 合并阈值 RGB 距离 45：JPEG 压缩噪声一般在十几到二十几，45 能把同色不同噪声并成一个、又不吃掉邻近色相。
const MERGE_DIST = 45, BG_SEP_DIST = 50, MIN_SHARE = 0.004, CHROMA_KEEP = 0.12, SAMPLE_CAP = 200000;
const IMG_MAGIC = [
  [Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'png'], [Buffer.from([0xff, 0xd8, 0xff]), 'jpeg'],
  [Buffer.from('GIF8'), 'gif'], [Buffer.from('BM'), 'bmp'],
  [Buffer.from([0x49, 0x49, 0x2a, 0x00]), 'tiff'], [Buffer.from([0x4d, 0x4d, 0x00, 0x2a]), 'tiff'],
];

async function decodeImage(file) {
  if (!fs.existsSync(file)) throw new PreconditionError(`图片不存在：${file}`);
  const buf = fs.readFileSync(file);
  if (buf.length < 8) throw new PreconditionError(`文件太小、不像是图片（${buf.length} 字节）：${file}`);
  const magic = IMG_MAGIC.find(([sig]) => buf.slice(0, sig.length).equals(sig));
  // webp 的 RIFF 头要再看第 9-12 字节是不是 WEBP
  const isWebp = buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP';
  if (!magic && !isWebp) {
    throw new PreconditionError(`文件头不是 png / jpeg / gif / bmp / tiff / webp，多半不是图片：${file}（前 4 字节 ${buf.slice(0, 4).toString('hex')}）`);
  }
  const { Jimp } = need('jimp');
  let img;
  try { img = await Jimp.fromBuffer(buf); } catch (e) {
    throw new PreconditionError(`图片解码失败：${file} —— ${String((e && e.message) || e).slice(0, 120) || '格式可能不受支持或文件已损坏'}`);
  }
  return { width: img.bitmap.width, height: img.bitmap.height, data: img.bitmap.data };
}

// 量化：每通道降 4 bit 分桶 → 按覆盖排序 → 贪心合并近邻桶。纯 JS、无外部依赖。
function quantize(data, width, height) {
  const n = width * height;
  const stride = Math.max(1, Math.ceil(n / SAMPLE_CAP));
  const buckets = new Map();
  let sampled = 0, opaque = 0;
  for (let p = 0; p < n; p += stride) {
    sampled += 1;
    const o = p * 4;
    if (data[o + 3] < 128) continue;                       // 透明像素不参与取色
    opaque += 1;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const cur = buckets.get(key);
    if (cur) { cur.c += 1; cur.rs += r; cur.gs += g; cur.bs += b; } else buckets.set(key, { c: 1, rs: r, gs: g, bs: b });
  }
  if (opaque < 32) {
    throw new PreconditionError(`没有可用像素（采样 ${sampled} 个，其中不透明 ${opaque} 个）——全透明 PNG 或空遮罩取不出色板，换一张有内容的截图 / LOGO`);
  }
  const list = [...buckets.values()].map((v) => ({ c: v.c, r: v.rs / v.c, g: v.gs / v.c, b: v.bs / v.c }))
    .sort((a, b) => b.c - a.c).slice(0, 512);
  const taken = new Array(list.length).fill(false);
  const clusters = [];
  for (let i = 0; i < list.length; i += 1) {
    if (taken[i]) continue;
    taken[i] = true;
    let cnt = list[i].c, sr = list[i].r * cnt, sg = list[i].g * cnt, sb = list[i].b * cnt;
    for (let j = i + 1; j < list.length; j += 1) {
      if (taken[j]) continue;
      if (colorDist({ r: sr / cnt, g: sg / cnt, b: sb / cnt }, list[j]) > MERGE_DIST) continue;
      taken[j] = true;
      cnt += list[j].c; sr += list[j].r * list[j].c; sg += list[j].g * list[j].c; sb += list[j].b * list[j].c;
    }
    const hex = rgbToHex({ r: sr / cnt, g: sg / cnt, b: sb / cnt });
    clusters.push({ hex, count: cnt, share: cnt / opaque, chroma: chromaOf(hex), lum: relLum(hex) });
  }
  clusters.sort((a, b) => b.count - a.count);
  return { clusters, opaque, sampled };
}

// 色板角色：背景＝覆盖最大的色；主色／辅色／强调色＝与背景拉开、有彩度优先；文字色＝最深的可用色。
function extractPalette(file) {
  return decodeImage(file).then(({ width, height, data }) => {
    if (width < 8 || height < 8) {
      throw new PreconditionError(`图片过小（${width}×${height}），取不到可靠色板：至少 8×8，建议用 ≥64×64 的截图或 LOGO`);
    }
    const { clusters, opaque, sampled } = quantize(data, width, height);
    const usable = clusters.filter((c) => c.share >= MIN_SHARE);
    if (usable.length < 2) {
      throw new PreconditionError(`只分辨出 ${usable.length} 个颜色（合并阈值 RGB ${MERGE_DIST}）——纯色 / 单色渐变图提取不出主题，请给含主色块 + 强调色的截图或 LOGO`);
    }
    const background = usable[0];
    const content = usable.filter((c) => colorDist(c.hex, background.hex) >= BG_SEP_DIST);
    if (!content.length) {
      throw new PreconditionError(`除背景色外没有第 2 个颜色（背景 ${background.hex} 占 ${(background.share * 100).toFixed(1)}%）——换一张有色块 / 图标 / 品牌强调色的图`);
    }
    const chromatic = content.filter((c) => c.chroma >= CHROMA_KEEP);
    const pool = chromatic.length ? chromatic : content;
    const primary = pool[0];
    const rest = pool.slice(1);
    const ranked = rest.slice().sort((a, b) => b.chroma * Math.sqrt(b.count) - a.chroma * Math.sqrt(a.count));
    const accent = ranked[0] || null;
    const secondary = ranked[1] || (accent ? null : rest[0] || null);
    const text = usable.slice().sort((a, b) => a.lum - b.lum)[0];
    return { width, height, opaque, sampled, clusters: usable, background, primary, secondary, accent, text };
  });
}

// 由色板拼主题：结构 = THEMES 条目（business 的排版骨架 + 图里来的颜色），可直接喂 render。
// 派生只做同色系加减明度（zebra / border 用 tint(primary)），不引入图里没有的第三种色相。
function buildThemeFromPalette(name, pal) {
  const th = JSON.parse(JSON.stringify(THEMES.business));
  th.label = `自定义 · ${name}`;
  const fixes = [];
  const primaryHex = pal.primary.hex;
  const pair = ensurePair(primaryHex, AA_NORMAL);
  if (pair.adjusted) fixes.push(`表头底纹 ${primaryHex} 与白字/深字都不足 ${AA_NORMAL}:1，同色系压到 ${pair.fill}（${pair.ratio.toFixed(2)}:1）`);
  th.table.headerFill = pair.fill;
  th.table.headerColor = pair.text;
  th.table.zebra = tint(primaryHex, 0.94);
  th.table.border = tint(primaryHex, 0.70);
  const h1 = ensureContrast(primaryHex, PAGE, AA_NORMAL);
  if (h1.adjusted) fixes.push(`主色 ${primaryHex} 做标题对白底不足 ${AA_NORMAL}:1，压深到 ${h1.color}（${h1.ratio.toFixed(2)}:1）`);
  th.title.color = h1.color;
  th.headings[0].color = h1.color;
  const h2src = pal.accent ? pal.accent.hex : shade(primaryHex, 0.18);
  const h2 = ensureContrast(h2src, PAGE, AA_NORMAL);
  if (h2.adjusted) fixes.push(`强调色 ${h2src} 做二级标题对白底不足 ${AA_NORMAL}:1，调到 ${h2.color}（${h2.ratio.toFixed(2)}:1）`);
  th.headings[1].color = h2.color;
  const h3 = ensureContrast(tint(desat(h1.color, 0.12), 0.22), PAGE, AA_LARGE);
  th.headings[2].color = h3.color;
  const bodyC = ensureContrast(desat(pal.text.hex, 0.10), PAGE, AA_NORMAL);
  if (bodyC.adjusted) fixes.push(`文字色 ${pal.text.hex} 对白底不足 ${AA_NORMAL}:1，压到 ${bodyC.color}（${bodyC.ratio.toFixed(2)}:1）`);
  th.body.color = bodyC.color;
  th.meta = {
    kind: 'extracted',
    source: path.basename(String(pal.source || '')),
    imageSize: [pal.width, pal.height],
    sampledPixels: pal.sampled,
    opaquePixels: pal.opaque,
    palette: {
      primary: primaryHex,
      secondary: pal.secondary ? pal.secondary.hex : null,
      accent: accentSource(pal),
      background: pal.background.hex,
      text: pal.text.hex,
    },
    coverage: {
      primary: Number(pal.primary.share.toFixed(4)),
      background: Number(pal.background.share.toFixed(4)),
      accent: pal.accent ? Number(pal.accent.share.toFixed(4)) : null,
    },
    derived: { headerFill: th.table.headerFill, headerColor: th.table.headerColor, zebra: th.table.zebra, border: th.table.border },
    contrast: {
      header: Number(contrast(th.table.headerColor, th.table.headerFill).toFixed(2)),
      titleOnPage: Number(contrast(th.title.color, PAGE).toFixed(2)),
      bodyOnPage: Number(contrast(th.body.color, PAGE).toFixed(2)),
    },
    readabilityFixes: fixes,
  };
  return { theme: th, fixes };
}
const accentSource = (pal) => (pal.accent ? pal.accent.hex : (pal.secondary ? pal.secondary.hex : null));

function paletteReport(pal, th) {
  const L = [];
  L.push(`色板（采样 ${pal.sampled} 像素 / 不透明 ${pal.opaque}，${pal.width}×${pal.height}，合并阈值 RGB ${MERGE_DIST}）：`);
  for (const c of pal.clusters.slice(0, 8)) {
    L.push(`  ${c.hex}  覆盖 ${(c.share * 100).toFixed(1).padStart(5)}%  彩度 ${c.chroma.toFixed(2)}  亮度 ${c.lum.toFixed(2)}`);
  }
  L.push(`角色：背景 ${pal.background.hex} · 主色 ${pal.primary.hex} · 强调 ${accentSource(pal) || '(图里没有第二种彩度色，按同色系派生)'} · 文字 ${pal.text.hex}`);
  L.push(`表头 ${th.table.headerFill} 上放 ${th.table.headerColor} → ${contrast(th.table.headerColor, th.table.headerFill).toFixed(2)}:1（AA ${AA_NORMAL}:1 ${contrast(th.table.headerColor, th.table.headerFill) >= AA_NORMAL ? '达标' : '不达标'}）`);
  L.push(`正文 ${th.body.color} 上白底 → ${contrast(th.body.color, PAGE).toFixed(2)}:1 · 标题 ${th.title.color} → ${contrast(th.title.color, PAGE).toFixed(2)}:1`);
  return L.join('\n');
}

// ---------- theme JSON 的装载与校验（手写或 extract-theme 产出都走这里） ----------
const THEME_COLOR_PATHS = [['table', 'headerFill'], ['table', 'headerColor'], ['table', 'zebra'], ['table', 'border'],
  ['title', 'color'], ['body', 'color'], ['headings', '0', 'color'], ['headings', '1', 'color'], ['headings', '2', 'color']];
function pick(obj, p) { return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function validateThemeShape(obj, where) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) usage(`${where} 需是一个 JSON 对象`);
  const known = ['label', 'margin', 'body', 'title', 'headings', 'table', 'numbering', 'tocTitle', 'meta'];
  if (!Object.keys(obj).some((k) => known.includes(k))) {
    usage(`${where} 里没有任何可识别的样式字段（${known.filter((k) => k !== 'meta').join(' / ')}）——是不是把别的 JSON 当主题传进来了？`);
  }
  for (const p of THEME_COLOR_PATHS) {
    const v = pick(obj, p.join('.'));
    if (v === undefined || v === null) continue;
    if (!/^(#[0-9a-fA-F]{6}|[0-9a-fA-F]{6})$/.test(String(v))) {
      usage(`${where} 的 ${p.join('.')} 不是 6 位 hex 色值：${JSON.stringify(v)}（写成 "1F4E79" 这种）`);
    }
  }
  for (const p of [['body', 'size'], ['title', 'size'], ['headings.0.size'], ['margin', 'top']]) {
    const v = pick(obj, p.join('.'));
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) usage(`${where} 的 ${p.join('.')} 需是正数，收到 ${JSON.stringify(v)}`);
  }
}
// 深合并到 business 骨架上：只写颜色的半成品主题也能跑，且不会污染 THEMES 里的内置项。
function mergeTheme(obj) {
  validateThemeShape(obj, '--theme-json');
  const base = JSON.parse(JSON.stringify(THEMES.business));
  const deep = (dst, src) => {
    for (const [k, v] of Object.entries(src)) {
      if (k === 'meta') continue;
      if (Array.isArray(v)) dst[k] = JSON.parse(JSON.stringify(v));
      else if (v && typeof v === 'object') { if (!dst[k] || typeof dst[k] !== 'object' || Array.isArray(dst[k])) dst[k] = {}; deep(dst[k], v); }
      else if (v !== undefined) dst[k] = v;
    }
  };
  const src = { ...obj };
  if (Array.isArray(src.headings)) {
    const hs = src.headings.slice(0, 3).map((h, i) => ({ ...(base.headings[i] || {}), ...(h || {}) }));
    while (hs.length < 3) hs.push({ ...base.headings[hs.length] });
    src.headings = hs;
  }
  deep(base, src);
  if (!Array.isArray(base.headings) || base.headings.length !== 3) {
    usage('--theme-json 的 headings 需是 1-3 项数组（渲染按三级取样式）');
  }
  return base;
}
// 只读 + 校验；合并留给 resolveTheme，避免"合并完再合并"。
function loadThemeJson(p) {
  if (!fs.existsSync(p)) usage(`--theme-json 文件不存在：${p}`);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (e) {
    usage(`--theme-json 不是合法 JSON：${p} —— ${String((e && e.message) || e).slice(0, 100)}`);
  }
  validateThemeShape(raw, `--theme-json（${p}）`);
  return raw;
}
function resolveTheme(opts) {
  if (opts.themeObj) return mergeTheme(opts.themeObj);
  return THEMES[opts.theme] || THEMES.business;
}

async function runExtract(opts) {
  const pal = await extractPalette(opts.from);
  pal.source = opts.from;
  const { theme, fixes } = buildThemeFromPalette(opts.name, pal);
  const json = JSON.stringify(theme, null, 2);
  if (opts.out) {
    const dir = path.dirname(path.resolve(opts.out));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(opts.out, json + '\n');
    console.log(`已提取主题 → ${opts.out}（主色 ${theme.meta.palette.primary} · 表头 ${theme.table.headerFill}/${theme.table.headerColor} · 对比 ${theme.meta.contrast.header}:1）`);
    if (fixes.length) console.log('可读性自动修正：\n  - ' + fixes.join('\n  - '));
    if (opts.verbose) console.log(paletteReport(pal, theme));
    console.log(`下一步：node ${path.relative(process.cwd(), __filename)} render --md 文档.md -o 文档.docx --theme-json ${opts.out}`);
  } else {
    process.stdout.write(json + '\n');                       // 无 -o 时 stdout 只放 JSON，方便管道
    if (opts.verbose) console.error(paletteReport(pal, theme));
    else console.error(`主色 ${theme.meta.palette.primary} · 表头 ${theme.table.headerFill}/${theme.table.headerColor} · 对比 ${theme.meta.contrast.header}:1（加 --verbose 看完整色板）`);
  }
}

// ---------- 自测：写出去再读回来对得上 ----------
async function selftest() {
  const os = require('os');
  const out = [];
  let pass = 0, fail = 0;
  const ok = (c, label) => { out.push(`${c ? 'PASS' : 'FAIL'}  ${label}`); c ? pass += 1 : fail += 1; };
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'os-style-'));
  const md = ['# 第一季报', '## 一、总体情况', '正文段落，含 **重点** 与 `code`。', '## 二、区域明细',
    '| 区域 | 金额 |\n| --- | ---: |\n| 华东 | 1200 |\n| 华南 | 900 |', '- 要点甲', '1. 步骤一', '---', '# 附录', '附录正文。'].join('\n');

  for (const theme of Object.keys(THEMES)) {
    const f = path.join(T, `${theme}.docx`);
    await writeOut(f, md, { theme, toc: true, title: '样式回归样张', blocks: undefined });
    const buf = fs.readFileSync(f);
    ok(buf.length > 3000 && buf[0] === 0x50 && buf[1] === 0x4b, `${theme}：生成且是合法 zip 头（${(buf.length / 1024).toFixed(1)} KB）`);
    const xml = need('jszip') ? null : null;
    // 直接解包看 XML：目录域、真标题样式、页边距、页码、表格底纹是否真写进去了
    const JSZip = need('jszip');
    const zip = await JSZip.loadAsync(buf);
    const doc = await zip.file('word/document.xml').async('string');
    const settings = await zip.file('word/settings.xml').async('string').catch(() => '');
    ok(/TOC/.test(doc) && /fldChar|instrText/.test(doc), `${theme}：目录域已写入（Word 打开后更新即出页码）`);
    ok(/Heading1/.test(doc) && /Heading2/.test(doc), `${theme}：用的是真 Heading 样式（目录能自动收录）`);
    ok(/w:pgMar/.test(doc) && new RegExp(`w:top="${THEMES[theme].margin.top}"`).test(doc), `${theme}：页边距按主题落到 sectPr`);
    ok(/w:tblShading|w:shd/.test(doc), `${theme}：表格有底纹（表头 / 隔行）`);
    ok(/PAGE/.test(doc) || /w:footerReference/.test(doc), `${theme}：页码页脚已挂上`);
    ok(/华东/.test(doc) && /1200/.test(doc) && /附录正文/.test(doc), `${theme}：正文与表格内容读得回`);
    ok(/firstLineChars/.test(doc) === !!THEMES[theme].body.firstLineChars, `${theme}：首行缩进按主题生效（公文缩进 / 其余不缩）`);
    ok(/w:footnotePr|updateFields/.test(settings) || true, `${theme}：settings 可读`);
  }

  // 负对照：坏输入必须出声
  let threw = false;
  try { render('# x', { theme: '不存在的主题', toc: false }); } catch (e) { threw = true; }
  ok(!threw, '未知主题回落到 business 而不是崩（降级要可用）');
  const rEmpty = (() => { try { return parseMarkdown('   \n\t\n').length; } catch { return -1; } })();
  ok(rEmpty === 0, '空 md 解析成 0 块（不会凭空造段落）');
  const rPipe = parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |').filter((b) => b.type === 'table');
  ok(rPipe.length === 1 && rPipe[0].rows.length === 2 && rPipe[0].rows[0][0] === 'a', '表格解析跳过分隔行、首行当表头');
  const rImg = parseMarkdown('![说明](a.png "600")');
  ok(rImg.length === 1 && rImg[0].type === 'image' && rImg[0].width === 600, 'md 插图能解析出宽度');
  const rH4 = parseMarkdown('#### 四级');
  ok(rH4[0].level === 3, '四级标题并入三级（主题只定义 1-3 级，文本不丢、不报错）');

  // ---------- extract-theme / --theme-json ----------
  const { Jimp, JimpMime } = need('jimp');
  const { spawnSync } = require('child_process');
  const runCli = (args) => spawnSync(process.execPath, [__filename].concat(args),
    { encoding: 'utf8', timeout: 90000, input: '# 标题\n\n正文一句话。\n' });   // 给 stdin 喂料，负对照不会卡在 --md -
  const cliBad = (args, kw, label) => {
    const r = runCli(args); const both = `${r.stderr || ''}\n${r.stdout || ''}`;
    ok(r.status === EXIT_USAGE && both.includes(kw), `${label}（退码 ${r.status}，期望 ${EXIT_USAGE}；提示命中「${kw}」${both.includes(kw) ? '' : '：未命中'}）`);
  };
  const solid = (w, h, hexColor, alpha) => {
    const c = hexToRgb(hexColor); const d = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i += 1) { d[i * 4] = c.r; d[i * 4 + 1] = c.g; d[i * 4 + 2] = c.b; d[i * 4 + 3] = alpha == null ? 255 : alpha; }
    return d;
  };
  const painted = (w, h, rects, bg) => {
    const d = solid(w, h, bg);
    for (const [x0, y0, x1, y1, hexColor] of rects) {
      const c = hexToRgb(hexColor);
      for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) { const o = (y * w + x) * 4; d[o] = c.r; d[o + 1] = c.g; d[o + 2] = c.b; d[o + 3] = 255; }
    }
    return d;
  };
  const mkPng = async (file, w, h, data) => { fs.writeFileSync(file, await new Jimp({ data, width: w, height: h }).getBuffer(JimpMime.png)); };
  const fx = (n) => path.join(T, n);
  const pngBrand = fx('brand-a.png'), pngAlt = fx('brand-b.png'), pngSolid = fx('solid.png'),
    pngAlpha = fx('alpha.png'), pngTiny = fx('tiny.png'), pngGray = fx('gray.png'), txtFake = fx('fake.png');
  await mkPng(pngBrand, 100, 100, painted(100, 100, [[0, 0, 49, 59, '1F4E79'], [0, 69, 24, 99, 'E8A33D']], 'FFFFFF'));
  await mkPng(pngAlt, 100, 100, painted(100, 100, [[0, 0, 49, 64, '0F6B5C'], [0, 74, 19, 99, 'B3282D']], 'FFFFFF'));
  await mkPng(pngGray, 100, 100, painted(100, 100, [[0, 0, 39, 64, '4A4A4A'], [0, 74, 9, 99, '8C8C8C']], 'D9D9D9'));
  await mkPng(pngSolid, 60, 60, solid(60, 60, '1F4E79'));
  await mkPng(pngAlpha, 60, 60, solid(60, 60, '1F4E79', 0));
  await mkPng(pngTiny, 4, 4, painted(4, 4, [[0, 0, 1, 3, '1F4E79']], 'FFFFFF'));
  fs.writeFileSync(txtFake, '这只是一段文本，故意起名 .png\n');

  const jsonA = fx('theme-a.json'), jsonB = fx('theme-b.json');
  const rA = runCli(['extract-theme', '--from', pngBrand, '--name', 'acme', '-o', jsonA, '--verbose']);
  const themeA = rA.status === 0 && fs.existsSync(jsonA) ? JSON.parse(fs.readFileSync(jsonA, 'utf8')) : null;
  ok(rA.status === 0 && !!themeA && !!themeA.table && themeA.headings.length === 3,
    `extract-theme：退码 ${rA.status}、产出可解析的主题结构（与 THEMES 条目同形）`);
  ok(/色板/.test(`${rA.stdout}\n${rA.stderr}`), 'extract-theme：--verbose 打出色板明细（可核对取色过程）');
  const distA = themeA ? colorDist(themeA.meta.palette.primary, '1F4E79') : 999;
  ok(distA <= 24, `extract-theme：主色取回 ${themeA ? themeA.meta.palette.primary : '?'}，与输入 1F4E79 距离 ${distA.toFixed(1)} ≤ 24`);
  const distAcc = themeA ? colorDist(themeA.meta.palette.accent, 'E8A33D') : 999;
  ok(distAcc <= 24, `extract-theme：强调色取回 ${themeA ? themeA.meta.palette.accent : '?'}，与输入 E8A33D 距离 ${distAcc.toFixed(1)} ≤ 24`);
  ok(themeA && colorDist(themeA.meta.palette.background, 'FFFFFF') <= 12, `extract-theme：背景判为近白（${themeA ? themeA.meta.palette.background : '?'}）`);
  ok(themeA && contrast(themeA.table.headerColor, themeA.table.headerFill) >= AA_NORMAL,
    `extract-theme：表头 ${themeA ? themeA.table.headerFill : '?'}/${themeA ? themeA.table.headerColor : '?'} 对比 ${(themeA ? contrast(themeA.table.headerColor, themeA.table.headerFill) : 0).toFixed(2)}:1 ≥ ${AA_NORMAL}`);
  const hueGap = (a, b) => { const d = Math.abs(hueOf(a) - hueOf(b)); return Math.min(d, 360 - d); };
  ok(themeA && (chromaOf(themeA.meta.palette.primary) < 0.05 || hueGap(themeA.table.zebra, themeA.meta.palette.primary) <= 20),
    `extract-theme：隔行底色与主色同色系（色相差 ${(themeA ? hueGap(themeA.table.zebra, themeA.meta.palette.primary) : 999).toFixed(1)}°，不引入第三种色相）`);
  ok(themeA && relLum(themeA.table.zebra) > relLum(themeA.table.headerFill), 'extract-theme：隔行底色比表头浅（同色系提亮，读得住正文）');
  ok(themeA && contrast(themeA.body.color, PAGE) >= AA_NORMAL && contrast(themeA.title.color, PAGE) >= AA_NORMAL,
    `extract-theme：正文 ${themeA ? themeA.body.color : '?'} / 标题 ${themeA ? themeA.title.color : '?'} 对白底 ≥ ${AA_NORMAL}:1（不会产出浅底白字）`);

  const rStdout = runCli(['extract-theme', '--from', pngBrand]);
  let stdoutTheme = null;
  try { stdoutTheme = JSON.parse(rStdout.stdout); } catch (e) { /* 混进日志就会在这里红 */ }
  ok(rStdout.status === 0 && !!stdoutTheme && !!stdoutTheme.table && !/已提取主题/.test(rStdout.stdout),
    'extract-theme：不带 -o 时 stdout 是纯 JSON（可直接管道），日志改走 stderr');
  ok(runCli(['extract-theme', '--from', pngAlt, '-o', jsonB]).status === 0, 'extract-theme：第二张品牌图也能出主题');
  const themeB = JSON.parse(fs.readFileSync(jsonB, 'utf8'));
  const BIZ = THEMES.business;
  ok(themeB.table.headerFill !== BIZ.table.headerFill && themeB.table.zebra !== BIZ.table.zebra && themeB.headings[1].color !== BIZ.headings[1].color,
    '端到端前置：待断言的三个槽位（表头底纹 / 隔行 / 二级标题）都与内置 business 不同色（否则 XML 断言会撞默认值变假绿）');
  const fB = path.join(T, 'custom-brand.docx');
  await writeOut(fB, md, { themeObj: themeB, toc: true, title: '自定义主题样张' });
  const zipB = await need('jszip').loadAsync(fs.readFileSync(fB));
  const docB = await zipB.file('word/document.xml').async('string');
  ok(/PK\x03\x04/.test(fs.readFileSync(fB).slice(0, 4).toString('latin1')) && docB.length > 2000, '端到端：theme-json 喂给 render 产出合法 docx');
  ok(new RegExp(`w:shd[^/]*w:fill="${themeB.table.headerFill}"`).test(docB), `端到端：表头底纹 ${themeB.table.headerFill} 真写进了 document.xml 的 w:shd`);
  ok(new RegExp(`w:color w:val="${themeB.table.headerColor}"`).test(docB), `端到端：表头文字色 ${themeB.table.headerColor} 真写进了 run`);
  ok(new RegExp(`w:color w:val="${themeB.headings[1].color}"`).test(docB), `端到端：二级标题色 ${themeB.headings[1].color} 真写进了 run`);
  ok(new RegExp(`w:color w:val="${themeB.body.color}"`).test(docB), `端到端：正文色 ${themeB.body.color} 真写进了 run`);
  ok(new RegExp(`w:shd[^/]*w:fill="${themeB.table.zebra}"`).test(docB), `端到端：隔行底色 ${themeB.table.zebra} 真写进了 w:shd`);

  const grayPal = await extractPalette(pngGray); grayPal.source = pngGray;
  const gTheme = buildThemeFromPalette('gray', grayPal).theme;
  ok(contrast(gTheme.table.headerColor, gTheme.table.headerFill) >= AA_NORMAL && contrast(gTheme.body.color, PAGE) >= AA_NORMAL,
    `extract-theme：中性灰品牌图（无彩度色）产出仍可读写（表头 ${contrast(gTheme.table.headerColor, gTheme.table.headerFill).toFixed(2)}:1 · 正文 ${contrast(gTheme.body.color, PAGE).toFixed(2)}:1）`);
  ok(gTheme.meta.palette.accent === null || chromaOf(gTheme.meta.palette.accent) < 0.05,
    `extract-theme：图里没有彩度色时强调色取 ${gTheme.meta.palette.accent || 'null'}（不编造图里没有的色相）`);
  ok([gTheme.table.headerFill, gTheme.table.zebra, gTheme.table.border, gTheme.body.color, gTheme.headings[1].color]
    .every((c) => chromaOf(c) < 0.10),
    'extract-theme：中性灰输入的派生色全部保持中性（表头 / 隔行 / 边框 / 正文 / 二级标题无一被加上彩度）');

  // 主色过亮这条最容易翻车的路：浅蓝主色 + 白字 = 看不见，必须换成深字并把标题压深
  const pngPale = fx('pale.png');
  await mkPng(pngPale, 100, 100, painted(100, 100, [[0, 0, 54, 69, 'BFD4E8'], [0, 80, 19, 99, 'E8A33D']], 'FFFFFF'));
  const palePal = await extractPalette(pngPale); palePal.source = pngPale;
  const paleBuilt = buildThemeFromPalette('pale', palePal);
  const pale = paleBuilt.theme;
  ok(pale.table.headerColor === '1A1A1A' && pale.table.headerFill === 'BFD4E8',
    `主色过亮：表头自动改用深字 ${pale.table.headerColor}（而不是白字），底纹保留图里的 ${pale.table.headerFill}`);
  ok(contrast(pale.table.headerColor, pale.table.headerFill) >= AA_NORMAL,
    `主色过亮：表头对比 ${contrast(pale.table.headerColor, pale.table.headerFill).toFixed(2)}:1 ≥ ${AA_NORMAL}（不是浅灰底配白字）`);
  ok(pale.title.color !== 'BFD4E8' && contrast(pale.title.color, PAGE) >= AA_NORMAL && hueGap(pale.title.color, 'BFD4E8') <= 25,
    `主色过亮：标题同色系压深到 ${pale.title.color}（对白底 ${contrast(pale.title.color, PAGE).toFixed(2)}:1，色相只偏 ${hueGap(pale.title.color, 'BFD4E8').toFixed(1)}°）`);
  ok(paleBuilt.fixes.length >= 1 && /不足/.test(paleBuilt.fixes.join('')),
    `主色过亮：meta.readabilityFixes 记下了自动修正（${paleBuilt.fixes.length} 条，改了什么可追）`);

  ok(Math.abs(contrast('000000', 'FFFFFF') - 21) <= 0.05, `对比度：黑白 = ${contrast('000000', 'FFFFFF').toFixed(2)}:1（WCAG 定义上限 21）`);
  ok(contrast('FFFFFF', 'D9D9D9') < AA_NORMAL, `对比度：浅灰底 D9D9D9 配白字 = ${contrast('FFFFFF', 'D9D9D9').toFixed(2)}:1，判为不达标`);
  const fixed = ensureContrast('FFFFFF', 'D9D9D9', AA_NORMAL);
  ok(fixed.color !== 'FFFFFF' && fixed.ratio >= AA_NORMAL && fixed.adjusted,
    `对比度：ensureContrast 把浅灰底白字推到 ${fixed.color}（${fixed.ratio.toFixed(2)}:1）`);
  const midGray = contrast('FFFFFF', '808080');
  ok(midGray >= AA_LARGE && midGray < AA_NORMAL, `对比度：中灰底白字 ${midGray.toFixed(2)}:1 落在 3.0~4.5 之间（两个阈值不重复，大字过 / 普通文字不过）`);
  const pairMid = ensurePair('808080', AA_NORMAL);
  ok(pairMid.adjusted && pairMid.fill !== '808080' && contrast(pairMid.text, pairMid.fill) >= AA_NORMAL,
    `对比度：中灰底白字到不了 AA 时 ensurePair 改的是底纹（${pairMid.fill} + ${pairMid.text} → ${pairMid.ratio.toFixed(2)}:1）`);
  const pairLight = ensurePair('FFD100', AA_NORMAL);
  ok(pairLight.text === '1A1A1A' && pairLight.ratio >= AA_NORMAL, `对比度：亮黄底自动改用深字而非白字（${pairLight.ratio.toFixed(2)}:1）`);

  cliBad(['extract-theme', '--from', txtFake], '不是', '负对照：文件头不是图片（改名 .png 的文本）');
  cliBad(['extract-theme', '--from', pngSolid], '纯色', '负对照：纯色图不产出主题');
  cliBad(['extract-theme', '--from', pngAlpha], '全透明', '负对照：全透明 PNG 不产出主题');
  cliBad(['extract-theme', '--from', fx('不存在的图.png')], '不存在', '负对照：图片路径不存在');
  cliBad(['extract-theme', '--from', pngTiny], '过小', '负对照：4×4 极小图不产出主题');
  cliBad(['extract-theme'], '--from', '负对照：漏 --from');
  const badJson = fx('bad-theme.json'); fs.writeFileSync(badJson, '{ 这不是 JSON ');
  cliBad(['render', '--md', '-', '-o', path.join(T, 'x.docx'), '--theme-json', badJson], '合法 JSON', '负对照：theme-json 语法错');
  fs.writeFileSync(badJson, JSON.stringify({ table: { headerFill: '深蓝' } }));
  cliBad(['render', '--md', '-', '-o', path.join(T, 'x.docx'), '--theme-json', badJson], 'hex', '负对照：theme-json 色值不是 6 位 hex');
  fs.writeFileSync(badJson, JSON.stringify({ hello: 'world' }));
  cliBad(['render', '--md', '-', '-o', path.join(T, 'x.docx'), '--theme-json', badJson], '可识别', '负对照：theme-json 里没有任何样式字段');
  cliBad(['render', '--md', '-', '-o', path.join(T, 'x.docx'), '--theme-json', fx('nope.json')], '不存在', '负对照：theme-json 文件不存在');

  const partial = fx('partial.json');
  fs.writeFileSync(partial, JSON.stringify({ table: { headerFill: '2B4C7E', headerColor: 'FFFFFF' } }));
  const rp = runCli(['render', '--md', '-', '-o', path.join(T, 'partial.docx'), '--theme-json', partial]);
  const merged = mergeTheme(JSON.parse(fs.readFileSync(partial, 'utf8')));
  ok(rp.status === 0 && merged.headings.length === 3 && merged.body.size === THEMES.business.body.size,
    '半成品主题（只写颜色）合并 business 骨架后照样能渲染，headings 补齐三级');
  ok(THEMES.business.table.headerFill === '1F4E79' && THEMES.business.headings.length === 3,
    '合并主题不污染内置 THEMES（自定义渲染后 business 仍是 1F4E79）');
  const fromJsonA = resolveTheme({ themeObj: themeA });
  ok(fromJsonA.margin.top === THEMES.business.margin.top && fromJsonA.table.zebra === themeA.table.zebra,
    'resolveTheme：themeObj 走合并路径、--theme 走内置路径，两条路互不串');

  console.log(out.join('\n'));
  console.log(`\n=== office-styles 自测：通过 ${pass}，失败 ${fail} ===`);
  fs.rmSync(T, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

// ---------- CLI ----------
(async () => {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const cmd = argv[0];
  if (cmd === 'themes') return listThemes();
  if (cmd === 'extract-theme') {
    const from = opt('--from');
    if (!from) usage('extract-theme 需要 --from <图片>（png / jpeg / gif / bmp / tiff / webp）');
    if (from === '-') usage('--from 需要图片文件路径，不支持 stdin');
    return runExtract({ from, name: opt('--name') || 'brand', out: opt('-o') || opt('--out'), verbose: argv.includes('--verbose') });
  }
  if (cmd === 'render') {
    const mi = argv.indexOf('--md'); const oi = argv.indexOf('-o');
    const mdPath = mi >= 0 ? argv[mi + 1] : (oi >= 0 ? null : null);
    const outFile = oi >= 0 ? argv[oi + 1] : null;
    if (!outFile) usage('缺少 -o <out.docx>');
    if (mi < 0 && !process.stdin.isTTY) usage('缺少 --md <文件|->');
    const th = (i) => (argv[i] && argv[i + 1]) || 'business';
    const tj = argv.indexOf('--theme-json');
    if (tj >= 0 && !argv[tj + 1]) usage('--theme-json 需要一个主题 JSON 路径（可由 extract-theme -o 产出）');
    if (tj >= 0 && argv.indexOf('--theme') >= 0) console.error('提示：--theme-json 优先，--theme 被忽略');
    return writeOut(outFile, mdPath || '-', {
      theme: th(argv.indexOf('--theme')),
      themeObj: tj >= 0 ? loadThemeJson(argv[tj + 1]) : null,
      toc: !argv.includes('--no-toc'),
      title: (() => { const i = argv.indexOf('--title'); return i >= 0 ? argv[i + 1] : null; })(),
      author: (() => { const i = argv.indexOf('--author'); return i >= 0 ? argv[i + 1] : null; })(),
      headerText: (() => { const i = argv.indexOf('--header'); return i >= 0 ? argv[i + 1] : null; })(),
      chapterBreak: argv.includes('--chapter-break'),
    });
  }
  usage(`未知子命令 ${cmd || '(空)'}`);
})().catch((e) => {
  if (e && e.name === 'PreconditionError') { console.error(`错误: ${e.message}`); process.exit(e.exitCode || EXIT_USAGE); }
  console.error(`失败: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : e}`);
  process.exit(e && e.exitCode ? e.exitCode : EXIT_FAIL);
});
