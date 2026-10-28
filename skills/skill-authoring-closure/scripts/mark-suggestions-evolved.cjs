#!/usr/bin/env node
// 把已处理完的进化建议标记为 evolved（应用侧「完成」状态），默认先预览，--apply 才写。
// 用法: node mark-suggestions-evolved.cjs --db <main.sqlite> (--ids "id1,id2" | --names "a,b,c") [--backup-dir <目录>] [--allow-partial] [--apply] [--reason 文本]
// 优先用 --ids：同一 skill_name 可能有多条 pending 行，按名字会误标其他行；ids 模式要求全部命中，部分命中判红（除非 --allow-partial）。
// 退出码: 0=成功/预览 2=参数错误 3=没有匹配的 pending 行或 ids 未全命中 4=数据库错误/复验不符
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
const get = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes('--' + n);
const dbPath = get('db');
const ids = (get('ids') || '').split(',').map((x) => x.trim()).filter(Boolean);
const names = (get('names') || '').split(',').map((x) => x.trim()).filter(Boolean);
if (!dbPath || (!ids.length && !names.length)) {
  console.error('用法: node mark-suggestions-evolved.cjs --db <main.sqlite> (--ids "id1,id2" | --names "a,b,c") [--backup-dir <目录>] [--allow-partial] [--apply] [--reason 文本]');
  process.exit(2);
}
if (ids.length && names.length) { console.error('--ids 与 --names 二选一，不要混用'); process.exit(2); }
if (!fs.existsSync(dbPath)) { console.error('数据库不存在: ' + dbPath); process.exit(2); }

const apply = has('apply');
const reason = get('reason', '合并落库后标记完成');
const now = Date.now();

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: !apply });
  db.exec('PRAGMA busy_timeout = 5000');
} catch (e) {
  console.error('打开数据库失败: ' + e.message);
  process.exit(4);
}

const selector = ids.length ? 'id' : 'skill_name';
const wanted = ids.length ? ids : names;
const ph = wanted.map(() => '?').join(',');
let rows;
try {
  rows = db.prepare(
    `SELECT id, skill_name, status, created_at FROM skill_evolution_suggestions
     WHERE status = 'pending' AND ${selector} IN (${ph}) ORDER BY skill_name, created_at`
  ).all(...wanted);
} catch (e) {
  console.error('查询失败: ' + e.message);
  db.close();
  process.exit(4);
}

const total = db.prepare("SELECT COUNT(*) c FROM skill_evolution_suggestions WHERE status='pending'").get().c;
console.log(`匹配 pending 行: ${rows.length} / 指定 ${selector}: ${wanted.length} / 全库 pending: ${total}`);
for (const r of rows) console.log(`  - ${r.skill_name}  (${r.id})`);

if (!rows.length) { db.close(); process.exit(3); }
if (ids.length && rows.length !== wanted.length && !has('allow-partial')) {
  const hit = new Set(rows.map((r) => String(r[selector])));
  console.error('未全部命中，未写入。缺失的 ' + selector + ': ' + wanted.filter((w) => !hit.has(w)).join(', '));
  console.error('（多为快照已过期或该行已被其他会话处理；确认后可加 --allow-partial 只标已命中行）');
  db.close();
  process.exit(3);
}
if (!ids.length && rows.length !== wanted.length) {
  console.log(`提示：按名字匹配到 ${rows.length} 行（指定 ${wanted.length} 个名字），同名多行会一起标记；需精确范围请改用 --ids`);
}

if (!apply) {
  console.log('\n[预览] 未写入。确认无误后加 --apply 执行。');
  db.close();
  process.exit(0);
}

const CLIENT_ROOT = (() => {
  try { return require(path.join(__dirname, '..', '..', '..', 'scripts', 'client-root.js')).clientRoot(); } catch (e) { return path.join(os.homedir(), '.qoder'); }
})();
const backupDir = get('backup-dir') || path.join(CLIENT_ROOT, 'evolution', 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(backupDir, `suggestion-rows-${stamp}.json`);
const full = db.prepare(`SELECT * FROM skill_evolution_suggestions WHERE id IN (${rows.map(() => '?').join(',')})`).all(...rows.map((r) => r.id));
fs.writeFileSync(backupFile, JSON.stringify({ db: dbPath, rows: full }, null, 2), 'utf8');
console.log('逻辑备份: ' + backupFile);

try {
  db.exec('BEGIN IMMEDIATE');
  const upd = db.prepare(
    `UPDATE skill_evolution_suggestions
     SET status = 'evolved', updated_at = ?, reason = ?
     WHERE id = ? AND status = 'pending'`
  );
  for (const r of rows) upd.run(now, reason, r.id);
  db.exec('COMMIT');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch {}
  console.error('写入失败，已回滚: ' + e.message);
  db.close();
  process.exit(4);
}

const after = db.prepare(`SELECT status, COUNT(*) c FROM skill_evolution_suggestions WHERE ${selector} IN (${ph}) GROUP BY status`).all(...wanted);
const pendingLeft = db.prepare("SELECT COUNT(*) c FROM skill_evolution_suggestions WHERE status='pending'").get().c;
console.log('\n写入后状态分布:', JSON.stringify(after));
console.log(`全库 pending: ${total} -> ${pendingLeft}（应减少 ${rows.length}）`);
const marked = db.prepare(`SELECT COUNT(*) c FROM skill_evolution_suggestions WHERE ${selector} IN (${ph}) AND status='evolved'`).get(...wanted).c;
if (total - pendingLeft !== rows.length) {
  console.error(`复验不符：pending 减少量 ${total - pendingLeft} ≠ 匹配行 ${rows.length}（有其他会话并发写入，请按备份核对）`);
  db.close();
  process.exit(4);
}
if (!marked) { console.error('复验失败：没有任何行处于 evolved'); db.close(); process.exit(4); }
console.log(`[复验] 已标记 evolved = ${marked}`);
db.close();
process.exit(0);
