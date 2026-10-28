'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'fact-ledger.cjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-ledger-test-'));
const CWD_A = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-cwd-a-'));
const CWD_B = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-cwd-b-'));

function run(args, cwd, input) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    input: input === undefined ? '' : input,
    encoding: 'utf8',
    env: { ...process.env, FACT_LEDGER_DIR: ROOT },
    timeout: 10000,
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

test('无事实时 --list 明确提示空', () => {
  const r = run(['--list'], CWD_A);
  assert.equal(r.code, 0);
  assert.match(r.out, /暂无硬事实/);
});

test('--add 后 --list 能读回，重复登记去重', () => {
  assert.equal(run(['--add', '用户要求 TS strict'], CWD_A).code, 0);
  run(['--add', '用户要求 TS strict'], CWD_A);
  const r = run(['--list'], CWD_A);
  assert.match(r.out, /1\. 用户要求 TS strict/);
  assert.equal((r.out.match(/TS strict/g) || []).length, 1, '重复登记不应产生两条');
});

test('超过 12 条按 FIFO 掉最旧的，且序号连续', () => {
  for (let i = 1; i <= 15; i++) run(['--add', 'fact-' + i], CWD_B);
  const r = run(['--list'], CWD_B);
  assert.doesNotMatch(r.out, /fact-1\b|fact-2\b|fact-3\b/, '最旧三条应被挤出');
  assert.match(r.out, /1\. fact-4/);
  assert.match(r.out, /12\. fact-15/);
  assert.match(r.out, /12\/12/);
});

test('超长事实截断到 200 字符以内', () => {
  const long = 'x'.repeat(400);
  run(['--add', long], CWD_B);
  const r = run(['--list'], CWD_B);
  const line = r.out.split('\n').find((l) => l.includes('xxxx'));
  const body = line.replace(/^\s*\d+\.\s*/, '');
  assert.ok(body.length <= 200, '单条事实应被截断到 200 字符内，实际 ' + body.length);
  assert.match(body, /…$/, '截断应有省略号标记');
});

test('--remove 按序号删除，越界退 2', () => {
  assert.equal(run(['--remove', '1'], CWD_B).code, 0);
  assert.equal(run(['--remove', '99'], CWD_B).code, 2);
});

test('--clear 清空且 hook 不再注入', () => {
  run(['--clear'], CWD_B);
  const ev = JSON.stringify({ cwd: CWD_B, hook_event_name: 'UserPromptSubmit' });
  const r = run(['--hook'], CWD_B, ev);
  assert.equal(r.code, 0);
  assert.equal(r.out, '', '无事实时 hook 必须零输出');
});

test('hook 有事实时输出可解析的 additionalContext，且含全部事实', () => {
  run(['--clear'], CWD_A);
  run(['--add', '架构决定：只读子代理', ], CWD_A);
  run(['--add', '禁 any'], CWD_A);
  const ev = JSON.stringify({ cwd: CWD_A, hook_event_name: 'UserPromptSubmit' });
  const r = run(['--hook'], CWD_A, ev);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(j.hookSpecificOutput.additionalContext, /只读子代理/);
  assert.match(j.hookSpecificOutput.additionalContext, /禁 any/);
  assert.match(j.hookSpecificOutput.additionalContext, /2\/12/);
});

test('不同 cwd 互不串味', () => {
  run(['--clear'], CWD_A);
  run(['--clear'], CWD_B);
  run(['--add', 'only-a'], CWD_A);
  const rb = run(['--list'], CWD_B);
  assert.match(rb.out, /暂无硬事实/);
});

test('空 stdin 不崩溃', () => {
  const r = run(['--hook'], CWD_A, '');
  assert.equal(r.code, 0);
});

test('非法 JSON 不崩溃', () => {
  const r = run(['--hook'], CWD_A, 'not-json{{');
  assert.equal(r.code, 0);
});
