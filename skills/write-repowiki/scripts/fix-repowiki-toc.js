#!/usr/bin/env node
// fix-repowiki-toc：按 github-slugger 规则核对并（可选）修复 repowiki 的锚点。
//
// 用法:
//   node fix-repowiki-toc.js <repo 路径>            # 只报，不改
//   node fix-repowiki-toc.js <repo 路径> --apply    # 落盘（改前备份为 <文件>.bak-<时间戳>）
// 退出码: 0 无需修 / 1 有可修或待人工的 / 2 用法或前置错误
//
// 只处理"指向某个 md 页面里某个标题"的锚点：
//   `](#某个标题)`                 页内锚点
//   `](file://path/x.md#标题)`      仓根相对 + 锚点
//   `](x.md#标题)` / `](../x.md#标题)`  相对 + 锚点
// `#L1-L20` 这类行号锚点不属于标题，跳过（那是代码引用，由 validate-repowiki.js 管）。
'use strict';
const fs = require('fs');
const path = require('path');

// github-slugger 的有效行为（本机用到的子集）：小写 → 去掉标点/符号 → 空格转 -
// 中文按 \p{L} 保留；重复标题追加 -1 / -2
//
// 注意**不能把连续空白折叠成一个连字符**：`Monaco + ECharts` 官方给的是
// `monaco--echarts`（两个空格各转一个 `-`，中间的 `+` 被删掉），折叠会得到一个 `-`。
// 这条是拿官方库对 6314 个真实标题逐条比对后修出来的（原先 32 处不一致，全是这个形状）。
// 导出它是为了让"与官方库逐条比对"这件事可以重跑，而不是靠我口述结论。
function slugify(title) {
  let s = String(title).trim().toLowerCase();
  s = s.replace(/[^\p{L}\p{N}\s_-]/gu, '');   // 去标点与符号，保留字母/数字/空白/下划线/连字符
  s = s.replace(/\s/g, '-');
  return s;
}
module.exports = { slugify };

function run() {
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const repoArg = argv.find((a) => !a.startsWith('--'));
if (!repoArg) {
  console.error('用法: node fix-repowiki-toc.js <repo 路径> [--apply]');
  process.exit(2);
}
const REPO = path.resolve(repoArg);
const WIKI = path.join(REPO, '.qoder', 'repowiki');
if (!fs.existsSync(WIKI)) { console.error(`没有 wiki: ${WIKI}`); process.exit(2); }

const rel = (p) => path.relative(REPO, p).replace(/\\/g, '/');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(p, out); }
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function headings(text) {
  const seen = new Map();
  const slugs = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (!m) continue;
    let s = slugify(m[1]);
    if (seen.has(s)) { const n = seen.get(s) + 1; seen.set(s, n); s = `${s}-${n}`; }
    else seen.set(s, 0);
    slugs.add(s);
  }
  return slugs;
}

const pages = walk(WIKI);
const cache = new Map();
const slugsOf = (f) => {
  if (!cache.has(f)) cache.set(f, headings(fs.readFileSync(f, 'utf8')));
  return cache.get(f);
};

// 归一化到"只留字母数字"，用于找近似标题（大小写 / 空格 / 连字符差异）
const norm = (s) => String(s).replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

const fixable = [];   // {file, raw, target, from, to}
const manual = [];    // {file, raw, frag, targetRel}

for (const f of pages) {
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const raw = m[1];
    const hashAt = raw.indexOf('#');
    if (hashAt < 0) continue;
    const frag = decodeURIComponent(raw.slice(hashAt + 1));
    if (!frag) continue;
    // 行号锚点不归这里管——**按前缀判，不按完整形状判**：库里存在 `#L31-L...` 这种
    // 写残的（76 处 / 3 个文件），用完整正则判断会让它们掉进"待人工的标题锚点"里，
    // 报出一个不存在的类别。残缺行号由 validate-repowiki.js 报。
    if (/^L\d/i.test(frag)) continue;

    const targetRaw = raw.slice(0, hashAt);
    let targetFile = f;
    if (targetRaw) {
      let t = targetRaw;
      let fromRepoRoot = false;
      if (t.startsWith('file://')) { t = t.slice('file://'.length); fromRepoRoot = true; }
      if (/^https?:/i.test(t)) continue;
      // 解析规则必须与 validate-repowiki.js 逐字一致：`file://x` 与 `/x` 都是**仓根相对**，
      // 只有普通相对链接才按当前文件所在目录解析。两处口径漂移 = 一个说红一个说绿。
      targetFile = (fromRepoRoot || t.startsWith('/'))
        ? path.join(REPO, t.replace(/^\//, ''))
        : path.resolve(path.dirname(f), t);
      if (!fs.existsSync(targetFile)) continue;           // 文件不存在是 validate 的事
    }
    const slugs = slugsOf(targetFile);
    if (slugs.has(frag)) continue;
    // 近似匹配：唯一命中才自动修
    const want = norm(frag);
    const hits = [...slugs].filter((s) => norm(s) === want);
    if (hits.length === 1) {
      fixable.push({ file: f, raw, to: (targetRaw ? targetRaw : '') + '#' + hits[0] });
    } else {
      manual.push({ file: f, raw, frag, targetRel: targetFile === f ? '(本页)' : rel(targetFile) });
    }
  }
}

console.log(`锚点核对：${rel(WIKI)} · 页面 ${pages.length} 个`);
if (manual.length) {
  console.log(`待人工判断 ${manual.length} 处（找不到唯一近似标题）：`);
  for (const x of manual.slice(0, 10)) console.log(`  ? ${rel(x.file)} -> #${x.frag}（目标 ${x.targetRel}）`);
  if (manual.length > 10) console.log(`  …另有 ${manual.length - 10} 处`);
}
if (fixable.length === 0) {
  console.log(manual.length ? `结果：${manual.length} 处需人工，0 处可自动修` : '结果：锚点全部可达（0 处）');
  process.exit(manual.length ? 1 : 0);
}

console.log(`可自动修 ${fixable.length} 处（大小写 / 空格 / 连字符差异）：`);
for (const x of fixable.slice(0, 10)) console.log(`  ~ ${rel(x.file)}: ${x.raw} -> ${x.to}`);
if (fixable.length > 10) console.log(`  …另有 ${fixable.length - 10} 处`);

if (!APPLY) {
  console.log('（未加 --apply，未改动任何文件）');
  process.exit(1);
}

const byFile = new Map();
for (const x of fixable) {
  if (!byFile.has(x.file)) byFile.set(x.file, []);
  byFile.get(x.file).push(x);
}
const st = stamp();
let written = 0;
for (const [file, items] of byFile) {
  const orig = fs.readFileSync(file, 'utf8');
  let next = orig;
  for (const x of items) {
    // 只替换完整的链接目标，避免误伤正文里同名的普通文本
    next = next.split(`](${x.raw})`).join(`](${x.to})`);
  }
  if (next === orig) continue;
  fs.copyFileSync(file, `${file}.bak-${st}`);
  fs.writeFileSync(file, next);
  written++;
}
console.log(`已修 ${fixable.length} 处，涉及 ${written} 个文件；备份后缀 .bak-${st}`);
process.exit(manual.length ? 1 : 0);
}

if (require.main === module) run();
