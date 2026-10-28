// MCP stdio 协议级冒烟测试：initialize → tools/list（可选 tools/call 实测一次调用）
// 用法: node mcp-smoke.js <command> [args...] [--call <toolName> <json-args>]
// 例:   node mcp-smoke.js node "D:\\...\\dist\\index.js" --transport stdio --config=C:\\...\\xx.toml
//       node mcp-smoke.js cmd /c "D:\\...\\npx.cmd" -y some-mcp --call execute_sql '{"sql":"SELECT 1"}'
// 退出码: 0=全绿；1=有步骤失败（错误信息指向具体步骤）
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const callIdx = argv.indexOf('--call');
let callSpec = null;
if (callIdx >= 0) {
  callSpec = { tool: argv[callIdx + 1], args: JSON.parse(argv[callIdx + 2] || '{}') };
  argv.splice(callIdx);
}
if (argv.length === 0) {
  console.error('用法: node mcp-smoke.js <command> [args...] [--call <toolName> <json-args>]');
  process.exit(1);
}

const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '', errBuf = '';
const pending = new Map();
child.stdout.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) { const r = pending.get(msg.id); pending.delete(msg.id); r(msg); }
  }
});
child.stderr.on('data', d => { errBuf += d.toString(); });
child.on('error', e => { console.error('FAIL spawn:', e.message); process.exit(1); });

function send(o) { child.stdin.write(JSON.stringify(o) + '\n'); }
function rpc(id, method, params, timeoutMs) {
  return new Promise(resolve => {
    const t = setTimeout(() => { pending.delete(id); resolve({ __timeout: true }); }, timeoutMs);
    pending.set(id, m => { clearTimeout(t); resolve(m); });
    send({ jsonrpc: '2.0', id, method, params });
  });
}
function fail(step, res) {
  console.error(`FAIL ${step}:`, JSON.stringify(res).slice(0, 300), '| stderr:', errBuf.slice(0, 300));
  child.kill(); process.exit(1);
}

(async () => {
  const t0 = Date.now();
  const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-smoke', version: '1.0' } }, 30000);
  if (init.__timeout || init.error) fail('initialize', init);
  const si = (init.result && init.result.serverInfo) || {};
  console.log(`OK initialize: ${si.name || '?'} @ ${si.version || '?'} (${Date.now() - t0}ms)`);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const tl = await rpc(2, 'tools/list', {}, 15000);
  if (tl.__timeout || tl.error) fail('tools/list', tl);
  const tools = (tl.result && tl.result.tools) || [];
  console.log(`OK tools/list: ${tools.length} 个工具${tools.length ? ' — ' + tools.map(t => t.name).join(', ') : ''}`);

  if (callSpec) {
    if (!tools.some(t => t.name === callSpec.tool)) fail('tools/call', { error: `工具不存在: ${callSpec.tool}` });
    const res = await rpc(3, 'tools/call', { name: callSpec.tool, arguments: callSpec.args }, 60000);
    if (res.__timeout || res.error) fail('tools/call', res);
    const c = res.result && res.result.content;
    const text = Array.isArray(c) ? (c.find(x => x.type === 'text') || {}).text : JSON.stringify(res.result);
    console.log('OK tools/call:', String(text).replace(/\s+/g, ' ').slice(0, 200));
  }
  console.log('=== 冒烟通过（三步全绿） ===');
  child.kill();
  process.exit(0);
})();
