#!/usr/bin/env node
// commit-scope-guard 的自检：每条都要能失败，且**必须在真 git 仓库上跑**——
// 这个守卫的判断依据是"工作区还有没有未提交改动"，桩不出来就等于没判。
// 用法：node scripts/commit-scope-guard.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const HOOK = path.join(__dirname, 'commit-scope-guard.js');

function run(payload, cwd) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: cwd || process.cwd(),
    timeout: 8000,
  });
  let verdict = null;
  const line = (r.stdout || '').trim();
  if (line) {
    try {
      verdict = JSON.parse(line).hookSpecificOutput.permissionDecision;
    } catch (e) {
      verdict = `unparsable:${line.slice(0, 60)}`;
    }
  }
  return { verdict, status: r.status };
}

function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-scope-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.invalid']);
  git(['config', 'user.name', 't']);
  git(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(dir, 'clean.md'), 'a\n');
  fs.writeFileSync(path.join(dir, '台账.md'), 'one\n');
  git(['add', '.']);
  git(['commit', '-qm', 'seed']);
  // 只把「台账.md」弄脏：模拟并行会话在这个共享文件里有在途改动
  fs.writeFileSync(path.join(dir, '台账.md'), 'one\ntwo\n');
  return dir;
}

const cases = [];
function it(name, fn) { cases.push([name, fn]); }

it('非 Bash 工具直接放行', () => {
  const r = run({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x' } });
  assert.strictEqual(r.verdict, null, `不该有任何判定，实际 ${r.verdict}`);
});

it('普通命令放行', () => {
  const r = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' } });
  assert.strictEqual(r.verdict, null);
});

it('不带 pathspec 的 git commit 放行（守卫不管这条路径）', () => {
  const r = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
  assert.strictEqual(r.verdict, null);
});

it('pathspec 指向"工作区已脏"的文件 ⇒ deny', () => {
  const dir = fixtureRepo();
  const r = run({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git commit -q -m msg -- 台账.md', dir_path: dir },
  }, dir);
  assert.strictEqual(r.verdict, 'deny', '共享文件有在途改动时带 pathspec，必须拦');
});

it('pathspec 指向干净文件 ⇒ 放行（不能误伤常规提交）', () => {
  const dir = fixtureRepo();
  const r = run({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git commit -q -m msg -- clean.md', dir_path: dir },
  }, dir);
  assert.strictEqual(r.verdict, null, '干净文件用 pathspec 提交是本仓库常规做法');
});

it('git 把中文路径打成八进制转义时仍然拦得住', () => {
  const dir = fixtureRepo();
  const r = run({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git commit -q -m msg -- "\\345\\217\\260\\350\\264\\246.md"', dir_path: dir },
  }, dir);
  assert.strictEqual(r.verdict, 'deny', 'basename 比对要扛住 git 的八进制转义');
});

it('cwd 不是 git 仓库时 fail-open（守卫自己坏了不能卡住会话）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
  const r = run({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git commit -q -m msg -- 台账.md', dir_path: dir },
  }, dir);
  assert.notStrictEqual(r.verdict, 'unparsable:');
  assert.ok(r.verdict === null || r.verdict === 'deny');
  assert.strictEqual(r.status, 0, '异常路径也必须正常退出');
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}
console.log(`[commit-scope-guard.test] ${cases.length - failed}/${cases.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
