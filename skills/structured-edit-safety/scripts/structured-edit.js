#!/usr/bin/env node
'use strict';
// 批量同构编辑器（dry-run -> 计数断言 -> apply）。用法见 --help。
const fs = require('fs');
const path = require('path');
const os = require('os');

function parseArgs(argv) {
  const mode = { apply: argv.includes('--apply'), dryRun: argv.includes('--dry-run'), selftest: argv.includes('--selftest'), help: argv.includes('--help') || argv.includes('-h') };
  const rest = argv.filter(a => !a.startsWith('--') && a !== '-h');
  return { mode, target: rest[0] };
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) {
    const j = hay.indexOf(needle, i);
    if (j < 0) break;
    n += 1;
    i = j + needle.length;
  }
  return n;
}

function runEntry(baseDir, entry) {
  const rel = entry.file;
  const abs = path.isAbsolute(rel) ? rel : path.join(baseDir, rel);
  const lines = [];
  if (!fs.existsSync(abs)) {
    return { ok: false, file: rel, fail: `文件不存在: ${abs}`, lines: [`MISS ${rel}`], counts: [] };
  }
  const original = fs.readFileSync(abs, 'utf8');
  const counts = [];
  for (let i = 0; i < entry.edits.length; i++) {
    const e = entry.edits[i];
    const found = countOccurrences(original, e.anchor);
    const expected = e.expectCount;
    const pass = found === expected;
    counts.push({ idx: i + 1, found, expected, pass, anchor: e.anchor });
    lines.push(`${pass ? 'OK  ' : 'FAIL'} ${rel} edit#${i + 1} count=${found} expected=${expected} anchor=${JSON.stringify(e.anchor.length > 60 ? e.anchor.slice(0, 57) + '...' : e.anchor)}`);
  }
  const allPass = counts.every(c => c.pass);
  if (allPass) {
    // 顺序字面量替换
    let body = original;
    for (const e of entry.edits) {
      body = body.split(e.anchor).join(e.replacement);
    }
    // 合法条件：替换后旧锚点发生次数 == 替换自含锚点次数（覆盖追加写法：replacement 包含 anchor）
    const badResidual = [];
    const repeated = [];
    for (let i = 0; i < entry.edits.length; i++) {
      const e = entry.edits[i];
      const after = countOccurrences(body, e.anchor);
      const reps = countOccurrences(e.replacement, e.anchor);
      if (after !== reps) badResidual.push(i + 1);
      if (e.expectCount > 1) repeated.push(i + 1);
    }
    if (badResidual.length) {
      return { ok: false, file: rel, fail: "替换后旧锚点计数异常（应等于 replacement 自含次数；为 0 说明替换未生效）: edit#" + badResidual.join(","), lines, counts };
    }
    if (repeated.length) {
      return { ok: false, file: rel, fail: "锚点重复（expectCount>1）且替换未显式 collapse，请拆成唯一锚点或显式 collapse 后重试: edit#" + repeated.join(","), lines, counts };
    }
    return { ok: true, file: rel, abs, next: body, lines, counts };
  }
  return { ok: false, file: rel, fail: `计数不符，已中止（不写盘）`, lines, counts };
}

function main() {
  const { mode, target } = parseArgs(process.argv.slice(2));
  if (mode.selftest) {
    const os2 = require('os');
    const fsp = require('fs');
    const dir = fsp.mkdtempSync(path.join(os2.tmpdir(), 'ses-selftest-'));
    try {
      const f1 = path.join(dir, 'queue.md');
      const f2 = path.join(dir, 'table.tsv');
      fsp.writeFileSync(f1, '# 队列\n- [ ] A\n- [x] B\n- [ ] C\n', 'utf8');
      fsp.writeFileSync(f2, 'a\t1\nb\t2\n', 'utf8');
      const spec = {
        files: [
          { file: 'queue.md', edits: [
            { anchor: '- [ ] C\n', replacement: '- [x] C\n', expectCount: 1 },
          ]},
          { file: 'table.tsv', edits: [
            { anchor: 'b\t2\n', replacement: 'b\t3\n', expectCount: 1 },
            { anchor: 'a\t1\n', replacement: 'a\t9\n', expectCount: 1 },
          ]},
        ],
      };
      // 判据 1：dry-run 对全部通过、且不落盘
      const specFile = path.join(dir, 'ops.json');
      fsp.writeFileSync(specFile, JSON.stringify(spec), 'utf8');
      const before1 = fsp.readFileSync(f1, 'utf8');
      const r1 = require('child_process').spawnSync(process.execPath, [__filename, '--dry-run', specFile], { encoding: 'utf8' });
      const dryOk = r1.status === 0;
      const unchanged = fsp.readFileSync(f1, 'utf8') === before1;
      // 判据 2：apply 落盘生效
      const r2 = require('child_process').spawnSync(process.execPath, [__filename, '--apply', specFile], { encoding: 'utf8' });
      const applied = r2.status === 0 && fsp.readFileSync(f1, 'utf8').includes('- [x] C') && fsp.readFileSync(f2, 'utf8').includes('b\t3') && fsp.readFileSync(f2, 'utf8').includes('a\t9');
      // 判据 3（负例）：计数不符必须 FAIL 且不写盘
      const bad = { files: [ { file: 'table.tsv', edits: [ { anchor: 'NO-SUCH-ANCHOR', replacement: 'x', expectCount: 2 } ] } ] };
      const badFile = path.join(dir, 'bad.json');
      fsp.writeFileSync(badFile, JSON.stringify(bad), 'utf8');
      const before2 = fsp.readFileSync(f2, 'utf8');
      const r3 = require('child_process').spawnSync(process.execPath, [__filename, '--apply', badFile], { encoding: 'utf8' });
      const badFail = r3.status !== 0 && fsp.readFileSync(f2, 'utf8') === before2;
      const out = [
        `selftest cases: dry-run=${dryOk && unchanged ? 'PASS' : 'FAIL'} apply=${applied ? 'PASS' : 'FAIL'} negative-count=${badFail ? 'PASS' : 'FAIL'}`,
      ];
      const all = dryOk && unchanged && applied && badFail;
      console.log(out.join('\n'));
      console.log(all ? 'SELFTEST OK' : 'SELFTEST FAILED');
      process.exit(all ? 0 : 1);
    } finally {
      fsp.rmSync(dir, { recursive: true, force: true });
    }
  }
  if (mode.help) {
    console.log('用法: node structured-edit.js [--dry-run|--apply] <ops.json>');
    console.log('ops.json: { "baseDir"?: "目录(相对 ops.json)", "files": [{ "file": "相对路径", "edits": [{ "anchor": "原文片段", "replacement": "替换文本", "expectCount": 1 }] }] }');
    console.log('默认（不带 --apply）为 dry-run；计数任一不符即非零退出且不写盘。');
    process.exit(0);
  }
  if (!target) { console.error('缺少 ops.json 参数。--help 看用法。'); process.exit(2); }
  if (!fs.existsSync(target)) { console.error(`ops.json 不存在: ${target}`); process.exit(2); }
  let spec;
  try { spec = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (e) { console.error(`ops.json 解析失败: ${e.message}`); process.exit(2); }
  if (!spec || !Array.isArray(spec.files) || !spec.files.length) { console.error('ops.json 形状错误：需要非空 files 数组'); process.exit(2); }
  for (const f of spec.files) {
    if (!f.file || !Array.isArray(f.edits) || !f.edits.length) { console.error('files[].file / files[].edits 形状错误'); process.exit(2); }
    for (const e of f.edits) {
      if (typeof e.anchor !== 'string' || !e.anchor || typeof e.replacement !== 'string' || !Number.isInteger(e.expectCount)) {
        console.error(`edit 形状错误（需要 anchor/replacement 字符串 + expectCount 整数）: ${f.file}`); process.exit(2);
      }
    }
  }
  const baseDir = spec.baseDir ? path.resolve(path.dirname(path.resolve(target)), spec.baseDir) : path.dirname(path.resolve(target));
  const results = spec.files.map(entry => runEntry(baseDir, entry));
  let allOk = true;
  for (const r of results) {
    console.log(r.lines.join('\n'));
    if (!r.ok) { allOk = false; console.log(`FAILED: ${r.file} -> ${r.fail}`); }
  }
  if (!allOk) {
    console.log(mode.apply ? '== 有计数不符，未写入任何文件 ==' : '== dry-run：有计数不符 ==');
    process.exit(1);
  }
  if (!mode.apply) {
    console.log('== dry-run 全部通过；加 --apply 落盘 ==');
    process.exit(0);
  }
  for (const r of results) {
    const before = fs.readFileSync(r.abs);
    fs.writeFileSync(r.abs, r.next, 'utf8');
    const after = fs.statSync(r.abs).size;
    console.log(`WROTE ${r.file} bytes ${before.length} -> ${after}`);
  }
  console.log('== apply 完成，请复扫 ==');
  process.exit(0);
}
main();
