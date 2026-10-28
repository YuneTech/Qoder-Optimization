#!/usr/bin/env node
// 技能降量后的「提及扫描」（只读）：列出 AGENTS.md + rules/ commands/ memory/ skills/ 中对
// 「已不在 skills/ 的名字」的提及，每条给 文件:行 + 上下文 + 名字状态 + 留痕提示。
// 名字来源：① skills-disabled/ 的目录名（状态「已停」）② --names-file 追加的历史名字（状态「不明」）。
// skills/ 里在用的名字永远不报（负对照）。
// 命中是待读线索不是判决：「有意留痕 vs 真悬空」由人 / AI 读原文判定，留痕提示只是措辞启发式。
// 不写文件、不删文件。
//   node skill-mention-scan.cjs [--root <dir>] [--names-file <path>] [--limit N] [--strict] [--selftest]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const QODER = path.join(os.homedir(), '.qoder');
const SCAN_DIRS = ['rules', 'commands', 'memory', 'skills'];
const ROOT_FILES = ['AGENTS.md'];
// 留痕启发式：同一行或相邻一行出现这些措辞，说明这处提及很可能是在记录「能力去哪了」
const HINT_RE = /已停用|停用|skills-disabled|能力去向|回退|CAPABILITIES|移入|不再装|收敛/;

function listDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (e) {
    return [];
  }
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.cache') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(p);
  }
}

function collectFiles(root) {
  const out = [];
  for (const f of ROOT_FILES) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) out.push(p);
  }
  for (const d of SCAN_DIRS) {
    const base = path.join(root, d);
    if (fs.existsSync(base)) walk(base, out);
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function resolveNames(root, extraNames) {
  const active = listDirs(path.join(root, 'skills'));
  const disabled = listDirs(path.join(root, 'skills-disabled'));
  const activeSet = new Set(active);
  const disabledSet = new Set(disabled);
  const names = [];
  for (const n of disabled) names.push({ name: n, status: '已停', source: 'skills-disabled/' });
  for (const n of extraNames) {
    if (activeSet.has(n)) continue; // 在用技能永不报
    if (disabledSet.has(n)) continue; // 已在上面
    names.push({ name: n, status: '不明', source: '--names-file' });
  }
  return { active, disabled, names };
}

function scan(root, extraNames) {
  const { active, disabled, names } = resolveNames(root, extraNames);
  const files = collectFiles(root);
  const pats = names.map((n) => ({ ...n, re: new RegExp('(?<![A-Za-z0-9_.-])' + escapeRe(n.name) + '(?![A-Za-z0-9_-])') }));
  const hits = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (e) {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.length > 4000) continue;
      for (const p of pats) {
        if (!p.re.test(line)) continue;
        const near = (lines[i - 1] || '') + ' ' + line + ' ' + (lines[i + 1] || '');
        hits.push({
          name: p.name,
          status: p.status,
          file: path.relative(root, f).split(path.sep).join('/'),
          line: i + 1,
          hint: HINT_RE.test(near) ? '留痕' : '待读',
          text: line.trim().slice(0, 160),
        });
      }
    }
  }
  return { active, disabled, names, files: files.length, hits };
}

const exitFor = (hits, strict) => (strict && hits.some((h) => h.hint === '待读') ? 2 : 0);

function report(res, limit) {
  const byName = new Map();
  for (const h of res.hits) {
    if (!byName.has(h.name)) byName.set(h.name, []);
    byName.get(h.name).push(h);
  }
  console.log(`== 提及扫描 · 根目录 ${res.names.root} ==`);
  console.log(`扫描 md 文件 ${res.files} 个；候选名字 ${res.names.length} 个（已停 ${res.disabled.length} / 不明 ${res.names.length - res.disabled.length}）；在用技能 ${res.active.length} 个（永不报）`);
  if (!byName.size) {
    console.log('无命中：没有对「已不在 skills/ 的名字」的提及。');
    return;
  }
  for (const [name, list] of [...byName.entries()].sort()) {
    const st = list[0].status;
    const suffix = st === '已停' ? '（在 skills-disabled/，可回退）' : '（skills/ 与 skills-disabled/ 都没有；来源：--names-file）';
    console.log(`\n[${st}] ${name} ${suffix}  命中 ${list.length} 处`);
    for (const h of list.slice(0, limit)) console.log(`   ${h.hint}  ${h.file}:${h.line}  ${h.text}`);
    if (list.length > limit) console.log(`   …另有 ${list.length - limit} 处（--limit 调整上限）`);
  }
  const n = (k) => res.hits.filter((h) => h.hint === k).length;
  console.log(`\n—— 汇总：${byName.size} 个名字命中 / ${res.hits.length} 处（留痕提示 ${n('留痕')} / 待读 ${n('待读')}）`);
  console.log('提示：留痕提示只是措辞启发式；请读原文区分「有意留痕」与「真悬空」。');
}

function parseArgs(argv) {
  const o = { root: QODER, namesFile: null, limit: 6, strict: false, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.root = argv[++i];
    else if (a === '--names-file') o.namesFile = argv[++i];
    else if (a === '--limit') o.limit = Number(argv[++i]) || 6;
    else if (a === '--strict') o.strict = true;
    else if (a === '--selftest') o.selftest = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else {
      console.error(`未知参数：${a}`);
      o.bad = true;
    }
  }
  return o;
}

function readNamesFile(p) {
  if (!p) return [];
  if (!fs.existsSync(p)) {
    console.error(`名字清单不存在：${p}`);
    process.exit(1);
  }
  return fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .map((s) => (s.startsWith('`') && s.endsWith('`') ? s.slice(1, -1) : s));
}

// ---------- 自测：正例 / 留痕 / 不明 / 词边界 / 非 md / 负对照 ----------
function selftest() {
  const parent = path.join(os.tmpdir(), 'qoder-work');
  fs.mkdirSync(parent, { recursive: true });
  const T = fs.mkdtempSync(path.join(parent, 'mention-scan-'));
  const W = (rel, text) => {
    const p = path.join(T, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, 'utf8');
  };
  W('skills/alpha/SKILL.md', '---\nname: alpha\n---\n\n# alpha\n');
  W('skills-disabled/beta/SKILL.md', '---\nname: beta\n---\n\n# beta\n');
  W('skills-disabled/docx/SKILL.md', '---\nname: docx\n---\n\n# docx\n');
  W('AGENTS.md', '## 工具选用\n\n- 细节见 `beta` 技能（当前可用）。\n- 在用技能 alpha 不参与扫描。\n');
  W('rules/r.md', '## 办公\n\n- 官方 `beta` 已停用，能力去向见 skills/alpha/CAPABILITIES.md，回退命令见记忆。\n');
  W('memory/m.md', '---\nname: m\n---\n\n- `docx-surgery.js` 与 `python-docx` 是库不是技能名，不该算作提及。\n- `gamma` 是历史上彻底移除的名字。\n');
  W('memory/ext.md', '---\nname: ext\n---\n\n- 产出物是 报告.docx 与 表格.xlsx；扩展名不该算作技能名提及。\n');
  W('memory/notes.txt', 'beta 出现但这不是 md 文件，应被忽略。\n');
  fs.writeFileSync(path.join(T, 'names.txt'), '# 历史名字\ngamma\n`alpha`\n', 'utf8');

  const res = scan(T, readNamesFile(path.join(T, 'names.txt')));
  res.names.root = T;
  const names = res.names.map((n) => n.name).sort();
  const hitsOf = (n) => res.hits.filter((h) => h.name === n);
  const rules = [];
  const check = (label, ok, detail) => rules.push({ label, ok, detail });

  check('名字收集 = 已停 beta/docx + 不明 gamma', JSON.stringify(names) === JSON.stringify(['beta', 'docx', 'gamma']), names.join(','));
  check('负对照：在用技能 alpha 零命中', hitsOf('alpha').length === 0, `命中 ${hitsOf('alpha').length} 处`);
  check('负对照：词边界（docx-surgery / python-docx / 报告.docx 都不算 docx）', hitsOf('docx').length === 0, `命中 ${hitsOf('docx').length} 处`);
  check('负对照：非 md 文件被忽略', res.hits.every((h) => h.file.endsWith('.md')), res.hits.map((h) => h.file).join(','));
  check('正例：AGENTS.md 里 beta 记为 待读', hitsOf('beta').some((h) => h.file === 'AGENTS.md' && h.hint === '待读'), JSON.stringify(hitsOf('beta')));
  check('正例：rules/r.md 里 beta 记为 留痕', hitsOf('beta').some((h) => h.file === 'rules/r.md' && h.hint === '留痕'), JSON.stringify(hitsOf('beta')));
  check('正例：不明名字 gamma 命中 memory/m.md', hitsOf('gamma').some((h) => h.file === 'memory/m.md'), JSON.stringify(hitsOf('gamma')));
  check('退出码：--strict 且有 待读 → 2', exitFor(res.hits, true) === 2, String(exitFor(res.hits, true)));
  check('退出码：不加 --strict → 0', exitFor(res.hits, false) === 0, String(exitFor(res.hits, false)));

  const tryExit = (args) => {
    try {
      execFileSync(process.execPath, [__filename, ...args], { encoding: 'utf8', stdio: 'pipe' });
      return 0;
    } catch (e) {
      return typeof e.status === 'number' ? e.status : -1;
    }
  };
  const realStrict = tryExit(['--root', T, '--names-file', path.join(T, 'names.txt'), '--strict', '--limit', '1']);
  check('真跑：--strict 退出码 = 2', realStrict === 2, String(realStrict));
  const realLoose = tryExit(['--root', T, '--names-file', path.join(T, 'names.txt'), '--limit', '1']);
  check('真跑：不加 --strict 退出码 = 0', realLoose === 0, String(realLoose));

  const failed = rules.filter((r) => !r.ok);
  for (const r of rules) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.ok ? '' : ' → ' + r.detail}`);
  console.log(`\nskill-mention-scan 自测：${rules.length - failed.length} 通过 / ${failed.length} 失败`);
  try {
    fs.rmSync(T, { recursive: true, force: true });
  } catch (e) {
    /* 清理失败不影响判据 */
  }
  process.exit(failed.length ? 1 : 0);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.selftest) return selftest();
  if (o.help) {
    console.log('用法: node skill-mention-scan.cjs [--root <dir>] [--names-file <path>] [--limit N] [--strict] [--selftest]');
    console.log('  --root        扫描根目录，默认 ~/.qoder');
    console.log('  --names-file  追加历史名字（每行一个，# 开头为注释）');
    console.log('  --limit       每个名字最多打印几处（默认 6）');
    console.log('  --strict      有「待读」命中即 exit 2（可做门禁）');
    return;
  }
  if (o.bad) process.exit(1);
  if (!fs.existsSync(o.root)) {
    console.error(`根目录不存在：${o.root}`);
    process.exit(1);
  }
  let extra = [];
  try {
    extra = readNamesFile(o.namesFile);
  } catch (e) {
    console.error(`名字清单读取失败：${e.message}`);
    process.exit(1);
  }
  const res = scan(o.root, extra);
  res.names.root = path.resolve(o.root);
  report(res, o.limit);
  process.exit(exitFor(res.hits, o.strict));
}

main();
