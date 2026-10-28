// 自测：hook-crash-guard 的 fail-open + 崩溃可见 是否同时成立（含对照）
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const GUARD = path.join(os.homedir(), '.qoder', 'scripts', 'hook-crash-guard.js');
const LOG = path.join(os.homedir(), '.qoder', 'scripts', 'hooks-crash.log');
const NODE = process.execPath;

const countLines = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length : 0);
const run = (code) => {
  try { execFileSync(NODE, ['-e', code], { stdio: 'pipe', timeout: 15000 }); return 0; }
  catch (e) { return e.status === null ? -1 : e.status; }
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name + ' ' + extra); } };

const before = countLines();
const beforeContent = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : null;

// ① 接了守卫且抛错 → 必须 exit 0（fail-open）且日志 +1
const code1 = `require(${JSON.stringify(GUARD)}).install('__selftest__'); throw new Error('boom-selftest');`;
const rc1 = run(code1);
const after1 = countLines();
check('接守卫后崩溃仍放行（exit 0）', rc1 === 0, 'rc=' + rc1);
check('崩溃写入日志（+1 行）', after1 === before + 1, `${before} -> ${after1}`);
const lastLine = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').pop() : '';
check('日志含 hook 名与错误信息', /__selftest__/.test(lastLine) && /boom-selftest/.test(lastLine), lastLine.slice(0, 120));

// ② 对照：不接守卫、同样抛错 → 必须非 0 退出，且日志不增长
const rc2 = run(`throw new Error('boom-control');`);
const after2 = countLines();
check('对照组（无守卫）非 0 退出', rc2 !== 0, 'rc=' + rc2);
check('对照组不写日志（行数不变）', after2 === after1, `${after1} -> ${after2}`);

// ③ readCrashes 能读到刚才那条
const g = require(GUARD);
const c = g.readCrashes(3600 * 1000);
check('readCrashes 统计到失败记录', c.count >= 1 && /__selftest__/.test(c.samples.join(' ')), JSON.stringify(c).slice(0, 160));

// 收尾恢复自测前的日志（没有则删）：**不能无脑删**——真出现崩溃记录时，删日志等于把证据一起清掉。
if (beforeContent === null) fs.rmSync(LOG, { force: true });
else fs.writeFileSync(LOG, beforeContent);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
