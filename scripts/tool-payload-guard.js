#!/usr/bin/env node
// tool-payload-guard.js —— **PostToolUse 返回侧入账**：单条工具返回超过阈值时当场提示。
//
// 为什么还要这一层：huge-output-guard 在 PreToolUse 拦"明显超标的单条命令/文件读取"，
// 但拦不住"多条中等返回累积"与"子代理报告/工具默认回显"这类**返回才知道多大**的情形
// （README 的已知局限：session-budget 只有回合粒度，看不出是哪一个工具贡献的）。
//
// 判据：把 tool_response 序列化后量字节；超过阈值（默认 2MB）⇒ 每个会话每个工具只提醒一次，
// 让模型立刻用摘要/片段替代原样回放，而不是等回合被传输层掐断。
// 不做"截断"——PostToolUse 拿到的返回已经进了上下文，截断是假的；这里只做**可见化 + 纠偏提示**。
// 关闭：~/.qoder/tool-payload-guard.json 写 {"disabled":true}
// 台账：~/.qoder/tmp/tool-payload/decisions.log
'use strict';
require('./hook-crash-guard.js').install('tool-payload-guard');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const CONFIG = path.join(CLIENT_ROOT, 'tool-payload-guard.json');
const STATE_DIR = process.env.TOOL_PAYLOAD_STATE_DIR || path.join(CLIENT_ROOT, 'tmp', 'tool-payload');
const THRESHOLD = Number(process.env.TPG_BYTES || 2 * 1024 * 1024);
const WARN_COOLDOWN_MS = Number(process.env.TPG_COOLDOWN_MS || 30 * 60 * 1000);

function ledger(row) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(path.join(STATE_DIR, 'decisions.log'), new Date().toISOString() + '|' + row + '\n'); } catch (e) {}
}
function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) {
    const chunks = []; const buf = Buffer.alloc(65536);
    try { let r; while ((r = fs.readSync(0, buf, 0, buf.length, null)) > 0) chunks.push(Buffer.from(buf.subarray(0, r))); } catch (e2) {}
    return Buffer.concat(chunks).toString('utf8');
  }
}

let p;
try { p = JSON.parse(readStdin() || '{}'); } catch (e) { process.exit(0); }
if (String(p.hook_event_name || 'PostToolUse') !== 'PostToolUse') process.exit(0);
try { if (JSON.parse(fs.readFileSync(CONFIG, 'utf8')).disabled) process.exit(0); } catch (e) {}

const tool = String(p.tool_name || p.toolName || 'unknown');
const resp = p.tool_response !== undefined ? p.tool_response
  : p.tool_output !== undefined ? p.tool_output
    : p.result !== undefined ? p.result : p.output;
let bytes = 0;
try { bytes = Buffer.byteLength(typeof resp === 'string' ? resp : JSON.stringify(resp === undefined ? '' : resp), 'utf8'); } catch (e) { process.exit(0); }
if (bytes <= THRESHOLD) process.exit(0);

const sid = String(p.session_id || p.sessionId || 'nosession').replace(/[^A-Za-z0-9._-]/g, '_');
const stateFile = path.join(STATE_DIR, 'warned-' + sid.slice(0, 40) + '.json');
let warned = {};
try { warned = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) {}
const last = warned[tool] || 0;
if (Date.now() - last < WARN_COOLDOWN_MS) process.exit(0);
warned[tool] = Date.now();
try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(warned)); } catch (e) {}
ledger(tool + '|' + (bytes / 1048576).toFixed(2) + 'MB');

process.stdout.write(JSON.stringify({
  decision: 'block',
  reason: '[tool-payload] `' + tool + '` 这一条返回约 ' + (bytes / 1048576).toFixed(1) + ' MB（阈值 '
    + (THRESHOLD / 1048576).toFixed(1) + ' MB）。单请求 payload 越大，服务端越可能在 60s 内发不出响应头、回合被掐断。'
    + '接下来改用摘要推进：不要原样复述这段返回；需要细节时用 Grep/offset 定向取片段，或把结果写入文件后只看结论行。'
    + '（本会话同工具只提醒一次；阈值 TPG_BYTES 可调。）',
}) + '\n');
process.exit(0);
