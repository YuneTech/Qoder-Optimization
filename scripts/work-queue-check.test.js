#!/usr/bin/env node
// work-queue-check.js 的自测包装：把"接续队列可恢复性"检查纳入统一测试套件。
// 判据（任一不成立即 exit 1）：
//   ① 脚本自带 selftest 通过（含四要素正例 + 四条负对照）
//   ② 独立负对照：缺「下一步」小节的队列必须被判红（证明它不是恒绿）
//   ③ 独立正例：四要素齐全且入口路径存在 → 绿色
//   ④ 没找到队列文件时退 3（调用方据此区分"没有队列"与"队列坏了"）
// 用法: node work-queue-check.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'work-queue-check.js');
const SB = path.join(os.tmpdir(), `wqc-test-${Date.now()}`);
fs.mkdirSync(SB, { recursive: true });

let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!ok) fail++; };
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000 });
const detail = (r) => `exit=${r.status}${r.error ? ' err=' + r.error.message : ''}`;

// ① 自带 selftest
const self = run(['--selftest']);
check('① 自带 selftest 全过', self.status === 0 && /6 通过 \/ 0 失败/.test(self.stdout || ''),
  `exit=${self.status} ${String(self.stdout || '').trim().split('\n').pop()}`);

// ② 独立负对照：缺小节必须红
const missing = path.join(SB, 'missing-next.md');
fs.writeFileSync(missing, ['## 当前状态', '- 做了 A', '', '## 阻塞点', '- 无', '', '## 关键入口', '- 无'].join('\n'));
const r2 = run(['--file', missing]);
check('② 独立负对照：缺「下一步」→ exit 1', r2.status === 1, `exit=${r2.status}`);

// ③ 独立正例
const entry = path.join(SB, 'real-entry.md');
fs.writeFileSync(entry, 'x');
const good = path.join(SB, 'good.md');
fs.writeFileSync(good, [
  '## 当前状态', '- [x] 做完 A（证据：退出码 0）', '',
  '## 下一步', '- [ ] 做 B：先读 C 再改 D', '',
  '## 阻塞点', '- 无', '',
  '## 关键入口', `- \`${entry}\``, '- 验证：`node work-queue-check.js`', '',
].join('\n'));
const r3 = run(['--file', good]);
check('③ 独立正例：四要素齐全 → exit 0', r3.status === 0, `exit=${r3.status} ${String(r3.stdout || '').trim().split('\n').pop()}`);

// ④ 没队列时退 3
const r4 = run(['--file', path.join(SB, 'no-such-file.md')]);
check('④ 没有队列文件 → exit 3（与"坏了"区分）', r4.status === 3, `exit=${r4.status}`);

try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}

console.log(fail ? `\n${fail} 项失败` : '\nALL PASS');
process.exit(fail ? 1 : 0);
