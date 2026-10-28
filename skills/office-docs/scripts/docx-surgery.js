#!/usr/bin/env node
'use strict';
/*
 * docx-surgery.js —— 既有 .docx 的「解包 / 改 / 回包」手术台（纯 Node）
 *
 * 存在理由：2026-09-29 技能降量时，官方 `docx`（Python 路线，含 unpack/pack/批注/修订脚本）
 * 与市场 `word-document-organizer` 被移入 skills-disabled，办公文档域只留 office-docs。
 * 为不丢失「改既有文档」这类能力，把其中最常用的四件事用 Node 重实现：
 *   unpack  —— 解开 docx 看/改内部 XML
 *   pack    —— 把改过的目录打回 docx
 *   replace —— 跨 run 安全的文本替换（Word 会把一句话拆进多个 <w:r>）
 *   validate / changes —— 结构和修订标记体检
 * 依赖只用技能目录里已有的 jszip + fast-xml-parser，不引入新包、不依赖 Python。
 *
 * 用法：
 *   node docx-surgery.js unpack   <in.docx> <outDir>
 *   node docx-surgery.js pack     <inDir> <out.docx>
 *   node docx-surgery.js replace  <in.docx> <out.docx> --find "旧" --replace "新"
 *   node docx-surgery.js validate <in.docx>
 *   node docx-surgery.js changes  <in.docx> [--accept <out.docx>]
 *   node docx-surgery.js --selftest
 *
 * 退出码：0 成功；1 运行失败；2 用法/前置错误（与 office-styles.js 一致）。
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');

const die = (code, msg) => { console.error('错误：' + msg); process.exit(code); };
const REQUIRED = ['[Content_Types].xml', 'word/document.xml'];

async function loadDocx(file) {
  if (!fs.existsSync(file)) die(2, '文件不存在：' + file);
  const buf = fs.readFileSync(file);
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) die(2, '不是 zip/docx（缺 PK 头）：' + file);
  return JSZip.loadAsync(buf);
}

// ── unpack ───────────────────────────────────────────────────────────────
async function unpack(args) {
  const [src, outDir] = args;
  if (!src || !outDir) die(2, '用法：unpack <in.docx> <outDir>');
  const zip = await loadDocx(src);
  let n = 0;
  for (const name of Object.keys(zip.files)) {
    const e = zip.files[name];
    const dest = path.join(outDir, name);
    if (e.dir) { fs.mkdirSync(dest, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, await e.async('nodebuffer'));
    n++;
  }
  console.log(`解包 ${n} 个文件 → ${outDir}`);
  console.log('提示：改完用 pack <目录> <输出.docx> 回包；XML 原样写出（不美化），避免改动命名空间声明。');
  return 0;
}

// ── pack ─────────────────────────────────────────────────────────────────
function walk(dir, base = dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, base, acc);
    else acc.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return acc;
}

async function pack(args) {
  const [inDir, outDocx] = args;
  if (!inDir || !outDocx) die(2, '用法：pack <inDir> <out.docx>');
  if (!fs.existsSync(path.join(inDir, '[Content_Types].xml'))) die(2, '目录不像 docx 解包产物（缺 [Content_Types].xml）：' + inDir);
  const files = walk(inDir);
  // [Content_Types].xml 提到最前，兼容按序读取的解析器
  files.sort((a, b) => (a === '[Content_Types].xml' ? -1 : b === '[Content_Types].xml' ? 1 : 0));
  const zip = new JSZip();
  for (const rel of files) zip.file(rel, fs.readFileSync(path.join(inDir, rel)));
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outDocx, buf);
  console.log(`回包 ${files.length} 个文件 → ${outDocx}（${buf.length} 字节）`);
  return 0;
}

// ── 跨 run 文本替换 ───────────────────────────────────────────────────────
// Word 会把「一句话」拆进多个 <w:r><w:t>（改过格式、开过修订、粘贴过都会）。
// 所以先在单个 <w:t> 里找；找不到再把同一段落（<w:p>）的所有 w:t 拼起来找，命中后
// 写回第一个 w:t，其余置空——这样保留段落级格式，只牺牲该段内被拆散的局部格式。
// fast-xml-parser 的 preserveOrder 模式下，元素值会包成数组、文本放进 #text 子节点
// （<w:t xml:space="preserve">X</w:t> → { 'w:t': [ { '#text': 'X' } ], ':@': {...} }）。
// 取/写文本都必须兼容「字符串 / 数组 / { '#text' }」三种形状，否则替换会静默 0 命中。
const getT = (n) => {
  const v = n['w:t'];
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v.map((x) => {
      if (typeof x === 'string') return x;
      if (x && typeof x === 'object' && x['#text'] !== undefined) return String(x['#text']);
      return '';
    }).join('');
  }
  if (v && typeof v === 'object' && v['#text'] !== undefined) return String(v['#text']);
  return String(v == null ? '' : v);
};
const setT = (n, v) => {
  const cur = n['w:t'];
  if (typeof cur === 'string') { n['w:t'] = v; return; }
  if (Array.isArray(cur)) {
    let wrote = false;
    for (const item of cur) {
      if (item && typeof item === 'object' && '#text' in item) { item['#text'] = wrote ? '' : v; wrote = true; }
    }
    if (!wrote) n['w:t'] = v;
    return;
  }
  if (cur && typeof cur === 'object' && '#text' in cur) { cur['#text'] = v; return; }
  n['w:t'] = v;
};

function replaceInXml(xml, find, repl) {
  const parser = new XMLParser({ ignoreAttributes: false, preserveOrder: true, trimValues: false });
  const builder = require('fast-xml-parser').XMLBuilder;
  let ast;
  try { ast = parser.parse(xml); } catch (e) { die(1, 'document.xml 解析失败：' + e.message); }

  let direct = 0, span = 0;
  const tNodes = [];
  (function collect(node) {
    if (Array.isArray(node)) return node.forEach(collect);
    if (node && typeof node === 'object') {
      if (node['w:t'] !== undefined) tNodes.push(node);
      for (const k of Object.keys(node)) if (k !== ':@') collect(node[k]);
    }
  })(ast);

  for (const n of tNodes) {
    const t = getT(n);
    if (t.includes(find)) { setT(n, t.split(find).join(repl)); direct++; }
  }
  if (direct === 0) {
    // 段落级兜底：按 <w:p> 聚合
    const ps = [];
    (function collectP(node) {
      if (Array.isArray(node)) return node.forEach(collectP);
      if (node && typeof node === 'object') {
        if (node['w:p'] !== undefined) ps.push(node['w:p']);
        for (const k of Object.keys(node)) if (k !== ':@') collectP(node[k]);
      }
    })(ast);
    for (const p of ps) {
      const ts = [];
      (function collectT(node) {
        if (Array.isArray(node)) return node.forEach(collectT);
        if (node && typeof node === 'object') {
          if (node['w:t'] !== undefined) ts.push(node);
          for (const k of Object.keys(node)) if (k !== ':@') collectT(node[k]);
        }
      })(p);
      const joined = ts.map(getT).join('');
      if (joined.includes(find) && ts.length) {
        setT(ts[0], joined.split(find).join(repl));
        for (let i = 1; i < ts.length; i++) setT(ts[i], '');
        span++;
      }
    }
  }
  return { xml: new builder({ ignoreAttributes: false, preserveOrder: true, format: false }).build(ast), direct, span };
}

async function replace(args) {
  const [src, out] = args;
  const fi = args.indexOf('--find'), ri = args.indexOf('--replace');
  if (!src || !out || fi < 0 || ri < 0) die(2, '用法：replace <in.docx> <out.docx> --find "旧" --replace "新"');
  const find = args[fi + 1], repl = args[ri + 1];
  if (!find) die(2, '--find 不能为空');
  const zip = await loadDocx(src);
  const targets = Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n));
  if (!targets.length) die(1, '包内没有可替换的正文/页眉页脚 XML');
  let total = 0, spanned = 0;
  for (const name of targets) {
    const xml = await zip.file(name).async('string');
    const r = replaceInXml(xml, find, repl);
    if (r.direct + r.span > 0) { zip.file(name, r.xml); total += r.direct + r.span; spanned += r.span; }
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(out, buf);
  console.log(`替换 ${total} 处（其中跨 run ${spanned} 处）→ ${out}`);
  if (total === 0) console.log('未命中：确认 --find 的文本与文档一致（注意全角/半角与空格）');
  return total === 0 ? 1 : 0;
}

// ── validate ─────────────────────────────────────────────────────────────
async function validate(args) {
  const [src] = args;
  if (!src) die(2, '用法：validate <in.docx>');
  const zip = await loadDocx(src);
  const names = Object.keys(zip.files);
  const problems = [];
  for (const r of REQUIRED) if (!names.includes(r)) problems.push('缺必需要件 ' + r);
  const parser = new XMLParser({ ignoreAttributes: false });
  let xmlOk = 0;
  for (const n of names) {
    if (!n.endsWith('.xml') && !n.endsWith('.rels')) continue;
    const text = await zip.file(n).async('string');
    try { parser.parse(text); xmlOk++; } catch (e) { problems.push('XML 解析失败：' + n + ' — ' + e.message); }
  }
  console.log(`要件 ${names.length} 个，XML 可解析 ${xmlOk} 个`);
  if (problems.length) { problems.forEach((p) => console.error('  ✗ ' + p)); return 1; }
  console.log('校验通过：结构完整、XML 全部可解析');
  return 0;
}

// ── changes（修订标记体检 / 可选接受）────────────────────────────────────
async function changes(args) {
  const [src] = args;
  if (!src) die(2, '用法：changes <in.docx> [--accept <out.docx>]');
  const zip = await loadDocx(src);
  const xml = await zip.file('word/document.xml').async('string');
  const count = (re) => (xml.match(re) || []).length;
  const ins = count(/<w:ins[ >]/g), del = count(/<w:del[ >]/g);
  const authors = [...new Set([...xml.matchAll(/w:author="([^"]*)"/g)].map((m) => m[1]))];
  console.log(`修订标记：插入 ${ins} 处、删除 ${del} 处${authors.length ? '；作者：' + authors.join(' / ') : ''}`);
  const ai = args.indexOf('--accept');
  if (ai >= 0) {
    const out = args[ai + 1];
    if (!out) die(2, '--accept 需要输出路径');
    // 接受修订：删掉 w:del 包裹的内容，解开 w:ins 包裹只留内容
    let next = xml
      .replace(/<w:del [^>]*>[\s\S]*?<\/w:del>/g, '')
      .replace(/<w:ins [^>]*>([\s\S]*?)<\/w:ins>/g, '$1')
      .replace(/<w:delText[\s\S]*?<\/w:delText>/g, '');
    zip.file('word/document.xml', next);
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(out, buf);
    console.log(`已接受修订 → ${out}（提示：复杂修订建议用官方 docx 技能的 accept_changes.py，或 Word 里审阅）`);
  }
  return 0;
}

// ── selftest ─────────────────────────────────────────────────────────────
async function selftest() {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-surgery-'));
  const { Document, Packer, Paragraph, TextRun } = require('docx');
  let pass = 0, fail = 0;
  const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL ' + msg); } };

  // 夹具：一句被拆成三个 run 的段落 —— 正是跨 run 替换的真实场景
  const doc = new Document({ sections: [{ children: [new Paragraph({ children: [
    new TextRun('甲方应于'), new TextRun({ text: '三十日内', bold: true }), new TextRun('支付全部款项。'),
  ] })] }] });
  const fixture = path.join(tmp, 'in.docx');
  fs.writeFileSync(fixture, await Packer.toBuffer(doc));

  const out1 = path.join(tmp, 'replaced.docx');
  const r1 = await replace([fixture, out1, '--find', '三十日内', '--replace', '十五个工作日内']);
  ok(r1 === 0, 'replace 应 exit 0（实际 ' + r1 + '）');
  const zip1 = await JSZip.loadAsync(fs.readFileSync(out1));
  const xml1 = await zip1.file('word/document.xml').async('string');
  ok(xml1.includes('十五个工作日内'), '替换后的文本应写进 XML');
  ok(!xml1.includes('三十日内'), '旧文本应消失');
  ok(xml1.includes('甲方应于') && xml1.includes('支付全部款项。'), '未命中部分必须原样保留（负对照）');

  // 负对照：找不到的字符串 → exit 1，且输出文件仍生成
  const r2 = await replace([fixture, path.join(tmp, 'noop.docx'), '--find', '不存在的词', '--replace', 'x']);
  ok(r2 === 1, '未命中应 exit 1（实际 ' + r2 + '）');

  // 跨 run：把一句话拆进两个 run，替换必须仍能命中（这是本脚本存在的理由）
  const doc2 = new Document({ sections: [{ children: [new Paragraph({ children: [
    new TextRun('本合同自'), new TextRun({ text: '签署之日', italics: true }), new TextRun({ text: '起生效。', italics: true }),
  ] })] }] });
  const fx2 = path.join(tmp, 'span.docx');
  fs.writeFileSync(fx2, await Packer.toBuffer(doc2));
  const out3 = path.join(tmp, 'span-out.docx');
  const r3 = await replace([fx2, out3, '--find', '签署之日起生效', '--replace', '双方盖章之日起生效']);
  ok(r3 === 0, '跨 run 替换应 exit 0（实际 ' + r3 + '）');
  const xml3 = await (await JSZip.loadAsync(fs.readFileSync(out3))).file('word/document.xml').async('string');
  ok(xml3.includes('双方盖章之日起生效'), '跨 run 替换结果应写进 XML');
  ok(!/签署之日<\/w:t>/.test(xml3), '被合并的旧 run 文本应被清空');

  // unpack → pack 往返：结构要能读回
  const dir = path.join(tmp, 'unpacked');
  await unpack([fixture, dir]);
  const out2 = path.join(tmp, 'repacked.docx');
  await pack([dir, out2]);
  const v = await validate([out2]);
  ok(v === 0, 'pack 产物应通过 validate（实际 exit ' + v + '）');
  const zip2 = await JSZip.loadAsync(fs.readFileSync(out2));
  const xml2 = await zip2.file('word/document.xml').async('string');
  ok(xml2.includes('三十日内'), '往返后正文应原样在（负对照：不应被改动）');

  // validate 负对照：非 docx
  const bad = path.join(tmp, 'bad.docx');
  fs.writeFileSync(bad, Buffer.from('not a zip at all'));
  let threw = 0;
  const origExit = process.exit;
  process.exit = (c) => { threw = c; throw new Error('exit:' + c); };
  try { await validate([bad]); } catch (e) { /* 预期 */ }
  process.exit = origExit;
  ok(threw === 2, '非 docx 应 exit 2（实际 ' + threw + '）');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\ndocx-surgery 自测：${pass} 通过 / ${fail} 失败`);
  return fail ? 1 : 0;
}

// ── main ─────────────────────────────────────────────────────────────────
(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  const table = { unpack, pack, replace, validate, changes };
  if (cmd === '--selftest') process.exit(await selftest());
  if (!table[cmd]) die(2, '未知子命令：' + (cmd || '(空)') + '\n可用：unpack | pack | replace | validate | changes | --selftest');
  process.exit(await table[cmd](args));
})().catch((e) => die(1, e.stack || String(e)));
