#!/usr/bin/env node
// 重建技能索引：扫描 ~/.qoder/skills（常驻）与 ~/.qoder/skills-library（按需），写 skills-index.json
const fs = require('fs');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();
const os = require('os');
const Q = CLIENT_ROOT;
const SRC = [['core', path.join(Q, 'skills')], ['library', path.join(Q, 'skills-library')]];
const OUT = path.join(Q, 'skills-index.json');

function desc(p) {
  const t = fs.readFileSync(p, 'utf8');
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return '';
  const d = m[1].match(/^description:([\s\S]*?)(?=\r?\n[A-Za-z_][\w-]*:|(?![\s\S]))/m);
  return d ? d[1].trim().replace(/^\|\s*/, '').replace(/\s+/g, ' ').replace(/^"|"$/g, '') : '';
}

function collectSkills() {
  const entries = [];
  const names = new Set();
  for (const [tier, root] of SRC) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, 'SKILL.md');
      if (!fs.existsSync(p)) continue;
      const key = d.toLowerCase();
      if (names.has(key)) throw new Error('两层技能重名，需核对真源后再建索引；重复项：' + d);
      names.add(key);
      entries.push({ name: d, tier, path: p.split(path.sep).join('/'), description: desc(p) });
    }
  }
  return entries.sort((a, b) => a.tier.localeCompare(b.tier) || a.name.localeCompare(b.name));
}

module.exports = { collectSkills };
if (require.main === module) {
  try {
    const entries = collectSkills();
    fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), count: entries.length, entries }, null, 1));
    console.log('index=' + entries.length + ' core=' + entries.filter((e) => e.tier === 'core').length + ' library=' + entries.filter((e) => e.tier === 'library').length);
    console.log(OUT);
  } catch (error) {
    console.error('INDEX_ERROR: ' + error.message);
    process.exitCode = 2;
  }
}
