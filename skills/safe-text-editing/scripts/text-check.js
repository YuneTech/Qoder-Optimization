#!/usr/bin/env node
// text-check.js —— "写出来的到底是不是我想要的"：编码 / 行尾 / 片段 / BOM 的可失败断言。
//
// 为什么单独做：编码与行尾错了**不报错**，只是"内容看着对、用起来不对"（.cmd 中文乱码、diff 满屏红、
// 替换没命中）。本工具把这几件事变成退出码：全过 0，有断言不成立 1，用法错 2。
//
// 用法：
//   node text-check.js <文件> [--has <片段>]... [--not <片段>]... [--eol crlf|lf] [--encoding utf8|gbk] [--bom yes|no]
//   node text-check.js --selftest
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const has = (buf, needle) => { // 片段按当前判断的编码解码后再找
  const t = decode(buf);
  return t !== null && t.includes(needle);
};
let FORCE = null; // 'utf8' | 'gbk'，由 --encoding 指定，影响片段断言的解码
function decode(buf) {
  const body = buf.length >= 3 && buf.subarray(0, 3).equals(BOM) ? buf.subarray(3) : buf;
  if (FORCE === 'gbk') { try { return new TextDecoder('gbk', { fatal: true }).decode(body); } catch { return null; } }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return null; }
}
const eolStats = (buf) => {
  let crlf = 0, lf = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) (i > 0 && buf[i - 1] === 0x0d) ? crlf++ : lf++;
  return { crlf, lf };
};

function main(argv) {
  const file = argv[0];
  if (!file || file.startsWith('--')) { console.error('用法: node text-check.js <文件> [--has x]... [--not y]... [--eol crlf|lf] [--encoding utf8|gbk] [--bom yes|no]'); return 2; }
  if (!fs.existsSync(file)) { console.error('文件不存在：' + file); return 2; }
  const buf = fs.readFileSync(file);
  const problems = [], notes = [];
  let wantHas = [], wantNot = [], wantEol = null, wantEnc = null, wantBom = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--has') { wantHas.push(v); i++; }
    else if (a === '--not') { wantNot.push(v); i++; }
    else if (a === '--eol') { wantEol = v; i++; }
    else if (a === '--encoding') { wantEnc = v; i++; }
    else if (a === '--bom') { wantBom = v; i++; }
  }
  if (wantEnc) FORCE = wantEnc;

  const hasBom = buf.length >= 3 && buf.subarray(0, 3).equals(BOM);
  const utf8Ok = decode({ ...buf, subarray: undefined } && (hasBom ? buf.subarray(3) : buf)) !== null;
  const gbkOk = (() => { try { new TextDecoder('gbk', { fatal: true }).decode(hasBom ? buf.subarray(3) : buf); return true; } catch { return false; } })();
  const utf8Text = (() => { try { return new TextDecoder('utf-8', { fatal: true }).decode(hasBom ? buf.subarray(3) : buf); } catch { return null; } })();
  notes.push(`BOM=${hasBom ? 'yes' : 'no'} UTF-8=${utf8Ok ? 'ok' : 'fail'} GBK=${gbkOk ? 'ok' : 'fail'} 高字节=${buf.some((b) => b > 0x7f) ? '有' : '无'}`);
  const st = eolStats(buf);
  notes.push(`行尾 CRLF=${st.crlf} LF-only=${st.lf}`);

  if (wantEnc === 'utf8' && !utf8Ok) problems.push('断言编码 UTF-8，但严格解码失败（多半是 GBK 或其他编码）');
  if (wantEnc === 'gbk') {
    if (utf8Ok && utf8Text !== null && /[\u4e00-\u9fff]/.test(utf8Text)) problems.push('断言编码 GBK，但内容是合法 UTF-8 中文（.cmd 场景下应转 GBK）');
    else if (!gbkOk) problems.push('断言编码 GBK，但 GBK 严格解码也失败（字节可能已损坏）');
  }
  if (wantEol === 'crlf' && st.lf > 0) problems.push(`断言 CRLF，但有 ${st.lf} 处裸 LF（.cmd 需要全 CRLF）`);
  if (wantEol === 'lf' && st.crlf > 0) problems.push(`断言 LF，但有 ${st.crlf} 处 CRLF`);
  if (wantBom === 'yes' && !hasBom) problems.push('断言要有 BOM，实际没有（PowerShell 中文无 BOM 会吞引号）');
  if (wantBom === 'no' && hasBom) problems.push('断言不要 BOM，实际有');

  const text = decode(buf);
  for (const n of wantHas) { if (text === null) { problems.push('片段断言无法进行：文件按当前编码解不开'); break; } if (!text.includes(n)) problems.push(`应有片段未找到：${n}`); }
  for (const n of wantNot) { if (text === null) break; if (text.includes(n)) problems.push(`不应存在片段仍在：${n}`); }

  for (const n of notes) console.log('  · ' + n);
  if (problems.length) { for (const p of problems) console.error('  ✗ ' + p); return 1; }
  console.log('  校验通过（' + path.basename(file) + '）');
  return 0;
}

function selftest() {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'textcheck-'));
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL ' + m); } };
  const run = (...a) => spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8' }).status;

  const f1 = path.join(tmp, 'utf8-lf.txt');
  fs.writeFileSync(f1, '第一行\n第二行 KEY=值\n');
  ok(run(f1, '--has', 'KEY=值', '--not', '不存在的词', '--eol', 'lf', '--encoding', 'utf8') === 0, 'UTF-8/LF 正例应 exit 0');
  ok(run(f1, '--eol', 'crlf') === 1, '把 LF 断言成 CRLF 应 exit 1（负对照）');
  ok(run(f1, '--not', 'KEY=值') === 1, '断言"不应存在"却存在 → exit 1（负对照）');

  const f2 = path.join(tmp, 'gbk-crlf.txt');
  const src = '标题：中文内容测试\n';
  fs.writeFileSync(path.join(tmp, 'src.txt'), src);
  const r = spawnSync('iconv', ['-f', 'UTF-8', '-t', 'GBK', path.join(tmp, 'src.txt')], { encoding: 'buffer' });
  if (r.status === 0 && r.stdout && r.stdout.length) {
    // 注意：**不要** String(buffer) —— 那会按 UTF-8 解码 GBK 字节，把内容弄坏（本工具要检的正是这类错）。
    // 按字节换行：0x0a → 0x0d 0x0a。
    const out = [];
    for (const b of r.stdout) { if (b === 0x0a) out.push(0x0d, 0x0a); else out.push(b); }
    fs.writeFileSync(f2, Buffer.from(out));
    ok(run(f2, '--encoding', 'gbk') === 0, 'GBK+CRLF 文件断言 gbk 应通过');
    ok(run(f2, '--encoding', 'utf8') === 1, 'GBK 文件断言 utf8 → exit 1（负对照）');
    ok(run(f2, '--has', '中文内容测试', '--encoding', 'gbk') === 0, 'GBK 下片段断言应命中（解码正确）');
  } else {
    console.log('  · 跳过 GBK 分支：本机没有可用的 iconv');
  }
  ok(run(f1, '--has') === 2 || run(path.join(tmp, 'nope.txt')) === 2, '用法/文件不存在 → exit 2');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\ntext-check 自测：${pass} 通过 / ${fail} 失败`);
  return fail ? 1 : 0;
}

if (process.argv.includes('--selftest')) process.exit(selftest());
process.exit(main(process.argv.slice(2)));
