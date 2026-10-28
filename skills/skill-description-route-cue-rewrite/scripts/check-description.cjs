#!/usr/bin/env node
'use strict';
/*
 * check-description.cjs — 技能 frontmatter description 改写验收检查器
 * 正向：格式断言 + 逐组关键短语断言；负对照：baseline 必须判红，否则内置剥短语变异对照。
 * 用法：
 *   node check-description.cjs --file <SKILL.md> --groups <spec.json> [--baseline <路径1>,<路径2>] [--max-len 1024] [--max-ratio 0.9]
 *   node check-description.cjs --desc "<description 文本>" --groups <spec.json>
 * spec.json：{"groups":[{"name":"跨通道合并计数","phrases":["字面量短语"]}],"maxLen":1024,"maxRatio":0.9}
 * phrases 一律写字面量（中文不要用 \uXXXX 转义，跨 U+8DE8 误写成跳 U+8DF3 会假红）。
 * 退出码：0 全绿；1 判红；2 用法或 IO 错误。
 */

const fs = require('fs');

function usageError(msg) {
  console.error('[用法错误] ' + msg);
  console.error('用法: node check-description.cjs --file <SKILL.md> --groups <spec.json> [--baseline <路径1>,<路径2>] [--max-len 1024] [--max-ratio 0.9]');
  process.exit(2);
}

const argv = process.argv.slice(2);
function argVal(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const filePath = argVal('--file');
const descArg = argVal('--desc');
const groupsPath = argVal('--groups');
const baselineArg = argVal('--baseline');
const maxLenArg = argVal('--max-len');
const maxRatioArg = argVal('--max-ratio');

if (!filePath && !descArg) usageError('必须给 --file <SKILL.md> 或 --desc "<文本>"');
if (filePath && descArg) usageError('--file 与 --desc 只能给一个');
if (!groupsPath) usageError('必须给 --groups <spec.json>');

const maxLen = maxLenArg !== undefined ? Number(maxLenArg) : 1024;
if (!Number.isFinite(maxLen) || maxLen <= 0) usageError('--max-len 必须是正数');
const maxRatio = maxRatioArg !== undefined ? Number(maxRatioArg) : 0.9;
if (!Number.isFinite(maxRatio) || maxRatio <= 0 || maxRatio >= 1) usageError('--max-ratio 必须在 (0,1) 区间');

let spec;
try {
  spec = JSON.parse(fs.readFileSync(groupsPath, 'utf8'));
} catch (e) {
  usageError('读不到或解析不了 groups spec（' + groupsPath + '）: ' + e.message);
}
const groups = spec.groups;
if (!Array.isArray(groups) || groups.length === 0) usageError('spec.groups 必须是非空数组');
for (const g of groups) {
  if (!g || typeof g.name !== 'string' || g.name.length === 0 ||
      !Array.isArray(g.phrases) || g.phrases.length === 0 ||
      g.phrases.some(function (p) { return typeof p !== 'string' || p.length === 0; })) {
    usageError('spec.groups 每项需要 {name: 非空字符串, phrases: [非空字符串]}，实际: ' + JSON.stringify(g));
  }
}
const effMaxLen = Number.isFinite(Number(spec.maxLen)) && Number(spec.maxLen) > 0 ? Number(spec.maxLen) : maxLen;
const effMaxRatio = Number.isFinite(Number(spec.maxRatio)) && Number(spec.maxRatio) > 0 && Number(spec.maxRatio) < 1 ? Number(spec.maxRatio) : maxRatio;
const effMaxRatioPct = Math.round(effMaxRatio * 100);

// ---- 提取 description ----
// 返回 {value, quoted, closedOnSameLine, fromFrontmatter, lineNo} 或 {err}
function extractDescription(raw) {
  const lines = raw.split('\n');
  if ((lines[0] || '').replace(/\r$/, '') !== '---') {
    // 不是 SKILL.md 结构：整个文件内容当作 description 文本（残缺版夹具常这样给）
    return { value: raw.replace(/^[ \t\r\n]+/, '').replace(/[ \t\r\n]+$/, ''), quoted: false, closedOnSameLine: false, fromFrontmatter: false };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] || '').replace(/\r$/, '') === '---') { endIdx = i; break; }
  }
  if (endIdx === -1) return { err: 'frontmatter 没有闭合的 ---' };
  for (let i = 1; i < endIdx; i++) {
    const m = (lines[i] || '').replace(/\r$/, '').match(/^description:\s*(.*)$/);
    if (!m) continue;
    const t = m[1].trim();
    if (t.startsWith('"')) {
      const lastQ = t.lastIndexOf('"');
      if (lastQ === 0) {
        return { value: t.slice(1), quoted: true, closedOnSameLine: false, fromFrontmatter: true, lineNo: i + 1 };
      }
      return { value: t.slice(1, lastQ), quoted: true, closedOnSameLine: true, fromFrontmatter: true, lineNo: i + 1 };
    }
    return { value: t, quoted: false, closedOnSameLine: true, fromFrontmatter: true, lineNo: i + 1 };
  }
  return { err: 'frontmatter 里没有 description 行' };
}

function hasBareQuote(v) {
  return v.replace(/\\"/g, '').indexOf('"') !== -1;
}

function checkGroups(desc) {
  return groups.map(function (g, idx) {
    const hit = g.phrases.find(function (p) { return desc.indexOf(p) !== -1; });
    return { idx: idx + 1, name: g.name, pass: hit !== undefined, hit: hit || null };
  });
}

function stripAllPhrases(desc) {
  let out = desc, prev, guard = 0;
  do {
    prev = out;
    for (const g of groups) {
      for (const p of g.phrases) out = out.split(p).join('');
    }
  } while (out !== prev && ++guard < 10);
  return out;
}

// ---- 目标 ----
let targetRaw;
if (filePath) {
  try {
    targetRaw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    usageError('读不到目标文件（' + filePath + '）: ' + e.message);
  }
} else {
  targetRaw = descArg;
}
const target = extractDescription(targetRaw);
if (target.err) {
  console.log('[DESC-CHECK] target=' + (filePath || '--desc'));
  console.log('[EXTRACT] FAIL: ' + target.err);
  console.log('[判定] FAIL');
  process.exit(1);
}

let failed = false;
const problems = [];

console.log('[DESC-CHECK] target=' + (filePath || '--desc'));

// ---- 格式断言 ----
const crlf = /[\r\n]/.test(target.value);
const bareQuote = hasBareQuote(target.value);
const fmt = [
  ['引号包裹', target.quoted],
  ['单行闭合', target.closedOnSameLine],
  ['无裸双引号', !bareQuote],
  ['无CR/LF', !crlf]
];
const fmtStr = fmt.map(function (f) { return f[0] + '=' + (f[1] ? 'OK' : 'FAIL'); }).join(' ');
console.log('[FORMAT] ' + fmtStr + ' 长度=' + target.value.length + '/' + effMaxLen + (target.lineNo ? ' (第' + target.lineNo + '行)' : ''));
if (!target.quoted) problems.push('description 未用双引号包裹');
if (!target.closedOnSameLine) problems.push('description 未在同一行闭合（跨行或缺闭合引号）');
if (bareQuote) problems.push('description 内部有裸双引号');
if (crlf) problems.push('description 值内含 CR/LF');
if (target.value.length > effMaxLen) problems.push('长度 ' + target.value.length + ' 超过上限 ' + effMaxLen);
if (fmt.some(function (f) { return !f[1]; }) || target.value.length > effMaxLen) failed = true;

// ---- 逐组短语断言 ----
const groupResults = checkGroups(target.value);
for (const r of groupResults) {
  console.log('[GROUP] ' + r.idx + ' ' + r.name + ': ' + (r.pass ? 'PASS（命中 ' + r.hit + '）' : 'MISS'));
  if (!r.pass) problems.push('线索组「' + r.name + '」全部短语未命中');
}
if (groupResults.some(function (r) { return !r.pass; })) failed = true;

// ---- baseline 负对照 / 内置变异对照 ----
const baselinePaths = baselineArg ? baselineArg.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
if (baselinePaths.length > 0) {
  let maxBaselineLen = 0;
  for (const bp of baselinePaths) {
    let raw;
    try {
      raw = fs.readFileSync(bp, 'utf8');
    } catch (e) {
      usageError('读不到 baseline（' + bp + '）: ' + e.message);
    }
    const ex = extractDescription(raw);
    if (ex.err) usageError('baseline 提取失败（' + bp + '）: ' + ex.err);
    const gr = checkGroups(ex.value);
    const missing = gr.filter(function (r) { return !r.pass; });
    const ok = missing.length >= 1;
    console.log('[BASELINE] ' + bp + ' 长度=' + ex.value.length + ' 缺组=' + missing.length + (ok ? ' → 判红（符合预期）' : ' → 恒绿（不符合预期，短语无区分力）'));
    if (missing.length > 0) {
      console.log('[BASELINE]   缺: ' + missing.map(function (r) { return r.idx + ' ' + r.name; }).join('；'));
    }
    if (!ok) {
      failed = true;
      problems.push('baseline ' + bp + ' 全部命中 → 断言无区分力，换补回后的具体子项短语');
    }
    if (ex.value.length > maxBaselineLen) maxBaselineLen = ex.value.length;
  }
  const pct = Math.round(target.value.length * 100 / maxBaselineLen);
  const ratioOk = target.value.length < maxBaselineLen * effMaxRatio;
  console.log('[RATIO] 新=' + target.value.length + ' 原版(取baseline最长)=' + maxBaselineLen + ' → ' + pct + '%（<' + effMaxRatioPct + '%）' + (ratioOk ? ' OK' : ' FAIL'));
  if (!ratioOk) {
    failed = true;
    problems.push('新长度 ' + target.value.length + ' 未明显低于原版 ' + maxBaselineLen + '（需 <' + effMaxRatioPct + '%）');
  }
} else {
  const mutated = stripAllPhrases(target.value);
  const gr = checkGroups(mutated);
  const survivors = gr.filter(function (r) { return r.pass; });
  const ok = survivors.length === 0;
  console.log('[MUTATION] 剥短语变异对照: 剥后仍命中组数=' + survivors.length + (ok ? ' → 全 MISS（符合预期）' : ' → 恒绿（不符合预期）'));
  if (!ok) {
    failed = true;
    problems.push('剥短语变异后仍命中: ' + survivors.map(function (r) { return r.name; }).join('、') + ' → 短语清单疑似无区分力');
  }
  console.log('[RATIO] 未给 baseline，跳过比例判断');
}

if (failed) {
  console.log('[判定] FAIL');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('[判定] PASS');
process.exit(0);
