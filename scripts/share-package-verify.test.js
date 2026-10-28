'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

test('share-package-verify 自测全过（1 正例 / 4 负例）', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'share-package-verify.cjs'), '--selftest'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SELFTEST=PASS/);
});
