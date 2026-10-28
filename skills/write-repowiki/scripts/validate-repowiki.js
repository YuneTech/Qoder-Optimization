#!/usr/bin/env node
// validate-repowiki：按 Qoder 标准校验 .qoder/repowiki/。
//
// 用法: node validate-repowiki.js <repo 路径>
// 退出码: 0 通过 / 1 有问题 / 2 用法或前置错误
//
// 查七项（都是能失败的确定性检查，不做语义判断）：
//   ① wiki_plan.yaml 存在且四个顶层键齐（version / scope / repowiki / knowledgecard）
//   ② 四层结构在（knowledge/zh、zh/content）
//   ③ 代码围栏闭合（``` 成对）
//   ④ 内链可达（本仓相对链接指向的文件存在）
//   ⑤ <cite> 引用的 `path#Lx-Ly`：文件存在、行号不越界、起止不倒置
//   ⑥ 疑似明文凭据（password= / token= / 私钥头）
//   ⑦ plan↔磁盘一致：有 documents 白名单则查"列出的页都在、且不超上限"；没有则查"内容页都被某个索引页提到过"
'use strict';
const fs = require('fs');
const path = require('path');

const USAGE = '用法: node validate-repowiki.js <repo 路径>';
const repoArg = process.argv[2];
if (!repoArg) { console.error(USAGE); process.exit(2); }
const REPO = path.resolve(repoArg);
if (!fs.existsSync(REPO)) { console.error(`仓库路径不存在: ${REPO}`); process.exit(2); }

const WIKI = path.join(REPO, '.qoder', 'repowiki');
if (!fs.existsSync(WIKI)) { console.error(`没有 wiki（未初始化？）: ${WIKI}`); process.exit(2); }

// problems 是对象：m = 给人看的整句，g = 归组键（成因所在的路径/目标）。
// 把 g 与 m 分开存，是为了让"同一模块下 200 条同类问题"能折叠成一行。
const problems = [];
const notes = [];
const rel = (p) => path.relative(REPO, p).replace(/\\/g, '/');
const P = (m, g) => problems.push({ m, g: g || '' });

function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(p, out); }
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// ① wiki_plan.yaml
const PLAN = path.join(WIKI, 'wiki_plan.yaml');
let planText = '';
if (!fs.existsSync(PLAN)) P('缺 wiki_plan.yaml', 'wiki_plan.yaml');
else {
  planText = fs.readFileSync(PLAN, 'utf8');
  // 只要求这三个。**不要要求 `scope`**：官方技能 qoder-context-knowledge-plan 明写
  // "scope.include/exclude 未实现，解析后告警并忽略，别写这个块"——早前把 scope 列进必填，
  // 等于逼用户加一个不起作用、还带告警的键。
  for (const k of ['version', 'repowiki', 'knowledgecard']) {
    if (!new RegExp(`^${k}:`, 'm').test(planText)) P(`wiki_plan.yaml 缺顶层键: ${k}`, 'wiki_plan.yaml');
  }
  if (/^\s*scope:/m.test(planText)) {
    notes.push('wiki_plan.yaml 里有 `scope:` 块——当前版本不解析它（解析后告警并忽略），官方建议不写');
  }
  // YAML 两个真实的坑：缩进用 tab（YAML 不允许）、双引号标量里嵌 ASCII 引号（解析直接崩）
  planText.split('\n').forEach((line, i) => {
    if (/^\t/.test(line)) P(`wiki_plan.yaml 第 ${i + 1} 行用 tab 缩进（YAML 不允许，必须是空格）`, 'wiki_plan.yaml');
    const m = line.match(/:\s*"([^"]*)"\s*$/);
    if (m && /["']/.test(m[1])) P(`wiki_plan.yaml 第 ${i + 1} 行：双引号标量里还有引号，YAML 解析会失败`, 'wiki_plan.yaml');
  });
}

// ② 四层结构
for (const d of ['knowledge/zh', 'zh/content']) {
  if (!fs.existsSync(path.join(WIKI, d))) P(`缺目录: ${d}`, d);
}

// 逐页扫描
const pages = walk(WIKI);
let fenceBad = 0, linkBad = 0, citeBad = 0, secretBad = 0, citeSoft = 0;
const linkTargets = new Set();   // 被引用过的页（用于⑦）

for (const f of pages) {
  const text = fs.readFileSync(f, 'utf8');
  const r = rel(f);

  // ③ 围栏闭合
  const fences = (text.match(/^```/gm) || []).length;
  if (fences % 2 !== 0) { fenceBad++; P(`围栏未闭合: ${r}（${fences} 个 \`\`\`）`, r); }

  // ④ 内链：标准格式是 `](file://<仓内相对路径>)`（实测 Chat2DB 的 wiki 全用它），
  // 也兼容普通相对链接与根相对链接。跳过 http(s)。
  // 注意：`#Lx-Ly` 片段必须**在拆分前**留下来——早先把片段交给正则的可选组吃掉，
  // 结果 m[1] 里没有片段 ⇒ 行号检查永不执行（负对照"#L1-L99"竟然判绿，已修）。
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    let raw = m[1].trim();
    const hashAt = raw.indexOf('#');
    let frag = '';
    if (hashAt >= 0) { frag = raw.slice(hashAt); raw = raw.slice(0, hashAt); }
    if (/^https?:/i.test(raw)) continue;
    if (!raw) continue;                                  // 纯页内锚点，不是文件
    let t = raw;
    let fromRepoRoot = false;
    if (t.startsWith('file://')) { t = t.slice('file://'.length); fromRepoRoot = true; }
    if (!t) continue;
    // `file://xxx` 与 `/xxx` 都是**仓根相对**；只有普通相对链接才按当前文件所在目录解析。
    const abs = (fromRepoRoot || t.startsWith('/'))
      ? path.join(REPO, t.replace(/^\//, ''))
      : path.resolve(path.dirname(f), decodeURIComponent(t));
    if (!fs.existsSync(abs)) { linkBad++; P(`内链指向不存在的文件: ${r} -> ${m[1]}`, t); continue; }
    linkTargets.add(rel(abs));

    // ⑤ 同一链接若带 #Lx-Ly，顺带验行号（标准把代码引用写成 file://...#L1-L36）
    const lr = frag.match(/^#L(\d+)(?:-L?(\d+))?$/);
    if (lr) {
      let lines = 0;
      try { lines = fs.readFileSync(abs, 'utf8').split('\n').length; } catch (e) { continue; }
      const lo = Number(lr[1]), hi = lr[2] ? Number(lr[2]) : lo;
      if (hi < lo) { citeBad++; P(`行号倒置: ${r} -> ${t}#L${lo}-L${hi}`, t); }
      else if (hi > lines) {
        // `#L1-Ln` 是"整文件"写法（本仓 wiki 里约一半锚点如此）。文件在 wiki 写完后变短，
        // 这种锚点仍能打开文件、只是行号封顶——报成问题会一次刷出 172 条噪声，
        // 噪声多就会被忽略。降级为计数说明；真正会失真的"具体切片"（lo>1）照报。
        if (lo === 1) citeSoft++;
        else { citeBad++; P(`行号越界: ${r} -> ${t}#L${lo}-L${hi}（该文件 ${lines} 行）`, t); }
      }
    } else if (/^#L\d/i.test(frag)) {
      // 写法残缺的行号锚点（实测有 `#L31-L...` 这种，末尾是省略号）——它们既不是合法
      // 行号也不是标题，两边的检查都漏掉就等于没人管。归到"引用"类里报出来。
      citeBad++;
      P(`行号锚点写法残缺: ${r} -> ${t}#${frag}`, t);
    }
  }

  // ⑤ <cite> 的 path#Lx-Ly
  for (const m of text.matchAll(/`([^`\s#]+)#L(\d+)(?:-L?(\d+))?`/g)) {
    const [, p, a, b] = m;
    const abs = path.join(REPO, p);
    if (!fs.existsSync(abs)) { citeBad++; P(`引用文件不存在: ${r} -> ${p}`, p); continue; }
    let lines = 0;
    try { lines = fs.readFileSync(abs, 'utf8').split('\n').length; } catch (e) { continue; }
    const lo = Number(a), hi = b ? Number(b) : lo;
    if (hi < lo) { citeBad++; P(`行号倒置: ${r} -> ${p}#L${lo}-L${hi}`, p); }
    else if (hi > lines) {
      if (lo === 1) citeSoft++;
      else { citeBad++; P(`行号越界: ${r} -> ${p}#L${hi}（该文件仅 ${lines} 行）`, p); }
    }
  }

  // ⑥ 疑似明文凭据
  for (const m of text.matchAll(/(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["'`]?([A-Za-z0-9_\-]{8,})/gi)) {
    const v = m[2];
    if (/^(x+|xxx+|none|changeme|your|example|placeholder|<)/i.test(v)) continue;
    secretBad++; P(`疑似明文凭据: ${r}（${m[1]}=…，值已隐去）`, r);
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) { secretBad++; P(`含私钥: ${r}`, r); }
}

// ⑦ plan ↔ 磁盘一致
const docsMatch = planText.match(/^\s*documents:\s*$/m);
if (docsMatch) {
  const listed = [...planText.matchAll(/^\s*-\s*["']?([\w./-]+\.md)["']?/gm)].map((m) => m[1]);
  const LIMIT = 50;
  if (listed.length > LIMIT) P(`documents 白名单 ${listed.length} 页，超上限 ${LIMIT}（超出会被静默截断）`, 'wiki_plan.yaml');
  for (const l of listed) {
    const abs = path.join(WIKI, l);
    if (!fs.existsSync(abs)) P(`白名单列了但磁盘上没有: ${l}`, l);
  }
  notes.push(`白名单模式：documents 列了 ${listed.length} 页`);
} else {
  // 无白名单模式：**只报计数，不判"未被互链"**——标准里页面之间并不要求互相链接
  // （实测 Chat2DB 的 329 个内容页主要引用**代码文件**，页面间互链不是约定）。
  // 早前这里把"没有互链"当问题报，一次误报 329 条——守卫噪声多就会被忽略。
  const contentPages = pages.map(rel).filter((p) => p.includes('/content/'));
  const indexLike = pages.map(rel).filter((p) => /(index|导航|目录|总览|README)/i.test(p));
  if (contentPages.length === 0) P('无白名单模式：一个内容页都没有（zh/content/ 是空的？）', 'zh/content');
  if (indexLike.length === 0) P('无白名单模式：找不到任何索引/导航类页面（index / 导航 / 目录 / 总览）', 'zh/content');
  notes.push(`无白名单模式：内容页 ${contentPages.length} 个，索引/导航类页面 ${indexLike.length} 个`);
}

// —— 输出（给 AI 读：先结论，再归组，最后样例）——
// 缺失链接常有批量成因（某模块源码搬迁后 wiki 没跟上）。逐条列 500 行是噪声，
// 按归组键的"前两段路径"折叠后，一眼能看出该修哪个模块。
function groupKey(g) {
  const s = String(g || '').replace(/^file:\/\//, '').replace(/\\/g, '/');
  if (!s) return '(其它)';
  const seg = s.split('/').filter(Boolean);
  return seg.length > 2 ? seg.slice(0, 2).join('/') : s;
}

const summary = `repowiki 校验：${rel(WIKI)} · 页面 ${pages.length} 个 · 围栏 ${fenceBad} · 内链 ${linkBad} · 引用 ${citeBad} · 凭据 ${secretBad}`;
if (citeSoft) notes.push(`另有 ${citeSoft} 处整文件锚点（\`#L1-Ln\`）的 n 已超出当前文件行数——锚点仍可打开文件，按约定不计为问题`);
for (const n of notes) console.log('  ' + n);
console.log(summary);
if (problems.length === 0) { console.log('结果：通过（0 个问题）'); process.exit(0); }
console.log(`结果：${problems.length} 个问题`);

const SHOW = 12;
for (const p of problems.slice(0, SHOW)) console.log('  ✗ ' + p.m);
if (problems.length > SHOW) {
  const groups = new Map();
  for (const p of problems) {
    const k = groupKey(p.g);
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  const top = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`  另有 ${problems.length - SHOW} 条未列出；成因归组（前 ${top.length}）：`);
  for (const [k, n] of top) console.log(`    ${String(n).padStart(5)}× ${k}`);
}
process.exit(1);
