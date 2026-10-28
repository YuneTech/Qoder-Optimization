#!/usr/bin/env node
// 从超大 SQLite 中枚举「<kebab-name>create<中文描述>」形式的建议记录名。
// 用法: node list-suggestion-names.cjs <文件>
// 输出: 每行 "<名称>\t<出现次数>"，按名称排序；退出码 0=至少 1 条 3=没有
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('用法: node list-suggestion-names.cjs <文件>');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error('文件不存在: ' + file);
  process.exit(2);
}

const CHUNK = 32 * 1024 * 1024;
const OVERLAP = 8192;
// 记录形如 <uuid><kebab-name>create<中文描述>；用完整 UUID 作左边界，避免把 UUID 尾部当名字首段
const RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}([a-z][a-z0-9]*(?:-[a-z0-9]+){1,6})create/g;
const names = new Map();

const fd = fs.openSync(file, 'r');
const size = fs.fstatSync(fd).size;
let pos = 0;
let carry = '';
while (pos < size) {
  const len = Math.min(CHUNK, size - pos);
  const b = Buffer.alloc(len);
  fs.readSync(fd, b, 0, len, pos);
  const s = carry + b.toString('latin1');
  let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(s)) !== null) {
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 400);
    let high = 0;
    for (let i = 0; i < after.length; i++) if (after.charCodeAt(i) >= 0x80) high++;
    if (high >= 6) names.set(m[1], (names.get(m[1]) || 0) + 1);
  }
  carry = s.slice(-OVERLAP);
  pos += len;
}
fs.closeSync(fd);

function cleanName(raw) {
  const segs = raw.split('-');
  while (segs.length > 1) {
    const s = segs[0];
    const hexRun = (s.match(/^[0-9a-f]+/) || [''])[0];
    if (/^[0-9a-f]+$/.test(s) && s.length <= 12) { segs.shift(); continue; }
    if (hexRun.length >= 4 && s.length - hexRun.length >= 2) { segs[0] = s.slice(hexRun.length); }
    break;
  }
  return segs.join('-');
}

const cleaned = new Map();
for (const [n, c] of names) {
  const k = cleanName(n);
  if (!k.includes('-') || k.length < 8) continue;
  cleaned.set(k, (cleaned.get(k) || 0) + c);
}
const rows = [...cleaned.entries()].sort((a, b) => a[0].localeCompare(b[0]));
for (const [n, c] of rows) console.log(`${n}\t${c}`);
process.exit(rows.length > 0 ? 0 : 3);
