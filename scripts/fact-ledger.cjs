#!/usr/bin/env node
/**
 * 硬事实登记簿：把 ≤12 行长期硬约束钉在每轮注意力窗口里（对照 DSH 的 fact_register）。
 *
 * 用法：
 *   node fact-ledger.cjs --add "用户要求 TS strict、禁 any"
 *   node fact-ledger.cjs --list
 *   node fact-ledger.cjs --remove 2
 *   node fact-ledger.cjs --clear
 *   node fact-ledger.cjs --hook     # UserPromptSubmit 钩子模式，从 stdin 读事件 JSON
 *
 * 存储：<facts 根>/<sha1(cwd) 前 12 位>.md，默认根 ~/.qoder/facts（测试可用 FACT_LEDGER_DIR 覆盖）。
 * 纪律：一条一行、≤200 字符、最多 12 条（超出按 FIFO 掉最旧的）；不存会过期的进度状态。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();
const crypto = require('crypto');

const MAX_FACTS = 12;
const MAX_LINE = 200;
const ROOT = process.env.FACT_LEDGER_DIR || path.join(CLIENT_ROOT, 'facts');
const TMP_DIR = path.join(CLIENT_ROOT, 'tmp', 'fact-ledger');

function projectKey(cwd) {
  return crypto.createHash('sha1').update(String(cwd || process.cwd())).digest('hex').slice(0, 12);
}

function factsFile(cwd) {
  return path.join(ROOT, projectKey(cwd) + '.md');
}

function readFacts(cwd) {
  const p = factsFile(cwd);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean)
    .slice(-MAX_FACTS);
}

function writeFacts(cwd, facts) {
  fs.mkdirSync(ROOT, { recursive: true });
  const p = factsFile(cwd);
  if (!facts.length) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return;
  }
  fs.writeFileSync(p, facts.map((f) => '- ' + f).join('\n') + '\n', 'utf8');
}

function normalize(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_LINE ? t.slice(0, MAX_LINE - 1) + '…' : t;
}

function addFact(cwd, text) {
  const fact = normalize(text);
  if (!fact) return { ok: false, reason: '空内容' };
  const facts = readFacts(cwd);
  const idx = facts.indexOf(fact);
  if (idx >= 0) facts.splice(idx, 1);
  facts.push(fact);
  while (facts.length > MAX_FACTS) facts.shift();
  writeFacts(cwd, facts);
  return { ok: true, facts, dropped: idx < 0 && facts.length === MAX_FACTS ? 1 : 0 };
}

function heartbeat(n) {
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const log = path.join(TMP_DIR, 'heartbeat.log');
    fs.appendFileSync(log, new Date().toISOString() + ' ok ' + n + '\n');
    if (fs.statSync(log).size > 64 * 1024) {
      const tail = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(-200).join('\n') + '\n';
      fs.writeFileSync(log, tail);
    }
  } catch {}
}

function emitHook(facts) {
  heartbeat(facts.length);
  if (!facts.length) return;
  const body = facts.map((f, i) => (i + 1) + '. ' + f).join('\n');
  const ctx =
    '【硬事实登记簿 · 本会话已钉住 ' + facts.length + '/' + MAX_FACTS + ' 条】\n' +
    body +
    '\n（长期硬约束，每轮自动注入；新增 /fact add "…"，查看 /fact list，删除 /fact remove N，清空 /fact clear）';
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } }) + '\n'
  );
}

function hookMain() {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    let cwd = process.cwd();
    try {
      const ev = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (ev.cwd) cwd = ev.cwd;
    } catch {}
    try { emitHook(readFacts(cwd)); } catch {}
    process.exit(0);
  });
  setTimeout(() => { try { emitHook(readFacts(process.cwd())); } catch {} process.exit(0); }, 1500).unref();
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--hook') return hookMain();
  const cwd = process.cwd();

  if (args[0] === '--add') {
    const r = addFact(cwd, args.slice(1).join(' '));
    if (!r.ok) { console.error('未新增：' + r.reason); process.exit(2); }
    console.log('已登记（' + r.facts.length + '/' + MAX_FACTS + '）：');
    r.facts.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
    return;
  }
  if (args[0] === '--list' || !args.length) {
    const facts = readFacts(cwd);
    if (!facts.length) { console.log('（本目录暂无硬事实；用 --add "<一条硬约束>" 登记）'); return; }
    console.log('硬事实 ' + facts.length + '/' + MAX_FACTS + '（' + factsFile(cwd) + '）：');
    facts.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
    return;
  }
  if (args[0] === '--remove') {
    const n = Number(args[1]);
    const facts = readFacts(cwd);
    if (!Number.isInteger(n) || n < 1 || n > facts.length) { console.error('序号越界（1..' + facts.length + '）'); process.exit(2); }
    const [gone] = facts.splice(n - 1, 1);
    writeFacts(cwd, facts);
    console.log('已删除：' + gone + '；剩余 ' + facts.length + ' 条');
    return;
  }
  if (args[0] === '--clear') {
    writeFacts(cwd, []);
    console.log('已清空本目录的硬事实');
    return;
  }
  console.error('用法：--add "<文本>" | --list | --remove <序号> | --clear | --hook');
  process.exit(2);
}

if (require.main === module) main();

module.exports = { readFacts, writeFacts, addFact, normalize, projectKey, factsFile, MAX_FACTS, MAX_LINE };
