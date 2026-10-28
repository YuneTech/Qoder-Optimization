#!/usr/bin/env node
// auth-lock-core.js —— **认证失败计数与锁库拦截的判据真源**（唯一一份，两个入口共用）
//
// 为什么要有这个文件：门禁需要挂在两个不同的事件面上——
//   · PreToolUse：调用发出**之前**查状态并拦（入口 = `risky-match-guard.js`，2026-10-21 按用户要求并入，
//     不再为"失败计数"单独挂第 7 个 hook）；
//   · PostToolUse：只看**工具返回**给次数记账（入口 = `auth-lock-guard.js`，失败签名只出现在返回里）。
// 判据若抄两遍必然分叉，所以两个入口都只做"读 stdin → 调本模块 → 打印/退出"。
//
// 事故背景与判据说明见 auth-lock-guard.js 头注释与 README-rule-enforcement.md 的 auth-lock 一节。
// 关闭：~/.qoder/auth-lock-guard.json 写 {"disabled":true}；threshold/dims/ttlHours/blockTtlHours 同文件可配
// 状态与台账：~/.qoder/tmp/auth-lock-guard/{state.json,decisions.log}
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const CONFIG = process.env.AUTH_LOCK_CONFIG || path.join(CLIENT_ROOT, 'auth-lock-guard.json');
const STATE_DIR = process.env.AUTH_LOCK_STATE_DIR || path.join(CLIENT_ROOT, 'tmp', 'auth-lock-guard');
const STATE = path.join(STATE_DIR, 'state.json');
const LEDGER = path.join(STATE_DIR, 'decisions.log');

function cfg() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { return {}; } }
function ledger(f) {
  // 容错：调用点历史上既传数组也传字符串，传错时**不能静默丢台账**（台账是"守卫到底跑没跑"的唯一证据；
  // 真机第一版就因为 `f.join` 抛错被 catch 吞掉，台账整段为空＝假绿）
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(LEDGER, new Date().toISOString() + '|' + (Array.isArray(f) ? f.join('|') : String(f)) + '\n'); } catch (e) {}
}

const AUTH_FAIL = [
  /password authentication failed/i, /authentication failed/i, /\baccess denied for user\b/i,
  /login failed for user/i, /invalid username\/password/i, /ORA-01017/i,
  /\b(?:error[- ]?)?1045\b/i, /WRONGPASS|ERR invalid password|NOAUTH\b/i,
  /认证失败|身份验证失败|密码错误|登录失败/i,
];
const LOCKED = [
  /too many invalid attempts/i, /ORA-28000/i, /account is (?:locked|expired)/i,
  /user\b[\s\S]{0,40}\bwas\b[\s\S]{0,20}\block/i, /账号[\s\S]{0,6}锁/i, /被锁(?:定|死)/i,
  /contact the syssso/i, /max_connection_errors/i,
];
// 中性：拿不到凭据对错的证据，不清零也不计数
const NEUTRAL = /ECONNREFUSED|connection refused|ETIMEDOUT|timed out|could not connect|no route to host|connection reset|ENOTFOUND|网络|unreachable/i;

// 从一个文本块里抽目标维度：{srv, host, user}
// gate=true 时要求文本里**先出现数据库客户端入口**才解析 host/user：真机首跑发现任意 Bash 文本里的
// `-u xxx`、`a@b` 片段会被抽成假账号键（台账里出现过 `3_40`、`4_47` 这种行号残片），
// 假键一旦和真账号撞上就是误拦。MCP 侧有 srv 别名可锚，不需要 gate。
const DB_ENTRY = /\b(?:psql|pg_dump|pg_restore|mysql|mariadb|sqlplus|sqlcl|sqlcmd|sqlline|beeline|gsql|mongo(?:sh)?|redis-cli)\b|jdbc:|execute_sql/i;
function dims(text, srvFromTool, gate) {
  const t = String(text || '');
  const d = {};
  if (srvFromTool) d.srv = String(srvFromTool).toLowerCase();
  const mSrv = t.match(/execute_sql[_-]([a-z0-9_]+)/i);
  if (mSrv && !d.srv) d.srv = mSrv[1].toLowerCase();
  if (gate && !DB_ENTRY.test(t)) return d;
  const mJdbc = t.match(/jdbc:[a-z0-9]+:\/\/([\w.\-]+)(?::(\d+))?/i);
  if (mJdbc) d.host = mJdbc[1].toLowerCase();
  const mHost = t.match(/(?:^|[\s'"])(?:-h|--host)[=\s]+["']?([\w.\-]+)/);
  if (mHost && !d.host) d.host = mHost[1].toLowerCase();
  const mUser = t.match(/(?:^|[\s'"])(?:-U|--username|-u)[=\s]+["']?([\w.\-]+)/);
  if (mUser) d.user = mUser[1].toLowerCase();
  const mAt = t.match(/\b([a-z][a-z0-9_.\-]{1,})@([a-z0-9.\-]+)/i);
  if (mAt) { if (!d.user) d.user = mAt[1].toLowerCase(); if (!d.host) d.host = mAt[2].toLowerCase(); }
  // PG/瀚高、Oracle 的报错写法是 `for user "xxx"`，只按 `user=` / `user@host` 抽会**永远抽不到账号维度**
  // ——而锁定发生在账号上，抽不到就等于换条路（从 MCP 换到 shell 直连）就能绕开门禁。
  const mForUser = t.match(/for user\s+["']?([a-z][a-z0-9_.\-]{1,})["']?/i) || t.match(/user\s+["']([a-z][a-z0-9_.\-]{1,})["']/i);
  if (mForUser && !d.user) d.user = mForUser[1].toLowerCase();
  const mDbUser = t.match(/["']?(?:username|user|uid)["']?\s*[=:]\s*["']([\w.\-]+)["']/i);
  if (mDbUser && !d.user) d.user = mDbUser[1].toLowerCase();
  return d;
}
const hasDim = (d) => !!(d && (d.srv || d.host || d.user));
const keyOf = (d) => [d.srv || '-', d.host || '-', d.user || '-'].join('/');
const DIMS_DEFAULT = ['srv', 'host', 'user'];
function sameDim(a, b, dimsAllowed) {
  for (const k of dimsAllowed) if (a[k] && b[k] && a[k] === b[k]) return k;
  return null;
}

function load() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return { entries: {} }; } }
function save(s) { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 1)); } catch (e) {} }
function prune(s, c) {
  const now = Date.now();
  const ttl = (c.ttlHours || 24) * 3600e3, bttl = (c.blockTtlHours || 24) * 3600e3;
  for (const k of Object.keys(s.entries)) {
    const e = s.entries[k];
    const age = now - (e.at || 0);
    if (e.blocked ? age > bttl : age > ttl) delete s.entries[k];
  }
  return s;
}
function findMatch(s, d, dimsAllowed) {
  return Object.keys(s.entries)
    .map((k) => ({ k, e: s.entries[k] }))
    .find((x) => sameDim(x.e.dims || {}, d, dimsAllowed));
}

const STOP = '停手：不要再换连接方式/工具/端口重试同一目标——每一次认证失败都在逼近服务端锁定阈值'
  + '（瀚高/PG 约 10 次即 `Too many invalid attempts`，Oracle ORA-28000，MySQL 1045 累计触发主机屏蔽），'
  + '一旦锁定只能由 sysso/DBA 手工解锁，且锁定期内任何重连都在续命。';
const HOWTO = '先查凭据本身再谈重试：① 从配置文件/环境变量取到的密码先校验字节——内网仓库的 `application*.yml` 多为 CRLF，'
  + '按行截取的值带尾部 `\\r`，连发的全是"错密码"；② 优先用已配置好的只读 MCP 连接，不要手搓直连去试生产库；'
  + '③ 向用户上报已失败次数与报错原文，等用户决定（解锁/换凭据/放弃该步）。';

// 只守"能真的发起数据目标连接"的工具面。真机发现 Edit/Write 的 new_string 里只要**引用**了
// `psql -h ... -U ...` 这种字符串（写测试、写文档时必然出现）也会被建出目标键——同一类假键问题。
const SHELLISH = /^(bash|shell|cmd|powershell|terminal|zsh)$/i;
const DBTOOL = /execute_sql|sqlcl|psql|mysql|mariadb|sqlplus|redis-cli/i;

// 把 hook payload 归一化成 {event, rawTool, toolName, call, callDims, srvFromTool}；与数据目标无关 → null
function parse(p) {
  if (!p || typeof p !== 'object') return null;
  const c = cfg();
  if (c.disabled) return null;
  const event = String(p.hook_event_name || (p.tool_response !== undefined || p.tool_output !== undefined || p.result !== undefined ? 'PostToolUse' : 'PreToolUse'));
  const rawTool = String(p.tool_name || p.toolName || '');
  let toolName = rawTool, call = p.tool_input || p.toolInput || {};
  // MCP 懒加载形态：真名在 tool_input.toolName，参数在 tool_input.arguments（只按限定名写判据会永远匹配不上）
  if (/^mcp_call$/.test(rawTool) && call && typeof call === 'object') {
    toolName = String(call.toolName || '');
    call = (call.arguments && typeof call.arguments === 'object') ? call.arguments : {};
  }
  if (!(SHELLISH.test(rawTool) || /^mcp_call$/i.test(rawTool) || DBTOOL.test(toolName))) return null;
  const srvFromTool = (toolName.match(/execute_sql[_-]([a-z0-9_]+)/i) || [])[1];
  const callDims = dims(toolName + ' ' + JSON.stringify(call || {}), srvFromTool, !srvFromTool);
  if (!hasDim(callDims)) return null;
  return { event, rawTool, toolName, call, callDims, srvFromTool, cfg: c };
}

// PreToolUse：查状态，该拦就给 reason。返回 null＝放行（已建目标时顺带留 allow 台账）
function preCheck(payload) {
  const t = parse(payload);
  if (!t) return null;
  const dimsAllowed = Array.isArray(t.cfg.dims) && t.cfg.dims.length ? t.cfg.dims : DIMS_DEFAULT;
  const threshold = Number(t.cfg.threshold) > 0 ? Number(t.cfg.threshold) : 3;
  const s = prune(load(), t.cfg);
  const hit = findMatch(s, t.callDims, dimsAllowed);
  const cur = hit ? s.entries[hit.k] : null;
  const idKey = hit ? hit.k : keyOf(t.callDims);
  if (cur && (cur.blocked || (cur.count || 0) >= threshold)) {
    ledger('block|' + idKey + '|n=' + (cur.count || 0));
    return {
      key: idKey, count: cur.count || 0,
      reason: '[auth-lock] 目标 `' + idKey + '` 已累计认证失败 ' + (cur.count || 0) + ' 次'
        + (cur.locked ? '，且返回里已出现**锁定签名**（该账号大概率已被服务端锁死，只能由 sysso/DBA 解锁）' : '') + '，本次调用被拦。' + STOP + '\n' + HOWTO
        + '\n人工解除：node ~/.qoder/scripts/auth-lock-guard.js --clear "' + idKey + '"（或 --clear ALL）',
    };
  }
  ledger('eval|allow|' + idKey + '|n=' + (cur ? cur.count || 0 : 0));
  return null;
}

// PostToolUse：只看返回给次数记账。返回 {key, count, kind, reason}；reason 非空＝该当场叫停
function postRecord(payload) {
  const t = parse(payload);
  if (!t) return null;
  const dimsAllowed = Array.isArray(t.cfg.dims) && t.cfg.dims.length ? t.cfg.dims : DIMS_DEFAULT;
  const threshold = Number(t.cfg.threshold) > 0 ? Number(t.cfg.threshold) : 3;
  const s = prune(load(), t.cfg);
  const hit = findMatch(s, t.callDims, dimsAllowed);
  const idKey = hit ? hit.k : keyOf(t.callDims);
  const cur = hit ? s.entries[hit.k] : { dims: t.callDims, count: 0, at: Date.now(), samples: [] };

  const resp = payload.tool_response !== undefined ? payload.tool_response
    : payload.tool_output !== undefined ? payload.tool_output
    : payload.result !== undefined ? payload.result : payload.output;
  const respText = typeof resp === 'string' ? resp : JSON.stringify(resp || '');
  const resDims = dims(respText, t.srvFromTool);
  const merged = Object.assign({}, t.callDims);
  for (const k of ['srv', 'host', 'user']) if (!merged[k] && resDims[k]) merged[k] = resDims[k];

  const any = (pats) => pats.some((re) => re.test(respText));
  let kind = 'ok';
  if (any(LOCKED)) kind = 'locked';
  else if (any(AUTH_FAIL)) kind = 'authfail';
  else if (NEUTRAL.test(respText) && !/^\s*[\[{]/.test(String(respText || '').trim())) kind = 'neutral';

  if (kind === 'ok') {
    // 已拦的目标**不因一次"看起来成功"就自动解封**：解封是用户的决定（--clear），
    // 否则一次误判的绿灯就能把门禁绕过去。
    if (hit && !hit.e.blocked) { delete s.entries[hit.k]; save(s); ledger('reset|' + hit.k); }
    return { key: idKey, count: cur.count || 0, kind };
  }
  if (kind === 'neutral') { ledger('neutral|' + idKey); return { key: idKey, count: cur.count || 0, kind }; }

  cur.dims = merged;
  cur.count = kind === 'locked' ? Math.max(threshold, (cur.count || 0) + 1) : (cur.count || 0) + 1;
  cur.at = Date.now();
  cur.samples = (cur.samples || []).concat([respText.replace(/\s+/g, ' ').slice(0, 160)]).slice(-3);
  if (kind === 'locked') { cur.blocked = true; cur.locked = true; }
  if (cur.count >= threshold) cur.blocked = true;
  s.entries[idKey] = cur;
  save(s);
  ledger(kind + '|' + idKey + '|n=' + cur.count);
  return {
    key: idKey, count: cur.count, kind,
    reason: cur.count >= threshold
      ? '[auth-lock] 目标 `' + idKey + '` 认证失败已累计到 ' + cur.count + ' 次'
        + (kind === 'locked' ? '（返回里已出现**锁定签名**）' : '') + '。' + STOP + '\n' + HOWTO
        + '\n最近报错：' + cur.samples[cur.samples.length - 1]
      : null,
  };
}

function status() { const s = prune(load(), cfg()); return { state: STATE, entries: s.entries }; }
function clear(arg) {
  const s = load();
  let removed = 0;
  if (!arg || arg === 'ALL') { removed = Object.keys(s.entries).length; s.entries = {}; }
  else {
    for (const k of Object.keys(s.entries)) {
      if (k === arg || (s.entries[k].dims || {})[String(arg).split('/')[1]]) { delete s.entries[k]; removed++; }
    }
  }
  save(s); ledger('clear|' + (arg || 'ALL') + '|' + removed);
  return removed;
}

module.exports = { preCheck, postRecord, status, clear, cfg, ledger, parse, paths: () => ({ CONFIG, STATE_DIR, STATE, LEDGER }) };
