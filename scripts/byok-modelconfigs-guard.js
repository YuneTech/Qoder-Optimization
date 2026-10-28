#!/usr/bin/env node
// BYOK 自伤守卫：检测并清除 settings.json 顶层的 modelConfigs.customModels。
//
// 为什么是「清除」而不是「同步」：这段注入表会走 setBYOKCustomModels → addUserModels，
// 把 provider/model 注册成 catalog 的**用户条目**；随后 providers 侧投影同一批键时命中
// userEntries.has(key) 被 reject，而 runtime 对 reject 的处理是 clearCustomProviderProjection()
// —— 一个键冲突就清掉**全部** custom provider，BYOK 从「轻量调用失败」恶化为「完全不可用」
// （日志：Custom provider "…" was ignored: … conflicts with an existing catalog model
//   →  FatalRoutingError: Custom Provider model '…' is not available）。实测于 2026-09-30。
//
// 用法：
//   node byok-modelconfigs-guard.js                 # 检查两侧配置，存在即 exit 1（只读）
//   node byok-modelconfigs-guard.js --file <path>   # 指定 settings.json
//   node byok-modelconfigs-guard.js --apply         # 备份后删除顶层 modelConfigs
//
// 只打印 provider/model 键，绝不打印 apiKey / baseURL 等凭据相关字段。

const fs = require('fs');
const path = require('path');
const os = require('os');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const fi = argv.indexOf('--file');
const ONLY = fi >= 0 ? [path.resolve(argv[fi + 1])] : null;

function candidates() {
  if (ONLY) return ONLY;
  const home = process.env.QODER_GUARD_HOME || process.env.HOME || os.homedir();
  const sides = ['.qoder', '.qoder-cn']
    .map((d) => path.join(home, d, 'settings.json'))
    .filter((p) => fs.existsSync(p));
  const cur = process.env.QODER_CONFIG_DIR;
  if (cur) {
    const p = path.join(cur, 'settings.json');
    if (fs.existsSync(p) && !sides.includes(p)) sides.unshift(p);
  }
  return sides;
}

function listEntries(j) {
  const cm = (j.modelConfigs && j.modelConfigs.customModels) || [];
  return Array.isArray(cm) ? cm : [];
}

let dirty = 0;
const targets = candidates();
if (!targets.length) {
  console.log('[跳过] 没找到 settings.json（QODER_CONFIG_DIR / HOME 都推不出来）');
  process.exit(0);
}

for (const f of targets) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.log(`[红] ${f} 不是合法 JSON：${e.message.slice(0, 60)}`);
    dirty++;
    continue;
  }
  const ents = listEntries(j);
  if (!Object.prototype.hasOwnProperty.call(j, 'modelConfigs')) {
    console.log(`[绿] ${f} 无顶层 modelConfigs`);
    continue;
  }
  const keys = ents.map((m) => `${m.provider || '?'}/${m.model || '?'}`);
  console.log(`[红] ${f} 存在 modelConfigs（customModels ${ents.length} 条）→ 会清掉全部 custom provider`);
  if (keys.length) console.log('      冲突键: ' + keys.join(', '));
  if (!APPLY) { dirty++; continue; }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const bak = `${f}.bak-byok-guard-${stamp}`;
  fs.copyFileSync(f, bak);
  if (!fs.existsSync(bak) || fs.statSync(bak).size !== fs.statSync(f).size) {
    console.log('      [失败] 备份未写入或字节不符，放弃改动');
    dirty++;
    continue;
  }
  delete j.modelConfigs;
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  const gone = !Object.prototype.hasOwnProperty.call(after, 'modelConfigs');
  console.log(`      备份 ${path.basename(bak)} → 删除顶层 modelConfigs：${gone ? '已生效' : '未生效'}`);
  if (gone) console.log('      其他顶层键保留: ' + Object.keys(after).join(', '));
  else dirty++;
}

if (dirty) {
  console.log(APPLY
    ? `\n[需人工处理] ${dirty} 处未清干净。改完必须重启客户端：provider 投影态活在进程里。`
    : `\n[判红] ${dirty} 处带 modelConfigs。清除：node ${path.basename(__filename)} --apply\n        清完必须重启客户端才生效（同进程的新 run 不会重新投影）。`);
  process.exit(1);
}
console.log(APPLY ? '\n[通过] 已清除，记得重启客户端后用新 run 复验冲突=0' : '\n[通过] 两侧配置均无 modelConfigs');
