// gh-accel-plan —— 对每个被 Watt 劫持的域名，同刻实测两条路径并比较：
//   A) 走劫持（域名解析到 127.0.0.1，由 Watt 本地 MITM 回源）
//   B) 绕过 hosts 直连真实 IP（dns.resolve4 不读 hosts）
// 输出按"该不该把这批域名交还给直连"排序的六桶清单，并强制校验六桶覆盖全部域名。
const fs = require('fs'), os = require('os'), path = require('path'), dns = require('dns'), https = require('https');
const CONC = 12, TMO = 6000, WIN_MS = 500;
const BENIGN = /^(localhost|.*\.localhost|kubernetes\.docker\.internal|wpad)$/i;
const HOSTS = 'C:\\Windows\\System32\\drivers\\etc\\hosts';

const uniq = [...new Set(fs.readFileSync(HOSTS, 'latin1').split(/\r?\n/)
  .filter(l => /^\s*127\.0\.0\.1\s+\S/.test(l)).map(l => l.trim().split(/\s+/)[1]).filter(h => h && !BENIGN.test(h)))];

const get = (connectHost, servername) => new Promise(res => {
  const t0 = Date.now();
  const rq = https.get({ host: connectHost, servername, port: 443, path: '/favicon.ico', timeout: TMO,
    rejectUnauthorized: false, headers: { Host: servername, 'User-Agent': 'Mozilla/5.0' } }, r => {
      const iss = (r.socket.getPeerCertificate().issuer || {}).CN || '?';
      r.resume(); r.on('end', () => res({ ms: Date.now() - t0, ok: true, iss }));
    });
  rq.on('timeout', () => rq.destroy(Object.assign(new Error('t'), { code: 'ETIMEOUT' })));
  rq.on('error', e => res({ ms: Date.now() - t0, ok: false, iss: e.code || 'ERR' }));
});
const resolve4 = h => new Promise(r => dns.resolve4(h, (e, a) => r(e || !a ? null : a[0])));

async function one(host) {
  const [watt, ip] = await Promise.all([get(host, host), resolve4(host)]);
  const direct = ip ? await get(ip, host) : { ms: 9999, ok: false, iss: 'NO_A' };
  return { host, watt, direct, hijacked: /SteamTools/.test(watt.iss) };
}

(async () => {
  const out = [];
  let i = 0;
  async function w() { while (i < uniq.length) out.push(await one(uniq[i++])); }
  await Promise.all(Array.from({ length: CONC }, w));
  const dir = path.join(os.tmpdir(), 'qoder-work');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gh-accel-plan.json'), JSON.stringify(out, null, 1));

  const wFail = r => !r.watt.ok;
  const B = {
    giveBack: out.filter(r => wFail(r) && r.direct.ok),                    // Watt 挂了、直连能用
    faster: out.filter(r => !wFail(r) && r.direct.ok && r.direct.ms + WIN_MS < r.watt.ms),
    bothBad: out.filter(r => wFail(r) && !r.direct.ok),                    // 两条都不通
    keep: out.filter(r => !wFail(r) && (!r.direct.ok || r.watt.ms + WIN_MS <= r.direct.ms)),
    near: out.filter(r => !wFail(r) && r.direct.ok && Math.abs(r.watt.ms - r.direct.ms) < WIN_MS),
    notHijacked: out.filter(r => !wFail(r) && !r.hijacked),                // Watt 应答了但不是它的证书
  };
  const sum = Object.values(B).reduce((s, a) => s + a.length, 0);
  const dup = sum !== new Set([].concat(...Object.values(B))).size;
  console.log('同刻双路对比：走 Watt 劫持路径  vs  绕过 hosts 直连真实 IP   (共 ' + uniq.length + ' 个被劫持域名)');
  if (dup || sum !== out.length) console.log('!! 分桶校验失败: 覆盖 ' + sum + '/' + out.length + ' 重复=' + dup);
  else console.log('分桶校验: ' + Object.entries(B).map(([k, v]) => k + '=' + v.length).join(' ') +
    '  合计 ' + sum + '/' + out.length + '  PASS');

  const grp = a => { const g = {}; a.forEach(r => { const b = r.host.split('.').slice(-2).join('.'); (g[b] ||= []).push(r); }); return g; };
  const show = (title, rows, pick) => {
    console.log('\n【' + title + '】' + rows.length + ' 个域名');
    Object.entries(grp(rows)).sort((x, y) => y[1].length - x[1].length).slice(0, 12).forEach(([b, a]) =>
      console.log('  ' + b.padEnd(24) + String(a.length + '条').padStart(6) + '  ' + a.map(pick).sort((x, y) => x - y)[a.length >> 1]));
    if (!rows.length) console.log('  (无)');
  };
  const dsc = r => (r.watt.ok ? 'Watt ' + r.watt.ms + 'ms' : 'Watt 失败(' + r.watt.iss + ')') +
    ' / 直连 ' + (r.direct.ok ? r.direct.ms + 'ms' : '不通(' + r.direct.iss + ')');
  show('1. 立刻交还直连：Watt 路径直接失败，而直连可用', B.giveBack, dsc);
  show('2. 值得交还直连：两条都通但直连明显更快', B.faster, dsc);
  show('3. 保留加速：Watt 通且更快，或直连根本不通', B.keep, dsc);
  show('4. 两条都不通：需要代理节点，Watt 也救不了', B.bothBad, dsc);
  show('5. 两条接近（差 <' + WIN_MS + 'ms）：不用动', B.near, dsc);
  show('6. Watt 应答但证书不是 SteamTools：这条劫持项此刻没起作用', B.notHijacked, dsc);

  console.log('\n建议: 桶 1+2 共 ' + (B.giveBack.length + B.faster.length) + ' 个域名可在 Watt 界面取消对应服务的勾选。');
  console.log('提醒 1) 本对比是单请求。GitHub 静态资源域在"整页 100+ 并发"下直连会崩到十几秒（实测中位 14.5s），');
  console.log('        githubassets / avatars 这类即使这里显示直连略快，也建议保留 Watt 加速。');
  console.log('提醒 2) 收敛只能在 Watt 界面点，手改 hosts 会被它数秒内自愈重写。');
  console.log('明细 JSON: ' + path.join(dir, 'gh-accel-plan.json'));
})();
