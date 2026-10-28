#!/usr/bin/env node
// fail-streak-guard 自测：**违规必红 + 对照必绿**（沙箱 env 隔离，并断言真实台账跑前跑后逐字节一致）
// 红：同目标按 3 种不同手段连败必须拦；已拦目标 Pre 必须拒；懒加载 mcp_call 形态必须识别目标
// 绿：同一手段重跑不得涨手段集；HTTP 404 不得计数；认证签名必须中性（交 auth-lock）；
//     本地构建/测试失败不得建账；另一主机不受影响；--clear 精确解除
// 用法：node fail-streak-guard.test.js            （逻辑自测；Pre 走 core 直调）
//       node fail-streak-guard.test.js --installed （安装后复验：Pre spawn 真实宿主 risky-match-guard.js）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const SB = path.join(os.tmpdir(), `fail-streak-${Date.now()}`);
const STATE = path.join(SB, 'state');
const INSTALLED = process.argv.includes('--installed');
let fail = 0, total = 0;
const check = (label, ok, detail) => {
  total++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + String(detail).replace(/\s+/g, ' ').slice(0, 160) : ''}`);
  if (!ok) fail++;
};

const reset = () => { try { fs.rmSync(STATE, { recursive: true, force: true }); } catch (e) {} fs.mkdirSync(STATE, { recursive: true }); };
// 真实状态目录快照：沙箱自测**绝不允许**写进 ~/.qoder/tmp（写进去就污染真机门禁）。
// state.json 与 decisions.log 都要盯：allow 类判定只进台账。
const REAL_DIR = path.join(HOME, '.qoder', 'tmp', 'fail-streak-guard');
const snapReal = () => {
  const g = (f) => { try { return fs.readFileSync(path.join(REAL_DIR, f), 'utf8'); } catch (e) { return '<absent>'; } };
  return g('state.json') + '@@' + g('decisions.log');
};
const REAL_BEFORE = snapReal();

// core 的路径在 **require 时**从 process.env 取值固化：必须先把沙箱 env 设好再 require，
// 否则直调 core 的 Pre 断言会读真实 ~/.qoder/tmp（实测：污染真实台账 274 字节，绿16 判红）。
process.env.FAIL_STREAK_STATE_DIR = STATE;
process.env.FAIL_STREAK_CONFIG = path.join(SB, 'no-such-config.json');
const POST_SCRIPT = path.join(__dirname, 'fail-streak-guard.js');
const HOST_PRE = path.join(HOME, '.qoder', 'scripts', 'risky-match-guard.js');
const core = require('./fail-streak-core.js');
const SESS = 'fsttest';

const spawn = (script, payload) => {
  const r = spawnSync(process.execPath, [script], {
    input: payload === undefined ? '' : JSON.stringify(payload),
    encoding: 'utf8', timeout: 15000,
    env: Object.assign({}, process.env, {
      FAIL_STREAK_STATE_DIR: STATE,
      FAIL_STREAK_CONFIG: path.join(SB, 'no-such-config.json'),
      RISKY_MATCH_STATE_DIR: path.join(SB, 'risky-state'),
    }),
  });
  let d = {};
  try { d = JSON.parse(r.stdout || '{}'); } catch (e) {}
  return { code: r.status, blocked: d.decision === 'block', reason: d.reason || '', out: r.stdout || '' };
};
const bash = (cmd) => ({ tool_name: 'Bash', tool_input: { command: cmd } });
const post = (cmd, resp) => spawn(POST_SCRIPT, Object.assign({ hook_event_name: 'PostToolUse', session_id: SESS, tool_response: resp }, bash(cmd)));
// Pre 半边：未安装时直调 core；--installed 时 spawn 真实宿主（测「已不存在的接线」= 假绿）
const pre = (cmd) => {
  if (INSTALLED) {
    const r = spawnSync(process.execPath, [HOST_PRE], {
      input: JSON.stringify(Object.assign({ hook_event_name: 'PreToolUse', session_id: SESS }, bash(cmd))),
      encoding: 'utf8', timeout: 15000,
      env: Object.assign({}, process.env, { FAIL_STREAK_STATE_DIR: STATE, FAIL_STREAK_CONFIG: path.join(SB, 'no-such-config.json'), RISKY_MATCH_STATE_DIR: path.join(SB, 'risky-state') }),
    });
    let d = {}; try { d = JSON.parse(r.stdout || '{}'); } catch (e) {}
    return { blocked: d.decision === 'block', reason: d.reason || '' };
  }
  const x = core.preCheck(Object.assign({ hook_event_name: 'PreToolUse', session_id: SESS }, bash(cmd)));
  return { blocked: !!(x && x.reason), reason: (x && x.reason) || '' };
};
const F1 = 'curl: (7) Failed to connect to 192.0.2.1 port 80 after 2054 ms: Connection refused';
const F2 = 'ssh: connect to host 192.0.2.1 port 22: Operation timed out';
const F3 = 'ping: transmit failed. General error. (No route to host)';
const ledger = () => { try { return fs.readFileSync(path.join(STATE, 'decisions.log'), 'utf8'); } catch (e) { return ''; } };
const stateObj = () => { try { return JSON.parse(fs.readFileSync(path.join(STATE, 'state.json'), 'utf8')); } catch (e) { return { entries: {} }; } };

// —— 1. 必须拦（红）——
reset();
check('红1 手段一（curl）首次失败不拦', post('curl -sS http://192.0.2.1/api', F1).blocked === false && pre('curl -sS http://192.0.2.1/api').blocked === false);
check('红2 手段二（ssh）第二次仍不拦', post('ssh -o ConnectTimeout=5 root@192.0.2.1 systemctl status agent', F2).blocked === false);
const r3 = post('ping -n 2 192.0.2.1', F3);
check('红3 第三种不同手段必须出声', r3.blocked === true, r3.reason);
check('红4 reason 必须带 [fail-streak] 归因前缀', /^\[fail-streak\]/.test(r3.reason));
check('红5 已拦目标第四次调用 Pre 必须拒', pre('wget -q -O - http://192.0.2.1/x').blocked === true);
check('红6 台账记录三种新手段', (ledger().match(/streak-new\|192\.0\.2\.1/g) || []).length === 3, ledger().split('\n').slice(-4).join(' | '));
check('红7 台账记录本轮拦截', /block\|192\.0\.2\.1/.test(ledger()));
check('红8 状态里该目标 blocked=true 且手段集=3', (stateObj().entries['192.0.2.1:-'] || {}).blocked === true && Object.keys(((stateObj().entries['192.0.2.1:-'] || {}).means) || {}).length === 3);

// —— 2. 对照必须绿 ——
reset();
const rep1 = post('curl -sS http://192.0.2.1/api', F1);
const rep2 = post('curl -sS http://192.0.2.1/api', F1);
const rep3 = post('curl -sS http://192.0.2.1/api', F1);
check('绿1 同一手段重跑三次不涨手段集（用户口径「重跑同一手段不计」）',
  rep1.blocked === false && rep2.blocked === false && rep3.blocked === false && Object.keys((stateObj().entries['192.0.2.1:-'] || {}).means || {}).length === 1);
check('绿2 台账区分 new / repeat', /streak-new\|192\.0\.2\.1/.test(ledger()) && (ledger().match(/streak-repeat\|192\.0\.2\.1/g) || []).length === 2);

reset();
const nf = post('curl -i http://198.51.100.9/nope', 'HTTP/1.1 404 Not Found\ncontent-length: 0');
check('绿3 拿到响应的 404 必须不计数（故意构造的负对照不能被门禁吃掉）', nf.blocked === false && !stateObj().entries['198.51.100.9:-']);
reset();
const au = post('psql -h 192.0.2.7 -U probe -d appdb -c "SELECT 1"', 'FATAL: password authentication failed for user "probe"');
check('绿4 认证签名对本守卫中性（签名互斥，计数归 auth-lock）', au.blocked === false && !stateObj().entries['192.0.2.7:-']);
reset();
post('mvn -q test', '[ERROR] Tests run: 12, Failures: 3 [ERROR] BUILD FAILURE');
post('npm run build', 'exit status 1  error TS2304: Cannot find name');
post('pytest -q', 'FAILED tests/test_x.py::test_y - assert 1 == 2');
check('绿5 本地构建/测试类失败完全不建账（噪声防线）', Object.keys(stateObj().entries).length === 0 && !/mvn|npm|pytest/.test(ledger()));
reset();
const noTarget = post('ls -la', 'total 0');
check('绿6 无远程入口特征不建账', noTarget.blocked === false && Object.keys(stateObj().entries).length === 0);

// —— 3. 目标隔离 ——
reset();
post('curl -sS http://192.0.2.1/api', F1);
post('ssh root@192.0.2.1 systemctl status agent', F2);
post('ping -n 2 192.0.2.1', F3);
check('红9 另一主机不受已拦目标影响', pre('curl -sS http://203.0.113.4/health').blocked === false);
check('红10 已拦目标换工具仍拦（拦的是目标不是工具）', pre('telnet 192.0.2.1 80').blocked === true);

// —— 4. 懒加载 mcp_call 形态 ——
reset();
const lazy = spawn(POST_SCRIPT, {
  hook_event_name: 'PostToolUse', session_id: SESS,
  tool_name: 'mcp_call', tool_input: { toolName: 'mcp__node-repl__node_repl', arguments: { command: 'curl -sS http://192.0.2.1/api' } },
  tool_response: F1,
});
check('红11 懒加载形态（真名在 tool_input.toolName、参数在 arguments）必须识别目标',
  !lazy.blocked && Object.keys(stateObj().entries).length === 1 && !!stateObj().entries['192.0.2.1:-']);

// —— 5. 成功清零 + 人工解封 ——
reset();
post('curl -sS http://192.0.2.1/api', F1);
post('ssh root@192.0.2.1 systemctl status agent', F2);
check('绿12 连接成功必须清零未拦目标', post('curl -sS http://192.0.2.1/api', '{"ok":true}').blocked === false && !stateObj().entries['192.0.2.1:-']);
reset();
post('curl -sS http://192.0.2.1/api', F1);
post('ssh root@192.0.2.1 systemctl status agent', F2);
post('ping -n 2 192.0.2.1', F3);
const clearOne = (() => {
  const r = spawnSync(process.execPath, [POST_SCRIPT, '--clear', '192.0.2.1:-'], { encoding: 'utf8', env: Object.assign({}, process.env, { FAIL_STREAK_STATE_DIR: STATE, FAIL_STREAK_CONFIG: path.join(SB, 'no-such-config.json') }) });
  let d = {}; try { d = JSON.parse(r.stdout || '{}'); } catch (e) {}
  return d;
})();
check('绿13 --clear <key> 精确解除后放行', clearOne.cleared === 1 && pre('curl -sS http://192.0.2.1/api').blocked === false);
check('绿14 --clear ALL 幂等（无条目时 cleared=0）', (() => {
  const r = spawnSync(process.execPath, [POST_SCRIPT, '--clear', 'ALL'], { encoding: 'utf8', env: Object.assign({}, process.env, { FAIL_STREAK_STATE_DIR: STATE, FAIL_STREAK_CONFIG: path.join(SB, 'no-such-config.json') }) });
  let d = {}; try { d = JSON.parse(r.stdout || '{}'); } catch (e) {}
  return d.cleared === 0;
})());

// —— 6. 台账非空（守卫真跑过的唯一证据）——
check('红15 台账非空且含本轮目标', ledger().length > 0 && /192\.0\.2\.1/.test(ledger()));

// —— 7. 沙箱隔离：真实台账跑前跑后逐字节一致 ——
check('绿16 真实 ~/.qoder/tmp/fail-streak-guard 未被自测污染（逐字节一致）', snapReal() === REAL_BEFORE, 'before=' + REAL_BEFORE.length + ' after=' + snapReal().length);

try { fs.rmSync(SB, { recursive: true, force: true }); } catch (e) {}
// 条数由计数器得出：手写数字会在加了一条断言之后变成"看起来对"的过期口径（这里曾长期写着 16，实际 22）
console.log(fail === 0 ? `\nALL GREEN (${total} 组判据)` : `\nRED: ${fail}/${total} 组判据未过`);
process.exit(fail === 0 ? 0 : 1);
