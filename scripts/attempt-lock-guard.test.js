#!/usr/bin/env node
// attempt-lock-guard 自测：**违规必红 + 对照必绿**
// 红：同一目标连败到阈值 → Post 当场叫停、Pre 硬拦下一次同类调用
// 绿：不同目标不串账；成功一次清零；拿不到明确信号的返回不计数；非构建/测试/部署命令不建账
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SB = path.join(os.tmpdir(), `attempt-lock-${Date.now()}`);
const STATE = path.join(SB, 'state');
let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + String(detail).replace(/\s+/g, ' ').slice(0, 140) : ''}`); if (!ok) fail++; };
const reset = () => { try { fs.rmSync(STATE, { recursive: true, force: true }); } catch (e) {} fs.mkdirSync(STATE, { recursive: true }); };

// 沙箱自测不许写进真机状态目录（写进去会污染真实门禁）
const REAL_DIR = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.qoder', 'tmp', 'attempt-lock');
const snapReal = () => {
  const g = (f) => { try { return fs.readFileSync(path.join(REAL_DIR, f), 'utf8'); } catch (e) { return '<absent>'; } };
  return g('state.json') + '@@' + g('decisions.log');
};
const REAL_BEFORE = snapReal();

const POST_SCRIPT = path.join(__dirname, 'attempt-lock-guard.js');
const PRE_SCRIPT = path.join(__dirname, 'risky-match-guard.js');
const RSTATE = path.join(SB, 'risky-state');
const SESS = 'altest';
try {
  fs.mkdirSync(RSTATE, { recursive: true });
  fs.writeFileSync(path.join(RSTATE, 'memory-first.json'), JSON.stringify({ [SESS]: { memSeen: true, warned: {} } }));
} catch (e) {}

const spawn = (script, payload) => {
  const r = spawnSync(process.execPath, [script], {
    input: payload === undefined ? '' : JSON.stringify(payload),
    encoding: 'utf8', timeout: 15000,
    env: {
      ...process.env,
      ATTEMPT_LOCK_STATE_DIR: STATE,
      ATTEMPT_LOCK_CONFIG: path.join(SB, 'no-such-config.json'),
      RISKY_MATCH_STATE_DIR: RSTATE,
    },
  });
  let d = {};
  try { d = JSON.parse(r.stdout || '{}'); } catch (e) {}
  return { code: r.status, blocked: d.decision === 'block', reason: d.reason || '', out: r.stdout || '' };
};
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const pre = (command, extra) => spawn(PRE_SCRIPT, Object.assign({ hook_event_name: 'PreToolUse', session_id: SESS }, bash(command), extra));
const post = (command, resp, extra) => spawn(POST_SCRIPT, Object.assign({ hook_event_name: 'PostToolUse', session_id: SESS, tool_response: resp }, bash(command), extra));
const FAILOUT = 'npm ERR! code ELIFECYCLE\nBUILD FAILURE';
const OKOUT = 'BUILD SUCCESS\nTotal time: 12s';

// —— 必须拦（红）——
reset();
check('① 第 1、2 次构建失败：只记账不拦',
  !post('npm run build', FAILOUT).blocked && !post('npm run build', FAILOUT).blocked);
const third = post('npm run build', FAILOUT);
check('② 第 3 次失败当场叫停', third.blocked && /连败|连续失败/.test(third.reason), third.reason);
check('③ 已到阈值后，同类调用的 Pre 半边必须硬拦', pre('npm run build').blocked);
check('④ 不同目标不串账（同 family 不同签名）', !pre('npm run test').blocked);

// —— 必须放行（绿）——
reset();
post('npm run build', FAILOUT); post('npm run build', FAILOUT);
post('npm run build', OKOUT);              // 成功一次即清零（连续语义）
post('npm run build', FAILOUT);
check('⑤ 成功一次清零：再来两次仍是放行', !pre('npm run build').blocked);
reset();
post('npm run build', 'some unrelated output');
post('npm run build', 'some unrelated output');
post('npm run build', 'still unclear');
check('⑥ 拿不到明确信号的返回不计数', !pre('npm run build').blocked);
reset();
post('ls -la', FAILOUT);
post('ls -la', FAILOUT);
post('ls -la', FAILOUT);
check('⑦ 非构建/测试/部署命令不建账', !pre('ls -la').blocked);

// —— 人工解除 ——
reset();
post('npm run build', FAILOUT); post('npm run build', FAILOUT); post('npm run build', FAILOUT);
const cleared = spawnSync(process.execPath, [POST_SCRIPT, '--clear', 'ALL'], {
  encoding: 'utf8', timeout: 15000,
  env: { ...process.env, ATTEMPT_LOCK_STATE_DIR: STATE, ATTEMPT_LOCK_CONFIG: path.join(SB, 'no-such-config.json') },
});
check('⑧ --clear ALL 之后恢复放行', /cleared/.test(cleared.stdout) && !pre('npm run build').blocked);

// —— 复合命令的键 ——
const { keyOf } = require('./attempt-lock-core.js');
check('⑨ 复合命令的键取真正命中的那一段',
  keyOf('build', 'cd /d/tmp 2>/dev/null; npm run build') === 'build@npm run build',
  keyOf('build', 'cd /d/tmp 2>/dev/null; npm run build'));

// —— 沙箱隔离 ——
check('⑩ 沙箱自测没有写进真机状态目录', snapReal() === REAL_BEFORE);

try { fs.rmSync(SB, { recursive: true, force: true }); } catch (e) {}
console.log(fail ? `\n${fail} 项失败` : '\nALL PASS');
process.exit(fail ? 1 : 0);
