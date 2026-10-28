#!/usr/bin/env node
// hook-gap-scan.cjs —— 「这条纪律是不是只有提示词」的取证器（流水线第 1 步）
//
// 为什么不能直接 grep：`grep -rlE "三次|连败|threshold" ~/.qoder/scripts/*.js` 会把
// ① 废弃副本（.bak/_backup 里被取代的旧 hook）也算成「现役机制」，得出「已经有门禁了」的假结论；
// ② 把提示词注入器（rules-reminder.js 里那句「连败三次」）算成机制；
// ③ 漏掉真正的机制代码——现役入口只是薄壳，判据在被 `require` 的 core 里，而 core 不直接挂在 settings.json 上。
// 所以本工具：只认 settings.json 真实引用的脚本 → 顺一层局部 require → 去掉注释后分档。
//
// 分档（只描述「代码里有没有」，不描述「文案里提没提」）：
//   counting   有计数逻辑（计数器/阈值符号 + 数值比较）
//   state      有状态写（把判定结果落盘，但没有阈值比较）
//   mention    仅文本提及（关键词只出现在注释/提示词字符串里）
//   none       未命中
//
// 用法：
//   node hook-gap-scan.cjs                      默认扫 ~/.qoder 与同级的 ~/.qoder-cn
//   node hook-gap-scan.cjs --json               机器可读输出
//   node hook-gap-scan.cjs --home <目录>         指定体检根（settings.json 所在目录）
//   node hook-gap-scan.cjs --pattern <正则>      换默认口径
//   node hook-gap-scan.cjs --discipline <正则>   换「目标纪律」特征（判缺口用）
//   node hook-gap-scan.cjs --no-follow           不顺 require（只看 settings.json 直接引用的文件）
//   node hook-gap-scan.cjs --selftest            自检：机制夹具必须判「非仅文本」、文案夹具必须判「仅文本」
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PATTERN = /三次|连败|consecutive|failCount|streak|threshold/i;
// 目标纪律的「机制级」特征：泛化的「同类连败 N 种不同手段即停」守卫本体（安装后应命中）
const DEFAULT_DISCIPLINE = /fail-streak|distinct\s*means|不同手段/i;
const DEPRECATED = /(\.bak(\.|$))|(_backup)|(backup-)|(\.old$)|(\.orig$)|(\.save$)/i;
const SCRIPT_TAIL = /\.(?:js|cjs|mjs|sh|ps1|cmd|bat)\b/i;

function home() { return process.env.USERPROFILE || process.env.HOME || os.homedir(); }
function parseArgs(argv) {
  const a = { follow: true, depth: 1 };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--json') a.json = true;
    else if (t === '--selftest') a.selftest = true;
    else if (t === '--no-follow') a.follow = false;
    else if (t === '--home') a.home = argv[++i];
    else if (t === '--pattern') a.pattern = argv[++i];
    else if (t === '--discipline') a.discipline = argv[++i];
    else if (t === '--depth') a.depth = Number(argv[++i]) || 1;
    else if (t === '--help' || t === '-h') a.help = true;
    else a.unknown = (a.unknown || []).concat([t]);
  }
  return a;
}

// 去掉注释，但**不能**碰字符串里的 `//`（URL、提示词文本都含）
function stripComments(src) {
  let out = '', i = 0, q = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { out += n || ''; i += 2; continue; }
      if (c === q) q = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

// 再去掉字符串字面量内容（保留引号与换行）：提示词注入器的关键词全在字符串里，
// 不剥掉就没法区分「代码里真有个计数器」和「文案里写了句连败三次」。
// 模板字符串里的 `${}` 表达式一并当作文本剥掉——本工具只做分档取证，不做解析。
function stripStrings(src) {
  let out = '', i = 0, q = null, prev = '';
  const REGEX_OK = '(,=:[!&|?{};';   // 这些字符之后出现的 `/` 是正则字面量而不是除号（比对最近一个**非空白**字符）
  while (i < src.length) {
    const c = src[i];
    if (q) {
      if (c === '\\') { i += 2; continue; }
      if (c === q) { out += c; q = null; i++; continue; }
      i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; prev = c; continue; }
    // 正则字面量里常有撇号（/user'?/、/账号[\s\S]{0,6}锁/）：不跳过去，撇号会被当成字符串开头，
    // 一路吞掉后面的真代码 ⇒ 计数器被判成「仅文本提及」，本工具的结论就反了。
    if (c === '/' && REGEX_OK.includes(prev)) {
      i++;
      let cls = false;
      while (i < src.length) {
        const r = src[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '\n') break;                       // 没闭合就换行：判回普通字符，交回主循环
        if (cls) { if (r === ']') cls = false; i++; continue; }
        if (r === '[') { cls = true; i++; continue; }
        if (r === '/') { i++; while (i < src.length && /[gimsuyvd]/.test(src[i])) i++; break; }
        i++;
      }
      prev = '/'; continue;
    }
    out += c; i++;
    if (!/\s/.test(c)) prev = c;          // 空白不更新 prev：`= /re/` 前面是空格，判据要落在 `=` 上
  }
  return out;
}

const COUNTING_SYMBOL = /\b(?:fail[_]?count|failcount|streak|attempts|consecutive|threshold|counter|hits?)\b/i;
// 阈值比较：符号在比较符任一侧（`>= threshold` / `count > 3` / `meansCount(e) >= threshold`）
const COMPARISON = /(?:[<>]=?|===|!==)\s*[\w.\s()[\]+'"|-]{0,40}?(?:threshold|limit|max|attempts|streak|fail[_]?count|counter)|(?:threshold|fail[_]?count|streak|attempts|counter)\s*(?:[<>]=?|===)|\+\+\s*[\w.[$\]'"]+|\bMath\.max\b[\s\S]{0,60}(?:ttl|bttl)/i;
const STATE_WRITE = /(?:writeFileSync|appendFileSync)\s*\((?![\s\S]{0,400}?\b(?:readFileSync)\b)[\s\S]{0,400}?(?:state|ledger|\.log|\.json|decisions)/i;

// 单个文件分档：{file, exists, hits, bucket, evidence, requires}
// 判据一律跑在 `logic`（注释与字符串都剥掉）上——否则 rules-reminder.js 那种「提示词里写了句
// 连败三次」会被算成机制，正是本工具要区分开的两类东西。
function classify(file, pattern, discipline) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { file, exists: false, hits: 0, bucket: 'missing', evidence: [], requires: [] }; }
  const code = stripComments(raw);
  const logic = stripStrings(code);
  const hits = (raw.match(new RegExp(pattern.source, pattern.flags)) || []).length;
  const logicHits = (logic.match(new RegExp(pattern.source, pattern.flags)) || []).length;
  const counting = COUNTING_SYMBOL.test(logic) && COMPARISON.test(logic);
  // 状态落盘的判据要在 `code`（保留了字符串）上跑：state.json / decisions.log 这些特征本身就在路径字面量里
  const state = STATE_WRITE.test(code);
  const bucket = hits === 0 ? 'none' : counting ? 'counting' : state ? 'state' : 'mention';
  // require 路径与纪律特征都在**字符串/标识符**里 ⇒ 跑在 `code`（剥注释、留字符串）上；
  // 计数逻辑判据仍跑在 `logic` 上，二者不可混用（拿 logic 提 require 会永远提不到，漏掉委托 core）。
  const discHits = (code.match(new RegExp(discipline.source, discipline.flags)) || []).length;
  const requires = [...code.matchAll(/require\(\s*['"](\.\/[^'"]+|\.\.[\\/][^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const ev = [];
  if (counting) ev.push('阈值比较');
  if (state) ev.push('状态落盘');
  if (logicHits > 0) ev.push('代码逻辑内关键词×' + logicHits);
  else if (hits > 0) ev.push('仅注释/提示词×' + hits);
  if (discHits > 0) ev.push((bucket === 'counting' || bucket === 'state' ? '目标纪律特征×' : '纪律字样仅见于文案×') + discHits);
  return { file, exists: true, hits, logicHits, bucket, disciplineHits: discHits, evidence: ev, requires };
}

// settings.json 里真实引用的脚本清单（去重；顺序稳定）
function wiredScripts(settingsFile) {
  let j; try { j = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) { return { error: String(e.message).slice(0, 80), scripts: [] }; }
  const hooks = (j && j.hooks) || {};
  const found = [];
  for (const ev of Object.keys(hooks)) {
    for (const entry of (hooks[ev] || [])) {
      for (const h of (entry.hooks || [])) {
        const cmd = String(h.command || '');
        for (const m of cmd.matchAll(/[^\s"';|&]+?\.(?:js|cjs|mjs|sh|ps1|cmd|bat)\b/gi)) {
          const p = m[0].replace(/\\/g, '/');
          found.push({ event: ev, matcher: entry.matcher || null, script: p });
        }
      }
    }
  }
  return { scripts: found };
}

function collect(root, pattern, discipline, follow, depth) {
  const settingsFile = path.join(root, 'settings.json');
  if (!fs.existsSync(settingsFile)) return { root, settingsFile, error: 'settings.json 不存在', rows: [], excluded: [], wiredCount: 0 };
  const wired = wiredScripts(settingsFile);
  const seen = new Map(), excluded = [];
  const queue = [];
  for (const w of wired.scripts) {
    const abs = path.resolve(w.script);
    if (DEPRECATED.test(path.basename(abs)) || DEPRECATED.test(abs)) {
      const key = abs + '|' + w.event;
      if (!excluded.some((e) => e.file === abs && e.event === w.event)) excluded.push({ file: abs, event: w.event, reason: '废弃副本（.bak/_backup 等）仍挂在 settings.json 上' });
      void key; continue;
    }
    if (!seen.has(abs)) { seen.set(abs, { origin: 'wired:' + w.event }); queue.push({ abs, origin: 'wired:' + w.event, d: 0 }); }
  }
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const row = classify(item.abs, pattern, discipline);
    row.origin = item.origin;
    row.depth = item.d;
    seen.set(item.abs, row);
    if (follow && item.d < depth) {
      for (const r of row.requires) {
        const target = path.resolve(path.dirname(item.abs), r.replace(/\\/g, '/'));
        if (!/\.(js|cjs|mjs)$/.test(target)) continue;
        if (DEPRECATED.test(path.basename(target))) { excluded.push({ file: target, event: 'require', reason: '废弃副本被 require（会被周检判红的那种写法）' }); continue; }
        if (seen.has(target)) continue;
        queue.push({ abs: target, origin: 'required-by:' + path.basename(item.abs), d: item.d + 1 });
      }
    }
  }
  const rows = [...seen.values()].filter((r) => r.origin && r.bucket !== undefined);
  // 口径对照：`grep -rl <pattern> ~/.qoder/scripts/*.js` 会把废弃副本也算成「现役机制」；这里独立数出来，
  // 让「排除」这个动作本身可核验（交付判据第 1 条要的「被排除的废弃副本数」）。
  let naiveDeprecated = 0; const naiveFiles = [];
  try {
    for (const f of fs.readdirSync(path.join(root, 'scripts'))) {
      if (!DEPRECATED.test(f) || !/\.(js|cjs|mjs|sh|ps1)$/i.test(f)) continue;
      let s = ''; try { s = fs.readFileSync(path.join(root, 'scripts', f), 'utf8'); } catch (e) { continue; }
      if (new RegExp(pattern.source, pattern.flags).test(s)) { naiveDeprecated++; if (naiveFiles.length < 12) naiveFiles.push(f); }
    }
  } catch (e) {}
  const tally = {
    wiredCount: new Set(wired.scripts.map((w) => path.resolve(w.script))).size, scanned: rows.length,
    counting: 0, state: 0, mention: 0, none: 0, missing: 0,
    keywordHits: 0, keywordHitsWired: 0, keywordHitsRequired: 0,
    disciplineMechanisms: 0, excludedDeprecated: excluded.length, naiveDeprecated, naiveFiles,
  };
  for (const r of rows) {
    if (r.bucket === 'missing') tally.missing++;
    else if (r.bucket === 'counting') tally.counting++;
    else if (r.bucket === 'state') tally.state++;
    else if (r.bucket === 'mention') tally.mention++;
    else tally.none++;
    if (r.hits > 0) { tally.keywordHits++; if (String(r.origin).startsWith('wired:')) tally.keywordHitsWired++; else tally.keywordHitsRequired++; }
    if (r.disciplineHits > 0 && (r.bucket === 'counting' || r.bucket === 'state')) tally.disciplineMechanisms++;
  }
  return { root, settingsFile, error: wired.error || null, rows: rows.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.file.localeCompare(b.file)), excluded, tally };
}

// —— 自检：两个夹具必须落进不同档，同向即判红（工具坏了不许采信它的结论）——
function selftest(pattern, discipline) {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-gap-scan-'));
  const mech = path.join(dir, 'mech-hook.js');
  fs.writeFileSync(mech, [
    "'use strict';",
    'const fs = require("fs");',
    'const threshold = 3;',
    'let failCount = 0;',
    'function bump(s, key) { s.entries[key] = s.entries[key] || { means: {} };',
    '  if (!s.entries[key].means[process.argv[2]]) failCount++;',
    '  if (failCount >= threshold) { console.log(JSON.stringify({ decision: "block" })); }',
    '  fs.writeFileSync(s.path, JSON.stringify(s)); }',
  ].join('\n'));
  const prose = path.join(dir, 'prose-hook.js');
  fs.writeFileSync(prose, [
    "'use strict';",
    '// 同类操作连败三次（＝3 种不同手段，重跑同一手段不计）必须停手上报',
    "const tip = '提示词里写着：连败三次就要停手上报，别再换第 4 种手段';",
    'function build() { return tip; }',
    'module.exports = { build };',
  ].join('\n'));
  const stateOnly = path.join(dir, 'state-hook.js');
  fs.writeFileSync(stateOnly, [
    "'use strict';",
    'const fs = require("fs");',
    '// 只做台账，不做拦截：谁触发了「连败三次」提醒都记一行',
    'function log(row) { fs.appendFileSync(process.env.HOME + "/.qoder/tmp/x/decisions.log", row + "\\n"); }',
    'module.exports = { log };',
  ].join('\n'));
  const m = classify(mech, pattern, discipline);
  const p = classify(prose, pattern, discipline);
  const s = classify(stateOnly, pattern, discipline);
  // 夹具D：薄入口（自己没逻辑，只 require 委托 core）。require 路径是字符串字面量，
  // 曾经被我拿「剥掉字符串」的文本去提取 ⇒ 永远提不到、把委托 core 整个漏扫（假结论「没有机制」）。
  const entry = path.join(dir, 'entry-hook.js');
  fs.writeFileSync(entry, [
    "'use strict';",
    "const core = require('./mech-core.js');",
    'process.exit(core.preCheck(JSON.parse(require("fs").readFileSync(0, "utf8"))) ? 0 : 0);',
  ].join('\n'));
  const e = classify(entry, pattern, discipline);
  // 夹具E：正则字面量里带撇号（`/user'?/`）+ 后面才是真计数器。撇号若被当字符串起点，
  // 会把 threshold 整段吞掉 ⇒ 机制被判成「仅文本提及」，缺口结论直接反方向。
  const reApos = path.join(dir, 'regex-apos-hook.js');
  fs.writeFileSync(reApos, [
    "'use strict';",
    "const WHO = /user'?[a-z]+/;",
    'const threshold = 3;',
    'let failCount = 0;',
    "if (++failCount >= threshold) { console.log('block'); }",
    'void WHO;',
  ].join('\n'));
  const ra = classify(reApos, pattern, discipline);
  const results = [
    { label: '夹具A 含阈值比较的代码 → 必须判 counting（不得判仅文本）', ok: m.bucket === 'counting', got: m.bucket },
    { label: '夹具B 只在注释/提示词里提及 → 必须判 mention（同向即判红）', ok: p.bucket === 'mention', got: p.bucket },
    { label: '夹具A/B 落入不同档（同向＝工具坏了，结论不许采信）', ok: m.bucket !== p.bucket, got: m.bucket + ' vs ' + p.bucket },
    { label: '夹具C 只落盘不比较 → 判 state', ok: s.bucket === 'state', got: s.bucket },
    { label: '夹具B 必须带「仅注释/提示词」证据标注', ok: p.evidence.some((x) => /仅注释/.test(x)), got: p.evidence.join(',') },
    { label: '夹具D 薄入口必须提到 ./mech-core.js（漏了就会把委托 core 判成「无机制」）', ok: e.requires.includes('./mech-core.js'), got: e.requires.join(',') || '(空)' },
    { label: '夹具E 正则字面量里的撇号不得吞掉后面的计数器（必须判 counting）', ok: ra.bucket === 'counting', got: ra.bucket },
  ];
  // 端到端：造一个临时体检根（settings.json → 薄入口 → 委托 core），缺口判据必须**两个方向都能翻转**。
  // 只测单向的话，「缺口成立」这条结论可能只是 require 没跟上造成的假红（本项目最擅长制造这种假绿/假红）。
  const fh = path.join(dir, 'home');
  fs.mkdirSync(path.join(fh, 'scripts'), { recursive: true });
  const wiredHook = path.join(fh, 'scripts', 'host-guard.js');
  const body = fs.readFileSync(mech, 'utf8');
  fs.writeFileSync(path.join(fh, 'scripts', 'fail-streak-core.js'), body.replace('const threshold = 3;', 'const GUARD = "fail-streak";\nconst threshold = 3;\nvoid GUARD;'));
  fs.writeFileSync(wiredHook, "'use strict';\nrequire('./fail-streak-core.js');\n");
  fs.writeFileSync(path.join(fh, 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node ' + wiredHook.replace(/\\/g, '/') }] }], PostToolUse: [] },
  }, null, 1));
  const withDelegation = collect(fh, pattern, discipline, true, 1);
  fs.writeFileSync(wiredHook, "'use strict';\n// 委托段被摘掉（模拟未接线）\n");
  const withoutDelegation = collect(fh, pattern, discipline, true, 1);
  results.push(
    { label: '端到端 有委托段 → 扫到 core 且缺口判「已有机制」', ok: withDelegation.tally.scanned === 2 && withDelegation.tally.disciplineMechanisms >= 1, got: 'scanned=' + withDelegation.tally.scanned + ' mech=' + withDelegation.tally.disciplineMechanisms },
    { label: '端到端 摘掉委托段 → 缺口判「成立」（证明上面那条不是恒真）', ok: withoutDelegation.tally.disciplineMechanisms === 0, got: 'scanned=' + withoutDelegation.tally.scanned + ' mech=' + withoutDelegation.tally.disciplineMechanisms },
  );
  let bad = 0;
  for (const r of results) { console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.label + ' :: got=' + r.got); if (!r.ok) bad++; }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad === 0 ? '\n自检全绿：分档判据可用' : `\nRED: ${bad} 项自检未过 —— 本工具的结论不许采信`);
  return bad === 0 ? 0 : 1;
}

function toRegex(src, fallback) {
  if (!src) return fallback;
  try { return new RegExp(src, fallback.flags); } catch (e) { console.error('bad pattern: ' + src + ' (' + e.message + ')'); process.exit(2); }
}

const BUCKET_CN = { counting: '有计数逻辑', state: '有状态写', mention: '仅文本提及', none: '未命中', missing: '文件不存在' };

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 26).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
  const pattern = toRegex(a.pattern, DEFAULT_PATTERN);
  const discipline = toRegex(a.discipline, DEFAULT_DISCIPLINE);
  if (a.selftest) return selftest(pattern, discipline);

  const roots = [];
  if (a.home) roots.push(path.resolve(a.home));
  else {
    roots.push(path.join(home(), '.qoder'));
    const cn = path.join(home(), '.qoder-cn');
    if (fs.existsSync(path.join(cn, 'settings.json'))) roots.push(cn);
  }
  const reports = roots.map((r) => collect(r, pattern, discipline, a.follow, a.depth));

  if (a.json) { console.log(JSON.stringify({ pattern: pattern.source, discipline: discipline.source, reports }, null, 1)); }
  else {
    for (const rep of reports) {
      console.log('=== 体检根 ' + rep.root + (rep.error ? ' :: ' + rep.error : '') + ' ===');
      console.log('settings.json 直接引用 ' + rep.tally.wiredCount + ' 个脚本，扫描 ' + rep.tally.scanned + ' 个（含顺 ' + (a.follow ? a.depth : 0) + ' 层局部 require），排除废弃副本 ' + rep.tally.excludedDeprecated + ' 处');
      for (const r of rep.rows) {
        if (r.bucket === 'none') continue;
        console.log('  [' + BUCKET_CN[r.bucket] + '] ' + path.basename(r.file) + '  ← ' + r.origin + (r.evidence.length ? '  · ' + r.evidence.join(' · ') : ''));
      }
      for (const e of rep.excluded) console.log('  [已排除] ' + e.file + ' (' + e.reason + ')');
      const gap = rep.tally.disciplineMechanisms === 0;
      console.log('  小结：关键词命中 ' + rep.tally.keywordHits + ' 个文件；其中 有计数 ' + rep.tally.counting + ' / 有状态写 ' + rep.tally.state + ' / 仅文本 ' + rep.tally.mention + ' / 未命中 ' + (rep.tally.none + rep.tally.missing));
      console.log('  口径对照：裸 grep scripts/ 会多算 ' + rep.tally.naiveDeprecated + ' 个废弃副本' + (rep.tally.naiveFiles.length ? '（' + rep.tally.naiveFiles.join(', ') + (rep.tally.naiveDeprecated > rep.tally.naiveFiles.length ? ' …' : '') + '）' : '') + '；已接线 ' + rep.tally.wiredCount + ' 个里关键词命中 ' + rep.tally.keywordHitsWired + ' 个，另 ' + rep.tally.keywordHitsRequired + ' 个来自被 require 的 core');
      console.log('  缺口判定：目标纪律 /' + discipline.source + '/ 的机制级命中 ' + rep.tally.disciplineMechanisms + ' 个 ⇒ ' + (gap ? '缺口成立（提示词有、代码没有，可机制化）' : '已有机制，别做第二份（转去修接线或补测试）'));
    }
  }
  const anyGap = reports.some((r) => r.tally.disciplineMechanisms === 0);
  if (a.requireMechanism && anyGap) return 1;
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { classify, stripComments, collect, wiredScripts, DEPRECATED };
