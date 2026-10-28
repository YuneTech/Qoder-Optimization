#!/usr/bin/env node
/**
 * 职责：tmp-sweeper.js 的自测——每条判据都要能失败，且**含"不该触发的对照组必绿"**。
 * 依赖：node。用法：`node tmp-sweeper.test.js`（退 0 = 全绿）。
 *
 * <p>为什么要有对照组：清理类脚本最容易犯的错不是漏检，而是**误删**。
 * 只测"超期的被列出来"，一个"把所有文件都列出来"的实现也能全绿。
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const sweeper = require('./tmp-sweeper.js')

let pass = 0
let fail = 0
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-work-test-'))

function touch(file, ageDays, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text === undefined ? 'x' : text)
  const t = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
  fs.utimesSync(file, t, t)
  return file
}

function listed(files) {
  const out = []
  sweeper.walk(root, out)
  const set = new Set(out.map((f) => path.relative(root, f.path).replace(/\\/g, '/')))
  return files.map((f) => set.has(f))
}

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass += 1
    process.stdout.write(`  PASS  ${name}\n`)
  } else {
    fail += 1
    process.stdout.write(`  FAIL  ${name}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}\n`)
  }
}

const staleImg = touch(path.join(root, 'shot-old.png'), 5)
const freshImg = touch(path.join(root, 'shot-new.png'), 0)
const staleScript = touch(path.join(root, 'probe-old.cjs'), 16)
const freshScript = touch(path.join(root, 'probe-new.cjs'), 1)
const oddExt = touch(path.join(root, 'data-xyzzy.qdx'), 40)
const nestedStale = touch(path.join(root, 'sub/old-log.log'), 4)
// 宿主会话目录形状：即使躺在临时根里、即使超期，也绝不能被列、更不能被删
const hostDirName = 'qoder-AB12CD34-cwd'
const hostStale = touch(path.join(root, hostDirName, 'inside.png'), 90)

check('超期图片被列出', listed(['shot-old.png']), [true])
check('新鲜图片不被列（对照组，防"全列"式误删）', listed(['shot-new.png']), [false])
check('超期脚本被列出', listed(['probe-old.cjs']), [true])
check('15 天内的脚本不被列（脚本阈值比图片宽）', listed(['probe-new.cjs']), [false])
check('未知扩展名一律不碰', listed(['data-xyzzy.qdx']), [false])
check('子目录里的超期件也能扫到', listed(['sub/old-log.log']), [true])
check('qoder-*-cwd 里的超期件不被列（硬否决）', listed([`${hostDirName}/inside.png`]), [false])
check('isHostSessionDir 认得这个形状', [
  sweeper.isHostSessionDir(path.join(os.tmpdir(), 'qoder-AB12CD34-cwd')),
  sweeper.isHostSessionDir(path.join(os.tmpdir(), 'qoder-work')),
], [true, false])

// --apply：删该删的、留该留的
const rc = sweeper.main(['--root', root, '--apply', '--json'])
const stillThere = (f) => fs.existsSync(f)
check('--apply 退出码 0', rc, 0)
check('--apply 真的删掉了超期图片', stillThere(staleImg), false)
check('--apply 真的删掉了超期脚本', stillThere(staleScript), false)
check('--apply 真的删掉了子目录超期日志', stillThere(nestedStale), false)
check('--apply 没碰新鲜图片', stillThere(freshImg), true)
check('--apply 没碰 15 天内的脚本', stillThere(freshScript), true)
check('--apply 没碰未知扩展名', stillThere(oddExt), true)
check('--apply 没碰宿主会话目录里的文件', stillThere(hostStale), true)

// 把宿主会话目录本身当 --root 传进来，也必须被拒
check('显式 --root 指到宿主会话目录也会被拒',
  sweeper.isHostSessionDir(path.join(root, hostDirName)), true)

fs.rmSync(root, { recursive: true, force: true })
process.stdout.write(`\n=== tmp-sweeper 自测：通过 ${pass}，失败 ${fail} ===\n`)
process.exit(fail === 0 ? 0 : 1)
