#!/usr/bin/env node
// 在超大二进制文件（如 800MB+ SQLite）里按关键词定位文本，输出命中窗口。
// 用法: node scan-binary-text.cjs <文件> <关键词> [--window 4000] [--chunk 32] [--max 20] [--filter 文本]
// --filter: 只认窗口内还含有该文本的命中（过滤"只有名字的清单"这类噪声命中）
// 退出码: 0=有命中 2=参数/文件错误 3=无命中（可作负对照判据）
const fs = require('fs');

const [file, keyword, ...rest] = process.argv.slice(2);
if (!file || !keyword) {
  console.error('用法: node scan-binary-text.cjs <文件> <关键词> [--window 4000] [--chunk 32] [--max 20] [--filter 文本]');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error('文件不存在: ' + file);
  process.exit(2);
}
const opt = (name, def) => {
  const i = rest.indexOf('--' + name);
  const v = i >= 0 ? Number(rest[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
};
const WIN = opt('window', 4000);
const CHUNK = opt('chunk', 32) * 1024 * 1024;
const MAX = opt('max', 20);
const fi = rest.indexOf('--filter');
const FILTER = fi >= 0 ? String(rest[fi + 1] || '') : '';
const OVERLAP = Math.max(8192, Buffer.byteLength(keyword, 'utf8') * 2);

const needle = Buffer.from(keyword, 'utf8').toString('latin1');
const fd = fs.openSync(file, 'r');
const size = fs.fstatSync(fd).size;
let pos = 0, carry = Buffer.alloc(0), hits = 0, shown = 0;
const seen = new Set();

while (pos < size && shown < MAX) {
  const len = Math.min(CHUNK, size - pos);
  const b = Buffer.alloc(len);
  fs.readSync(fd, b, 0, len, pos);
  const hay = carry.toString('latin1') + b.toString('latin1');
  const base = pos - carry.length;
  let i = -1;
  while ((i = hay.indexOf(needle, i + 1)) >= 0) {
    const abs = base + i;
    if (seen.has(abs)) continue;
    seen.add(abs);
    const wl = Math.min(WIN, size - abs);
    const w = Buffer.alloc(wl);
    fs.readSync(fd, w, 0, wl, abs);
    const txt = w.toString('utf8').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ');
    if (FILTER && !txt.includes(FILTER)) continue;
    hits += 1;
    const pct = ((abs / size) * 100).toFixed(2);
    process.stdout.write(`\n===== hit #${hits} @${abs} (${pct}%)\n${txt}\n`);
    shown += 1;
    if (shown >= MAX) break;
  }
  carry = Buffer.concat([carry, b]).slice(-OVERLAP);
  pos += len;
}
fs.closeSync(fd);
process.stderr.write(`\n[hits=${hits} shown=${shown} size=${size}]\n`);
process.exit(hits > 0 ? 0 : 3);
