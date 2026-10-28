// hook 崩溃可见化（保持 fail-open 语义不变）：
// hook 脚本抛错时仍然放行（exit 0），但把崩溃写进 hooks-crash.log，交给周检报出来。
// 用法：在 hook 脚本顶部 `require('./hook-crash-guard.js').install('<hook 名>')`
'use strict';
const fs = require('fs');
const path = require('path');

// 日志路径默认落在脚本自己旁边；可用 HOOK_CRASH_LOG 覆盖 —— 沙箱自测必须能指到沙箱内，
// 否则"真实机器上崩过一次"会把沙箱的"零告警"断言全染红（2026-09-23 实测踩到）。
const LOG = process.env.HOOK_CRASH_LOG || path.join(__dirname, 'hooks-crash.log');

function install(name) {
  const write = (kind, err) => {
    try {
      const line = JSON.stringify({
        t: new Date().toISOString(),
        hook: name,
        kind,
        msg: String((err && err.stack) || err || 'unknown').replace(/\s+/g, ' ').slice(0, 600),
      });
      fs.appendFileSync(LOG, line + '\n');
    } catch {}
  };
  process.on('uncaughtException', (e) => { write('uncaughtException', e); process.exit(0); });
  process.on('unhandledRejection', (e) => { write('unhandledRejection', e); process.exit(0); });
  // EPIPE 不是脚本的错：宿主会提前关掉 stdout 管道（实测 2026-09-23 UserPromptSubmit 写提醒时发生）。
  // 不挂这个监听，写失败会以 uncaughtException 的形式冒出来，被记成一次"脚本崩溃"——
  // 但真正的事实是"提醒没送到"，两类噪声混在一张表里，真崩溃就被淹没了。
  // 挂上之后：写不出去就安静退 0（fail-open 语义不变），且**不写崩溃日志**。
  process.stdout.on('error', () => { process.exit(0); });
}

// 读崩溃日志（周检用）：返回 {count, last, samples}
function readCrashes(sinceMs = 7 * 24 * 3600 * 1000) {
  if (!fs.existsSync(LOG)) return { count: 0, last: null, samples: [] };
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  const since = Date.now() - sinceMs;
  const recent = [];
  for (const l of lines) {
    try { const o = JSON.parse(l); if (new Date(o.t).getTime() >= since) recent.push(o); } catch {}
  }
  return { count: recent.length, last: recent.length ? recent[recent.length - 1].t : null, samples: recent.slice(-3).map((o) => `${o.hook}/${o.kind}: ${o.msg.slice(0, 90)}`) };
}

module.exports = { install, readCrashes, LOG };
