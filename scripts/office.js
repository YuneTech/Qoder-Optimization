#!/usr/bin/env node
// 兼容入口（转发壳）：office.js 的真源已随技能走 → ~/.qoder/skills/office-docs/scripts/office.js
// 保留本文件只为兼容既有引用（记忆 / 旧文档 / 习惯路径）；实现一律改技能内那一份，别在这里写逻辑。
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const real = path.join(__dirname, '..', 'skills', 'office-docs', 'scripts', 'office.js');
const r = spawnSync(process.execPath, [real, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
