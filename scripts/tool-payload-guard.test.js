#!/usr/bin/env node
// tool-payload-guard 自测：单条返回超阈值必须出声；同工具同会话只提醒一次；小返回/非 Post 事件静默。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'tpg-test-'));
const GUARD = path.join(__dirname, 'tool-payload-guard.js');
const LIMIT = 1000;
let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!ok) fail++; };

const run = (payload) => {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, TOOL_PAYLOAD_STATE_DIR: path.join(SB, 'state'), TPG_BYTES: String(LIMIT), NO_TPG: '' },
  });
  let d = {};
  try { d = JSON.parse((r.stdout || '').trim() || '{}'); } catch (e) {}
  return { code: r.status, blocked: d.decision === 'block', reason: d.reason || '', out: r.stdout || '' };
};
const big = (tool, sid) => ({ hook_event_name: 'PostToolUse', tool_name: tool, session_id: sid, tool_response: 'x'.repeat(LIMIT + 10) });

const a = run(big('Read', 's1'));
check('① 超阈值返回必须出声并给出改法', a.code === 0 && a.blocked && /MB/.test(a.reason) && /Grep|摘要/.test(a.reason));
const b = run(big('Read', 's1'));
check('② 同工具同会话只提醒一次（降温）', b.code === 0 && !b.blocked);
const c = run(big('Bash', 's1'));
check('③ 换工具仍提醒', c.blocked);
const d = run({ hook_event_name: 'PostToolUse', tool_name: 'Read', session_id: 's2', tool_response: 'x'.repeat(LIMIT - 10) });
check('④ 未超阈值静默', d.code === 0 && !d.blocked);
const e = run({ hook_event_name: 'PreToolUse', tool_name: 'Read', session_id: 's3', tool_response: 'x'.repeat(LIMIT + 10) });
check('⑤ 非 PostToolUse 事件静默', e.code === 0 && !e.blocked);

const before = (() => { try { return fs.readFileSync(path.join(SB, 'state', 'decisions.log'), 'utf8'); } catch (e) { return ''; } })();
check('⑥ 台账记录了真正的提醒（不是只在 stdout 出现）', /Read\|0\.00MB|Bash\|0\.00MB/.test(before), before.trim().split('\n').slice(-1)[0]);
check('⑦ 沙箱隔离（未写进真机目录）', !fs.existsSync(path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.qoder', 'tmp', 'tool-payload', 'warned-s1.json')));

try { fs.rmSync(SB, { recursive: true, force: true }); } catch (e) {}
console.log(fail ? `\n${fail} 项失败` : '\nALL PASS');
process.exit(fail ? 1 : 0);
