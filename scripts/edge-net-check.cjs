// edge-net-check —— 本机"浏览器打不开网页"一键定性，可选自愈
// 用法:  node edge-net-check.cjs          只读诊断
//        node edge-net-check.cjs --fix    判红指向加速器时，重启 Watt(Steam++) 并复测
// 三种实测过的故障形状：代理残留 / hosts 劫持但加速器没跑 / 加速器回源随运行时间劣化
const { execSync, execFileSync } = require('child_process'), fs = require('fs'), https = require('https');
const FIX = process.argv.includes('--fix');
const sh = c => { try { return execSync(c, { encoding: 'latin1', timeout: 40000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return e.stdout || ''; } };
const ps = c => { try { return execFileSync('powershell', ['-NoProfile', '-Command', c],
  { encoding: 'latin1', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\r/g, '').trim(); }
catch (e) { return ''; } };
const pad = (s, n) => String(s).padEnd(n);
const BENIGN = /^(localhost|.*\.localhost|kubernetes\.docker\.internal|wpad)$/i;

// ---- 1) 系统代理：开了却无监听端口 = 浏览器全站打不开（非浏览器程序不受影响）----
const reg = sh('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"');
const enable = +(reg.match(/ProxyEnable\s+REG_DWORD\s+0x(\d+)/)?.[1] ?? -1);
const proxy = (reg.match(/ProxyServer\s+REG_SZ\s+(\S+)/) || [])[1] || '';
const port = +(proxy.match(/:(\d+)/)?.[1] || 0);
const ports = new Set((sh('netstat -ano -p tcp').match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING/gm) || [])
  .map(s => +s.match(/:(\d+)\s/)[1]));
console.log('1) 系统代理  ProxyEnable=' + enable + '  ProxyServer=' + (proxy || '(无)') +
  (port ? '  端口' + port + (ports.has(port) ? ' 有监听' : ' 无监听') : ''));
const proxyBad = enable === 1 && port > 0 && !ports.has(port);
console.log(proxyBad ? '   >> 判红：代理残留 —— 浏览器全站打不开'
  : (enable === 1 ? '   >> ProxyEnable=1 但无 ProxyServer ⇒ 实际走直连（无害）' : '   >> 代理层正常'));

// ---- 2) hosts 劫持面 + 加速器存活与运行时长 ----
const hostsTxt = fs.readFileSync('C:\\Windows\\System32\\drivers\\etc\\hosts', 'latin1');
const hijacked = new Set(hostsTxt.split(/\r?\n/).filter(l => /^\s*127\.0\.0\.1\s+\S/.test(l))
  .map(l => l.trim().split(/\s+/)[1]).filter(h => !BENIGN.test(h)));
const upRaw = ps("$p=Get-Process 'Steam++' -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1;" +
  "if($p){ [int]((Get-Date) - $p.StartTime).TotalMinutes } else { 'none' }");
const accUp = ports.has(443) || /Steam\+\+\.Accelerator/.test(sh('tasklist /fo csv /nh'));
console.log('\n2) hosts 有效劫持条目=' + hijacked.size + '  加速器=' + (accUp ? '在跑' : '未运行') +
  '  Watt 已运行=' + (/^\d+$/.test(upRaw) ? upRaw + ' 分钟' : '无进程'));
const hijackDead = hijacked.size > 0 && !accUp;
if (hijackDead) console.log('   >> 判红：有劫持却无转发服务 ⇒ 这些域名此刻全部连不上');

// ---- 3) 冷域名完整 HTTPS 请求耗时（必须量到响应，只量握手会假绿）----
const probe = host => new Promise(res => {
  const t0 = Date.now();
  const req = https.get({ host, port: 443, path: '/favicon.ico', timeout: 9000, rejectUnauthorized: false,
    headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
      const iss = (r.socket.getPeerCertificate().issuer || {}).CN || '?';
      r.resume();
      r.on('end', () => res({ host, ms: Date.now() - t0, path: /SteamTools/.test(iss) ? '加速器MITM' : '直连' }));
    });
  req.on('timeout', () => req.destroy(Object.assign(new Error('x'), { code: 'ETIMEOUT' })));
  req.on('error', e => res({ host, ms: Date.now() - t0, path: 'ERR ' + (e.code || e.message).slice(0, 14) }));
});
const HIJ = ['github.githubassets.com', 'objects.githubusercontent.com', 'avatars.githubusercontent.com'];
const CTRL = ['www.baidu.com', 'www.qq.com'];
async function measure() {
  const out = [];
  for (const h of [...HIJ, ...CTRL]) out.push(await probe(h));
  out.forEach(r => console.log('   ' + pad(r.host, 34) + pad(r.ms + 'ms', 9) + r.path));
  const bad = out.filter(r => HIJ.includes(r.host) && (r.ms > 3000 || /ERR/.test(r.path)));
  const ctrlFast = out.filter(r => CTRL.includes(r.host) && r.ms < 900);
  return { out, bad, ctrlOk: ctrlFast.length > 0 };
}
console.log('\n3) 完整请求耗时（新域名冷连接；前 3 项走劫持路径，后 2 项为对照）');
(async () => {
  const m = await measure();
  if (m.bad.length && m.ctrlOk) console.log('   >> 判红：劫持路径慢/超时 [' + m.bad.map(r => r.host).join(', ') + ']，对照域名正常 ⇒ 瓶颈在加速器回源');
  else if (m.bad.length) console.log('   >> 有慢项但对照也异常 ⇒ 先查本机网络 / DNS，不下加速器结论');
  else console.log('   >> 劫持路径此刻正常');

  if (!FIX) { console.log('\n（加 --fix 可在判红时自动重启 Watt 并复测）'); return; }
  if (!m.bad.length && !hijackDead && !proxyBad) { console.log('\n--fix：无判红项，不动任何进程'); return; }
  console.log('\n--fix：重启 Watt(Steam++) …');
  ps("Get-Process | Where-Object { $_.ProcessName -like 'Steam++*' } | Stop-Process -Force");
  await new Promise(r => setTimeout(r, 2500));
  ps("Start-Process 'D:\\Program Files\\Steam++\\Steam++.exe'");
  for (let i = 0; i < 20 && !/Steam\+\+\.Accelerator/.test(sh('tasklist /fo csv /nh')); i++) await new Promise(r => setTimeout(r, 1500));
  console.log('   重启完成，3 秒后复测：');
  await new Promise(r => setTimeout(r, 3000));
  const m2 = await measure();
  const mx = a => Math.max(...a.out.filter(r => HIJ.includes(r.host)).map(r => r.ms));
  console.log(`   >> 复测：劫持路径最大耗时 ${mx(m)}ms -> ${mx(m2)}ms` +
    (mx(m2) < 3000 ? '  已恢复' : '  仍未恢复（改走减小劫持面 / 换线路）'));
})();
