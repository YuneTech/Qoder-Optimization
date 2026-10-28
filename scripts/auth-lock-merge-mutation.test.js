// 变异验证：证明"合并后的 Pre 拦截"确实来自 risky-match-guard.js 里那段委托——
// 把委托摘掉做成 mutant，同一个已拦目标在 mutant 上必须**不拦**（否则 ③ 就是恒绿的假判据）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const DIR = __dirname;
const src = fs.readFileSync(path.join(DIR, 'risky-match-guard.js'), 'utf8');
const start = src.indexOf('try {\n  const al = require');
const end = src.indexOf('const verdict =');
if (start < 0 || end < 0) { console.log('FAIL  变异未命中委托段'); process.exit(2); }
const mutant = src.slice(0, start) + src.slice(end);
// 残留检查盯"调用"而不是文件名：头注释里本来就写着「判据在 auth-lock-core.js」，按文件名判会误报
if (mutant.includes('.preCheck(')) { console.log('FAIL  变异后仍残留委托'); process.exit(2); }
const MF = path.join(DIR, 'risky-match-guard.mutant.tmp.js');
fs.writeFileSync(MF, mutant);

const SB = path.join(os.tmpdir(), 'alg-merge-' + Date.now());
const env = { ...process.env, AUTH_LOCK_STATE_DIR: SB, RISKY_MATCH_STATE_DIR: SB + '-r', AUTH_LOCK_CONFIG: path.join(SB, 'none.json') };
const spawn = (script, payload) => {
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000, env });
  try { return JSON.parse(r.stdout || '{}'); } catch (e) { return {}; }
};
const db = (srv) => ({ tool_name: 'mcp_call', tool_input: { toolName: 'mcp__dbhub__execute_sql_' + srv, arguments: { sql: 'SELECT 1' } } });
// 先用真实入口把目标打到已拦（注意：Post 载荷必须显式覆盖 hook_event_name，db() 里那个 Pre 会把事件名顶掉）
const post = (resp) => spawnSync(process.execPath, [path.join(DIR, 'auth-lock-guard.js')], {
  input: JSON.stringify({ hook_event_name: 'PostToolUse', ...db('merge_srv'), tool_response: resp }), encoding: 'utf8', timeout: 15000, env,
}).stdout;
post('FATAL:  password authentication failed for user "mergeuser"');
post('FATAL:  password authentication failed for user "mergeuser"');
post('FATAL:  password authentication failed for user "mergeuser"');
const real = spawn(path.join(DIR, 'risky-match-guard.js'), { hook_event_name: 'PreToolUse', ...db('merge_srv') });
const mut = spawn(MF, { hook_event_name: 'PreToolUse', ...db('merge_srv') });
let fail = 0;
const check = (l, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${d ? ' :: ' + String(d).replace(/\s+/g, ' ').slice(0, 90) : ''}`); if (!ok) fail++; };
check('① 真实入口：已拦目标必须 block（前缀 [auth-lock]）', real.decision === 'block' && /^\[auth-lock\]/.test(real.reason || ''), real.reason);
check('② 变异（摘掉委托段）：同一目标不拦 ⇒ 判据 ① 可失败，不是恒绿', mut.decision !== 'block', JSON.stringify(mut).slice(0, 90));
fs.unlinkSync(MF);
try { fs.rmSync(SB, { recursive: true, force: true }); fs.rmSync(SB + '-r', { recursive: true, force: true }); } catch (e) {}
console.log(fail ? '\nFAIL: 变异验证未成立' : '\n变异验证成立：Pre 拦截确实由合并进来的委托段产生');
process.exit(fail ? 1 : 0);
