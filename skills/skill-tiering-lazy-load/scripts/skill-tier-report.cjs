#!/usr/bin/env node
'use strict';
// 技能分层只读盘点：core/library 计数、每轮注入字符、索引漂移、硬引用、入口文件。
//   node skill-tier-report.cjs                 # 默认根 ~/.qoder
//   node skill-tier-report.cjs --root <dir>    # 夹具根：<root>/skills + <root>/skills-library + <root>/skills-index.json
//   node skill-tier-report.cjs --top 10 --json
// 退出码：0=一致；1=索引漂移/重名/层级不符；2=前置失败
const fs = require('fs');
const path = require('path');
const os = require('os');

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const jsonMode = argv.includes('--json');
const root = path.resolve(opt('--root', '') || path.join(os.homedir(), '.qoder'));
const topRaw = Number(opt('--top', '10'));
const topN = Number.isFinite(topRaw) && topRaw > 0 ? Math.floor(topRaw) : 10;

const SKILLS = path.join(root, 'skills');
const LIB = path.join(root, 'skills-library');
const IDX = path.join(root, 'skills-index.json');

const lines = [];
const log = (...a) => { if (!jsonMode) lines.push(a.join(' ')); };
function die(code, msg) {
  if (jsonMode) console.log(JSON.stringify({ root, exit: code, error: msg }, null, 2));
  else { console.log("前置失败：" + msg); }
  process.exit(code);
}

const norm = (p) => path.resolve(p).split(path.sep).join('/').toLowerCase();

function descOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return '';
  const d = m[1].match(/^description:([\s\S]*?)(?=\r?\n[A-Za-z_][\w-]*:|(?![\s\S]))/m);
  return d ? d[1].trim().replace(/^\|\s*/, '').replace(/\s+/g, ' ').replace(/^"|"$/g, '') : '';
}

function readSkills(dir, tier) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    out.push({ name, tier, path: file.split(path.sep).join('/'), description: descOf(file) });
  }
  return out;
}

if (!fs.existsSync(SKILLS)) die(2, '缺少技能目录 ' + SKILLS);
let idx;
try { idx = JSON.parse(fs.readFileSync(IDX, 'utf8')); } catch (e) { die(2, '索引不可读或不是合法 JSON：' + IDX); }
if (!idx || !Array.isArray(idx.entries)) die(2, '索引缺少 entries 数组：' + IDX);

const core = readSkills(SKILLS, 'core');
const library = readSkills(LIB, 'library');
const disk = [...core, ...library];
const indexEntries = idx.entries.filter((e) => e && e.name);

const tierCount = new Map();
for (const r of disk) tierCount.set(r.name, (tierCount.get(r.name) || 0) + 1);
const duplicateNames = [...tierCount].filter(([, n]) => n > 1).map(([n]) => n).sort();

const idxCount = new Map();
for (const e of indexEntries) idxCount.set(e.name, (idxCount.get(e.name) || 0) + 1);
const indexDuplicates = [...idxCount].filter(([, n]) => n > 1).map(([n]) => n).sort();

const diskByName = new Map();
for (const r of disk) {
  if (!diskByName.has(r.name)) diskByName.set(r.name, []);
  diskByName.get(r.name).push(r);
}
const idxNames = new Set(indexEntries.map((e) => e.name));
const missing = disk.filter((r) => !idxNames.has(r.name)).map((r) => r.name).sort();
const extra = [...new Set(indexEntries.filter((e) => !diskByName.has(e.name)).map((e) => e.name))].sort();
const tierMismatch = [];
const stale = [];
for (const e of indexEntries) {
  const recs = diskByName.get(e.name) || [];
  if (!recs.length) continue;
  const rec = recs.find((r) => r.tier === e.tier) || recs[0];
  if (rec.tier !== e.tier) tierMismatch.push(e.name + '（索引=' + e.tier + '，磁盘=' + rec.tier + '）');
  else if (norm(rec.path) !== norm(String(e.path || '')) || rec.description !== String(e.description || '')) stale.push(e.name);
}

const injection = core.reduce((s, r) => s + r.name.length + r.description.length + 4, 0);
const longest = [...core]
  .sort((a, b) => b.description.length - a.description.length || a.name.localeCompare(b.name))
  .slice(0, topN)
  .map((r) => ({ name: r.name, descriptionLength: r.description.length, inject: r.name.length + r.description.length + 4 }));

const libNames = new Set(library.map((r) => r.name));
const hardRefs = [];
const seenRef = new Set();
const citedFiles = [path.join(root, 'AGENTS.md')];
const rulesDir = path.join(root, 'rules');
if (fs.existsSync(rulesDir)) {
  for (const f of fs.readdirSync(rulesDir)) if (f.endsWith('.md')) citedFiles.push(path.join(rulesDir, f));
}
const NAME_RE = /`([a-z][a-z0-9]+(?:-[a-z0-9]+){1,6})`/g;
for (const f of citedFiles) {
  if (!fs.existsSync(f)) continue;
  fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(NAME_RE)) {
      if (!libNames.has(m[1])) continue;
      const key = path.basename(f) + '|' + m[1];
      if (seenRef.has(key)) continue;
      seenRef.add(key);
      hardRefs.push({ file: path.basename(f), line: i + 1, name: m[1] });
    }
  });
}

const entryChecks = [
  ['skills-router', path.join(SKILLS, 'skills-router', 'SKILL.md')],
  ['skill-load.cjs', path.join(root, 'scripts', 'skill-load.cjs')],
  ['build-skills-index.cjs', path.join(root, 'scripts', 'build-skills-index.cjs')],
  ['tier-skills.cjs', path.join(root, 'scripts', 'tier-skills.cjs')],
].map(([name, p]) => ({ name, path: p, ok: fs.existsSync(p) }));

const drift = missing.length + extra.length + stale.length + tierMismatch.length + duplicateNames.length + indexDuplicates.length;
const duplicateAll = [...new Set([...duplicateNames, ...indexDuplicates])];
const exitCode = drift ? 1 : 0;

log('技能分层盘点 root=' + root);
log('常驻 core=' + core.length + ' ／ 按需 library=' + library.length + ' ／ 合计 total=' + disk.length);
log('每轮注入 name+description+4 = ' + injection + ' 字符（core ' + core.length + ' 条）');
log('索引 ' + indexEntries.length + ' 条：stale=' + stale.length + ' missing=' + missing.length
  + ' extra=' + extra.length + ' duplicate=' + duplicateAll.length
  + ' tierMismatch=' + tierMismatch.length);
log('core 最长 description top ' + longest.length + '：');
for (const r of longest) log('  ' + r.inject + 'B  desc=' + r.descriptionLength + '  ' + r.name);
log('入口：' + entryChecks.map((e) => e.name + (e.ok ? ' OK' : ' 缺失')).join('；'));
log('硬引用（AGENTS.md + rules/*.md 反引号点名库技能）：' + hardRefs.length + ' 条');
for (const r of hardRefs) log('  WARN ' + r.file + ':' + r.line + ' 引用库技能 `' + r.name + '`（需先 skill-load 再 Read）');
if (missing.length) log('  missing: ' + missing.join(', '));
if (extra.length) log('  extra: ' + extra.join(', '));
if (stale.length) log('  stale: ' + stale.join(', '));
if (tierMismatch.length) log('  tierMismatch: ' + tierMismatch.join(', '));
if (duplicateNames.length || indexDuplicates.length) {
  log('  duplicate: ' + duplicateAll.join(', '));
}
const missingEntries = entryChecks.filter((e) => !e.ok).map((e) => e.name);
if (missingEntries.length) log('  WARN 入口缺失：' + missingEntries.join(', '));
log(exitCode === 0 ? '结果：一致（exit 0）' : '结果：存在漂移（exit 1）');

if (jsonMode) {
  console.log(JSON.stringify({
    root,
    counts: { core: core.length, library: library.length, total: disk.length },
    injection,
    index: {
      declaredCount: idx.count,
      entries: indexEntries.length,
      stale, missing, extra,
      duplicate: duplicateAll,
      tierMismatch,
    },
    longestCore: longest,
    hardRefs,
    entries: entryChecks,
    exit: exitCode,
  }, null, 2));
} else {
  console.log(lines.join('\n'));
}
process.exit(exitCode);
