#!/usr/bin/env node
// 兼容入口（转发壳）：跑技能内 office.js 的自测（48 条断言，判据是"写出去再读回来对得上"）。
// 真源：~/.qoder/skills/office-docs/scripts/office.js --selftest
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const real = path.join(__dirname, '..', 'skills', 'office-docs', 'scripts', 'office.js');
const r = spawnSync(process.execPath, [real, '--selftest'], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
