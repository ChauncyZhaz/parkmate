#!/usr/bin/env node
/**
 * parkmate 一键部署
 *
 * 目标：别人 fork 仓库后，不用改任何代码，跑 `npm run deploy` 就能上线。
 *
 * 做的事情：
 *   1. 检查 wrangler.toml 里 PARKING_KV 的 id 是否已经是真实值
 *   2. 如果还是占位符：先找账号里同名的 KV 复用，找不到就自动创建
 *   3. 把拿到的 id 自动回填进 wrangler.toml
 *   4. 调用 wrangler deploy，并把最终 workers.dev 地址打印出来
 *
 * 用法：
 *   npm install          # 装 wrangler
 *   npx wrangler login   # 授权一次（浏览器点一下）
 *   npm run deploy
 *
 * 只想看会做什么、不真正执行：node scripts/deploy.mjs --dry-run
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOML_PATH = path.join(ROOT, 'wrangler.toml')
const BINDING = 'PARKING_KV'
const DRY_RUN = process.argv.includes('--dry-run')
const IS_WIN = process.platform === 'win32'

const ID_RE = /^[a-f0-9]{32}$/i

function log(msg = '') { console.log(msg) }
function step(msg) { console.log('\n▶ ' + msg) }
function ok(msg) { console.log('  ✓ ' + msg) }
function fail(msg) {
  console.error('\n✖ ' + msg)
  process.exit(1)
}

/* ---------------- 执行 wrangler ---------------- */

function wranglerPath() {
  const local = path.join(ROOT, 'node_modules', '.bin', IS_WIN ? 'wrangler.cmd' : 'wrangler')
  if (fs.existsSync(local)) return local
  return IS_WIN ? 'wrangler.cmd' : 'wrangler'
}

function runWrangler(args, { capture = false, allowFail = false } = {}) {
  const bin = wranglerPath()
  const cmd = IS_WIN && /[\\/]/.test(bin) ? '"' + bin + '"' : bin

  if (DRY_RUN && args[0] !== '--version') {
    log('  [dry-run] wrangler ' + args.join(' '))
    return { status: 0, stdout: '', stderr: '' }
  }

  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    shell: IS_WIN,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  })

  if (res.error) fail('调用 wrangler 失败：' + res.error.message)
  if (!allowFail && res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim()
    fail('wrangler ' + args.join(' ') + ' 执行失败' + (detail ? '：\n' + detail : ''))
  }
  return res
}

let WRANGLER_VERSION = null

function ensureWrangler() {
  const bin = wranglerPath()
  const res = spawnSync(IS_WIN && /[\\/]/.test(bin) ? '"' + bin + '"' : bin,
    ['--version'], { shell: IS_WIN, encoding: 'utf8' })

  if (res.status !== 0) {
    if (DRY_RUN) {
      log('  ! 没检测到 wrangler（dry-run 先继续）')
      return
    }
    fail('没找到 wrangler。先运行下面任意一条：\n'
      + '  npm install            # 用项目自带的依赖（推荐）\n'
      + '  npm install -g wrangler # 或装到全局')
  }

  const out = String(res.stdout || '') + String(res.stderr || '')
  const m = out.match(/(\d+)\.(\d+)\.(\d+)/)
  if (m) WRANGLER_VERSION = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
  ok('wrangler ' + (m ? m[0] : out.trim()))
}

// Wrangler 4.45+ 默认开启自动资源供应：配置里省略 id 就自动创建并绑定
function supportsAutoProvision() {
  const v = WRANGLER_VERSION
  if (!v) return false
  if (v.major > 4) return true
  return v.major === 4 && v.minor >= 45
}

/* ---------------- 读写 wrangler.toml ---------------- */

function readToml() {
  if (!fs.existsSync(TOML_PATH)) fail('找不到 wrangler.toml，请确认在项目根目录执行')
  return fs.readFileSync(TOML_PATH, 'utf8')
}

// 兼容两种写法：
//   kv_namespaces = [{ binding = "PARKING_KV", id = "..." }]
//   [[kv_namespaces]] / binding = "PARKING_KV" / id = "..."
function readKvId(toml) {
  const inline = toml.match(
    new RegExp('binding\\s*=\\s*"' + BINDING + '"\\s*,\\s*id\\s*=\\s*"([^"]*)"', 'i')
  )
  if (inline) return inline[1].trim()

  const blocks = toml.split(/\[\[kv_namespaces\]\]/i)
  for (let i = 1; i < blocks.length; i++) {
    if (new RegExp('binding\\s*=\\s*"' + BINDING + '"', 'i').test(blocks[i])) {
      const m = blocks[i].match(/id\s*=\s*"([^"]*)"/i)
      if (m) return m[1].trim()
    }
  }
  return ''
}

function writeKvId(toml, id) {
  // 1) inline 写法：{ binding = "PARKING_KV", id = "..." }
  const inlineRe = new RegExp(
    '(binding\\s*=\\s*"' + BINDING + '"\\s*,\\s*id\\s*=\\s*")[^"]*(")', 'i'
  )
  if (inlineRe.test(toml)) return toml.replace(inlineRe, '$1' + id + '$2')

  // 2) 多行写法：在 [[kv_namespaces]] 块里的 binding 行后补 id（已有则替换）
  const lines = toml.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (!new RegExp('^\\s*binding\\s*=\\s*"' + BINDING + '"', 'i').test(lines[i])) continue

    let header = ''
    for (let k = i - 1; k >= 0; k--) {
      if (/^\s*\[/.test(lines[k])) { header = lines[k]; break }
    }
    if (!/kv_namespaces/i.test(header)) continue

    let j = i + 1
    while (j < lines.length && !/^\s*\[/.test(lines[j])) {
      if (/^\s*id\s*=/i.test(lines[j])) {
        lines[j] = 'id = "' + id + '"'
        return lines.join('\n')
      }
      j++
    }
    lines.splice(i + 1, 0, 'id = "' + id + '"')
    return lines.join('\n')
  }
  return null
}

/* ---------------- KV 处理 ---------------- */

function isValidId(id) {
  return ID_RE.test(String(id || '').trim())
}

function findExistingKv() {
  const res = runWrangler(['kv', 'namespace', 'list', '--json'], { capture: true, allowFail: true })
  if (res.status !== 0 || !res.stdout) return null

  try {
    const parsed = JSON.parse(res.stdout)
    const list = Array.isArray(parsed) ? parsed : (parsed.result || [])
    const hit = list.find(item => String(item.title || '').toUpperCase().includes(BINDING))
    return hit && isValidId(hit.id) ? hit.id : null
  } catch (e) {
    return null
  }
}

function createKv() {
  const res = runWrangler(['kv', 'namespace', 'create', BINDING, '--json'], { capture: true, allowFail: true })

  const raw = (res.stdout || '') + '\n' + (res.stderr || '')
  try {
    const parsed = JSON.parse(res.stdout || '')
    const id = parsed.id || (Array.isArray(parsed) ? parsed[0] && parsed[0].id : '')
    if (isValidId(id)) return id.trim()
  } catch (e) { /* 老版本没有 --json，走下面的正则 */ }

  const m = raw.match(/[a-f0-9]{32}/i)
  if (m) return m[0]

  fail('创建 KV 失败，请确认已经登录：npx wrangler login\n' + raw.trim())
}

/* ---------------- 主流程 ---------------- */

async function main() {
  log('')
  log('  🅿️  parkmate — 车位临时借用系统')
  log('  ─────────────────────────────────')

  ensureWrangler()

  step('检查 KV 绑定')
  let toml = readToml()
  let kvId = readKvId(toml)

  if (isValidId(kvId)) {
    ok('已绑定 PARKING_KV：' + kvId.slice(0, 8) + '…')
  } else if (supportsAutoProvision()) {
    // 首选：交给 Wrangler 自动供应（官方推荐做法，fork 后零配置）
    ok('wrangler 支持自动供应，部署时会自动创建并绑定 KV')
    log('  → 不需要手动建 namespace，首次部署后 Cloudflare 会记住这个绑定')
  } else {
    // 兜底：老版本 wrangler 没有自动供应，手动建一次再回填
    if (kvId) log('  ! wrangler.toml 里的 id 不合法（' + kvId + '），继续自动处理')
    log('  → wrangler 版本较老，手动处理 KV 绑定')

    if (DRY_RUN) {
      log('  [dry-run] 会执行：wrangler kv namespace list --json（找同名 KV）')
      log('  [dry-run] 没有则：wrangler kv namespace create ' + BINDING)
      log('  [dry-run] 把 id 回填到 wrangler.toml')
      log('  [dry-run] 最后：wrangler deploy')
      log('\n  （dry-run 结束，未做任何修改）\n')
      return
    }

    kvId = findExistingKv()
    if (kvId) {
      ok('复用账号里已有的 KV：' + kvId.slice(0, 8) + '…')
    } else {
      log('  → 创建新的 KV namespace：' + BINDING)
      kvId = createKv()
      ok('创建成功：' + kvId)
    }

    const nextToml = writeKvId(toml, kvId)
    if (!nextToml) fail('没能把 id 写进 wrangler.toml，请手动把 id 填到 PARKING_KV 那一行')
    fs.writeFileSync(TOML_PATH, nextToml, 'utf8')
    ok('已回填到 wrangler.toml')
  }

  step('部署到 Cloudflare Workers')
  const res = runWrangler(['deploy'], { capture: true })
  const out = (res.stdout || '') + (res.stderr || '')
  process.stdout.write(out)

  if (res.status !== 0) fail('部署失败，请看上面的 wrangler 输出')

  const urlMatch = out.match(/https:\/\/[^\s"'<>]+\.workers\.dev/i)
  log('')
  log('  ✅ 部署完成')
  if (urlMatch) {
    const base = urlMatch[0].replace(/\/+$/, '')
    log('  站点首页：' + base + '/')
    log('  车主台：  ' + base + '/owner')
    log('  打印告示：' + base + '/poster?spot=B2-078')
  } else {
    log('  地址见上方 wrangler 输出（通常是 https://<名字>.<子域>.workers.dev）')
  }
  log('')
  log('  下一步：想收到推送的话，去 Cloudflare 后台')
  log('  Worker → Settings → Variables 里加 BARK_URL / PUSHPLUS_TOKEN / WXPUSHER_TOKEN')
  log('')
}

main().catch(err => fail(err && err.message ? err.message : String(err)))
