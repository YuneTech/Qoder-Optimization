#!/usr/bin/env node
// fail-streak 变异验证：**每条关键判据做一次「破坏它」的变异，变异后行为必须翻转**。
// 翻不过来 ⇒ 上一条自测里的那条断言是恒真断言（假绿），守卫其实没在守。
//
// 变异体一律写在**被测脚本同目录**（落到 os.tmpdir() 会让 `__dirname` 解析不到 core，
// 表现为成片假红，然后你会去查一个不存在的缺陷——本机踩过）。跑完即删。
// 每个变异体先跑一次原始实现拿基线，确认基线行为符合预期，再确认变异把它翻掉。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const SB = path.join(os.tmpdir(), `fst-mut-${Date.now()}`);
const STATE = path.join(SB, 'state');
fs.mkdirSync(STATE, { recursive: true });
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const REAL_DIR = path.join(HOME, '.qoder', 'tmp', 'fail-streak-guard');

const CORE = path.join(DIR, 'fail-streak-core.js');
const GUARD = path.join(DIR, 'fail-streak-guard.js');
const F1 = 'curl: (7) Failed to connect to 192.0.2.1 port 80: Connection refused';
const F2 = 'ssh: connect to host 192.0.2.1 port 22: Operation timed out';
const F3 = 'ping: transmit failed. General error. (No route to host)';
const CMDS = ['curl -sS http://192.0.2.1/api', 'ssh -o ConnectTimeout=5 root@192.0.2.1 systemctl status agent', 'ping -n 2 192.0.2.1'];

let fail = 0, total = 0;
const check = (label, ok, detail) => {
  total++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + String(detail).replace(/\s+/g, ' ').slice(0, 150) : ''}`);
  if (!ok) fail++;
};

function run(guardPath, cmd, resp, opts) {
  const o = opts || {};
  const env = Object.assign({}, process.env, {
    FAIL_STREAK_STATE_DIR: o.stateDir || STATE,
    FAIL_STREAK_CONFIG: o.config || path.join(SB, 'no-such-config.json'),
  });
  if (o.dropStateEnv) delete env.FAIL_STREAK_STATE_DIR;   // 变异：去掉沙箱隔离
  const r = spawnSync(process.execPath, [guardPath], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'mut', tool_name: 'Bash', tool_input: { command: cmd }, tool_response: resp }),
    encoding: 'utf8', timeout: 15000, env,
  });
  let d = {}; try { d = JSON.parse(r.stdout || '{}'); } catch (e) {}
  return { blocked: d.decision === 'block', reason: d.reason || '', out: r.stdout || '' };
}
function drive(guardPath, cmds, resp, opts) {
  // resp 必须有默认值：payload 里缺 tool_response 会被 postRecord 当成「拿到响应＝成功」，
  // 于是基线永远不拦——首轮就因为这个把套件自己的 bug 误读成「守卫假绿」（红先归因自己算错）
  const list = cmds || CMDS, text = resp || F1;
  const last = list.map((c) => run(guardPath, c, text, opts));
  return last[last.length - 1];
}
function resetState() { try { fs.rmSync(STATE, { recursive: true, force: true }); } catch (e) {} fs.mkdirSync(STATE, { recursive: true }); }
function writeMut(name, src) { const p = path.join(DIR, name); fs.writeFileSync(p, src); return p; }
function rmMut(p) { try { fs.unlinkSync(p); } catch (e) {} }
const realSnap = () => { const g = (f) => { try { return fs.readFileSync(path.join(REAL_DIR, f), 'utf8'); } catch (e) { return '<absent>'; } }; return g('state.json') + '@@' + g('decisions.log'); };
// 状态与台账读法：基线与变异各跑一轮后要**逐轮**比对，只看最后一轮会不会出声看不出「建没建账」
const stateFile = () => path.join(STATE, 'state.json');
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (e) { return { entries: {} }; } };
const entryCount = () => Object.keys(readState().entries || {}).length;
const blockedOf = (k) => ((readState().entries || {})[k] || {}).blocked === true;
const ledgerText = () => { try { return fs.readFileSync(path.join(STATE, 'decisions.log'), 'utf8'); } catch (e) { return ''; } };

// —— 变异 1：摘掉 Post 入口的「出声」——（证明拦截真的来自这一行）
{
  resetState();
  const base = drive(GUARD);
  const p = writeMut('__mut1_quiet.js', fs.readFileSync(GUARD, 'utf8').replace("if (r && r.reason) out({ decision: 'block', reason: r.reason });", '/* mutant: silenced */'));
  resetState();
  const mut = drive(p);
  check('变异1 摘掉 Post 出声 → 第三种手段不再拦（基线拦、变异放行）', base.blocked === true && mut.blocked === false, 'base=' + base.blocked + ' mutant=' + mut.blocked);
  rmMut(p);
}

// —— 变异 2：去掉沙箱 env 隔离 → 真实台账必须被改动（证明「逐字节一致」那条断言不是恒真）——
{
  const before = realSnap();
  resetState();
  const isolated = drive(GUARD, ['curl -sS http://198.51.100.251/api'], F1, {});
  const untouched = realSnap() === before;
  const noIso = drive(GUARD, ['curl -sS http://198.51.100.251/api'], F1, { dropStateEnv: true });
  const polluted = realSnap() !== before;
  check('变异2 去掉 env 隔离 → 真实台账出现改动；带隔离时逐字节不变', untouched && polluted && isolated.blocked === false && noIso.blocked === false,
    'untouched=' + untouched + ' polluted=' + polluted);
  // 变异体故意写进真实目录的那条测试目标必须清干净
  try { const core = require(GUARD.replace('fail-streak-guard.js', 'fail-streak-core.js')); void core; } catch (e) {}
  try {
    const st = path.join(REAL_DIR, 'state.json');
    if (fs.existsSync(st)) { const j = JSON.parse(fs.readFileSync(st, 'utf8')); delete (j.entries || {})['198.51.100.251:-']; fs.writeFileSync(st, JSON.stringify(j, null, 1)); }
    const lg = path.join(REAL_DIR, 'decisions.log');
    if (fs.existsSync(lg)) fs.writeFileSync(lg, fs.readFileSync(lg, 'utf8').split('\n').filter((l) => !/198\.51\.100\.251/.test(l)).join('\n'));
  } catch (e) {}
}

// —— 变异 3：阈值调成不可能命中 → 必须放行（证明阈值不是摆设）——
{
  resetState();
  const base = drive(GUARD);
  const cfgp = path.join(SB, 'threshold99.json');
  fs.writeFileSync(cfgp, JSON.stringify({ threshold: 99 }));
  resetState();
  const mut = drive(GUARD, CMDS, F1, { config: cfgp });
  check('变异3 threshold=99 → 三种手段也不拦（默认阈值 3 确实在起作用）', base.blocked === true && mut.blocked === false);
}

// —— 变异 4：破坏 meansOf 去重 → 同一手段重跑也涨（证明「重跑同一手段不计」来自该函数）——
{
  resetState();
  const baseReps = drive(GUARD, [CMDS[0], CMDS[0], CMDS[0]], F1);
  const mutCore = writeMut('__mut4_core.js', fs.readFileSync(CORE, 'utf8').replace(
    "return head + '|' + sub + '|' + flags.join(',');",
    "return head + '|' + sub + '|' + flags.join(',') + '|' + Date.now() + Math.random();"));
  const mutGuard = writeMut('__mut4_guard.js', fs.readFileSync(GUARD, 'utf8').replace("require('./fail-streak-core.js')", "require('./__mut4_core.js')"));
  resetState();
  const mutReps = drive(mutGuard, [CMDS[0], CMDS[0], CMDS[0]], F1);
  check('变异4 meansOf 不去重 → 同手段重跑三次就拦（基线不拦，用户口径得到机制保证）', baseReps.blocked === false && mutReps.blocked === true);
  rmMut(mutCore); rmMut(mutGuard);
}

// —— 变异 5：摘掉认证签名中性短路 → 认证失败被本守卫计数（与 auth-lock 双计）——
// 报错文本必须**同时**命中 AUTHISH 与 TRANSPORT_FAIL。真实 MySQL 1045 正是这种重叠形态
// （`Access denied for user ... (2002: Connection refused)`）；只写 `password authentication failed`
// 时 anyFail=false，变异体也走不到计数分支 ⇒ 断言恒不翻转＝空断言（第一版踩过这个坑）。
{
  const AUTH_X_TRANSPORT = "ERROR 1045 (28000): Access denied for user 'probe'@'192.0.2.6' (2002: Connection refused)";
  const AUTH_CMDS = ['psql -h 192.0.2.6 -U probe -d appdb -c "SELECT 1"', 'sqlplus probe@192.0.2.6 appdb', 'mysql -h 192.0.2.6 -u probe -e "SELECT 1"'];
  resetState();
  const base = AUTH_CMDS.map((c) => run(GUARD, c, AUTH_X_TRANSPORT));
  const baseNeutral = base.every((x) => !x.blocked) && entryCount() === 0 && /neutral\|192\.0\.2\.6/.test(ledgerText());
  const mutCore = writeMut('__mut5_core.js', fs.readFileSync(CORE, 'utf8').replace(
    'if (AUTHISH.test(text) || GATED.test(text)) {', 'if (false) {'));
  const mutGuard = writeMut('__mut5_guard.js', fs.readFileSync(GUARD, 'utf8').replace("require('./fail-streak-core.js')", "require('./__mut5_core.js')"));
  resetState();
  const mut = AUTH_CMDS.map((c) => run(mutGuard, c, AUTH_X_TRANSPORT));
  check('变异5 摘掉认证中性 → 认证+连接层重叠签名被本守卫计数到拦（基线三次全中性、entries=0，两套签名互斥）',
    baseNeutral && mut[0].blocked === false && mut[1].blocked === false && mut[2].blocked === true && entryCount() === 1,
    'baseNeutral=' + baseNeutral + ' mut=' + mut.map((x) => x.blocked).join(',') + ' entries=' + entryCount());
  rmMut(mutCore); rmMut(mutGuard);
}

// —— 变异 6：摘掉本地构建/测试排除 → 「本地命令里打远程」的失败也建账（噪声防线失效）——
// 命令必须**首 token 属本地类、正文真的在打远程**（make/python/gradle 包 curl/ssh/wget）：
// 只写 `mvn -q test` 时摘掉排除也没有远程入口特征，同样永远不翻转＝又是空断言。
{
  const LOCAL_CMDS = ['make deploy curl http://192.0.2.4/api', 'python test_remote.py ssh http://192.0.2.4/api', 'gradle -q check wget http://192.0.2.4/api'];
  const T6 = '[ERROR] deploy failed: curl: (7) Failed to connect to 192.0.2.4 port 80: Connection refused';
  resetState();
  const base = LOCAL_CMDS.map((c) => run(GUARD, c, T6));
  const baseClean = base.every((x) => !x.blocked) && entryCount() === 0 && !/192\.0\.2\.4/.test(ledgerText());
  const mutCore = writeMut('__mut6_core.js', fs.readFileSync(CORE, 'utf8').replace('if (LOCAL_ONLY.test(cmd)) return null;', 'if (false) return null;'));
  const mutGuard = writeMut('__mut6_guard.js', fs.readFileSync(GUARD, 'utf8').replace("require('./fail-streak-core.js')", "require('./__mut6_core.js')"));
  resetState();
  const mut = LOCAL_CMDS.map((c) => run(mutGuard, c, T6));
  check('变异6 摘掉本地排除 → 「本地命令里打远程」三种手段就拦（基线完全不建账）',
    baseClean && mut[0].blocked === false && mut[1].blocked === false && mut[2].blocked === true && entryCount() === 1,
    'baseClean=' + baseClean + ' mut=' + mut.map((x) => x.blocked).join(',') + ' entries=' + entryCount());
  rmMut(mutCore); rmMut(mutGuard);
}

// —— 变异 7：摘掉远程入口 gate → 引用文本被抽成假目标 ——
{
  resetState();
  const baseRef = run(GUARD, 'grep -rn "curl http://192.0.2.8/api" docs/', 'docs/a.md:3: curl http://192.0.2.8/api');
  const mutCore = writeMut('__mut7_core.js', fs.readFileSync(CORE, 'utf8').replace('if (!REMOTE_ENTRY.test(cmd)) return null;', 'if (false) return null;'));
  const mutGuard = writeMut('__mut7_guard.js', fs.readFileSync(GUARD, 'utf8').replace("require('./fail-streak-core.js')", "require('./__mut7_core.js')"));
  resetState();
  const mutRef = run(mutGuard, 'grep -rn "curl http://192.0.2.8/api" docs/', 'docs/a.md:3: curl http://192.0.2.8/api');
  void mutRef;
  const stMut = path.join(STATE, 'state.json');
  // grep 首 token 命中 LOCAL_ONLY，所以这个变异要连本地排除一起摘才露出假目标
  rmMut(mutCore); rmMut(mutGuard);
  const mutCore2 = writeMut('__mut7b_core.js', fs.readFileSync(CORE, 'utf8')
    .replace('if (!REMOTE_ENTRY.test(cmd)) return null;', 'if (false) return null;')
    .replace('if (LOCAL_ONLY.test(cmd)) return null;', 'if (false) return null;'));
  const mutGuard2 = writeMut('__mut7b_guard.js', fs.readFileSync(GUARD, 'utf8').replace("require('./fail-streak-core.js')", "require('./__mut7b_core.js')"));
  resetState();
  drive(mutGuard2, ['grep -rn "curl http://192.0.2.8/api" docs/', 'rg -n "plink -host 192.0.2.8" docs/', 'sed -n "10p" note.txt'], 'no match found ssh: connect to host 192.0.2.8 port 22: timed out');
  const mutHasFakeKey = (() => { try { return Object.keys(JSON.parse(fs.readFileSync(stMut, 'utf8')).entries).length > 0; } catch (e) { return false; } })();
  resetState();
  drive(GUARD, ['grep -rn "curl http://192.0.2.8/api" docs/', 'rg -n "plink -host 192.0.2.8" docs/', 'sed -n "10p" note.txt'], 'no match found ssh: connect to host 192.0.2.8 port 22: timed out');
  const baseHasFakeKey = (() => { try { return Object.keys(JSON.parse(fs.readFileSync(stMut, 'utf8')).entries).length > 0; } catch (e) { return false; } })();
  check('变异7 摘掉远程 gate → 文档里的引用文本被建成假目标（基线不建）', baseHasFakeKey === false && mutHasFakeKey === true, 'base=' + baseHasFakeKey + ' mutant=' + mutHasFakeKey);
  rmMut(mutCore2); rmMut(mutGuard2);
}

// —— 变异 8：摘掉「已拦目标不因一次看起来成功自动解封」的 blocked 保护 ——
// 解封只能是人的决定：一次 `{"ok":true}`（可能打到别的进程、或被网关/缓存挡回来的假绿灯）
// 就把 blocked 抹掉，等于让门禁被它最该防的那类误判绕过。
{
  resetState();
  drive(GUARD);                                                     // 三种不同手段打满 → blocked
  const baseBlockedBefore = blockedOf('192.0.2.1:-');
  const baseOk = run(GUARD, CMDS[0], '{"ok":true}');
  const baseKept = baseBlockedBefore === true && baseOk.blocked === false && blockedOf('192.0.2.1:-') === true && entryCount() === 1;
  const mutCore = writeMut('__mut8_core.js', fs.readFileSync(CORE, 'utf8').replace(
    'if (s.entries[t.key] && !s.entries[t.key].blocked) {', 'if (s.entries[t.key]) {'));
  const mutGuard = writeMut('__mut8_guard.js', fs.readFileSync(GUARD, 'utf8').replace("require('./fail-streak-core.js')", "require('./__mut8_core.js')"));
  resetState();
  drive(mutGuard);
  const mutBlockedBefore = blockedOf('192.0.2.1:-');
  run(mutGuard, CMDS[0], '{"ok":true}');
  const mutAutoUnblocked = mutBlockedBefore === true && blockedOf('192.0.2.1:-') === false && entryCount() === 0;
  check('变异8 摘掉 blocked 保护 → 一次 {"ok":true} 就把已拦目标自动解封（基线必须仍 blocked=true）',
    baseKept && mutAutoUnblocked, 'baseKept=' + baseKept + ' mutBlockedBefore=' + mutBlockedBefore + ' mutAutoUnblocked=' + mutAutoUnblocked);
  rmMut(mutCore); rmMut(mutGuard);
}

try { fs.rmSync(SB, { recursive: true, force: true }); } catch (e) {}
const leftovers = fs.readdirSync(DIR).filter((f) => /__mut\d/.test(f));
check('收尾 变异体全部删除（不留半成品在技能目录里）', leftovers.length === 0, leftovers.join(','));
console.log(fail === 0 ? `\n变异验证全绿：${total} 项判据（变异 + 收尾残留检查）都能被破坏` : `\nRED: ${fail}/${total} 项没有翻转行为 —— 对应断言是假绿`);
process.exit(fail === 0 ? 0 : 1);
