#!/usr/bin/env node
// session-budget.js 的自测（离线可跑）：每档必须真的触发，不该触发的必须静默。
// 用沙箱 HOME + 按大小造的稀硫 transcript，不依赖真实会话状态。
//   node ~/.qoder/scripts/session-budget.test.js    → 全绿退 0，任一失败退 1
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = require('path').join(__dirname, 'session-budget.js');
const SB = path.join(require('os').tmpdir(), 'q31', 'sb-sandbox');
const NODE = process.execPath;
let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!ok) fail++; };

fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(SB, { recursive: true });

// 造指定 MB 的 transcript（稀疏写入，不真占磁盘）
function makeTranscript(name, mb) {
  const p = path.join(SB, name);
  const fd = fs.openSync(p, 'w');
  fs.writeSync(fd, 'x');
  fs.ftruncateSync(fd, Math.round(mb * 1048576));
  fs.closeSync(fd);
  return p;
}

function run(payload) {
  const r = spawnSync(NODE, [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, SB_STATE_DIR: path.join(SB, 'state') },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const MB = (m) => Math.round(m * 1048576);

// ── 分档 ──
const cases = [
  { mb: 2, expect: null, name: '2MB 低于首档 → 静默' },
  { mb: 8, expect: '节约模式', name: '8MB → 节约模式' },
  { mb: 14, expect: '节约模式', name: '14MB 仍是节约模式' },
  { mb: 15, expect: '先落盘再继续', name: '15MB → 先落盘再继续' },
  { mb: 24, expect: '先落盘再继续', name: '24MB 仍是先落盘再继续' },
  { mb: 25, expect: '立即落盘 + 把任务接到新会话', name: '25MB → 立即落盘' },
  { mb: 120, expect: '立即落盘 + 把任务接到新会话', name: '120MB → 立即落盘' },
];
for (const c of cases) {
  const tp = makeTranscript(`t-${c.mb}.jsonl`, c.mb);
  const r = run({ hook_event_name: 'UserPromptSubmit', transcript_path: tp, cwd: 'C:\\x', session_id: 'abcdef12-3456' });
  let ctx = null;
  try { ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext; } catch (e) {}
  const ok = c.expect === null ? (r.out.trim() === '' && r.code === 0) : (typeof ctx === 'string' && ctx.includes(c.expect));
  check(c.name, ok, ctx ? ctx.slice(0, 40) : JSON.stringify(r.out.slice(0, 40)));
}

// ── 体积来源：transcript_path 优先，缺失时按 cwd 推导 ──
{
  const cwd = path.join(require('os').tmpdir(), 'q31', 'proj');
  const projDir = path.join(SB, 'projects', cwd.replace(/[\\/:]/g, '-'));
  fs.mkdirSync(projDir, { recursive: true });
  const big = path.join(projDir, 'sess.jsonl');
  const fd = fs.openSync(big, 'w'); fs.writeSync(fd, 'x'); fs.ftruncateSync(fd, MB(16)); fs.closeSync(fd);
  const r = run({ hook_event_name: 'UserPromptSubmit', cwd });
  // 该路径在真实 ~/.qoder*/projects 下才找得到；这里只断言"找不到时不报错、不误报"
  check('无 transcript_path 且推导不到 → 静默不误报', r.out.trim() === '' && r.code === 0, JSON.stringify(r.out.slice(0, 40)));
}

// ── 异常输入必须 fail-open ──
{
  let r = spawnSync(NODE, [SCRIPT], { input: 'not json', encoding: 'utf8', timeout: 20000, env: { ...process.env, SB_STATE_DIR: path.join(SB, 'state') } });
  check('非法 stdin → 静默放行', r.status === 0 && (r.stdout || '').trim() === '');
  r = run({ hook_event_name: 'UserPromptSubmit', transcript_path: path.join(SB, 'nope.jsonl') });
  check('transcript 不存在 → 静默放行', r.out.trim() === '' && r.code === 0);
}

// ── 关闭开关 ──
{
  const cfgDir = path.join(SB, '.qoder');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'session-budget.json'), JSON.stringify({ disabled: true }));
  const tp = makeTranscript('off.jsonl', 30);
  const r = spawnSync(NODE, [SCRIPT], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', transcript_path: tp }),
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, HOME: SB, USERPROFILE: SB, SB_STATE_DIR: path.join(SB, 'state') },
  });
  check('disabled=true → 静默', (r.stdout || '').trim() === '' && r.status === 0, JSON.stringify((r.stdout || '').slice(0, 40)));
}

// ── SessionStart 接续 ──
{
  const proj = path.join(SB, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const q = path.join(proj, '.qoder-work-queue.md');
  fs.writeFileSync(q, '# 接续队列\n\n- [x] 已完成的事\n- [ ] 把 A 模块的单测补齐\n- [ ] 收口 PR\n\n## 下一步\n先跑 mvn -q -pl web -am test，再补边界用例。\n');
  let r = run({ hook_event_name: 'SessionStart', cwd: proj });
  let ctx = null;
  try { ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext; } catch (e) {}
  check('SessionStart：有未完成队列 → 注入接续点', typeof ctx === 'string' && ctx.includes('接续点') && ctx.includes('把 A 模块的单测补齐') && ctx.includes('## 下一步'),
    ctx ? ctx.slice(0, 60) : JSON.stringify(r.out.slice(0, 60)));
  check('SessionStart：只列未完成项，不列已完成项', typeof ctx === 'string' && !ctx.includes('[x] 已完成的事'));
  check('SessionStart：旧待办须核对当前授权', typeof ctx === 'string' && ctx.includes('先核对任务ID、责任会话和用户本轮范围') && !ctx.includes('第一条未完成项就是你本轮的第一件事'));

  fs.writeFileSync(q, '# 接续队列\n\n- [x] 全部做完了\n');
  r = run({ hook_event_name: 'SessionStart', cwd: proj });
  check('SessionStart：没有未完成项 → 静默', r.out.trim() === '');

  fs.rmSync(q);
  r = run({ hook_event_name: 'SessionStart', cwd: proj });
  check('SessionStart：没有队列文件 → 静默', r.out.trim() === '');
}

// ── 压缩信号：独立于体积（体积没到档、但已丢过上下文，同样要提醒）──
{
  function withCompactions(name, mb, n) {
    const p = path.join(SB, name);
    const lines = [];
    for (let i = 0; i < n; i++) lines.push(JSON.stringify({ type: 'summary', isCompactSummary: true }) + '\n');
    fs.writeFileSync(p, lines.join(''));
    // 注意：Windows 上 'a' 模式打开后 ftruncate 会 EPERM，必须用 'r+'（实测踩到）
    const fd = fs.openSync(p, 'r+');
    fs.ftruncateSync(fd, Math.round(mb * 1048576));
    fs.closeSync(fd);
    return p;
  }
  for (const [n, mb, expect, label] of [
    [0, 2, null, 'comp=0 且体积小 → 静默'],
    [1, 2, '已压缩 1 次', 'comp=1 体积小 → 仍提醒（独立触发）'],
    [2, 2, '落盘并继续', 'comp=2 体积小 → 落盘并继续'],
    [2, 30, '落盘并继续', 'comp=2 且体积超线 → 两条同时注入'],
  ]) {
    const tp = withCompactions(`c-${n}-${mb}.jsonl`, mb, n);
    const r = run({ hook_event_name: 'UserPromptSubmit', transcript_path: tp });
    let ctx = null;
    try { ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext; } catch (e) {}
    const ok = expect === null ? (r.out.trim() === '' && r.code === 0) : (typeof ctx === 'string' && ctx.includes(expect));
    check(label, ok, ctx ? ctx.split('\n')[0].slice(0, 42) : JSON.stringify(r.out.slice(0, 42)));
  }
}

// ── 看门狗：会话开台独立检查"周检上次成功是多久前" ──
{
  const wh = path.join(SB, 'wd-home', '.qoder');
  const mk = () => { fs.mkdirSync(path.join(wh, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(wh, 'tmp', 'rules-audit'), { recursive: true }); };
  const runWd = () => spawnSync(NODE, [SCRIPT], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: path.join(SB, 'empty-proj') }),
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, HOME: path.join(SB, 'wd-home'), USERPROFILE: path.join(SB, 'wd-home'), SB_STATE_DIR: path.join(SB, 'wd-state') },
  });
  const ctxOf = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (e) { return ''; } };

  fs.rmSync(path.join(SB, 'wd-home'), { recursive: true, force: true });
  const r1 = runWd();
  check('看门狗：周检脚本缺失 → 静默', (r1.stdout || '').trim() === '', JSON.stringify((r1.stdout || '').slice(0, 40)));

  mk(); fs.writeFileSync(path.join(wh, 'scripts', 'rules-weekly-audit.js'), '// stub\n');
  const r2 = ctxOf(runWd());
  check('看门狗：台账不存在 → 提示"从未成功跑过"', r2.includes('从未成功跑过'), r2.slice(0, 40));

  fs.writeFileSync(path.join(wh, 'tmp', 'rules-audit', 'history.log'), new Date().toISOString() + '|warn=0|fixed=0|info=0\n');
  check('看门狗：台账新鲜 → 静默', (runWd().stdout || '').trim() === '');

  const old = new Date(Date.now() - 15 * 86400000).toISOString();
  fs.writeFileSync(path.join(wh, 'tmp', 'rules-audit', 'history.log'), old + '|warn=1|fixed=0|info=0\n');
  const r3 = ctxOf(runWd());
  check('看门狗：台账过期 15 天 → 报"已 X 天没跑"', /已 \*\*1[45]\.\d 天\*\*没成功跑过/.test(r3), r3.slice(0, 46));
}

// ── 返回侧入账：回合间增量（体积小到不触发分档，也要能单独报出来）──
{
  const sess = (s) => ({ hook_event_name: 'UserPromptSubmit', transcript_path: '', session_id: s });
  const grow = (name, mb) => makeTranscript(name, mb);
  // 独立 session_id，避免与上面分档用例互相污染基线
  let tp1 = grow('g-3a.jsonl', 3);
  let r1 = run({ ...sess('growth-A'), transcript_path: tp1 });
  check('返回侧：首次见到该会话（无基线）→ 静默', r1.out.trim() === '', JSON.stringify(r1.out.slice(0, 30)));

  const tp2 = grow('g-3b.jsonl', 3.4);
  let r2 = run({ ...sess('growth-A'), transcript_path: tp2 });
  check('返回侧：增量 0.4MB（<2MB 阈值）→ 静默', r2.out.trim() === '', JSON.stringify(r2.out.slice(0, 30)));

  const tp3 = grow('g-9.jsonl', 9.4);
  let r3 = run({ ...sess('growth-A'), transcript_path: tp3 });
  let ctx3 = '';
  try { ctx3 = JSON.parse(r3.out).hookSpecificOutput.additionalContext; } catch (e) {}
  check('返回侧：增量 6MB → 报"返回侧入账"', ctx3.includes('返回侧入账'), ctx3.split('\n')[0].slice(0, 40));
  check('返回侧：同一条注入里同时给分档（两个信号互不吞）', ctx3.includes('节约模式'));

  const tp4 = grow('g-2.jsonl', 2);
  const r4 = run({ ...sess('growth-B'), transcript_path: tp4 });
  const r5 = run({ ...sess('growth-B'), transcript_path: tp4 });
  check('返回侧：体积没涨（同文件重复读）→ 不报', r5.out.trim() === '', JSON.stringify(r5.out.slice(0, 30)));
}

// ── 台账要求可核对 ──
{
  const led = path.join(SB, 'state', 'checks.log');
  const txt = fs.existsSync(led) ? fs.readFileSync(led, 'utf8') : '';
  check('落了台账（含体积与档位）', /UserPromptSubmit\|2\d\.\dMB\|(yellow|orange|red)\|/.test(txt), txt.split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 100));
  const keys = path.join(SB, 'state', 'keys-UserPromptSubmit.json');
  check('首跑记录了 stdin 字段集（便于核实字段名）', fs.existsSync(keys));
}

const auditProject = path.join(SB, 'audit-project');
fs.mkdirSync(auditProject, { recursive: true });
fs.writeFileSync(path.join(auditProject, 'B00-共享上下文.md'), '# 旧任务包\n');
fs.writeFileSync(path.join(auditProject, '.qoder-work-queue.md'), '# 旧队列\n- [ ] 尚未授权实施的旧任务\n');
const auditRun = spawnSync(NODE, [SCRIPT], {
  input: JSON.stringify({hook_event_name:'SessionStart',cwd:auditProject}), encoding:'utf8',
  env:{...process.env,HOME:path.join(SB,'isolated-home'),USERPROFILE:path.join(SB,'isolated-home'),SB_STATE_DIR:path.join(SB,'audit-state')},
});
const auditContext = JSON.parse(auditRun.stdout).hookSpecificOutput.additionalContext;
check('旧队列和任务包不扩大执行授权', auditRun.status===0 && auditContext.includes('不构成执行授权') && auditContext.includes('目录内容不授权自动实施'));
check('只读审阅不被接续提醒催写文件', auditContext.includes('只读审阅交付报告即完成') && auditContext.includes('不写文件、不自动派发') && !auditContext.includes('开工第一件事'));
fs.rmSync(SB, { recursive: true, force: true });
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
