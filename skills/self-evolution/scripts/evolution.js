#!/usr/bin/env node
'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { randomUUID } = require('crypto');

const HOME = os.homedir();
// 状态根落在本机实际存在的客户端侧（只装 CN 时不去新建 ~/.qoder）；scripts/client-root.js 缺失时退回旧口径
const CLIENT_ROOT = (() => {
  try { return require(path.join(__dirname, '..', '..', '..', 'scripts', 'client-root.js')).clientRoot(); } catch (e) { return path.join(HOME, '.qoder'); }
})();
const DEFAULT_ROOT = path.join(CLIENT_ROOT, 'evolution');
const KINDS = new Set(['observation', 'correction', 'capability-gap', 'rejection']);
const SOURCES = new Set(['user', 'local-validation', 'memory', 'external']);

function fail(message) {
  const err = new Error(message);
  err.exitCode = 2;
  throw err;
}

function checkNoSymlink(value) {
  const parts = [];
  let cur = path.resolve(value);
  parts.unshift(cur);
  while (true) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
    parts.unshift(cur);
  }
  for (const p of parts) {
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        fail('Symlink/reparse paths are forbidden: ' + p);
      }
      if (process.platform === 'win32' && st.isFile() && (st.modules || 0)) {
        // Windows reparse point check via attributes
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}

function safePath(value, mustExist = true) {
  const resolved = path.resolve(value);
  checkNoSymlink(resolved);
  if (mustExist && !fs.existsSync(resolved)) {
    fail('Path does not exist: ' + resolved);
  }
  return resolved;
}

function digest(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function now() {
  return new Date().toISOString();
}

async function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  safePath(dir, false);
  const tmp = path.join(dir, '.tmp-' + randomUUID());
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, filePath);
  } finally {
    try { await fsp.unlink(tmp); } catch (e) { /* ignore */ }
  }
}

async function writeJSON(filePath, data) {
  const content = JSON.stringify(data, null, 2) + '\n';
  await atomicWrite(filePath, Buffer.from(content, 'utf-8'));
}

async function readJSON(filePath) {
  const p = safePath(filePath);
  const raw = await fsp.readFile(p);
  const text = raw.toString('utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

async function inputJSON(filePath) {
  const p = safePath(filePath);
  const raw = await fsp.readFile(p);
  if (raw.length > 16384) {
    fail('Input exceeds 16 KiB; store concise evidence, not raw logs/content');
  }
  const text = raw.toString('utf-8').replace(/^\uFEFF/, '');
  const value = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('Input must be a JSON object');
  }
  return value;
}

function checkFields(value, required, optional = []) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('Missing or unknown fields; required: ' + required.join(', '));
  }
  const keys = new Set(Object.keys(value));
  const reqSet = new Set(required);
  const optSet = new Set(optional);
  for (const r of required) {
    if (!keys.has(r)) fail('Missing or unknown fields; required: ' + required.join(', '));
  }
  for (const k of keys) {
    if (!reqSet.has(k) && !optSet.has(k)) {
      fail('Missing or unknown fields; required: ' + required.join(', '));
    }
  }
}

function shortStr(value, label, maximum = 600) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    fail(label + ' must be a nonempty string of at most ' + maximum + ' characters');
  }
  return value;
}

async function acquireLock(root) {
  const lockPath = path.join(root, '.lock');
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, created_at: now() }));
    fs.closeSync(fd);
    return lockPath;
  } catch (e) {
    if (e.code === 'EEXIST') {
      fail('Journal lock busy; retry later. After a crash, inspect .lock before removing it');
    }
    throw e;
  }
}

function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch (e) { /* ignore */ }
}

async function isEnabled(root) {
  const controlPath = path.join(root, 'control.json');
  if (!fs.existsSync(controlPath)) return true;
  const value = await readJSON(controlPath);
  if (typeof value !== 'object' || typeof value.enabled !== 'boolean') {
    fail('Invalid control.json: enabled must be a JSON boolean; inspect before proceeding');
  }
  return value.enabled;
}

async function listRecords(root) {
  const dir = path.join(root, 'records');
  if (!fs.existsSync(dir)) return [];
  const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json')).sort();
  const result = [];
  for (const f of files) {
    result.push(await readJSON(path.join(dir, f)));
  }
  return result;
}

async function doRecord(root, value, userRequested = false) {
  checkFields(value, ['type', 'topic', 'scope', 'summary', 'evidence', 'explicit'], ['verified']);
  if (!KINDS.has(value.type) || typeof value.explicit !== 'boolean' || typeof (value.verified || false) !== 'boolean') {
    fail('Invalid type/explicit/verified');
  }
  for (const [key, max] of [['topic', 160], ['scope', 240], ['summary', 600]]) {
    shortStr(value[key], key, max);
  }
  const evidence = value.evidence;
  checkFields(evidence, ['task_id', 'source', 'detail'], ['session_id']);
  shortStr(evidence.task_id, 'task_id', 160);
  shortStr(evidence.detail, 'detail', 600);
  if (evidence.session_id !== undefined) {
    shortStr(evidence.session_id, 'session_id', 160);
  }
  if (!SOURCES.has(evidence.source) || (value.explicit && evidence.source !== 'user')) {
    fail('source must be user/local-validation/memory/external; explicit requires user');
  }
  if (userRequested && !value.explicit) {
    fail('--user-requested record requires explicit=true and source=user');
  }
  const existing = await listRecords(root);
  const dup = existing.find(r =>
    r.topic === value.topic && r.scope === value.scope && r.evidence.task_id === evidence.task_id
  );
  const item = {
    ...value,
    id: randomUUID().replace(/-/g, ''),
    created_at: now(),
    verified: value.verified || false,
    duplicate_of: dup ? dup.id : null,
    user_requested: userRequested,
  };
  await writeJSON(path.join(root, 'records', item.id + '.json'), item);
  return { id: item.id, independent: !dup, duplicate_of: dup ? dup.id : null };
}

async function doStatus(root) {
  const items = await listRecords(root);
  items.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '') || (a.id || '').localeCompare(b.id || ''));
  const grouped = {};
  for (const item of items) {
    const key = item.topic + '|||' + item.scope;
    if (!grouped[key]) {
      grouped[key] = {
        topic: item.topic, scope: item.scope,
        task_ids: new Set(), local_task_ids: new Set(),
        qualified_task_ids: new Set(), qualified_session_ids: new Set(),
        counts_by_type: {}, counts_by_source: {},
        rejection_count: 0, record_count: 0,
      };
    }
    const g = grouped[key];
    g.task_ids.add(item.evidence.task_id);
    if (['user', 'local-validation'].includes(item.evidence.source)) {
      g.local_task_ids.add(item.evidence.task_id);
    }
    g.counts_by_type[item.type] = (g.counts_by_type[item.type] || 0) + 1;
    g.counts_by_source[item.evidence.source] = (g.counts_by_source[item.evidence.source] || 0) + 1;
    if (item.type === 'rejection') g.rejection_count++;
    if (['observation', 'correction'].includes(item.type) &&
        (item.evidence.source === 'user' ||
         (item.evidence.source === 'local-validation' && item.verified))) {
      g.qualified_task_ids.add(item.evidence.task_id);
      if (item.evidence.session_id) g.qualified_session_ids.add(item.evidence.session_id);
    }
    g.record_count++;
    g.last_at = item.created_at;
  }
  const groups = Object.values(grouped);
  for (const g of groups) {
    for (const k of ['task_ids', 'local_task_ids', 'qualified_task_ids', 'qualified_session_ids']) {
      g[k.replace('ids', 'count')] = g[k].size;
      g[k] = [...g[k]].sort().slice(-10);
    }
  }
  groups.sort((a, b) => (b.last_at || '').localeCompare(a.last_at || ''));

  const changes = [];
  const changesDir = path.join(root, 'changes');
  if (fs.existsSync(changesDir)) {
    for (const name of await fsp.readdir(changesDir)) {
      if (/^[a-f0-9]{32}$/.test(name)) {
        try {
          const manifest = await readJSON(path.join(changesDir, name, 'checkpoint.json'));
          let state = 'checkpointed';
          if (fs.existsSync(path.join(changesDir, name, 'rolled-back.json'))) state = 'rolled-back';
          else if (fs.existsSync(path.join(changesDir, name, 'committed.json'))) state = 'committed';
          changes.push({
            id: manifest.id, reason: manifest.reason, scope: manifest.scope,
            created_at: manifest.created_at, state,
          });
        } catch (e) { /* skip corrupt */ }
      }
    }
  }
  changes.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  return {
    enabled: await isEnabled(root),
    record_count: items.length,
    count_note: 'Descriptive evidence only; inspect contrary evidence before promotion. Missing session_id is unknown.',
    groups: groups.slice(0, 10),
    last_records: items.slice(-10),
    changes: changes.slice(0, 10),
  };
}

function getManagedRoots() {
  return [
    path.join(HOME, '.qoder', 'AGENTS.md'),
    path.join(HOME, '.qoder', 'settings.json'),
    path.join(HOME, '.qoder-cn', 'AGENTS.md'),
    path.join(HOME, '.qoder-cn', 'settings.json'),
  ];
}

function getManagedBases() {
  return [
    path.join(HOME, '.qoder', 'skills'),
    path.join(HOME, '.qoder-cn', 'skills'),
  ];
}

function isManaged(value, root) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    fail('Managed paths must be absolute');
  }
  const resolved = safePath(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    fail('Only existing regular files can be checkpointed');
  }
  const permitted = getManagedRoots().includes(resolved);
  if (!permitted) {
    for (const base of getManagedBases()) {
      if (resolved.startsWith(base + path.sep)) {
        const rel = resolved.slice(base.length + 1);
        const parts = rel.split(path.sep);
        if (!parts.some(p => p.toLowerCase() === '.system')) {
          return resolved;
        }
      }
    }
  }
  if (permitted) return resolved;
  fail('Outside managed AGENTS.md/settings.json/user skill files: ' + resolved);
}

async function doCheckpoint(root, value, userRequested = false) {
  checkFields(value, ['scope', 'reason', 'paths']);
  shortStr(value.scope, 'scope', 240);
  shortStr(value.reason, 'reason', 1000);
  if (!Array.isArray(value.paths) || value.paths.length < 1 || value.paths.length > 32) {
    fail('paths must contain 1..32 existing files');
  }
  const paths = value.paths.map(p => isManaged(p, root));
  if (new Set(paths).size !== paths.length) {
    fail('Duplicate checkpoint paths');
  }
  const contents = [];
  for (const p of paths) {
    const data = await fsp.readFile(p);
    if (data.length > 2 * 1024 * 1024) {
      fail('Managed files must not exceed 2 MiB');
    }
    contents.push(data);
  }
  const changeId = randomUUID().replace(/-/g, '');
  const stage = path.join(root, 'changes', '.pending-' + changeId);
  await fsp.mkdir(stage, { recursive: true });
  const files = [];
  for (let i = 0; i < paths.length; i++) {
    const snapshot = i + '.before';
    await atomicWrite(path.join(stage, snapshot), contents[i]);
    files.push({
      path: paths[i],
      snapshot,
      before_sha256: digest(contents[i]),
    });
  }
  await writeJSON(path.join(stage, 'checkpoint.json'), {
    id: changeId, created_at: now(), scope: value.scope,
    reason: value.reason, files, user_requested: userRequested,
  });
  await fsp.rename(stage, path.join(root, 'changes', changeId));
  return { id: changeId, files: files.length, state: 'checkpointed' };
}

async function loadChange(root, changeId) {
  if (!/^[a-f0-9]{32}$/.test(changeId)) {
    fail('Invalid change ID');
  }
  const dir = safePath(path.join(root, 'changes', changeId));
  const manifest = await readJSON(path.join(dir, 'checkpoint.json'));
  for (let i = 0; i < manifest.files.length; i++) {
    const item = manifest.files[i];
    isManaged(item.path, root);
    if (item.snapshot !== i + '.before') {
      fail('Invalid snapshot name');
    }
    const snapData = await fsp.readFile(path.join(dir, item.snapshot));
    if (digest(snapData) !== item.before_sha256) {
      fail('Snapshot integrity check failed');
    }
  }
  return { dir, manifest };
}

async function doCommit(root, changeId, validation, userRequested = false) {
  shortStr(validation, 'validation', 1000);
  const { dir, manifest } = await loadChange(root, changeId);
  if (fs.existsSync(path.join(dir, 'committed.json'))) {
    fail('Change already committed');
  }
  const contents = {};
  for (const f of manifest.files) {
    const data = await fsp.readFile(f.path);
    if (data.length > 2 * 1024 * 1024) {
      fail('Managed files must not exceed 2 MiB');
    }
    contents[f.path] = data;
  }
  const after = {};
  const afterSnapshots = {};
  for (const [p, data] of Object.entries(contents)) {
    const idx = manifest.files.findIndex(f => f.path === p);
    const snapshot = idx + '.after';
    await atomicWrite(path.join(dir, snapshot), data);
    after[p] = digest(data);
    afterSnapshots[p] = snapshot;
  }
  for (const [p, data] of Object.entries(contents)) {
    const current = await fsp.readFile(p);
    if (!current.equals(data)) {
      fail('Concurrent change during commit: ' + p);
    }
  }
  await writeJSON(path.join(dir, 'committed.json'), {
    created_at: now(), validation, after_sha256: after,
    after_snapshots: afterSnapshots, user_requested: userRequested,
  });
  return { id: changeId, state: 'committed', files: Object.keys(after).length };
}

async function doRollback(root, changeId, apply) {
  const { dir, manifest } = await loadChange(root, changeId);
  if (!fs.existsSync(path.join(dir, 'committed.json'))) {
    fail('No committed after-hashes; record actual validation/failure with commit before guarded rollback');
  }
  const committed = await readJSON(path.join(dir, 'committed.json'));
  if (fs.existsSync(path.join(dir, 'rolled-back.json'))) {
    fail('Change already rolled back');
  }
  const files = manifest.files;
  for (let i = 0; i < files.length; i++) {
    const item = files[i];
    const snapshot = i + '.after';
    if (committed.after_snapshots[item.path] !== snapshot) {
      fail('After-snapshot integrity check failed');
    }
    const snapData = await fsp.readFile(path.join(dir, snapshot));
    if (digest(snapData) !== committed.after_sha256[item.path]) {
      fail('After-snapshot integrity check failed');
    }
  }
  const current = {};
  for (const f of files) {
    current[f.path] = await fsp.readFile(f.path);
  }
  const conflicts = [];
  for (const f of files) {
    if (digest(current[f.path]) !== committed.after_sha256[f.path]) {
      conflicts.push(f.path);
    }
  }
  const preview = {
    id: changeId, state: 'preview', can_apply: conflicts.length === 0,
    conflicts, files: files.map(f => f.path),
  };
  if (!apply) return preview;
  if (conflicts.length > 0) {
    fail('Rollback refused; newer/concurrent changes in: ' + conflicts.join(', '));
  }
  const attempt = path.join(dir, 'restore-' + randomUUID().replace(/-/g, ''));
  await fsp.mkdir(attempt);
  for (let i = 0; i < files.length; i++) {
    await atomicWrite(path.join(attempt, i + '.current'), current[files[i].path]);
  }
  for (const f of files) {
    const recheck = await fsp.readFile(f.path);
    if (!recheck.equals(current[f.path])) {
      fail('Concurrent change detected before restore: ' + f.path);
    }
  }
  const restored = [];
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const recheck = await fsp.readFile(f.path);
      if (!recheck.equals(current[f.path])) {
        fail('Concurrent change during restore; inspect restore attempt before continuing: ' + f.path);
      }
      const beforeData = await fsp.readFile(path.join(dir, f.snapshot));
      await atomicWrite(f.path, beforeData);
      restored.push(f.path);
    }
  } finally {
    await writeJSON(path.join(attempt, 'result.json'), {
      created_at: now(), restored, expected: files.length,
    });
  }
  await writeJSON(path.join(dir, 'rolled-back.json'), {
    created_at: now(), restored,
  });
  return { id: changeId, state: 'rolled-back', files: restored };
}

async function main() {
  const args = process.argv.slice(2);
  let root = DEFAULT_ROOT;
  let command = null;
  let inputFile = null;
  let changeId = null;
  let validation = null;
  let apply = false;
  let userRequested = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') { root = args[++i]; }
    else if (args[i] === '--input') { inputFile = args[++i]; }
    else if (args[i] === '--id') { changeId = args[++i]; }
    else if (args[i] === '--validation') { validation = args[++i]; }
    else if (args[i] === '--apply') { apply = true; }
    else if (args[i] === '--user-requested') { userRequested = true; }
    else if (!command) { command = args[i]; }
    else { fail('Unknown argument: ' + args[i]); }
  }
  if (!command) fail('Command required: status|pause|resume|record|checkpoint|commit|rollback');

  // Ensure directories exist
  for (const d of [root, path.join(root, 'records'), path.join(root, 'changes')]) {
    await fsp.mkdir(d, { recursive: true });
  }

  const lockPath = await acquireLock(root);
  try {
    let result;
    if (command === 'status') {
      result = await doStatus(root);
    } else if (command === 'pause' || command === 'resume') {
      result = { enabled: command === 'resume', updated_at: now() };
      await writeJSON(path.join(root, 'control.json'), result);
    } else if (command === 'rollback') {
      if (!changeId) fail('--id required for rollback');
      result = await doRollback(root, changeId, apply);
    } else {
      if (!(await isEnabled(root)) && !userRequested) {
        fail('Self-evolution paused; status and rollback remain available');
      }
      if (command === 'record') {
        if (!inputFile) fail('--input required for record');
        result = await doRecord(root, await inputJSON(inputFile), userRequested);
      } else if (command === 'checkpoint') {
        if (!inputFile) fail('--input required for checkpoint');
        result = await doCheckpoint(root, await inputJSON(inputFile), userRequested);
      } else if (command === 'commit') {
        if (!changeId) fail('--id required for commit');
        if (!validation) fail('--validation required for commit');
        result = await doCommit(root, changeId, validation, userRequested);
      } else {
        fail('Unknown command: ' + command);
      }
    }
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    if (e.exitCode === 2 || e.message) {
      process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
      return 2;
    }
    throw e;
  } finally {
    releaseLock(lockPath);
  }
}

main().then(code => process.exit(code)).catch(e => {
  process.stderr.write(JSON.stringify({ error: e.message || String(e) }) + '\n');
  process.exit(2);
});
