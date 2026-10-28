#!/usr/bin/env node
// 兼容入口（转发壳）：真源已随技能走 → ~/.qoder/skills/write-repowiki/scripts/fix-repowiki-toc.js
// 保留本文件只为兼容既有引用（记忆 / 旧文档）；实现一律改技能内那一份。
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const real = path.join(__dirname, '..', 'skills', 'write-repowiki', 'scripts', 'fix-repowiki-toc.js');
const r = spawnSync(process.execPath, [real, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
