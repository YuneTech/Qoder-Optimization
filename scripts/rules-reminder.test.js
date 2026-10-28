#!/usr/bin/env node
// rules-reminder.js 的自测：每轮提醒是"最易被忽略的纪律"的唯一兜底，它自己坏了不该没人知道。
// 判据（任一不成立即 exit 1）：
//   ① 合法 UserPromptSubmit 载荷 → 退出码 0、stdout 是合法 JSON、形状为 hookSpecificOutput.additionalContext
//   ② 提醒正文含 10 条要素与两条**本轮强化的判据**（声明下一步就当场做 / 裁决先弹窗）
//   ③ 空 stdin（宿主异常）也必须照样注入——注入不能依赖载荷内容
//   ④ 心跳日志追加了一行（"机制在跑"的可观测证据）
//   ⑤ 对照组：删掉一条要素的"假提醒"必须被判红（证明 ② 的断言真能失败）
//   ⑥⑦⑧ 请求原文回注：有 prompt 必须在注入块末尾带回原文；无 prompt 只许印"未取到"（不许印"用户没提问"）；超长必须截断
// 用法: node rules-reminder.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'rules-reminder.js');
const SB = path.join(os.tmpdir(), `reminder-sb-${Date.now()}`);
const HOME = path.join(SB, 'home');
fs.mkdirSync(path.join(HOME, '.qoder', 'scripts'), { recursive: true });

let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!ok) fail++; };

const run = (input) => spawnSync(process.execPath, [SCRIPT], {
  input,
  encoding: 'utf8',
  timeout: 15000,
  env: { ...process.env, USERPROFILE: HOME, HOME },
});

const MARKERS = ['简体中文', '不随意停止', '需拍板', '验证要能失败', '先备份', '先只读预览命中范围', '明确结论', 'Vibecoding 两问', '目标模式', '过程落盘', '领域与流程纪律'];
const STRENGTHENED = ['只读', '不重复确认', '不得通过换工具', '零文件写入', '不适用记 N/A'];
const checkText = (text, expected) => MARKERS.concat(STRENGTHENED).every((k) => expected ? text.includes(k) : true);

// ① 合法载荷
const r1 = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'sid-1', cwd: 'X:/x' }));
let ctx = '';
try { ctx = JSON.parse(r1.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('① 合法载荷 → exit 0 + 合法 JSON + 形状正确',
  r1.status === 0 && /hookSpecificOutput/.test(r1.stdout) && ctx.length > 100, `exit=${r1.status}`);

// ② 要素完整（含本轮强化的两条）
const missing = MARKERS.concat(STRENGTHENED).filter((k) => !ctx.includes(k));
check('② 10 条要素 + 2 条强化判据齐全', missing.length === 0, missing.length ? '缺 ' + missing.join(',') : '');

// ③ 空 stdin 也要注入
const r3 = run('');
let ctx3 = '';
try { ctx3 = JSON.parse(r3.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('③ 空 stdin → 仍注入且 exit 0', r3.status === 0 && ctx3 === ctx, `exit=${r3.status}`);

// ④ 心跳日志
const LOG = path.join(HOME, '.qoder', 'scripts', 'rules-reminder.log');
const lines = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n') : [];
check('④ 心跳日志追加了带 ok 的行', lines.length >= 2 && /\d{4}-\d{2}-\d{2}T.*ok/.test(lines[lines.length - 1]), `行数=${lines.length}`);

// ⑤ 对照组：把"声明下一步"那条从文本里拿掉，② 的断言必须能红
check('⑤ 对照组：缺一条要素时必须能判红', !checkText(ctx.replace('零文件写入', ''), true), '（断言可失败性）');

// ⑥ 请求原文回注（缺陷来源：2026-09-24 会话 19586a9b，正文已在请求内、模型却判成"正文是空的"）
const P6 = '帮我检查一下，为什么我的edge动不动就无法访问网页了';
const r6 = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: P6 }));
let ctx6 = '';
try { ctx6 = JSON.parse(r6.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('⑥ 有 prompt → 注入块末尾回注请求原文',
  r6.status === 0 && ctx6.includes('【本轮请求摘要 · 可能截断，完整用户消息为准】' + P6) && !ctx6.includes('以此为准'), `exit=${r6.status}`);

// ⑦ 两个方向都要钉住：取不到才印"未取到"，取到就不许印；且回注行必须真的来自载荷
check('⑦ 对照组：无 prompt 印"未取到" / 有 prompt 不得印，且两者输出确有差异',
  ctx.includes('未取到 prompt 字段') && !ctx6.includes('未取到 prompt 字段') && ctx6 !== ctx, '');

// ⑧ 超长载荷截断（防注入块被一次大粘贴撑爆）——断言回注片段本身被截断，不依赖提醒正文长度
const r8 = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'A'.repeat(500) }));
let ctx8 = '';
try { ctx8 = JSON.parse(r8.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
const echo8 = (ctx8.split('【本轮请求摘要 · 可能截断，完整用户消息为准】')[1] || '').split('\n')[0];
check('⑧ prompt 超 300 字 → 回注片段被截断加省略号',
  echo8.length > 0 && echo8.length <= 302 && echo8.endsWith('…') && ctx8.length < ctx.length + 400,
  `回注片段=${echo8.length}B 注入块=${ctx8.length}B`);

const restricted = run(JSON.stringify({ prompt: 'A'.repeat(420) + '不得修改任何文件。' }));
const restrictedCtx = JSON.parse(restricted.stdout).hookSpecificOutput.additionalContext;
check('⑨ 长请求摘要不冒充完整授权', !restrictedCtx.includes('以此为准') && restrictedCtx.includes('完整用户消息为准') && restrictedCtx.includes('禁止项和批准条件'));

// ⑩⑪ 抑制提醒（2026-10-27）：门禁因滑动窗上限放行时必须让"这一段在放行"可见，且同批只提醒一次
const gateDir = path.join(HOME, '.qoder', 'tmp', 'stop-gate');
fs.mkdirSync(gateDir, { recursive: true });
const nowIso = new Date().toISOString();
fs.writeFileSync(path.join(gateDir, 'violations.log'), [
  nowIso + '|R2-decision-without-popup-SUPPRESSED|sess=abcd|hash=1|len=100',
  nowIso + '|R3-ui-claim-without-evidence-SUPPRESSED|sess=abcd|hash=2|len=100',
].join('\n') + '\n');
const r10 = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '继续' }));
let ctx10 = '';
try { ctx10 = JSON.parse(r10.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('⑩ 有抑制放行记录 → 必须提醒一次并带规则计数',
  r10.status === 0 && ctx10.includes('抑制提醒') && ctx10.includes('R2-decision-without-popup×1'), `exit=${r10.status}`);
const r11 = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '继续' }));
let ctx11 = '';
try { ctx11 = JSON.parse(r11.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('⑪ 对照组：同一批抑制不重复提醒', r11.status === 0 && !ctx11.includes('抑制提醒'), '');
try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}

console.log(fail ? `\n${fail} 项失败` : '\nALL PASS');
process.exit(fail ? 1 : 0);
