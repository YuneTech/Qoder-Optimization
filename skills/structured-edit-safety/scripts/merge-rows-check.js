#!/usr/bin/env node
'use strict';
// 追加/批量改造后的收口检查：锚点成活、行数增量、结构抽样。用法见 --help。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

function occ(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) { const j = hay.indexOf(needle, i); if (j < 0) break; n++; i = j + needle.length; }
  return n;
}

function checkFile(target, spec) {
  const results = [];
  if (!fs.existsSync(target)) return { ok: false, lines: [`FAIL 文件不存在: ${target}`] };
  const raw = fs.readFileSync(target);
  const text = raw.toString('utf8');
  const linesArr = text.split('\n');
  const lineCount = linesArr[linesArr.length - 1] === '' ? linesArr.length - 1 : linesArr.length;
  let ok = true;
  const add = (pass, msg) => { results.push(`${pass ? 'OK  ' : 'FAIL'} ${msg}`); if (!pass) ok = false; };

  if (typeof spec.expectLineCount === 'number') {
    add(lineCount === spec.expectLineCount, `行数 ${lineCount} == ${spec.expectLineCount}`);
  } else if (typeof spec.expectLineDelta === 'number' && typeof spec.beforeLineCount === 'number') {
    const target = spec.beforeLineCount + spec.expectLineDelta;
    add(lineCount === target, `行数 ${lineCount} == 前 ${spec.beforeLineCount} + 增量 ${spec.expectLineDelta} = ${target}`);
  }

  if (Array.isArray(spec.containsLines)) {
    for (const cl of spec.containsLines) {
      const found = linesArr.some(l => l === cl.text && occ(l, cl.text) >= cl.min);
      add(found, `含行(${cl.min}+) ${JSON.stringify(cl.text.slice(0, 60))}`);
    }
  }
  if (Array.isArray(spec.occurrences)) {
    for (const o of spec.occurrences) {
      const c = occ(text, o.text);
      add(c === o.count, `出现 ${c} 次 == ${o.count} 次 ${JSON.stringify(o.text.slice(0, 60))}`);
    }
  }
  if (Array.isArray(spec.notContains)) {
    for (const t of spec.notContains) {
      add(occ(text, t) === 0, `不含 ${JSON.stringify(t.slice(0, 60))}`);
    }
  }
  if (Array.isArray(spec.tableColumns)) {
    for (const t of spec.tableColumns) {
      const rows = linesArr.filter(l => l.startsWith(t.prefix)).map(l => l.split(t.separator || '|').length);
      const unique = [...new Set(rows)];
      add(rows.length > 0 && unique.length === 1 && unique[0] === t.columns,
        `表格列数：${JSON.stringify(t.prefix)} 行 ${rows.length} 条、列数 ${unique.join('/')} == ${t.columns}`);
    }
  }
  return { ok, lines: results };
}

function runSelftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrc-selftest-'));
  try {
    const f = path.join(dir, 'ledger.md');
    // 场景：追加两行，锚点存活、行数 +2、表格列数一致、无残留
    fs.writeFileSync(f, '# 台账\n| B01 | ok |\n| B02 | ok |\n', 'utf8');
    const beforeLineCount = fs.readFileSync(f, 'utf8').split('\n').length - 1;
    fs.appendFileSync(f, '| B03 | ok |\n| B04 | ok |\n');
    const spec = {
      beforeLineCount,
      expectLineDelta: 2,
      containsLines: [{ text: '| B02 | ok |', min: 1 }],
      occurrences: [{ text: '| B0', count: 4 }],
      notContains: ['B99'],
      tableColumns: [{ prefix: '| B', separator: '|', columns: 4 }],
    };
    const specFile = path.join(dir, 'check.json');
    fs.writeFileSync(specFile, JSON.stringify(spec), 'utf8');
    // 判据1：正常场景 PASS
    const r1 = spawnSync(process.execPath, [__filename, '--spec', specFile, f], { encoding: 'utf8' });
    const pass1 = r1.status === 0;
    // 判据2（负例）：行数增量错 → 必须 FAIL
    const badSpec = { beforeLineCount, expectLineDelta: 5 };
    const badFile = path.join(dir, 'bad.json');
    fs.writeFileSync(badFile, JSON.stringify(badSpec), 'utf8');
    const r2 = spawnSync(process.execPath, [__filename, '--spec', badFile, f], { encoding: 'utf8' });
    const pass2 = r2.status !== 0;
    // 判据3（负例）：锚点不存在 → 必须 FAIL
    const badSpec2 = { containsLines: [{ text: '| B99 | ok |', min: 1 }] };
    const badFile2 = path.join(dir, 'bad2.json');
    fs.writeFileSync(badFile2, JSON.stringify(badSpec2), 'utf8');
    const r3 = spawnSync(process.execPath, [__filename, '--spec', badFile2, f], { encoding: 'utf8' });
    const pass3 = r3.status !== 0;
    const all = pass1 && pass2 && pass3;
    console.log(`selftest: positive=${pass1 ? 'PASS' : 'FAIL'} negative-linecount=${pass2 ? 'PASS' : 'FAIL'} negative-anchor=${pass3 ? 'PASS' : 'FAIL'}`);
    console.log(all ? 'SELFTEST OK' : 'SELFTEST FAILED');
    process.exit(all ? 0 : 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return runSelftest();
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node merge-rows-check.js --spec <check.json> <目标文件>');
    console.log('check.json: { beforeLineCount?, expectLineDelta?, expectLineCount?, containsLines:[{text,min}], occurrences:[{text,count}], notContains:[字符串], tableColumns:[{prefix,separator,columns}] }');
    process.exit(0);
  }
  const si = argv.indexOf('--spec');
  const specPath = si >= 0 ? argv[si + 1] : null;
  const target = argv.filter((a, i) => a !== '--spec' && i !== si + 1)[0];
  if (!specPath || !target) { console.error('缺参数。--help 看用法。'); process.exit(2); }
  if (!fs.existsSync(specPath)) { console.error(`spec 不存在: ${specPath}`); process.exit(2); }
  let spec;
  try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); } catch (e) { console.error(`spec 解析失败: ${e.message}`); process.exit(2); }
  const { ok, lines } = checkFile(target, spec);
  console.log(lines.join('\n'));
  console.log(ok ? '== 检查通过 ==' : '== 检查未通过 ==');
  process.exit(ok ? 0 : 1);
}
main();
