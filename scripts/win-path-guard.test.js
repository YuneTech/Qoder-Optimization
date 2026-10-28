#!/usr/bin/env node
// win-path-guard.js 自测：正例（该拦）与负例（不该拦）必须分得干净。
// 正例取自 2026-10-26 真实事故：node -e 里 4 层反斜杠被折成 `C:Users...`，wscript 摆出错误对话框。
//   node ~/.qoder/scripts/win-path-guard.test.js   → 全绿退 0，任一失败退 1
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'win-path-guard.js');
const SB = path.join(os.homedir(), '.wpg-sandbox');
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(path.join(SB, '.qoder'), { recursive: true });

let fail = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`);
  if (!ok) fail++;
};

function run(command, opts = {}) {
  const env = { ...process.env, USERPROFILE: SB, HOME: SB, WIN_PATH_GUARD_STATE_DIR: path.join(SB, 'state'), ...opts.env };
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    env,
    encoding: 'utf8',
  });
  let out = null;
  try { out = JSON.parse((r.stdout || '').trim() || 'null'); } catch {}
  return { decision: out && out.decision, reason: (out && out.reason) || '', code: r.status,
    deny: out && out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision };
}

const CASES_BLOCK = [
  ['事故原形：node -e + 4 层反斜杠盘符路径',
    String.raw`node -e "const cp=require('child_process');cp.spawn('wscript.exe',['C:\\\\proj\\\\x\\\\a.vbs'])"]`],
  ['单层错：node -p 里直接用 C:\\proj（JS 会吃反斜杠）',
    String.raw`node -p "require('fs').readFileSync('D:\\tmp\\x.txt','utf8')"`],
  ['node -e 里拼 VBS 三引号',
    String.raw`node -e "const t='sh.Run \"\"\"C:/x/a.exe\"\"\"'"`],
  ['heredoc 往 .vbs 写单反斜杠路径',
    'cat > /d/tmp/a.vbs <<\'EOF\'\nSet sh = CreateObject("WScript.Shell")\nsh.Run "D:\\software\\node24\\node.exe"\nEOF'],
];

const CASES_ALLOW = [
  ['正斜杠路径（Node 在 Windows 认）', `node -e "const p=require('path').join('C:/proj','x');console.log(p)"`],
  ['正则转义，不是盘符路径', String.raw`node -e "console.log(/\d+/.test('12'))"`],
  // 2026-10-27 实测误拦：`description:\s` 里的 `n:\` 被当成盘符；内联测量脚本因此被拦
  ['JS 正则里的 description:\\s（n 后面跟冒号+反斜杠）', String.raw`node -e "const r=/description:\s*([\s\S]*?)/;console.log(r)"`],
  ['https 之后的冒号不是盘符', String.raw`node -e "console.log('https:\\example.com')"`],
  ['跑本地脚本文件', 'node ~/.qoder/scripts/byok-ua-proxy.js'],
  ['命令行普通参数带 Windows 路径（bash 自己处理引号）', String.raw`ls "C:\proj\src"`],
  ['heredoc 写 .js 且正确写成双反斜杠', 'cat > /d/tmp/a.js <<\'EOF\'\nconst p = \'C:\\\\\\\\proj\\\\\\\\x\';\nEOF'],
  ['只读搜索带反斜杠关键字', String.raw`grep -rn "C:\\proj" ~/.qoder/memory`],
  ['非脚本扩展名的文本重定向', 'echo "D:\\software\\x" > /d/tmp/note.txt'],
];

for (const [label, cmd] of CASES_BLOCK) {
  const r = run(cmd);
  check('BLOCK ' + label, r.decision === 'block' && r.deny === 'deny', r.decision + '/' + r.deny || r.reason);
}
for (const [label, cmd] of CASES_ALLOW) {
  const r = run(cmd);
  check('ALLOW ' + label, r.decision !== 'block', r.decision || '');
}

fs.writeFileSync(path.join(SB, '.qoder', 'win-path-guard.json'), '{"mode":"warn"}');
const warn = run(CASES_BLOCK[0][1]);
check('WARN 档只提醒不拦', warn.decision === 'approve' && /warn/.test(warn.reason), warn.decision);

fs.writeFileSync(path.join(SB, '.qoder', 'win-path-guard.json'), '{"disabled":true}');
const off = run(CASES_BLOCK[0][1]);
check('关闭开关后完全静默', !off.decision, String(off.decision));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
