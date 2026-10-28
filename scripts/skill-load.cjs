#!/usr/bin/env node
'use strict';
const { collectSkills } = require('./build-skills-index.cjs');
const { resolveCatalog, readCatalog, searchEntries, formatEntry } = require('./pkg-catalog.cjs');

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('用法: node skill-load.cjs "<关键词…>"');
  process.exit(2);
}

let entries;
try {
  // 查询现场而非可漂移的生成物；纯检索不修改索引或安装状态。
  entries = collectSkills().map(e => ({ ...e, id: 'skill:' + e.name, category: 'skill' }));
} catch (error) {
  console.error('INDEX_ERROR: ' + error.message);
  process.exit(2);
}
const hits = searchEntries(entries, query, 6);
if (hits.length) {
  hits.forEach(({ e, s }, i) => {
    console.log(`${i + 1}. ${e.name}   [${e.tier}]  score=${s}`);
    console.log(`   ${e.path}`);
    console.log(`   ${(e.description || '').slice(0, 110)}`);
  });
} else {
  console.log('NO_MATCH');
  const file = resolveCatalog();
  if (file) {
    try {
      const candidates = searchEntries(readCatalog(file).entries, query, 3);
      if (candidates.length) {
        console.log(`分享包候选 ${candidates.length} 条（文件存在不等于已装载；检索不授权安装）：`);
        for (const { e } of candidates) console.log(formatEntry(e, file));
      }
    } catch (error) {
      console.error('CATALOG_UNAVAILABLE: 分享包索引不可用；请核对包位置后重新 register。' + error.message);
    }
  }
  process.exitCode = 3;
}
