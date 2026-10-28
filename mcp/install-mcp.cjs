#!/usr/bin/env node
// MCP 安装助手：交互询问 → 选择离线包 / 联网最新版 / 跳过 → 合并配置（改前备份，不写凭据）。
// 用法: node install-mcp.cjs [--config-dir <目录>] [--dry-run] [--yes]
//        [--cua offline|online|register|skip] [--dbhub online|tgz|skip]
//        [--install-dir <cua 安装目录>] [--wire-guard] [--skip-cua] [--skip-dbhub]
process.noDeprecation = true; // npm 在 Windows 上需要 shell:true，屏蔽对应的 DEP0190 噪声
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');
const https = require('https');
const readline = require('readline');

const args = process.argv.slice(2);
const get = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes('--' + n);

// 配置落到**本机实际存在**的客户端目录：只装了一个客户端时，不去新建另一侧的目录（2026-10-27）
const CLIENT_ROOT = (() => {
  const h = os.homedir();
  const sides = [path.join(h, '.qoder'), path.join(h, '.qoder-cn')].filter((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
  return sides.length === 1 ? sides[0] : path.join(h, '.qoder');
})();
const CONFIG = path.resolve(get('config-dir', CLIENT_ROOT));
const DRY = has('dry-run');
const YES = has('yes');
const WIRE_GUARD = has('wire-guard');
const SKIP_CUA = has('skip-cua');
const SKIP_DBHUB = has('skip-dbhub');
const CUA_MODE = get('cua', 'auto');
const DBHUB_MODE = get('dbhub', 'auto');
const INSTALL_DIR_RAW = get('install-dir', null);
const INSTALL_DIR = path.resolve(INSTALL_DIR_RAW || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Cua', 'cua-driver', 'bin'));
const KIT = __dirname;
const OFFLINE = path.join(KIT, 'offline');
const SETTINGS = path.join(CONFIG, 'settings.json');
const REGISTRY = 'https://registry.npmmirror.com';
const WIN = process.platform === 'win32';
const REPO = 'trycua/cua';

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('[警告]', ...a);

function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function backup(p) {
  const dir = path.join(CONFIG, '.backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(dir, `${stamp}-${path.basename(p)}`);
  if (fs.existsSync(p)) fs.copyFileSync(p, dst);
  return dst;
}
function npmRoot() {
  const r = cp.spawnSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: WIN });
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}
function bundledCua() {
  if (!fs.existsSync(OFFLINE)) return null;
  const zip = fs.readdirSync(OFFLINE).find((f) => /^cua-driver-rs-.*-windows-x86_64\.zip$/.test(f));
  if (!zip) return null;
  const m = zip.match(/cua-driver-rs-(.+)-windows-x86_64\.zip$/);
  const sums = path.join(OFFLINE, 'SHA256SUMS');
  return { zip: path.join(OFFLINE, zip), version: m ? m[1] : 'unknown', sums: fs.existsSync(sums) ? sums : null };
}
function installedCuaVersion(exe) {
  if (!fs.existsSync(exe)) return null;
  const r = cp.spawnSync(exe, ['--version'], { encoding: 'utf8' });
  const m = String(r.stdout || '').match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : 'unknown';
}
function findCuaExe() {
  const cands = [path.join(INSTALL_DIR, 'cua-driver.exe')];
  if (!INSTALL_DIR_RAW) {
    cands.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe'));
    cands.push(path.join(os.homedir(), '.cua-driver', 'packages', 'current', 'cua-driver.exe'));
  }
  return cands.find((p) => p && fs.existsSync(p)) || null;
}
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function verifySums(zip, sums) {
  if (!sums) return { ok: false, reason: '没有 SHA256SUMS' };
  const name = path.basename(zip);
  const line = fs.readFileSync(sums, 'utf8').split(/\r?\n/).find((l) => l.trim().endsWith(name));
  if (!line) return { ok: false, reason: 'SHA256SUMS 中没有该文件' };
  const want = line.trim().split(/\s+/)[0];
  const got = sha256(zip);
  return { ok: want === got, want, got };
}
function extractZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let r = cp.spawnSync('tar', ['-xf', zip, '-C', dest], { encoding: 'utf8' });
  if (r.status !== 0) {
    r = cp.spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`], { encoding: 'utf8' });
  }
  if (r.status !== 0) throw new Error('解压失败: ' + (r.stderr || r.stdout || 'tar/powershell 均失败'));
}
function installCuaFromZip(zip, version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cua-'));
  extractZip(zip, tmp);
  const inner = fs.readdirSync(tmp).map((n) => path.join(tmp, n)).find((p) => fs.statSync(p).isDirectory()) || tmp;
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.cpSync(inner, INSTALL_DIR, { recursive: true, force: true });
  const exe = path.join(INSTALL_DIR, 'cua-driver.exe');
  const got = installedCuaVersion(exe);
  log(`- cua-driver ${version} 已释放到 ${INSTALL_DIR}（实测版本: ${got}）`);
  return exe;
}
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'qoder-share-mcp-kit' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects < 5) {
        r.resume();
        return download(new URL(r.headers.location, url).toString(), dest, redirects + 1).then(resolve, reject);
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const f = fs.createWriteStream(dest);
      r.pipe(f);
      f.on('finish', () => f.close(() => resolve()));
      f.on('error', reject);
    }).on('error', reject);
  });
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'qoder-share-mcp-kit', Accept: 'application/vnd.github+json' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return getJson(new URL(r.headers.location, url).toString()).then(resolve, reject);
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      let s = '';
      r.on('data', (d) => (s += d));
      r.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
async function installCuaOnline() {
  const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  const ver = String(rel.tag_name || '').replace(/^v/, '');
  const assets = rel.assets || [];
  const zip = assets.find((a) => /^cua-driver-rs-.*-windows-x86_64\.zip$/.test(a.name));
  const sums = assets.find((a) => /^SHA256SUMS$|^checksums\.txt$/i.test(a.name));
  if (!zip) throw new Error('最新 release 没有 windows-x86_64 资产');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cua-dl-'));
  const zipPath = path.join(tmp, zip.name);
  log(`- 下载 ${zip.name} ...`);
  await download(zip.browser_download_url, zipPath);
  let sumsPath = null;
  if (sums) { sumsPath = path.join(tmp, sums.name); await download(sums.browser_download_url, sumsPath); }
  const v = verifySums(zipPath, sumsPath);
  if (!v.ok) throw new Error('校验失败: ' + (v.reason || `期望 ${v.want} 实际 ${v.got}`));
  log('- SHA256 校验通过');
  return installCuaFromZip(zipPath, ver);
}
function createAutostart(exe) {
  const dir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  fs.mkdirSync(dir, { recursive: true });
  const vbs = path.join(dir, 'CuaDriverServe.vbs');
  const body = `CreateObject("WScript.Shell").Run """${exe}"" serve", 0, False\r\n`;
  fs.writeFileSync(vbs, body, 'utf8');
  return vbs;
}

async function main() {
  const interactive = !YES;
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = (q, def) => {
    if (!rl) return Promise.resolve(def);
    return new Promise((resolve) => rl.question(q, (a) => resolve(String(a).trim() || def)));
  };

  log(`配置目录: ${CONFIG}`);
  log(`模式: ${DRY ? '预览（不执行安装/写入）' : '执行'}`);

  const settings = readJson(SETTINGS, {});
  settings.mcpServers = settings.mcpServers || {};
  const planned = [];
  const b = bundledCua();
  const existing = findCuaExe();
  log(`\n检测：包内 cua-driver=${b ? b.version : '无'}；已安装=${existing ? installedCuaVersion(existing) : '无'}；npm=${npmRoot() ? '可用' : '不可用'}`);

  // ---- cua-driver ----
  let cuaChoice = SKIP_CUA ? 'skip' : CUA_MODE;
  if (cuaChoice === 'auto') {
    if (interactive) {
      log('\n是否安装 / 修复 cua-driver？');
      log('  1) 用包内离线版本' + (b ? `（${b.version}，无需联网）` : '（包内没有，不可用）'));
      log('  2) 联网下载最新版（GitHub 不通时会失败）');
      log('  3) 跳过（不安装、不注册）');
      log('  4) 仅注册已安装的版本');
      cuaChoice = await ask('选择 [默认 1]: ', '1');
      cuaChoice = cuaChoice === '1' ? 'offline' : cuaChoice === '2' ? 'online' : cuaChoice === '3' ? 'skip' : 'register';
    } else {
      cuaChoice = b ? 'offline' : existing ? 'register' : 'skip';
    }
  }
  let cuaExe = existing;
  if (cuaChoice === 'offline') {
    if (!b) { warn('包内没有离线 cua-driver，跳过'); }
    else if (existing && installedCuaVersion(existing) === b.version) { log(`- 已安装同版本 ${b.version}，跳过`); cuaExe = existing; }
    else {
      const v = verifySums(b.zip, b.sums);
      if (!v.ok) warn('包内 zip 校验失败: ' + (v.reason || `期望 ${v.want} 实际 ${v.got}`));
      else if (DRY) { log(`- [预览] 将释放 ${path.basename(b.zip)} 到 ${INSTALL_DIR}`); cuaExe = path.join(INSTALL_DIR, 'cua-driver.exe'); }
      else { log('- SHA256 校验通过'); cuaExe = installCuaFromZip(b.zip, b.version); }
      if (interactive && !DRY) {
        const auto = await ask('是否设置开机自启（启动文件夹 VBS 运行 cua-driver serve）？[y/N]: ', 'n');
        if (/^y/i.test(auto)) log('- 自启: ' + createAutostart(cuaExe));
      }
    }
  } else if (cuaChoice === 'online') {
    if (DRY) log('- [预览] 将查询 GitHub 最新 release 并下载校验');
    else {
      try { cuaExe = await installCuaOnline(); }
      catch (e) { warn('联网安装失败: ' + e.message + '；可改用 --cua offline'); }
    }
  } else if (cuaChoice === 'register') {
    if (!cuaExe) warn('未找到已安装的 cua-driver.exe，无法注册');
  }
  const cuaServer = 'cua-computer-use';
  const cuaLegacy = 'cua-driver';
  if (cuaChoice !== 'skip' && cuaExe && !settings.mcpServers[cuaServer] && !settings.mcpServers[cuaLegacy]) {
    settings.mcpServers[cuaServer] = { type: 'stdio', command: cuaExe, args: ['mcp'] };
    planned.push('mcpServers.' + cuaServer + ' → ' + cuaExe);
  } else if (settings.mcpServers[cuaServer] || settings.mcpServers[cuaLegacy]) log('- cua-driver 已注册（含 legacy 名），跳过重复写入');

  // ---- dbhub ----
  let dbChoice = SKIP_DBHUB ? 'skip' : DBHUB_MODE;
  if (dbChoice === 'auto') {
    if (interactive) {
      log('\n是否安装 dbhub（多库只读查询）？');
      log('  1) 联网安装最新版（npm）');
      log('  2) 用包内 tgz（仍需联网解析依赖）');
      log('  3) 跳过');
      dbChoice = await ask('选择 [默认 1]: ', '1');
      dbChoice = dbChoice === '1' ? 'online' : dbChoice === '2' ? 'tgz' : 'skip';
    } else dbChoice = 'online';
  }
  if (dbChoice !== 'skip') {
    const root = npmRoot();
    if (!root) warn('找不到 npm，跳过 dbhub');
    else {
      const entry = path.join(root, '@bytebase', 'dbhub', 'dist', 'index.js');
      if (!fs.existsSync(entry)) {
        const tgz = fs.existsSync(OFFLINE) ? fs.readdirSync(OFFLINE).find((f) => /^bytebase-dbhub-.*\.tgz$/.test(f)) : null;
        const spec = dbChoice === 'tgz' && tgz ? path.join(OFFLINE, tgz) : '@bytebase/dbhub';
        log(`- 安装 dbhub（${dbChoice === 'tgz' ? '包内 tgz' : 'npm 最新'}）...`);
        if (!DRY) {
          const npmArgs = ['install', '-g', spec, '--registry=' + REGISTRY];
          if (dbChoice === 'tgz') npmArgs.push('--prefer-offline');
          const r = cp.spawnSync('npm', npmArgs, { stdio: 'inherit', shell: WIN });
          if (r.status !== 0) warn('dbhub 安装失败：' + (dbChoice === 'tgz' ? '离线 tgz 仍需依赖，可先联网跑一次 npm cache，或改用联网安装' : '检查网络/镜像'));
        }
      } else log('- dbhub 已安装，跳过');
      if ((fs.existsSync(entry) || DRY) && !settings.mcpServers.dbhub) {
        settings.mcpServers.dbhub = { type: 'stdio', command: process.execPath, args: [entry, '--transport', 'stdio', '--config=' + path.join(CONFIG, 'dbhub.toml')] };
        planned.push('mcpServers.dbhub（stdio）');
      }
      const toml = path.join(CONFIG, 'dbhub.toml');
      if (!fs.existsSync(toml)) {
        const tpl = ['# dbhub 数据源模板：每个源只读、加超时；凭据只写本机文件', '[[sources]]', 'id = "example"', 'dsn = "mysql://user:password@127.0.0.1:3306/db"', 'lazy = true', 'connection_timeout = 10000', 'query_timeout = 30000', ''].join('\n');
        if (!DRY) fs.writeFileSync(toml, tpl, 'utf8');
        log(`- 生成 dbhub 模板: ${toml}${DRY ? '（预览）' : ''}`);
      }
    }
  }

  // ---- context7 ----
  let addContext7 = true;
  if (!settings.mcpServers.context7 && !settings.mcpServers.Context7 && interactive) {
    const a = await ask('\n是否接入 context7（HTTP 文档检索，无需安装依赖）？[Y/n]: ', 'y');
    addContext7 = /^y/i.test(a);
  }
  if (addContext7 && !settings.mcpServers.context7 && !settings.mcpServers.Context7) {
    settings.mcpServers.context7 = { type: 'http', url: 'https://mcp.context7.com/mcp' };
    planned.push('mcpServers.context7（HTTP）');
  }

  // ---- 守卫 ----
  let guardChoice = WIRE_GUARD;
  if (!WIRE_GUARD && !SKIP_CUA && interactive && cuaExe) {
    const a = await ask('\n是否接线鼠标抢占守卫（cua-cursor-guard）？[y/N]: ', 'n');
    guardChoice = /^y/i.test(a);
  }
  if (guardChoice) {
    const guard = path.join(CONFIG, 'scripts', 'cua-cursor-guard.js');
    if (!fs.existsSync(guard)) warn(`守卫脚本不存在: ${guard}（先把包内 scripts/ 复制过去）`);
    else {
      settings.hooks = settings.hooks || {};
      const matcher = 'mcp_call|mcp__cua[_-]?driver__.*|^Bash$';
      for (const evt of ['PreToolUse', 'PostToolUse']) {
        settings.hooks[evt] = settings.hooks[evt] || [];
        if (!settings.hooks[evt].some((h) => JSON.stringify(h).includes('cua-cursor-guard.js'))) {
          settings.hooks[evt].push({ matcher, hooks: [{ type: 'command', command: `"${process.execPath}" "${guard}"`, timeout: 10 }] });
          planned.push(`hooks.${evt}（cua-cursor-guard）`);
        } else log(`- hooks.${evt} 已接线，跳过`);
      }
    }
  }

  if (rl) rl.close();

  if (!planned.length) { log('\n没有需要变更的配置。'); }
  else {
    log('\n将写入:');
    for (const p of planned) log('  + ' + p);
    if (DRY) log('\n[预览] 未写入 settings.json。');
    else {
      const bak = backup(SETTINGS);
      if (bak) log('已备份: ' + bak);
      fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n', 'utf8');
      log('已写入: ' + SETTINGS);
    }
  }
  log('\n验证: 重开会话 → mcp_list 能看到工具名；dbhub 跑一条只读查询；cua-driver --version / status。');
}

main().catch((e) => { console.error('[错误] ' + e.message); process.exit(1); });
