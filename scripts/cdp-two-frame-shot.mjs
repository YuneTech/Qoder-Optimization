// One-off forensic: two real-time CDP screenshots + animation clock samples from a headless Edge.
import { writeFileSync } from 'node:fs';

const outDir = process.argv[2];
if (!outDir) { console.error('usage: node cdp-shot.mjs <outdir>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = 'http://127.0.0.1:9222';

process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e); process.exit(4); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 40000);

let targets = [];
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(base + '/json/list');
    targets = await r.json();
    if (Array.isArray(targets) && targets.some((t) => t.type === 'page')) break;
  } catch {}
  await sleep(250);
}
const page = targets.find((t) => t.type === 'page' && (t.url || '').includes('pelican')) || targets.find((t) => t.type === 'page');
if (!page) { console.log('NO_PAGE_TARGET', JSON.stringify(targets.map((t) => t.type + ':' + (t.url || '')))); process.exit(2); }
console.log('TARGET ' + page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

const evalExpr = async (expression) => {
  const m = await send('Runtime.evaluate', { expression, returnByValue: true });
  return m.result && m.result.result ? m.result.result.value : undefined;
};

for (let i = 0; i < 40; i++) {
  if ((await evalExpr('document.readyState')) === 'complete') break;
  await sleep(150);
}
await sleep(500);

const probe = "(function(){var svg=document.querySelector('svg');var dash=document.querySelector('.dash');var body=document.getElementById('bodyG');var anims=document.getAnimations();return {timeline: document.timeline.currentTime, smil: svg && svg.getCurrentTime ? svg.getCurrentTime() : null, dash: dash ? getComputedStyle(dash).strokeDashoffset : null, bodyTop: body ? body.getBoundingClientRect().top : null, nAnims: anims.length, c0: anims.length ? anims[0].currentTime : null};})()";

const a = await evalExpr(probe);
const shot1 = (await send('Page.captureScreenshot', { format: 'png' })).result.data;
writeFileSync(outDir + '/cdp1.png', Buffer.from(shot1, 'base64'));
await sleep(700);
const shot2 = (await send('Page.captureScreenshot', { format: 'png' })).result.data;
writeFileSync(outDir + '/cdp2.png', Buffer.from(shot2, 'base64'));
const b = await evalExpr(probe);

console.log('SAMPLE_A ' + JSON.stringify(a));
console.log('SAMPLE_B ' + JSON.stringify(b));
console.log('TIMELINE_DELTA_MS ' + (b.timeline - a.timeline));
try { await send('Browser.close'); } catch {}
await sleep(300);
process.exit(0);
