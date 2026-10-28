#!/usr/bin/env node
'use strict';
// Read-only smoke runner: enumerate *.test.js + four checkers, print name + exit code, keep logs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = process.env.USERPROFILE || os.homedir();
const SCRIPTS = process.env.SMOKE_SCRIPTS_DIR
  ? path.resolve(process.env.SMOKE_SCRIPTS_DIR)
  : path.join(HOME, '.qoder', 'scripts');
const CN_ROOT = path.join(HOME, '.qoder-cn');
const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const ONLY = String(valueOf('--only', '')).toLowerCase();
const TESTS_ONLY = hasFlag('--tests-only');
const TIMEOUT_MS = Number(valueOf('--timeout-ms', '180000'));

function stop(message) {
  console.error('ERROR ' + message);
  process.exit(2);
}

if (!fs.existsSync(SCRIPTS)) stop('scripts dir not found: ' + SCRIPTS);
if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS < 1000) stop('invalid --timeout-ms');

const testFiles = fs.readdirSync(SCRIPTS)
  .filter((f) => {
    if (!/\.test\.js$/.test(f) || /\.bak/i.test(f)) return false;
    try {
      return fs.statSync(path.join(SCRIPTS, f)).isFile();
    } catch (e) {
      return false;
    }
  })
  .sort((a, b) => a.localeCompare(b));

const CHECKERS = [
  { name: 'skills-doctor', file: 'skills-doctor.cjs', needsCn: true, advisory: false },
  { name: 'skill-collisions', file: 'skill-collisions.cjs', needsCn: true, advisory: true },
  { name: 'config-doctor', file: 'config-doctor.cjs', needsCn: true, advisory: false },
  { name: 'rules-weekly-audit', file: 'rules-weekly-audit.js', needsCn: false, advisory: false },
];

const items = testFiles.map((f) => ({ name: f, file: path.join(SCRIPTS, f), advisory: false }));
if (!TESTS_ONLY) {
  for (const c of CHECKERS) {
    if (c.needsCn && !fs.existsSync(CN_ROOT)) {
      items.push({ name: c.name, skip: 'single-client' });
      continue;
    }
    const file = path.join(SCRIPTS, c.file);
    if (!fs.existsSync(file)) {
      items.push({ name: c.name, missing: file });
      continue;
    }
    items.push({ name: c.name, file, advisory: c.advisory, args: c.name === 'rules-weekly-audit' ? ['--no-fix'] : [] });
  }
}

const selected = ONLY ? items.filter((i) => i.name.toLowerCase().includes(ONLY)) : items;
if (!selected.length) stop('no smoke items matched' + (ONLY ? ' --only ' + ONLY : ''));

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const LOGDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-smoke-' + stamp + '-'));
const results = [];
const safe = (s) => s.replace(/[^A-Za-z0-9_.-]+/g, '_');

for (let i = 0; i < selected.length; i++) {
  const item = selected[i];
  if (item.missing) {
    console.log(item.name + ' EXIT=MISSING');
    results.push({ name: item.name, exit: 'MISSING', file: item.missing, ms: 0, log: '' });
    continue;
  }
  if (item.skip) {
    console.log(item.name + ' SKIP(' + item.skip + ')');
    results.push({ name: item.name, exit: 'SKIP', kind: item.skip, ms: 0, log: '' });
    continue;
  }

  const t0 = Date.now();
  const r = spawnSync(process.execPath, [item.file, ...(item.args || [])], {
    cwd: SCRIPTS,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  const ms = Date.now() - t0;
  const spawnError = r.error ? '\n--- spawn error ---\n' + [r.error.code, r.error.message].filter(Boolean).join(' ') : '';
  const signal = r.signal ? '\n--- signal ---\n' + r.signal : '';
  const output = String(r.stdout || '') + (r.stderr ? '\n--- stderr ---\n' + String(r.stderr) : '') + spawnError + signal;
  const logFile = path.join(LOGDIR, safe(item.name) + '.log');
  fs.writeFileSync(logFile, '# ' + item.name + '\n# exit=' + r.status + ' ms=' + ms + '\n\n' + output + '\n', 'utf8');

  let exit;
  if (r.error && r.error.code === 'ETIMEDOUT') exit = 'TIMEOUT';
  else if (r.status === null) exit = 'CRASH';
  else exit = r.status;

  let line = item.name + ' EXIT=' + exit;
  let hits = null;
  if (item.advisory) {
    const m = output.match(/未指认=(\d+)/);
    hits = m ? Number(m[1]) : null;
    line += ' ADVISORY ' + (hits === null ? 'no-verdict' : '未指认=' + hits);
  }
  console.log(line);
  results.push({ name: item.name, exit, ms, log: logFile, advisory: !!item.advisory, advisoryHits: hits });
}

const isRed = (r) => r.exit === 'MISSING' || r.exit === 'TIMEOUT' || r.exit === 'CRASH' || (typeof r.exit === 'number' && r.exit !== 0);
const green = results.filter((r) => r.exit === 0).length;
const red = results.filter(isRed).length;
const skip = results.filter((r) => r.exit === 'SKIP').length;
const advisory = results.filter((r) => r.advisory).length;

const summary = { stamp, scripts: SCRIPTS, timeoutMs: TIMEOUT_MS, total: results.length, green, red, skip, advisory, results };
fs.writeFileSync(path.join(LOGDIR, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
const md = [
  '# Global config smoke',
  '',
  '- time: ' + stamp,
  '- scripts: ' + SCRIPTS,
  '- total: ' + results.length,
  '- green: ' + green,
  '- red: ' + red,
  '- skip: ' + skip,
  '- advisory: ' + advisory,
  '',
  '| item | exit | ms | log |',
  '|---|---|---|---|',
  ...results.map((r) => '| ' + r.name + ' | ' + r.exit + ' | ' + r.ms + ' | ' + (r.log || '') + ' |'),
  '',
].join('\n');
fs.writeFileSync(path.join(LOGDIR, 'summary.md'), md, 'utf8');

console.log('SUMMARY total=' + results.length + ' green=' + green + ' red=' + red + ' skip=' + skip + ' advisory=' + advisory);
console.log('LOGS ' + LOGDIR);
process.exit(red ? 1 : 0);
