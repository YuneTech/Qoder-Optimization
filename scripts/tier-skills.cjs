#!/usr/bin/env node
// 技能分层：把非核心技能从 ~/.qoder/skills 移到 ~/.qoder/skills-library（或反向恢复），然后重建索引。
// 默认 dry-run，加 --apply 才动手。
//   node tier-skills.cjs                        # 预览：哪些会移入按需库
//   node tier-skills.cjs --apply                # 执行分层（核心 = 内置 KEEP 列表）
//   node tier-skills.cjs --apply --keep a,b,c   # 额外保留（逗号分隔）
//   node tier-skills.cjs --restore a,b          # 把指定技能移回常驻
//   node tier-skills.cjs --restore-all          # 全部移回常驻
const fs = require('fs');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();
const os = require('os');
const { execFileSync } = require('child_process');
const Q = CLIENT_ROOT;
const S = path.join(Q, 'skills');
const LIB = path.join(Q, 'skills-library');

const CORE = [
  'skills-router', 'verify-before-claim', 'verify-ui-in-browser', 'goal-driven-execution',
  'ship-clean-pr', 'skill-trim-with-capability-transfer', 'rules-conflict-audit',
  'skill-reference-integrity-audit', 'skill-description-route-cue-rewrite', 'self-evolution',
  'safe-text-editing', 'structured-edit-safety', 'memory-link-and-credential-audit',
  'pause-writer-before-shared-file-edit', 'concurrent-edit-attribution-check',
  'office-docs', 'write-repowiki', 'vibecoding-doc', 'vibe-coding-workflow',
  'disk-junction-migration', 'verify-windows-cmd-tool', 'continuation-state-audit',
  'share-package-rebuild-triage', 'mechanize-rule-into-hook-guard',
  'skill-tiering-lazy-load', 'global-config-smoke-runner',
];

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const restoreAll = argv.includes('--restore-all');
const keepArg = (() => { const i = argv.indexOf('--keep'); return i >= 0 ? String(argv[i + 1] || '') : ''; })();
const restoreArg = (() => { const i = argv.indexOf('--restore'); return i >= 0 ? String(argv[i + 1] || '') : ''; })();
const keep = new Set([...CORE, ...keepArg.split(',').map((x) => x.trim()).filter(Boolean)]);

fs.mkdirSync(LIB, { recursive: true });
const skillDirs = (root) => (fs.existsSync(root) ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'SKILL.md'))) : []);
const rebuild = () => {
  try { execFileSync(process.execPath, [path.join(__dirname, 'build-skills-index.cjs')], { stdio: 'inherit' }); }
  catch (e) { console.log('索引重建失败：' + e.message); }
};

if (restoreAll || restoreArg) {
  const names = restoreAll ? skillDirs(LIB) : restoreArg.split(',').map((x) => x.trim()).filter(Boolean);
  let n = 0;
  for (const name of names) {
    const from = path.join(LIB, name), to = path.join(S, name);
    if (!fs.existsSync(from)) { console.log('SKIP 库中无 ' + name); continue; }
    if (fs.existsSync(to)) { console.log('SKIP 常驻已有 ' + name); continue; }
    if (apply) { fs.renameSync(from, to); n++; } else console.log('would-restore ' + name);
  }
  console.log((apply ? 'restored=' : 'dry-run restore=') + (apply ? n : names.length));
  if (apply && n) rebuild();
  process.exit(0);
}

const all = skillDirs(S);
const move = all.filter((d) => !keep.has(d));
const stay = all.filter((d) => keep.has(d));
console.log('常驻=' + stay.length + ' 拟移入按需库=' + move.length);
console.log('常驻: ' + stay.join(' '));
if (!apply) {
  console.log('拟移出: ' + move.join(' '));
  console.log('（dry-run；加 --apply 执行）');
  process.exit(0);
}
let moved = 0;
for (const d of move) {
  const from = path.join(S, d), to = path.join(LIB, d);
  if (fs.existsSync(to)) { console.log('SKIP 库中已有 ' + d); continue; }
  fs.renameSync(from, to); moved++;
}
console.log('moved=' + moved);
rebuild();
