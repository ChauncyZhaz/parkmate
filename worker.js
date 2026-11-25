/**
 * 车位临时借用通知系统 —— 单文件 Cloudflare Worker
 *
 * 场景：把二维码贴在私家车位的柱子/墙面上。路人想临时占一下，
 *      扫码 → 选时长 / 填原因 / 留电话 → 车主收到推送 →
 *      车主点"同意 / 不同意 / 回一句" → 申请人页面实时看到结果与倒计时。
 *
 * 路由：
 *   GET  /                          申请人页面（扫码进入，可带 ?spot=A-012 区分车位）
 *   GET  /owner                     车主控制台（不带 sid 时列出待处理申请）
 *   GET  /owner?sid=xxx             车主处理单条申请
 *   GET  /poster?spot=A-012         可直接打印的告示页（含二维码）
 *   POST /api/apply                 提交借用申请
 *   GET  /api/status?sid=           申请人轮询状态（不返回手机号）
 *   POST /api/release               申请人/车主主动结束占用
 *   GET  /api/owner-phone?sid=      申请人取车主电话（需会话有效）
 *   GET  /api/owner/app?sid=        车主读取申请详情（含联系电话）
 *   GET  /api/owner/list            车主读取待处理/进行中的申请列表
 *   POST /api/owner/decision        车主同意 / 不同意
 *   POST /api/owner/reply           车主追加留言
 *
 * 绑定：
 *   KV 命名空间：PARKING_KV（若没建，会退化为复用旧的 MOVE_CAR_STATUS，方便同号部署）
 * 环境变量：
 *   SPOT_NAME        车位名称/编号，默认「私家车位」
 *   SPOT_NOTE        给访客的一句说明
 *   OWNER_PHONE      车主电话（可选，仅用于"联系车主"按钮，不写进页面源码）
 *   BARK_URL / PUSHPLUS_TOKEN / PUSHPLUS_TOPIC / WXPUSHER_TOKEN / WXPUSHER_UIDS / WXPUSHER_TOPIC_IDS
 *
 * 与原挪车项目的差异（重要）：
 *   [1] 状态机从"等待/已确认"扩展为 pending → approved / declined / expired / overdue / ended
 *   [2] 同意时写入 expireAt 与 cur:{spot}，车位同一时刻只认一条生效许可
 *   [3] 新增"我已驶离"释放动作，车主不用等到期才能腾出车位
 *   [4] 手机号只在车主接口返回明文，申请人页面源码与状态接口都拿不到
 */

addEventListener('fetch', event => {
  event.respondWith(
    handleRequest(event).catch(err => json({ success: false, error: msgOf(err) }, 500))
  )
})

const CONFIG = {
  APP_TTL: 4 * 3600,             // 申请记录保留 4 小时
  STATE_TTL: 4 * 3600,
  PENDING_TTL_MS: 15 * 60000,    // 待处理申请 15 分钟没人管就失效，避免车主看到过期请求
  MAX_MINUTES: 480,              // 单次最长 8 小时
  MIN_MINUTES: 15,
  RATE_LIMIT_PER_MIN: 3,         // 单 IP 每分钟最多提交几次申请
  MAX_MESSAGES: 20,
  MAX_ACTIVE_LIST: 30,           // 车主列表最多扫多少个 key
}

const DURATION_PRESETS = [30, 60, 120, 240]

const DEFAULT_REASON = '临时停一下'

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handleRequest(event) {
  const request = event.request
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method

  if (method === 'POST') {
    if (path === '/api/apply') return handleApply(request, url, event)
    if (path === '/api/release') return handleRelease(request)
    if (path === '/api/owner/decision') return handleOwnerDecision(request, url)
    if (path === '/api/owner/reply') return handleOwnerReply(request)
    return json({ success: false, error: 'not found' }, 404)
  }

  if (path === '/api/status') return handleStatus(url)
  if (path === '/api/owner-phone') return handleOwnerPhone(url)
  if (path === '/api/owner/app') return handleOwnerApp(url)
  if (path === '/api/owner/list') return handleOwnerList(url)

  if (path === '/qr') return handleQr(url)

  if (path === '/owner') return renderOwnerPage()
  if (path === '/poster') return renderPosterPage(url)

  return renderApplyPage(url)
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

const NO_STORE = { 'Cache-Control': 'no-store' }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', ...NO_STORE },
  })
}

function html(body) {
  return new Response(body, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8', ...NO_STORE },
  })
}

function msgOf(err) {
  return (err && err.message) ? err.message : String(err)
}

function escapeHtml(input) {
  return String(input == null ? '' : input).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function genSid() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().replace(/-/g, '')
    }
  } catch (e) { /* 老 compat date 兜底 */ }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

// 只接受安全字符，避免构造任意 KV key
function sanitizeSid(value) {
  if (typeof value !== 'string') return ''
  const sid = value.trim()
  return /^[A-Za-z0-9_-]{8,64}$/.test(sid) ? sid : ''
}

function sanitizeSpot(value) {
  const s = String(value == null ? '' : value).trim()
  const cleaned = s.replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 20)
  return cleaned
}

function spotName(spot) {
  if (spot) return spot
  if (typeof SPOT_NAME !== 'undefined' && SPOT_NAME) return String(SPOT_NAME)
  return '私家车位'
}

function spotNote() {
  if (typeof SPOT_NOTE !== 'undefined' && SPOT_NOTE) return String(SPOT_NOTE)
  return '本车位为私家车位，可临时借用，请先申请并留下联系方式'
}

function formatMinutes(min) {
  const m = Math.max(0, Math.round(Number(min) || 0))
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (!h) return rest + ' 分钟'
  if (!rest) return h + ' 小时'
  return h + ' 小时 ' + rest + ' 分钟'
}

// 时间统一按东八区展示，Worker 默认跑在 UTC
function fmtHM(ts) {
  const t = Number(ts)
  if (!t) return ''
  const d = new Date(t + 8 * 3600 * 1000)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return hh + ':' + mm
}

function normalizePlate(raw) {
  const s = String(raw == null ? '' : raw).toUpperCase().replace(/[^\u4e00-\u9fa5A-Z0-9]/g, '')
  return s.slice(0, 10)
}

function isPhone(raw) {
  return /^1[3-9]\d{9}$/.test(String(raw == null ? '' : raw).trim())
}

function maskPhone(phone) {
  const s = String(phone || '')
  if (s.length >= 10) return s.slice(0, 3) + '****' + s.slice(-4)
  return s || '联系电话'
}

function kv() {
  if (typeof PARKING_KV !== 'undefined' && PARKING_KV) return PARKING_KV
  if (typeof MOVE_CAR_STATUS !== 'undefined' && MOVE_CAR_STATUS) return MOVE_CAR_STATUS
  throw new Error('未绑定 KV 命名空间：请创建 PARKING_KV 并绑定到 PARKING_KV')
}

const K = {
  app: sid => 'papp:' + sid,
  state: sid => 'pst:' + sid,
  msgs: sid => 'pmsg:' + sid,
  cur: spot => 'pcur:' + (spot || '_'),
  rl: (ip, bucket) => 'prl:' + ip + ':' + bucket,
}

async function readJson(key) {
  const raw = await kv().get(key)
  if (!raw) return null
  try { return JSON.parse(raw) } catch (e) { return null }
}

async function writeJson(key, value, ttl) {
  await kv().put(key, JSON.stringify(value), { expirationTtl: ttl })
}

/* ------------------------------------------------------------------ */
/* 占用状态                                                            */
/* ------------------------------------------------------------------ */

// 当前生效的占用（车位同一时刻只认一条）。已过期的直接当没有。
async function readCurrent(spot) {
  const cur = await readJson(K.cur(spot))
  if (!cur || !cur.expireAt) return null
  if (Date.now() > Number(cur.expireAt)) return null
  return cur
}

// 根据 state + 时间算出对外展示的状态
function resolveStatus(state) {
  if (!state || !state.status) return 'expired'
  const now = Date.now()

  if (state.status === 'pending') {
    if (state.createdAt && now - Number(state.createdAt) > CONFIG.PENDING_TTL_MS) return 'expired'
    return 'pending'
  }
  if (state.status === 'approved') {
    if (state.expireAt && now > Number(state.expireAt)) return 'overdue'
    return 'approved'
  }
  return state.status
}

/* ------------------------------------------------------------------ */
/* 二维码（内置生成，不依赖任何外部接口）                              */
/* 只做 byte 模式 + 纠错等级 M + 版本 1~10，足够装下一个网址           */
/* ------------------------------------------------------------------ */

const QR_EC_M = [
  null,
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
]

const QR_ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]

function qrDataCodewords(version) {
  let n = 0
  for (const [count, len] of QR_EC_M[version].groups) n += count * len
  return n
}

function qrMul(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xFF
}

function qrRsDivisor(degree) {
  const result = new Array(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = qrMul(result[j], root)
      if (j + 1 < degree) result[j] ^= result[j + 1]
    }
    root = qrMul(root, 0x02)
  }
  return result
}

function qrRsRemainder(data, degree) {
  const divisor = qrRsDivisor(degree)
  const result = new Array(degree).fill(0)
  for (const b of data) {
    const factor = b ^ result.shift()
    result.push(0)
    for (let i = 0; i < degree; i++) result[i] ^= qrMul(divisor[i], factor)
  }
  return result
}

function qrMaskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5: return (x * y) % 2 + (x * y) % 3 === 0
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0
    default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0
  }
}

// 手写 UTF-8 编码，避免依赖运行时是否提供 TextEncoder
function utf8Bytes(str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i)
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1)
      if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
        c = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00)
        i++
      }
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

// 返回 boolean 矩阵（true = 黑），编码失败返回 null
function qrMatrix(text) {
  const bytes = utf8Bytes(String(text))
  if (!bytes.length) return null

  let version = 0
  for (let v = 1; v <= 10; v++) {
    const cap = qrDataCodewords(v) - (v >= 10 ? 3 : 2)
    if (bytes.length <= cap) { version = v; break }
  }
  if (!version) return null

  const size = version * 4 + 17
  const bits = []
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1) }

  push(0b0100, 4)
  push(bytes.length, version >= 10 ? 16 : 8)
  for (const b of bytes) push(b, 8)

  const capacityBits = qrDataCodewords(version) * 8
  const term = Math.min(4, capacityBits - bits.length)
  for (let i = 0; i < term; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)

  const dataCw = []
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]
    dataCw.push(v)
  }
  let pad = 0
  while (dataCw.length < qrDataCodewords(version)) {
    dataCw.push(pad % 2 === 0 ? 0xEC : 0x11)
    pad++
  }

  // 分块 + RS 纠错 + 交错
  const spec = QR_EC_M[version]
  const blocks = []
  let offset = 0
  for (const [count, len] of spec.groups) {
    for (let i = 0; i < count; i++) {
      const d = dataCw.slice(offset, offset + len)
      offset += len
      blocks.push({ data: d, ec: qrRsRemainder(d, spec.ec) })
    }
  }
  const codewords = []
  const maxLen = Math.max.apply(null, blocks.map(b => b.data.length))
  for (let i = 0; i < maxLen; i++) {
    for (const b of blocks) if (i < b.data.length) codewords.push(b.data[i])
  }
  for (let i = 0; i < spec.ec; i++) {
    for (const b of blocks) codewords.push(b.ec[i])
  }

  // 画功能图形
  const modules = []
  const isFunc = []
  for (let y = 0; y < size; y++) {
    modules.push(new Array(size).fill(false))
    isFunc.push(new Array(size).fill(false))
  }
  const set = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    modules[y][x] = !!dark
    isFunc[y][x] = true
  }

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }

  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        set(cx + dx, cy + dy, dist !== 2 && dist !== 4)
      }
    }
  }

  const align = QR_ALIGN[version]
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      }
    }
  }

  // 版本信息（v7+）
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25)
    const vbits = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const bit = ((vbits >>> i) & 1) === 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      set(a, b, bit)
      set(b, a, bit)
    }
  }

  // 预留格式信息区，避免数据写进去
  const reserveFormat = () => {
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) { set(8, i, false); set(i, 8, false) }
    }
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, false)
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, false)
    set(8, size - 8, true)
  }
  reserveFormat()

  // 数据填充（右下角起的之字形）
  const total = codewords.length * 8
  let idx = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!isFunc[y][x] && idx < total) {
          modules[y][x] = ((codewords[idx >> 3] >>> (7 - (idx & 7))) & 1) === 1
          idx++
        }
      }
    }
  }

  // 选掩码
  const penalty = grid => {
    let score = 0
    for (let y = 0; y < size; y++) {
      let run = 1
      for (let x = 1; x < size; x++) {
        if (grid[y][x] === grid[y][x - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score++ }
        else run = 1
      }
    }
    for (let x = 0; x < size; x++) {
      let run = 1
      for (let y = 1; y < size; y++) {
        if (grid[y][x] === grid[y - 1][x]) { run++; if (run === 5) score += 3; else if (run > 5) score++ }
        else run = 1
      }
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = grid[y][x]
        if (c === grid[y][x + 1] && c === grid[y + 1][x] && c === grid[y + 1][x + 1]) score += 3
      }
    }
    let dark = 0
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (grid[y][x]) dark++
    const pct = (dark * 100) / (size * size)
    score += Math.floor(Math.abs(pct - 50) / 5) * 10
    return score
  }

  const applyMask = (mask, target) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunc[y][x] && qrMaskBit(mask, x, y)) target[y][x] = !target[y][x]
      }
    }
  }

  let best = 0
  let bestScore = Infinity
  for (let m = 0; m < 8; m++) {
    const trial = modules.map(row => row.slice())
    applyMask(m, trial)
    const s = penalty(trial)
    if (s < bestScore) { bestScore = s; best = m }
  }
  applyMask(best, modules)

  // 写格式信息（纠错等级 M 的指示位为 00）
  let data = (0 << 3) | best
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const fbits = ((data << 10) | rem) ^ 0x5412
  const fbit = i => ((fbits >>> i) & 1) === 1

  for (let i = 0; i <= 5; i++) set(8, i, fbit(i))
  set(8, 7, fbit(6))
  set(8, 8, fbit(7))
  set(7, 8, fbit(8))
  for (let i = 9; i < 15; i++) set(14 - i, 8, fbit(i))
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, fbit(i))
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, fbit(i))
  set(8, size - 8, true)

  return modules
}

function qrSvg(text, px) {
  const m = qrMatrix(text)
  if (!m) return null
  const n = m.length
  const quiet = 4
  const total = n + quiet * 2
  // 按整数倍放大，保证每个格子像素对齐，屏幕上不会出现半像素错位
  const scale = Math.max(2, Math.floor((px || 420) / total))
  const dim = total * scale
  let path = ''
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (m[y][x]) path += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z'
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '"'
    + ' shape-rendering="crispEdges" width="' + dim + '" height="' + dim + '">'
    + '<rect width="' + total + '" height="' + total + '" fill="#ffffff"/>'
    + '<path d="' + path + '" fill="#000000"/></svg>'
}

/* ------------------------------------------------------------------ */
/* 限流                                                                */
/* ------------------------------------------------------------------ */

async function allowRequest(ip) {
  try {
    const bucket = Math.floor(Date.now() / 60000)
    const key = K.rl(ip, bucket)
    const current = parseInt((await kv().get(key)) || '0', 10)
    if (current >= CONFIG.RATE_LIMIT_PER_MIN) return false
    await kv().put(key, String(current + 1), { expirationTtl: 180 })
    return true
  } catch (e) {
    // 限流自身异常时放行，别把正常请求挡死
    console.error('限流检查异常', msgOf(e))
    return true
  }
}

/* ------------------------------------------------------------------ */
/* 推送渠道                                                            */
/* ------------------------------------------------------------------ */

async function sendBark(text, title, linkUrl) {
  try {
    const base = String(BARK_URL).replace(/\/+$/, '')
    const target = base + '/' + encodeURIComponent(title) + '/' + encodeURIComponent(text)
      + '?group=Parking&level=active&sound=minuet&call=0'
      + (linkUrl ? '&url=' + encodeURIComponent(linkUrl) : '')
    const res = await fetch(target)
    if (!res.ok) return { ok: false, channel: 'bark', reason: 'HTTP ' + res.status }
    const data = await res.json().catch(() => null)
    if (data && data.code !== undefined && Number(data.code) !== 200) {
      return { ok: false, channel: 'bark', reason: data.message || data.code }
    }
    return { ok: true, channel: 'bark' }
  } catch (e) {
    return { ok: false, channel: 'bark', reason: msgOf(e) }
  }
}

async function sendPushPlus(title, htmlContent, topic) {
  try {
    const body = { token: PUSHPLUS_TOKEN, title, content: htmlContent, template: 'html' }
    if (topic) body.topic = topic
    const res = await fetch('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return { ok: false, channel: 'pushplus', reason: 'HTTP ' + res.status }
    const data = await res.json().catch(() => ({}))
    if (data && (data.code === 200 || data.code === '200')) return { ok: true, channel: 'pushplus' }
    return { ok: false, channel: 'pushplus', reason: (data && data.msg) || 'unknown' }
  } catch (e) {
    return { ok: false, channel: 'pushplus', reason: msgOf(e) }
  }
}

// contentType 必须为 2（HTML），否则 <a> 不会渲染
async function sendWxPusher(htmlContent, uids, topicIds) {
  try {
    const res = await fetch('https://wxpusher.zjiecode.com/api/send/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appToken: WXPUSHER_TOKEN,
        content: htmlContent,
        contentType: 2,
        uids,
        topicIds,
      }),
    })
    if (!res.ok) return { ok: false, channel: 'wxpusher', reason: 'HTTP ' + res.status }
    const data = await res.json().catch(() => ({}))
    if (data && data.code === 1000) return { ok: true, channel: 'wxpusher' }
    return { ok: false, channel: 'wxpusher', reason: (data && data.msg) || 'unknown' }
  } catch (e) {
    return { ok: false, channel: 'wxpusher', reason: msgOf(e) }
  }
}

function toList(value) {
  if (!value) return []
  return Array.isArray(value) ? value : String(value).split(',').map(s => s.trim()).filter(Boolean)
}

// 并发发出所有已配置渠道，任一成功即成功
async function pushAll({ title, text, htmlBody, linkUrl }) {
  const tasks = []

  if (typeof BARK_URL !== 'undefined' && BARK_URL) {
    tasks.push(sendBark(text, title, linkUrl))
  }
  if (typeof PUSHPLUS_TOKEN !== 'undefined' && PUSHPLUS_TOKEN) {
    const topic = (typeof PUSHPLUS_TOPIC !== 'undefined' && PUSHPLUS_TOPIC) ? PUSHPLUS_TOPIC : ''
    tasks.push(sendPushPlus(title, htmlBody, topic))
  }
  if (typeof WXPUSHER_TOKEN !== 'undefined' && WXPUSHER_TOKEN) {
    const uids = (typeof WXPUSHER_UIDS !== 'undefined') ? toList(WXPUSHER_UIDS) : []
    const topicIds = (typeof WXPUSHER_TOPIC_IDS !== 'undefined') ? toList(WXPUSHER_TOPIC_IDS) : []
    tasks.push(sendWxPusher(htmlBody, uids, topicIds))
  }

  if (!tasks.length) return { sent: false, error: '未配置任何通知渠道' }

  const results = await Promise.allSettled(tasks)
  let sent = false
  for (const item of results) {
    if (item.status === 'fulfilled') {
      if (item.value && item.value.ok) sent = true
      else console.error('推送失败', item.value && item.value.channel, item.value && item.value.reason)
    } else {
      console.error('推送异常', msgOf(item.reason))
    }
  }
  return { sent }
}

/* ------------------------------------------------------------------ */
/* 通知模板                                                            */
/* ------------------------------------------------------------------ */

function buildApplyPush(app, ownerUrl) {
  const lines = []
  lines.push('🅿️ ' + spotName(app.spot) + ' 借用申请')
  lines.push('⏱ 希望占用 ' + formatMinutes(app.minutes))
  if (app.plate) lines.push('🚙 车牌 ' + app.plate)
  lines.push('📝 原因 ' + app.reason)
  lines.push('📞 ' + maskPhone(app.phone))
  lines.push('🕒 申请时间 ' + fmtHM(app.createdAt))
  if (app.note) lines.push('💬 补充：' + app.note)

  const text = lines.join('\n')
  let body = '🅿️ <b>' + escapeHtml(spotName(app.spot)) + ' 借用申请</b>'
  body += '<br>⏱ 希望占用 ' + escapeHtml(formatMinutes(app.minutes))
  if (app.plate) body += '<br>🚙 车牌 ' + escapeHtml(app.plate)
  body += '<br>📝 原因 ' + escapeHtml(app.reason)
  body += '<br>📞 ' + escapeHtml(maskPhone(app.phone))
  body += '<br>🕒 申请时间 ' + escapeHtml(fmtHM(app.createdAt))
  if (app.note) body += '<br>💬 补充：' + escapeHtml(app.note)
  body += '<br><br><a href="' + escapeHtml(ownerUrl) + '">👉 点此同意 / 拒绝</a>'

  return { title: '车位借用申请', text, htmlBody: body, linkUrl: ownerUrl }
}

function buildReplyPush(app, text, ownerUrl) {
  const title = '车位借用申请有新回复'
  const plain = '💬 ' + spotName(app.spot) + '：' + text
  const body = '💬 <b>车位申请有新回复</b><br>' + escapeHtml(text)
    + '<br><br><a href="' + escapeHtml(ownerUrl) + '">👉 查看并处理</a>'
  return { title, text: plain, htmlBody: body, linkUrl: ownerUrl }
}

/* ------------------------------------------------------------------ */
/* API：申请人                                                         */
/* ------------------------------------------------------------------ */

async function handleApply(request, url, event) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'

  let body = {}
  try { body = await request.json() } catch (e) { body = {} }

  const spot = sanitizeSpot(body.spot)
  const minutes = Math.round(Number(body.minutes))
  const plate = normalizePlate(body.plate)
  const phone = String(body.phone == null ? '' : body.phone).trim()
  const reason = String(body.reason == null ? '' : body.reason).trim().slice(0, 40) || DEFAULT_REASON
  const note = String(body.note == null ? '' : body.note).trim().slice(0, 120)
  const force = body.force === true

  if (!Number.isFinite(minutes) || minutes < CONFIG.MIN_MINUTES || minutes > CONFIG.MAX_MINUTES) {
    return json({ success: false, error: '占用时长请填 ' + CONFIG.MIN_MINUTES + ' 分钟到 ' + formatMinutes(CONFIG.MAX_MINUTES) }, 400)
  }
  if (!isPhone(phone)) {
    return json({ success: false, error: '请填写正确的 11 位手机号，便于车主联系你' }, 400)
  }

  // 车位正被占用时，先让申请人知道，再由他决定是否继续（force）
  if (!force) {
    const cur = await readCurrent(spot)
    if (cur) {
      return json({
        success: false,
        occupied: true,
        error: '车位正在被占用，预计 ' + fmtHM(cur.expireAt) + ' 释放',
        until: cur.expireAt,
        remainMin: Math.max(1, Math.round((Number(cur.expireAt) - Date.now()) / 60000)),
      }, 409)
    }
  }

  if (!(await allowRequest(ip))) {
    return json({ success: false, error: '提交太频繁了，请稍等一分钟再试' }, 429)
  }

  const sid = genSid()
  const now = Date.now()
  const app = {
    sid, spot, plate, phone, reason, note,
    minutes,
    createdAt: now,
    ip,
  }

  await writeJson(K.app(sid), app, CONFIG.APP_TTL)
  await writeJson(K.state(sid), {
    status: 'pending',
    createdAt: now,
    minutes,
  }, CONFIG.STATE_TTL)

  const ownerUrl = url.origin + '/owner?sid=' + encodeURIComponent(sid)
  const result = await pushAll(buildApplyPush(app, ownerUrl))

  // 推送失败不销毁申请：车主仍可能在列表里看到，申请人也能等待
  return json({
    success: true,
    sid,
    pushed: result.sent,
    pushError: result.sent ? null : (result.error || '通知未送达，但申请已记录'),
    minutes,
  })
}

async function handleStatus(url) {
  const sid = sanitizeSid(url.searchParams.get('sid'))
  if (!sid) return json({ status: 'expired', messages: [] })

  const [app, state, msgs] = await Promise.all([
    readJson(K.app(sid)),
    readJson(K.state(sid)),
    readJson(K.msgs(sid)),
  ])

  // 申请记录过期后，state 可能还在，统一按失效处理
  if (!app) return json({ status: 'expired', messages: [] })

  const messages = Array.isArray(msgs) ? msgs : []
  const status = resolveStatus(state)

  return json({
    status,
    spot: app.spot,
    minutes: app.minutes,
    reason: app.reason,
    plate: app.plate,
    createdAt: app.createdAt,
    grantedMin: state && state.grantedMin ? state.grantedMin : null,
    decidedAt: state && state.decidedAt ? state.decidedAt : null,
    expireAt: state && state.expireAt ? state.expireAt : null,
    ownerReply: state && state.ownerReply ? state.ownerReply : null,
    messages,
    serverTime: Date.now(),
  })
}

// 申请人主动释放：车位空出来了，车主也该知道
async function handleRelease(request) {
  let body = {}
  try { body = await request.json() } catch (e) { body = {} }

  const sid = sanitizeSid(body.sid)
  if (!sid) return json({ success: false, error: 'missing sid' }, 400)

  const app = await readJson(K.app(sid))
  const state = await readJson(K.state(sid))
  if (!app || !state) return json({ success: false, error: '申请已失效' }, 404)

  const status = resolveStatus(state)
  if (status === 'ended' || status === 'declined' || status === 'expired') {
    return json({ success: true, status })
  }

  await writeJson(K.state(sid), {
    ...state,
    status: 'ended',
    endedAt: Date.now(),
    endedBy: body.by === 'owner' ? 'owner' : 'visitor',
  }, CONFIG.STATE_TTL)

  const cur = await readCurrent(app.spot)
  if (cur && cur.sid === sid) {
    await kv().delete(K.cur(app.spot))
  }

  // 车主自己结束的就不用再通知自己了
  if (body.by !== 'owner' && body.notify === true) {
    const ownerUrl = new URL(request.url).origin + '/owner?sid=' + encodeURIComponent(sid)
    await pushAll({
      title: '车位已释放',
      text: '✅ ' + spotName(app.spot) + '：对方表示已驶离（' + (app.plate || '未填车牌') + '）',
      htmlBody: '✅ <b>' + escapeHtml(spotName(app.spot)) + ' 已释放</b><br>'
        + escapeHtml(app.plate || '未填车牌') + ' 表示已驶离，车位空出来了。'
        + '<br><br><a href="' + escapeHtml(ownerUrl) + '">👉 查看记录</a>',
      linkUrl: ownerUrl,
    })
  }

  return json({ success: true, status: 'ended' })
}

async function handleOwnerPhone(url) {
  const sid = sanitizeSid(url.searchParams.get('sid'))
  if (!sid) return json({ error: 'missing sid' }, 400)

  // 会话必须真实存在过，避免任何人访问首页就能换到号码
  const state = await readJson(K.state(sid))
  if (!state) return json({ error: '会话已失效，请重新提交申请' }, 403)

  if (typeof OWNER_PHONE === 'undefined' || !OWNER_PHONE) {
    return json({ error: '车主未配置电话号码' }, 404)
  }

  try {
    const quotaKey = 'pph:' + sid
    const used = parseInt((await kv().get(quotaKey)) || '0', 10)
    if (used >= 5) return json({ error: '获取次数过多，请稍后再试' }, 429)
    await kv().put(quotaKey, String(used + 1), { expirationTtl: CONFIG.STATE_TTL })
  } catch (e) {
    console.error('号码配额计数异常', msgOf(e))
  }

  return json({ tel: String(OWNER_PHONE), mask: maskPhone(OWNER_PHONE) })
}

/* ------------------------------------------------------------------ */
/* API：车主                                                           */
/* ------------------------------------------------------------------ */

async function handleOwnerApp(url) {
  const sid = sanitizeSid(url.searchParams.get('sid'))
  if (!sid) return json({ success: false, error: 'missing sid' }, 400)

  const [app, state, msgs] = await Promise.all([
    readJson(K.app(sid)),
    readJson(K.state(sid)),
    readJson(K.msgs(sid)),
  ])
  if (!app) return json({ success: false, error: '申请已过期' }, 404)

  const status = resolveStatus(state)
  return json({
    success: true,
    app,
    status,
    grantedMin: state && state.grantedMin ? state.grantedMin : null,
    expireAt: state && state.expireAt ? state.expireAt : null,
    decidedAt: state && state.decidedAt ? state.decidedAt : null,
    ownerReply: state && state.ownerReply ? state.ownerReply : null,
    messages: Array.isArray(msgs) ? msgs : [],
    serverTime: Date.now(),
  })
}

async function handleOwnerList(url) {
  const spot = sanitizeSpot(url.searchParams.get('spot') || '')

  let keys = []
  try {
    const prefix = 'papp:'
    const listed = await kv().list({ prefix, limit: CONFIG.MAX_ACTIVE_LIST })
    keys = (listed && listed.keys) ? listed.keys.map(k => k.name) : []
  } catch (e) {
    console.error('列表读取失败', msgOf(e))
    return json({ success: false, error: '列表读取失败' }, 500)
  }

  const items = await Promise.all(keys.map(async name => {
    const sid = name.slice('papp:'.length)
    const [app, state] = await Promise.all([readJson(name), readJson(K.state(sid))])
    if (!app || !state) return null
    if (spot && app.spot !== spot) return null
    const status = resolveStatus(state)
    if (status === 'expired' || status === 'ended') return null
    return {
      sid: sid,
      spot: app.spot,
      plate: app.plate,
      minutes: app.minutes,
      reason: app.reason,
      createdAt: app.createdAt,
      status,
      expireAt: state.expireAt || null,
    }
  }))

  const list = items.filter(Boolean).sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
  return json({ success: true, items: list })
}

async function handleOwnerDecision(request, url) {
  let body = {}
  try { body = await request.json() } catch (e) { body = {} }

  const sid = sanitizeSid(body.sid) || sanitizeSid(url.searchParams.get('sid'))
  if (!sid) return json({ success: false, error: 'missing sid' }, 400)

  const action = body.action === 'decline' ? 'decline' : (body.action === 'approve' ? 'approve' : '')
  if (!action) return json({ success: false, error: 'action 只能是 approve 或 decline' }, 400)

  const [app, state] = await Promise.all([readJson(K.app(sid)), readJson(K.state(sid))])
  if (!app) return json({ success: false, error: '申请已过期，无法处理' }, 404)
  if (!state) return json({ success: false, error: '申请状态异常' }, 404)

  const current = resolveStatus(state)
  if (current === 'ended') return json({ success: false, error: '申请人已驶离，无需处理' }, 409)

  const reply = String(body.reply == null ? '' : body.reply).trim().slice(0, 100)
  const now = Date.now()

  if (action === 'decline') {
    const nextState = {
      ...state,
      status: 'declined',
      decidedAt: now,
      ownerReply: reply || '车主暂时不方便',
    }
    await writeJson(K.state(sid), nextState, CONFIG.STATE_TTL)
    await appendMessage(sid, reply || '车主暂时不方便', 'decline')
    return json({ success: true, status: 'declined', ownerReply: nextState.ownerReply })
  }

  // 同意：车主可以调整时长，但不超过上限
  let grantedMin = Math.round(Number(body.minutes))
  if (!Number.isFinite(grantedMin) || grantedMin <= 0) grantedMin = Number(app.minutes)
  grantedMin = Math.min(Math.max(grantedMin, CONFIG.MIN_MINUTES), CONFIG.MAX_MINUTES)

  const expireAt = now + grantedMin * 60000
  const nextState = {
    ...state,
    status: 'approved',
    grantedMin,
    decidedAt: now,
    expireAt,
    ownerReply: reply || '',
  }

  await writeJson(K.state(sid), nextState, CONFIG.STATE_TTL)

  // 同一车位只保留一条生效许可，被顶掉的旧申请标记为 ended
  const prev = await readCurrent(app.spot)
  if (prev && prev.sid && prev.sid !== sid) {
    const prevState = await readJson(K.state(prev.sid))
    if (prevState) {
      await writeJson(K.state(prev.sid), {
        ...prevState,
        status: 'ended',
        endedAt: now,
        endedBy: 'owner',
      }, CONFIG.STATE_TTL)
    }
  }

  await writeJson(K.cur(app.spot), {
    sid,
    plate: app.plate || '',
    expireAt,
    grantedMin,
  }, Math.max(60, grantedMin * 60))

  if (reply) await appendMessage(sid, reply, 'approve')

  return json({
    success: true,
    status: 'approved',
    grantedMin,
    expireAt,
    ownerReply: nextState.ownerReply,
  })
}

async function handleOwnerReply(request) {
  let body = {}
  try { body = await request.json() } catch (e) { body = {} }

  const sid = sanitizeSid(body.sid)
  if (!sid) return json({ success: false, error: 'missing sid' }, 400)

  const text = String(body.text == null ? '' : body.text).trim().slice(0, 100)
  if (!text) return json({ success: false, error: '消息不能为空' }, 400)

  const state = await readJson(K.state(sid))
  if (!state) return json({ success: false, error: '会话已失效' }, 403)

  const kept = await appendMessage(sid, text, 'owner')
  return json({ success: true, messages: kept, status: resolveStatus(state) })
}

async function appendMessage(sid, text, kind) {
  const raw = await readJson(K.msgs(sid))
  const list = Array.isArray(raw) ? raw : []
  list.push({ from: 'owner', kind: kind || 'reply', text, ts: Date.now() })
  const kept = list.slice(-CONFIG.MAX_MESSAGES)
  await writeJson(K.msgs(sid), kept, CONFIG.APP_TTL)
  return kept
}

function handleQr(url) {
  const text = String(url.searchParams.get('t') || url.searchParams.get('text') || '').slice(0, 200)
  if (!text) return new Response('missing t', { status: 400 })
  const px = Math.min(1024, Math.max(60, parseInt(url.searchParams.get('px'), 10) || 420))
  const svg = qrSvg(text, px)
  if (!svg) return new Response('text too long', { status: 414 })
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml;charset=UTF-8',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}

/* ------------------------------------------------------------------ */
/* 申请人页面                                                          */
/* ------------------------------------------------------------------ */

function renderApplyPage(url) {
  const spot = sanitizeSpot(url.searchParams.get('spot') || '')
  const name = spotName(spot)
  const note = spotNote()

  const page = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#4f46e5">
    <meta name="robots" content="noindex, nofollow">
    <title>${escapeHtml(name)} · 临时借用申请</title>
    <style>
      :root {
        --sat: env(safe-area-inset-top, 0px);
        --sar: env(safe-area-inset-right, 0px);
        --sab: env(safe-area-inset-bottom, 0px);
        --sal: env(safe-area-inset-left, 0px);
        --brand: #4f46e5;
        --brand2: #0ea5e9;
        --ink: #1e293b;
        --muted: #718096;
        --line: #e6ecf5;
      }
      * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; margin: 0; padding: 0; }
      html { font-size: 16px; -webkit-text-size-adjust: 100%; }
      html, body { min-height: 100%; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Segoe UI", Roboto, sans-serif;
        background: linear-gradient(165deg, #4f46e5 0%, #3b82f6 46%, #0ea5e9 100%);
        min-height: 100vh;
        min-height: -webkit-fill-available;
        padding: clamp(14px, 4vw, 24px);
        padding-top: calc(clamp(14px, 4vw, 24px) + var(--sat));
        padding-bottom: calc(clamp(20px, 5vw, 28px) + var(--sab));
        padding-left: calc(clamp(14px, 4vw, 24px) + var(--sal));
        padding-right: calc(clamp(14px, 4vw, 24px) + var(--sar));
        display: flex;
        justify-content: center;
        align-items: flex-start;
      }
      body::after {
        content: '';
        position: fixed; inset: 0; z-index: -1; opacity: .35;
        background-image:
          radial-gradient(circle at 18% 12%, rgba(255,255,255,.5) 0, transparent 42%),
          radial-gradient(circle at 82% 78%, rgba(255,255,255,.28) 0, transparent 46%);
      }
      .wrap { width: 100%; max-width: 480px; display: flex; flex-direction: column; gap: clamp(10px, 2.6vw, 14px); }

      .card {
        background: rgba(255,255,255,.97);
        border-radius: clamp(18px, 4.5vw, 24px);
        box-shadow: 0 12px 36px rgba(23, 42, 106, .22);
      }

      .head { padding: clamp(20px, 5vw, 28px) clamp(18px, 4.5vw, 26px); text-align: center; }
      .badge {
        display: inline-flex; align-items: center; gap: 6px;
        background: #eef2ff; color: #4338ca;
        border: 1px solid #c7d2fe;
        padding: 5px 12px; border-radius: 999px;
        font-size: clamp(11px, 3vw, 12.5px); font-weight: 700; letter-spacing: .02em;
      }
      .head h1 {
        font-size: clamp(20px, 5.4vw, 26px); color: var(--ink);
        margin: clamp(12px, 3vw, 16px) 0 8px; line-height: 1.3;
      }
      .head h1 span { color: var(--brand); }
      .head .note {
        font-size: clamp(12.5px, 3.4vw, 14px); color: var(--muted);
        line-height: 1.65; max-width: 30em; margin: 0 auto;
      }
      .free-tag {
        margin-top: clamp(12px, 3vw, 16px);
        display: flex; justify-content: center; gap: clamp(10px, 3vw, 18px);
        flex-wrap: wrap;
        font-size: clamp(11.5px, 3.1vw, 13px); color: #0f766e; font-weight: 600;
      }
      .free-tag span { display: inline-flex; align-items: center; gap: 4px; }

      .field { padding: clamp(15px, 3.8vw, 20px) clamp(16px, 4vw, 22px); }
      .field + .field { border-top: 1px solid var(--line); }
      .label {
        display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
        font-size: clamp(13.5px, 3.6vw, 15px); font-weight: 700; color: #334155;
        margin-bottom: clamp(10px, 2.6vw, 13px);
      }
      .label .req { color: #ef4444; font-weight: 700; margin-left: 2px; }
      .label .sub { font-size: clamp(11px, 2.9vw, 12px); color: #a0aec0; font-weight: 500; }

      .chips { display: flex; flex-wrap: wrap; gap: clamp(7px, 2vw, 10px); }
      .chip {
        flex: 1 1 calc(50% - 10px);
        min-height: 46px;
        display: flex; align-items: center; justify-content: center; gap: 6px;
        border: 1.5px solid #dfe7f3; background: #f8fafc;
        color: #475569; border-radius: 14px;
        font-size: clamp(13.5px, 3.6vw, 15px); font-weight: 600;
        font-family: inherit; cursor: pointer;
        transition: all .16s ease;
      }
      .chip:active { transform: scale(.97); }
      .chip.on {
        border-color: var(--brand); background: linear-gradient(135deg, #eef2ff, #e0f2fe);
        color: #3730a3; box-shadow: 0 4px 14px rgba(79,70,229,.16);
      }
      .chip.sm { flex: 1 1 auto; padding: 0 14px; min-height: 42px; font-size: clamp(13px, 3.5vw, 14px); }

      .custom-row { margin-top: clamp(8px, 2.2vw, 11px); display: none; gap: 8px; }
      .custom-row.show { display: flex; }
      .custom-row input {
        flex: 1; min-width: 0;
        height: 46px; padding: 0 14px;
        border: 1.5px solid #dfe7f3; border-radius: 13px;
        background: #fff; color: var(--ink);
        font-size: 16px; font-family: inherit; outline: none;
        -webkit-appearance: none;
      }
      .custom-row input:focus { border-color: #a5b4fc; }
      .unit {
        display: flex; align-items: center; gap: 0;
        border: 1.5px solid #dfe7f3; border-radius: 13px; overflow: hidden;
        flex-shrink: 0;
      }
      .unit button {
        height: 43px; padding: 0 14px; border: none; background: #f8fafc;
        color: #64748b; font-size: 14px; font-weight: 700; font-family: inherit;
      }
      .unit button.on { background: #eef2ff; color: #4338ca; }

      .text-input, .note-input {
        width: 100%; border: 1.5px solid #dfe7f3; border-radius: 13px;
        background: #fff; color: var(--ink); font-family: inherit; outline: none;
        -webkit-appearance: none;
      }
      .text-input { height: 48px; padding: 0 14px; font-size: 16px; }
      .text-input:focus { border-color: #a5b4fc; }
      .note-input {
        padding: 12px 14px; font-size: 15px; line-height: 1.5;
        min-height: 72px; resize: none;
      }
      .note-input:focus { border-color: #a5b4fc; }
      .text-input.err, .custom-row input.err { border-color: #fca5a5; background: #fef2f2; }

      .submit {
        margin-top: clamp(4px, 1.5vw, 8px);
        background: linear-gradient(135deg, #4f46e5 0%, #0ea5e9 100%);
        color: #fff; border: none; width: 100%;
        padding: clamp(16px, 4vw, 20px);
        border-radius: clamp(16px, 4vw, 20px);
        font-size: clamp(16px, 4.2vw, 18px); font-weight: 700; font-family: inherit;
        box-shadow: 0 12px 30px rgba(37, 99, 235, .4);
        display: flex; align-items: center; justify-content: center; gap: 9px;
        min-height: 56px; cursor: pointer; transition: all .18s;
      }
      .submit:active { transform: scale(.985); }
      .submit:disabled { background: linear-gradient(135deg, #94a3b8, #64748b); box-shadow: none; cursor: not-allowed; }

      .foot-note {
        text-align: center; font-size: clamp(11.5px, 3.1vw, 13px);
        color: rgba(255,255,255,.9); line-height: 1.7;
        text-shadow: 0 1px 4px rgba(12, 30, 70, .3); padding: 0 10px;
      }

      .occupy-tip {
        display: none;
        background: #fffbeb; border: 1px solid #fde68a; color: #92400e;
        border-radius: 14px; padding: 12px 14px;
        font-size: clamp(12.5px, 3.4vw, 13.5px); line-height: 1.6;
      }
      .occupy-tip.show { display: block; }
      .occupy-tip b { font-weight: 700; }
      .occupy-tip button {
        margin-top: 10px; width: 100%;
        border: 1px solid #fbbf24; background: #fff; color: #92400e;
        border-radius: 11px; padding: 10px; font-size: 13.5px; font-weight: 700;
        font-family: inherit; min-height: 44px;
      }

      /* 结果视图 */
      #resultView { display: none; }
      .status-card { padding: clamp(22px, 5.5vw, 30px) clamp(18px, 4.5vw, 26px); text-align: center; }
      .status-icon {
        width: clamp(64px, 16vw, 78px); height: clamp(64px, 16vw, 78px);
        margin: 0 auto clamp(12px, 3vw, 16px);
        border-radius: 50%; display: flex; align-items: center; justify-content: center;
        font-size: clamp(30px, 8vw, 38px);
        background: #eef2ff;
      }
      .status-card h2 { font-size: clamp(19px, 5vw, 24px); color: var(--ink); margin-bottom: 8px; }
      .status-card .desc {
        font-size: clamp(13px, 3.5vw, 14.5px); color: var(--muted); line-height: 1.7;
      }
      .timer-box {
        display: none;
        margin-top: clamp(14px, 3.6vw, 18px);
        background: linear-gradient(135deg, #ecfdf5, #d1fae5);
        border: 1px solid #a7f3d0; border-radius: 16px;
        padding: clamp(12px, 3.2vw, 16px);
      }
      .timer-box.show { display: block; }
      .timer-box .t-label { font-size: clamp(11.5px, 3.1vw, 12.5px); color: #047857; font-weight: 600; }
      .timer-box .t-value {
        font-size: clamp(22px, 6.2vw, 28px); font-weight: 800; color: #065f46;
        margin: 4px 0 2px; font-variant-numeric: tabular-nums;
      }
      .timer-box .t-range { font-size: clamp(11.5px, 3.1vw, 13px); color: #059669; }

      .status-card.s-approved .status-icon { background: #d1fae5; }
      .status-card.s-approved h2 { color: #065f46; }
      .status-card.s-declined .status-icon { background: #fff1f2; }
      .status-card.s-declined h2 { color: #9f1239; }
      .status-card.s-overdue .status-icon { background: #fee2e2; }
      .status-card.s-overdue h2 { color: #991b1b; }
      .status-card.s-expired .status-icon { background: #f1f5f9; }
      .status-card.s-expired h2 { color: #475569; }
      .status-card.s-ended .status-icon { background: #eff6ff; }
      .status-card.s-ended h2 { color: #1d4ed8; }

      .info-list { display: flex; flex-direction: column; gap: 9px; margin-top: clamp(14px, 3.6vw, 18px); text-align: left; }
      .info-row {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        background: #f8fafc; border: 1px solid #eef2f7;
        border-radius: 12px; padding: 10px 13px;
        font-size: clamp(12.5px, 3.4vw, 13.5px);
      }
      .info-row .k { color: #94a3b8; font-weight: 600; flex-shrink: 0; }
      .info-row .v { color: #334155; font-weight: 700; text-align: right; word-break: break-all; }

      .bubbles { display: flex; flex-direction: column; gap: 8px; }
      .bubble {
        background: #eef2ff; border: 1px solid #c7d2fe; color: #3730a3;
        border-radius: 14px 14px 14px 5px; padding: 10px 14px;
        font-size: clamp(13.5px, 3.5vw, 14.5px); line-height: 1.55;
        word-break: break-word; max-width: 94%; align-self: flex-start;
        white-space: pre-wrap;
      }
      .bubble .bt { display: block; font-size: 10.5px; color: #818cf8; margin-top: 3px; }

      .btn-ghost {
        width: 100%; min-height: 50px;
        border-radius: 15px; border: 1.5px solid #dfe7f3;
        background: #fff; color: #475569;
        font-size: clamp(14px, 3.8vw, 15.5px); font-weight: 700; font-family: inherit;
        cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;
      }
      .btn-ghost:active { transform: scale(.985); }
      .btn-ghost.danger { border-color: #fecdd3; color: #be123c; background: #fff1f2; }
      .btn-ghost[disabled] { opacity: .55; }

      .toast {
        position: fixed; top: calc(18px + var(--sat)); left: 50%;
        transform: translateX(-50%) translateY(-120px);
        background: #0f172a; color: #fff;
        padding: 12px 20px; border-radius: 14px;
        font-size: clamp(13px, 3.5vw, 14.5px); font-weight: 600;
        box-shadow: 0 12px 34px rgba(0,0,0,.3);
        opacity: 0; transition: all .35s cubic-bezier(.2,.9,.3,1.2);
        z-index: 100; max-width: calc(100vw - 36px); text-align: center;
      }
      .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

      @media (min-width: 760px) { body { align-items: center; } }
    </style>
  </head>
  <body>
    <div id="toast" class="toast"></div>

    <div class="wrap" id="formView">
      <div class="card head">
        <div class="badge">🅿️ ${escapeHtml(name)}</div>
        <h1>想临时停一下？<br><span>跟车主说一声就行</span></h1>
        <p class="note">${escapeHtml(note)}</p>
        <div class="free-tag">
          <span>⏱ 临时占用</span>
          <span>📞 留个电话</span>
          <span>🤝 到点挪车</span>
        </div>
      </div>

      <div class="card">
        <div class="field">
          <div class="label"><span>占用多久<span class="req">*</span></span><span class="sub">到点请挪车</span></div>
          <div class="chips" id="durChips"></div>
          <div class="custom-row" id="customRow">
            <input id="customMin" type="number" inputmode="numeric" min="15" max="480" placeholder="填个数字">
            <div class="unit">
              <button type="button" id="unitMin" class="on" onclick="setUnit('min')">分钟</button>
              <button type="button" id="unitHour" onclick="setUnit('hour')">小时</button>
            </div>
          </div>
        </div>

        <div class="field">
          <div class="label"><span>占用原因<span class="req">*</span></span><span class="sub">选一个或自己写</span></div>
          <div class="chips" id="reasonChips"></div>
          <div style="margin-top:10px">
            <input id="reasonInput" class="text-input" type="text" maxlength="40" placeholder="补充说明，例如：上楼取个东西">
          </div>
        </div>

        <div class="field">
          <div class="label"><span>车牌号<span class="sub">（可选）</span></span><span class="sub">方便车主核对</span></div>
          <input id="plateInput" class="text-input" type="text" maxlength="10" placeholder="例如：粤A12345" autocomplete="off">
        </div>

        <div class="field">
          <div class="label"><span>联系电话<span class="req">*</span></span><span class="sub">仅车主可见</span></div>
          <input id="phoneInput" class="text-input" type="tel" inputmode="numeric" maxlength="11" placeholder="11 位手机号" autocomplete="tel">
        </div>

        <div class="field">
          <div class="label"><span>更多说明<span class="sub">（可选）</span></span></div>
          <textarea id="noteInput" class="note-input" maxlength="120" placeholder="例如：只停 40 分钟，接孩子就走"></textarea>
        </div>
      </div>

      <div id="occupyTip" class="occupy-tip">
        <b id="occupyText">车位正在被占用</b>
        <button type="button" onclick="submitApply(true)">仍然提交申请（排队）</button>
      </div>

      <button id="submitBtn" class="submit" onclick="submitApply(false)">
        <span>📨</span><span>发送借用申请</span>
      </button>

      <p class="foot-note">提交后请停留本页，车主同意会实时显示<br>离开后重新扫码也能继续查看</p>
    </div>

    <div class="wrap" id="resultView">
      <div class="card status-card" id="statusCard">
        <div class="status-icon" id="statusIcon">⏳</div>
        <h2 id="statusTitle">申请已发出</h2>
        <p class="desc" id="statusDesc">正在等车主确认…</p>

        <div class="timer-box" id="timerBox">
          <div class="t-label">剩余可用时间</div>
          <div class="t-value" id="timerValue">--:--</div>
          <div class="t-range" id="timerRange"></div>
        </div>

        <div class="info-list" id="infoList"></div>
      </div>

      <div class="card" style="padding:clamp(15px,3.8vw,20px) clamp(16px,4vw,22px)">
        <div class="label" style="margin-bottom:12px"><span>💬 车主回复</span></div>
        <div class="bubbles" id="bubbleList">
          <div style="font-size:13.5px;color:#94a3b8">还没有回复，稍等一下下…</div>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:10px">
        <button class="btn-ghost" id="releaseBtn" onclick="releaseSpot()">
          <span>🚗</span><span>我已驶离，释放车位</span>
        </button>
        <button class="btn-ghost" id="callBtn" onclick="callOwner()" style="display:none">
          <span>📞</span><span>联系车主</span>
        </button>
        <button class="btn-ghost" id="againBtn" onclick="location.href=location.pathname+'?spot='+encodeURIComponent(SPOT)+'&new=1'">
          <span>🔄</span><span>重新申请</span>
        </button>
      </div>
    </div>

    <script>
      var SPOT = ${JSON.stringify(spot)};
      var SID = '';
      var currentStatus = 'pending';
      var serverSkew = 0;
      var applyMinutes = 60;
      var unit = 'min';
      var timer = null;
      var expireAt = 0;

      var DURATIONS = ${JSON.stringify(DURATION_PRESETS)};
      var REASONS = ['临时停一下', '接人送人', '上楼取东西', '吃饭买东西', '装货卸货', '车坏了等救援'];

      var SESSION_KEY = 'parking_session_' + (SPOT || 'default');
      var SESSION_TTL = 3 * 3600 * 1000;

      function saveSession(sid) {
        try { localStorage.setItem(SESSION_KEY, JSON.stringify({ sid: sid, ts: Date.now() })); } catch (e) {}
      }
      function readSession() {
        try {
          var raw = localStorage.getItem(SESSION_KEY);
          if (!raw) return null;
          var d = JSON.parse(raw);
          if (!d || !d.sid) return null;
          if (Date.now() - Number(d.ts || 0) > SESSION_TTL) { localStorage.removeItem(SESSION_KEY); return null; }
          return d.sid;
        } catch (e) { return null; }
      }
      function clearSession() {
        try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
      }

      function fmtMin(m) {
        m = Math.max(0, Math.round(m));
        var h = Math.floor(m / 60), r = m % 60;
        if (!h) return r + ' 分钟';
        if (!r) return h + ' 小时';
        return h + ' 小时 ' + r + ' 分钟';
      }

      function buildChips() {
        var box = document.getElementById('durChips');
        DURATIONS.forEach(function (m) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'chip' + (m === applyMinutes ? ' on' : '');
          b.textContent = (m >= 60 ? (m / 60) + ' 小时' : m + ' 分钟');
          b.onclick = function () { pickDuration(m, b); };
          box.appendChild(b);
        });
        var custom = document.createElement('button');
        custom.type = 'button';
        custom.className = 'chip';
        custom.id = 'customChip';
        custom.textContent = '⏱ 自定义';
        custom.onclick = function () {
          var row = document.getElementById('customRow');
          var open = row.classList.contains('show');
          row.classList.toggle('show', !open);
          custom.classList.toggle('on', !open);
          document.querySelectorAll('#durChips .chip').forEach(function (c) { if (c !== custom) c.classList.remove('on'); });
          if (!open) document.getElementById('customMin').focus();
          else { applyMinutes = Number(document.getElementById('customMin').value) || applyMinutes; }
        };
        box.appendChild(custom);

        var rbox = document.getElementById('reasonChips');
        REASONS.forEach(function (t, i) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'chip sm' + (i === 0 ? ' on' : '');
          b.textContent = t;
          b.onclick = function () {
            document.querySelectorAll('#reasonChips .chip').forEach(function (c) { c.classList.remove('on'); });
            b.classList.add('on');
            document.getElementById('reasonInput').value = (i === 0 ? '' : t);
          };
          rbox.appendChild(b);
        });
      }

      function pickDuration(m, btn) {
        applyMinutes = m;
        document.querySelectorAll('#durChips .chip').forEach(function (c) { c.classList.remove('on'); });
        btn.classList.add('on');
        document.getElementById('customRow').classList.remove('show');
        document.getElementById('customChip').classList.remove('on');
      }

      function setUnit(u) {
        unit = u;
        document.getElementById('unitMin').classList.toggle('on', u === 'min');
        document.getElementById('unitHour').classList.toggle('on', u === 'hour');
      }

      function currentMinutes() {
        var row = document.getElementById('customRow');
        if (row.classList.contains('show')) {
          var v = Number(document.getElementById('customMin').value);
          if (!v || v <= 0) return 0;
          return Math.round(unit === 'hour' ? v * 60 : v);
        }
        return applyMinutes;
      }

      function toast(msg) {
        var t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(t._t);
        t._t = setTimeout(function () { t.classList.remove('show'); }, 2600);
      }

      async function submitApply(force) {
        var btn = document.getElementById('submitBtn');
        var minutes = currentMinutes();
        var reason = (document.getElementById('reasonInput').value || '').trim();
        var plate = (document.getElementById('plateInput').value || '').trim().toUpperCase();
        var phone = (document.getElementById('phoneInput').value || '').trim();
        var note = (document.getElementById('noteInput').value || '').trim();

        if (!minutes || minutes < 15) { toast('请选择或填写占用时长'); return; }
        if (minutes > 480) { toast('单次最长 8 小时'); return; }
        if (!reason) {
          var on = document.querySelector('#reasonChips .chip.on');
          reason = on ? on.textContent.replace(/^[^\\u4e00-\\u9fa5]+/, '') : '临时停一下';
        }
        if (!/^1[3-9]\\d{9}$/.test(phone)) {
          var el = document.getElementById('phoneInput');
          el.classList.add('err');
          el.focus();
          toast('请填写正确的 11 位手机号');
          return;
        }
        document.getElementById('phoneInput').classList.remove('err');

        btn.disabled = true;
        btn.innerHTML = '<span>🚀</span><span>发送中…</span>';

        try {
          var res = await fetch('/api/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              spot: SPOT, minutes: minutes, reason: reason, plate: plate,
              phone: phone, note: note, force: !!force
            })
          });
          var data = await res.json().catch(function () { return {}; });

          if (res.status === 409 && data.occupied && !force) {
            document.getElementById('occupyText').textContent = data.error + '，' + (data.remainMin || 0) + ' 分钟后释放';
            document.getElementById('occupyTip').classList.add('show');
            toast('车位正在使用中');
            return;
          }

          if (res.ok && data.success) {
            SID = data.sid;
            saveSession(SID);
            await enterResult(SID);
            if (data.pushed === false) toast('已记录，但通知可能未送达车主');
            return;
          }
          toast('❌ ' + (data.error || '提交失败，请重试'));
        } catch (e) {
          toast('❌ 网络异常，请重试');
        } finally {
          btn.disabled = false;
          btn.innerHTML = '<span>📨</span><span>发送借用申请</span>';
        }
      }

      async function enterResult(sid) {
        document.getElementById('formView').style.display = 'none';
        document.getElementById('resultView').style.display = 'flex';
        await tick();
        startPolling();
      }

      function startPolling() {
        if (timer) clearInterval(timer);
        var n = 0;
        timer = setInterval(function () {
          n++;
          if (n > 240) { clearInterval(timer); timer = null; return; }
          if (document.hidden) return;
          tick();
        }, 4000);
      }

      function renderStatus(data) {
        currentStatus = data.status;
        serverSkew = Number(data.serverTime || Date.now()) - Date.now();

        var card = document.getElementById('statusCard');
        card.className = 'card status-card s-' + data.status;

        var icon = document.getElementById('statusIcon');
        var title = document.getElementById('statusTitle');
        var desc = document.getElementById('statusDesc');
        var timerBox = document.getElementById('timerBox');
        var releaseBtn = document.getElementById('releaseBtn');
        var callBtn = document.getElementById('callBtn');

        timerBox.classList.remove('show');
        releaseBtn.style.display = '';

        if (data.status === 'pending') {
          icon.textContent = '⏳';
          title.textContent = '申请已发出';
          desc.textContent = '正在等车主确认，一般几分钟内会有结果。请先别走开。';
        } else if (data.status === 'approved') {
          icon.textContent = '✅';
          title.textContent = '车主同意了';
          desc.textContent = '可以停了，到点前请把车挪走。';
          timerBox.classList.add('show');
          expireAt = Number(data.expireAt) || 0;
          document.getElementById('timerRange').textContent =
            '可用至 ' + fmtClock(data.expireAt) + '（批准 ' + fmtMin(data.grantedMin || data.minutes) + '）';
          updateTimer();
        } else if (data.status === 'overdue') {
          icon.textContent = '⏰';
          title.textContent = '已超过允许时间';
          desc.textContent = '请尽快驶离，车位主人可能已经在等了。';
          timerBox.classList.add('show');
          expireAt = Number(data.expireAt) || 0;
          document.getElementById('timerRange').textContent = '原定 ' + fmtClock(data.expireAt) + ' 结束';
          updateTimer();
        } else if (data.status === 'declined') {
          icon.textContent = '🙏';
          title.textContent = '车主暂时不方便';
          desc.textContent = data.ownerReply || '这次没能借用，麻烦另找车位，谢谢理解。';
          callBtn.style.display = '';
        } else if (data.status === 'expired') {
          icon.textContent = '💤';
          title.textContent = '申请已失效';
          desc.textContent = '等了太久没被处理，重新提交一次就好。';
          releaseBtn.style.display = 'none';
        } else if (data.status === 'ended') {
          icon.textContent = '🚗';
          title.textContent = '本次占用已结束';
          desc.textContent = '车位已释放，谢谢配合。';
          releaseBtn.style.display = 'none';
        }

        renderInfo(data);
        renderMessages(data.messages);

        // 按钮按状态显隐：能开车走的时候才给"我已驶离"，没戏了才给"重新申请"
        var canRelease = (data.status === 'pending' || data.status === 'approved' || data.status === 'overdue');
        releaseBtn.style.display = canRelease ? '' : 'none';
        var canAgain = (data.status === 'declined' || data.status === 'expired' || data.status === 'ended' || data.status === 'overdue');
        document.getElementById('againBtn').style.display = canAgain ? '' : 'none';

        // 到点后继续倒计时没有意义，但仍然保留"我已驶离"
        if (data.status === 'overdue' || data.status === 'ended') {
          if (timer) { clearInterval(timer); timer = null; }
        }
      }

      function renderInfo(data) {
        var box = document.getElementById('infoList');
        var rows = [];
        if (data.plate) rows.push(['车牌', data.plate]);
        rows.push(['占用时长', fmtMin(data.minutes)]);
        if (data.grantedMin && data.grantedMin !== data.minutes) rows.push(['批准时长', fmtMin(data.grantedMin)]);
        rows.push(['原因', data.reason || '临时停一下']);
        rows.push(['申请时间', fmtClock(data.createdAt)]);
        if (data.expireAt && (data.status === 'approved' || data.status === 'overdue')) {
          rows.push(['到期时间', fmtClock(data.expireAt)]);
        }
        var html = '';
        rows.forEach(function (r) {
          html += '<div class="info-row"><span class="k">' + esc(r[0]) + '</span><span class="v">' + esc(r[1]) + '</span></div>';
        });
        box.innerHTML = html;
      }

      function renderMessages(msgs) {
        var box = document.getElementById('bubbleList');
        if (!msgs || !msgs.length) {
          box.innerHTML = '<div style="font-size:13.5px;color:#94a3b8">还没有回复，稍等一下下…</div>';
          return;
        }
        var sig = msgs.map(function (m) { return m.ts + ':' + m.text; }).join('|');
        if (box.dataset.sig === sig) return;
        box.innerHTML = '';
        msgs.forEach(function (m) {
          var d = document.createElement('div');
          d.className = 'bubble';
          d.textContent = m.text;
          var t = document.createElement('span');
          t.className = 'bt';
          t.textContent = fmtClock(m.ts);
          d.appendChild(t);
          box.appendChild(d);
        });
        box.dataset.sig = sig;
      }

      function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
      }

      function fmtClock(ts) {
        var t = Number(ts);
        if (!t) return '';
        var d = new Date(t);
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        return hh + ':' + mm;
      }

      function updateTimer() {
        var el = document.getElementById('timerValue');
        if (!expireAt) { el.textContent = '--:--'; return; }
        var left = expireAt - (Date.now() + serverSkew);
        if (left <= 0) {
          el.textContent = '已到期';
          el.style.color = '#b91c1c';
          return;
        }
        var totalSec = Math.floor(left / 1000);
        var h = Math.floor(totalSec / 3600);
        var m = Math.floor((totalSec % 3600) / 60);
        var s = totalSec % 60;
        el.textContent = (h > 0 ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
        el.style.color = left < 10 * 60 * 1000 ? '#b45309' : '#065f46';
      }

      var timerTick = setInterval(function () {
        if (expireAt) updateTimer();
      }, 1000);

      async function tick() {
        if (!SID) return;
        try {
          var res = await fetch('/api/status?sid=' + encodeURIComponent(SID), { cache: 'no-store' });
          var data = await res.json();
          if (data.status === 'expired' && !data.minutes) {
            // 记录已经彻底过期
            clearSession();
            renderStatus({ status: 'expired', messages: [] });
            if (timer) { clearInterval(timer); timer = null; }
            return;
          }
          renderStatus(data);
        } catch (e) {}
      }

      async function releaseSpot() {
        if (!SID) return;
        var btn = document.getElementById('releaseBtn');
        btn.disabled = true;
        btn.innerHTML = '<span>⏳</span><span>提交中…</span>';
        try {
          var res = await fetch('/api/release', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sid: SID, by: 'visitor', notify: true })
          });
          var data = await res.json().catch(function () { return {}; });
          if (res.ok && data.success) {
            toast('✅ 已通知车主车位空了');
            expireAt = 0;
            await tick();
          } else {
            toast('❌ ' + (data.error || '提交失败'));
          }
        } catch (e) {
          toast('❌ 网络异常');
        }
        btn.disabled = false;
        btn.innerHTML = '<span>🚗</span><span>我已驶离，释放车位</span>';
      }

      var phoneCache = null;
      async function callOwner() {
        if (phoneCache) { location.href = 'tel:' + phoneCache; return; }
        if (!SID) { toast('请先提交申请'); return; }
        try {
          var res = await fetch('/api/owner-phone?sid=' + encodeURIComponent(SID));
          var data = await res.json().catch(function () { return {}; });
          if (res.ok && data.tel) {
            phoneCache = data.tel;
            document.getElementById('callBtn').innerHTML = '<span>📞</span><span>' + (data.mask || '拨打电话') + '</span>';
            location.href = 'tel:' + data.tel;
          } else {
            toast(data.error || '车主未留电话');
          }
        } catch (e) { toast('网络异常'); }
      }

      window.onload = async function () {
        buildChips();
        var saved = readSession();
        if (saved) {
          SID = saved;
          await enterResult(SID);
        }
      };
    </script>
  </body>
  </html>
  `;

  return html(page)
}

/* ------------------------------------------------------------------ */
/* 车主页面                                                            */
/* ------------------------------------------------------------------ */

function renderOwnerPage() {
  const page = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="theme-color" content="#0f766e">
    <meta name="robots" content="noindex, nofollow">
    <title>车位管理</title>
    <style>
      :root {
        --sat: env(safe-area-inset-top, 0px);
        --sab: env(safe-area-inset-bottom, 0px);
        --ink: #0f172a;
        --muted: #64748b;
        --line: #e6ecf5;
        --teal: #0d9488;
      }
      * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; margin: 0; padding: 0; }
      html { font-size: 16px; -webkit-text-size-adjust: 100%; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Segoe UI", Roboto, sans-serif;
        background: linear-gradient(165deg, #0f172a 0%, #134e4a 52%, #0e7490 100%);
        min-height: 100vh; min-height: -webkit-fill-available;
        padding: clamp(14px, 4vw, 24px);
        padding-top: calc(clamp(14px, 4vw, 24px) + var(--sat));
        padding-bottom: calc(clamp(20px, 5vw, 28px) + var(--sab));
        display: flex; justify-content: center; align-items: flex-start;
      }
      .wrap { width: 100%; max-width: 500px; display: flex; flex-direction: column; gap: clamp(10px, 2.6vw, 14px); }
      .card {
        background: rgba(255,255,255,.98);
        border-radius: clamp(18px, 4.5vw, 24px);
        box-shadow: 0 14px 40px rgba(3, 20, 30, .35);
      }
      .topbar {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 4px 4px 0; color: #e2e8f0;
      }
      .topbar .t { font-size: clamp(14px, 3.8vw, 16px); font-weight: 700; }
      .topbar .s { font-size: clamp(11.5px, 3.1vw, 12.5px); color: #94a3b8; }
      .refresh {
        border: 1px solid rgba(255,255,255,.22); background: rgba(255,255,255,.1);
        color: #e2e8f0; border-radius: 999px; padding: 8px 14px;
        font-size: 12.5px; font-weight: 600; font-family: inherit; min-height: 38px;
      }

      .detail-head { padding: clamp(20px, 5vw, 26px) clamp(18px, 4.5vw, 24px); text-align: center; }
      .spot-pill {
        display: inline-block; background: #ccfbf1; color: #115e59;
        border: 1px solid #99f6e4; border-radius: 999px;
        padding: 5px 13px; font-size: 12.5px; font-weight: 700;
      }
      .detail-head h1 { font-size: clamp(19px, 5vw, 24px); color: var(--ink); margin: 12px 0 6px; }
      .detail-head .time { font-size: clamp(12px, 3.2vw, 13px); color: var(--muted); }

      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; padding: 0 clamp(16px, 4vw, 22px) clamp(16px, 4vw, 20px); }
      .cell {
        background: #f8fafc; border: 1px solid #eef2f7; border-radius: 13px;
        padding: 11px 13px;
      }
      .cell .k { font-size: 11px; color: #94a3b8; font-weight: 700; letter-spacing: .02em; }
      .cell .v { font-size: clamp(14px, 3.7vw, 15.5px); color: #1e293b; font-weight: 700; margin-top: 3px; word-break: break-all; }
      .cell.wide { grid-column: 1 / -1; }
      .cell .v.big { font-size: clamp(16px, 4.2vw, 18px); color: #0f766e; }

      .phone-row {
        display: flex; align-items: center; gap: 10px;
        padding: 0 clamp(16px, 4vw, 22px) clamp(16px, 4vw, 20px);
      }
      .phone-box {
        flex: 1; display: flex; align-items: center; gap: 10px;
        background: #eff6ff; border: 1px solid #dbeafe; border-radius: 14px;
        padding: 12px 14px;
      }
      .phone-box .n { font-size: clamp(15px, 4vw, 17px); font-weight: 800; color: #1d4ed8; letter-spacing: .04em; }
      .phone-box .h { font-size: 11px; color: #60a5fa; }
      .btn-call {
        flex-shrink: 0; text-decoration: none;
        background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #fff;
        border-radius: 13px; padding: 0 18px; min-height: 48px;
        display: flex; align-items: center; justify-content: center; gap: 6px;
        font-size: 14px; font-weight: 700;
      }

      .section { padding: clamp(15px, 3.8vw, 20px) clamp(16px, 4vw, 22px); }
      .section + .section { border-top: 1px solid var(--line); }
      .sec-title {
        font-size: clamp(13px, 3.5vw, 14px); font-weight: 700; color: #334155;
        margin-bottom: 11px; display: flex; justify-content: space-between; align-items: baseline;
      }
      .sec-title .hint { font-size: 11.5px; color: #a0aec0; font-weight: 500; }

      .note-box {
        background: #fffbeb; border: 1px solid #fde68a; border-radius: 13px;
        padding: 11px 13px; font-size: clamp(13px, 3.5vw, 14px); color: #92400e;
        line-height: 1.6; white-space: pre-wrap; word-break: break-word;
      }

      .chips { display: flex; flex-wrap: wrap; gap: 8px; }
      .chip {
        border: 1.5px solid #dfe7f3; background: #f8fafc; color: #475569;
        border-radius: 12px; padding: 0 14px; min-height: 42px;
        font-size: clamp(12.5px, 3.4vw, 13.5px); font-weight: 700; font-family: inherit;
        display: flex; align-items: center; gap: 5px;
      }
      .chip.on { border-color: var(--teal); background: #ccfbf1; color: #115e59; }

      .actions { display: flex; gap: 10px; padding: clamp(15px, 3.8vw, 20px) clamp(16px, 4vw, 22px) clamp(16px, 4vw, 20px); }
      .btn {
        flex: 1; border: none; border-radius: 15px; min-height: 56px;
        font-size: clamp(15px, 4vw, 17px); font-weight: 800; font-family: inherit;
        display: flex; align-items: center; justify-content: center; gap: 8px;
        cursor: pointer; transition: transform .18s;
      }
      .btn:active { transform: scale(.98); }
      .btn:disabled { opacity: .6; }
      .btn-approve { background: linear-gradient(135deg, #10b981, #059669); color: #fff; box-shadow: 0 10px 26px rgba(16,185,129,.35); }
      .btn-decline { flex: 0 0 34%; background: #fff1f2; color: #be123c; border: 1.5px solid #fecdd3; }
      .btn-extend { flex: 1; background: linear-gradient(135deg, #0d9488, #0e7490); color: #fff; box-shadow: 0 10px 26px rgba(13,148,136,.3); }
      .btn-end { flex: 0 0 38%; background: #f1f5f9; color: #475569; border: 1.5px solid #e2e8f0; font-size: clamp(14px, 3.7vw, 15.5px); }

      .reply-row { display: flex; gap: 8px; }
      .reply-row input {
        flex: 1; min-width: 0; height: 46px; padding: 0 14px;
        border: 1.5px solid #dfe7f3; border-radius: 13px;
        font-size: 16px; font-family: inherit; color: var(--ink); outline: none;
        -webkit-appearance: none; background: #fff;
      }
      .reply-row input:focus { border-color: #5eead4; }
      .reply-row button {
        flex-shrink: 0; height: 46px; padding: 0 20px; border: none; border-radius: 13px;
        background: linear-gradient(135deg, #0d9488, #0e7490); color: #fff;
        font-size: 14.5px; font-weight: 700; font-family: inherit;
      }
      .reply-row button:disabled { opacity: .6; }

      .bubbles { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
      .bubble {
        background: #f0fdfa; border: 1px solid #99f6e4; color: #115e59;
        border-radius: 13px 13px 13px 5px; padding: 10px 13px;
        font-size: clamp(13px, 3.5vw, 14px); line-height: 1.5;
        word-break: break-word; white-space: pre-wrap;
      }
      .bubble .bt { display: block; font-size: 10.5px; color: #5eead4; margin-top: 3px; }

      .done-panel {
        display: none; padding: clamp(18px, 4.5vw, 24px); text-align: center;
      }
      .done-panel.show { display: block; }
      .done-panel .di { font-size: 44px; margin-bottom: 10px; }
      .done-panel h3 { font-size: clamp(17px, 4.4vw, 20px); color: #065f46; margin-bottom: 6px; }
      .done-panel p { font-size: clamp(13px, 3.5vw, 14px); color: #64748b; line-height: 1.65; }

      /* 列表 */
      .list-head { padding: clamp(18px, 4.5vw, 24px) clamp(18px, 4.5vw, 24px) 6px; }
      .list-head h1 { font-size: clamp(18px, 4.8vw, 22px); color: var(--ink); }
      .list-head p { font-size: 12.5px; color: var(--muted); margin-top: 5px; }
      .list { display: flex; flex-direction: column; }
      .item {
        display: flex; align-items: center; gap: 12px;
        padding: clamp(13px, 3.4vw, 16px) clamp(16px, 4vw, 22px);
        text-decoration: none; color: inherit;
      }
      .item + .item { border-top: 1px solid #f1f5f9; }
      .item:active { background: #f8fafc; }
      .item .avatar {
        width: 42px; height: 42px; border-radius: 13px; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center; font-size: 19px;
        background: #ccfbf1;
      }
      .item.s-pending .avatar { background: #fef3c7; }
      .item.s-overdue .avatar { background: #fee2e2; }
      .item .body { flex: 1; min-width: 0; }
      .item .l1 { font-size: clamp(14px, 3.8vw, 15.5px); font-weight: 700; color: var(--ink); }
      .item .l2 { font-size: 12px; color: var(--muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .item .st { font-size: 11.5px; font-weight: 700; border-radius: 999px; padding: 4px 10px; flex-shrink: 0; }
      .item.s-pending .st { background: #fef3c7; color: #92400e; }
      .item.s-approved .st { background: #ccfbf1; color: #115e59; }
      .item.s-overdue .st { background: #fee2e2; color: #991b1b; }
      .empty { padding: 40px 20px; text-align: center; color: #94a3b8; font-size: 14px; line-height: 1.7; }

      .toast {
        position: fixed; top: calc(18px + var(--sat)); left: 50%;
        transform: translateX(-50%) translateY(-120px);
        background: #0f172a; color: #fff; padding: 12px 20px; border-radius: 14px;
        font-size: 14px; font-weight: 600; box-shadow: 0 12px 34px rgba(0,0,0,.35);
        opacity: 0; transition: all .35s cubic-bezier(.2,.9,.3,1.2);
        z-index: 100; max-width: calc(100vw - 36px); text-align: center;
      }
      .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
      @media (min-width: 760px) { body { align-items: center; } }
    </style>
  </head>
  <body>
    <div id="toast" class="toast"></div>

    <div class="wrap">
      <div class="topbar">
        <div>
          <div class="t">🅿️ 车位管理</div>
          <div class="s" id="topSub">车辆进出，尽在掌握</div>
        </div>
        <button class="refresh" onclick="reload()">刷新</button>
      </div>

      <!-- 列表视图 -->
      <div class="card" id="listView" style="display:none">
        <div class="list-head">
          <h1>待处理 / 进行中</h1>
          <p>点开可以同意、拒绝或回一句话</p>
        </div>
        <div class="list" id="listBody"></div>
      </div>

      <!-- 详情视图 -->
      <div id="detailView" style="display:none">
        <div class="card" id="detailCard">
          <div class="detail-head">
            <div class="spot-pill" id="spotPill">私家车位</div>
            <h1 id="appTitle">借用申请</h1>
            <div class="time" id="appTime"></div>
          </div>

          <div class="grid" id="detailGrid"></div>

          <div class="phone-row">
            <div class="phone-box">
              <div style="flex:1">
                <div class="n" id="phoneText">-</div>
                <div class="h">仅你可见，勿外传</div>
              </div>
            </div>
            <a class="btn-call" id="callLink" href="#">📞 拨打</a>
          </div>

          <div class="section" id="noteSection" style="display:none">
            <div class="sec-title"><span>对方补充</span></div>
            <div class="note-box" id="noteText"></div>
          </div>

          <div class="section" id="grantSection">
            <div class="sec-title"><span>批准时长</span><span class="hint">可改，默认按对方申请</span></div>
            <div class="chips" id="grantChips"></div>
          </div>

          <div class="section">
            <div class="sec-title"><span>快捷回复（会一起发给对方）</span></div>
            <div class="chips" id="quickChips"></div>
            <div class="reply-row" style="margin-top:10px">
              <input id="replyInput" type="text" maxlength="100" placeholder="也可以自己写一句…"
                     onkeydown="if(event.key==='Enter'){event.preventDefault();sendReply();}">
              <button onclick="sendReply()">发送</button>
            </div>
            <div class="bubbles" id="bubbleList"></div>
          </div>

          <div class="actions" id="actionRow">
            <button class="btn btn-decline" id="declineBtn" onclick="decide('decline')">不方便</button>
            <button class="btn btn-approve" id="approveBtn" onclick="decide('approve')">✅ 同意借用</button>
          </div>

          <div class="actions" id="activeRow" style="display:none">
            <button class="btn btn-end" onclick="endNow()">结束占用</button>
            <button class="btn btn-extend" onclick="extend()">＋30 分钟</button>
          </div>

          <div class="done-panel" id="donePanel">
            <div class="di" id="doneIcon">✅</div>
            <h3 id="doneTitle">已同意</h3>
            <p id="doneDesc"></p>
          </div>
        </div>

        <div style="margin-top:12px">
          <a href="/owner" style="display:block;text-align:center;color:#cbd5e1;font-size:13px;text-decoration:none;padding:8px">查看全部申请</a>
        </div>
      </div>
    </div>

    <script>
      var SID = new URLSearchParams(location.search).get('sid') || '';
      var DATA = null;
      var grantMin = 0;
      var pendingReply = '';

      var QUICK = ['可以，注意别超时', '停吧，我晚上才回来', '可以，麻烦留个电话', '我马上要用车，麻烦快点'];

      function toast(msg) {
        var t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(t._t);
        t._t = setTimeout(function () { t.classList.remove('show'); }, 2400);
      }

      function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
      }
      function fmtMin(m) {
        m = Math.max(0, Math.round(Number(m) || 0));
        var h = Math.floor(m / 60), r = m % 60;
        if (!h) return r + ' 分钟';
        if (!r) return h + ' 小时';
        return h + ' 小时 ' + r + ' 分钟';
      }
      function fmtClock(ts) {
        var t = Number(ts);
        if (!t) return '-';
        var d = new Date(t + 0);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      }

      function reload() {
        if (SID) loadDetail(); else loadList();
      }

      async function loadList() {
        document.getElementById('listView').style.display = '';
        document.getElementById('detailView').style.display = 'none';
        var body = document.getElementById('listBody');
        body.innerHTML = '<div class="empty">加载中…</div>';
        try {
          var res = await fetch('/api/owner/list', { cache: 'no-store' });
          var data = await res.json();
          if (!data.success) throw new Error(data.error || 'failed');
          var items = data.items || [];
          document.getElementById('topSub').textContent = items.length ? ('共 ' + items.length + ' 条记录') : '暂无待处理申请';
          if (!items.length) {
            body.innerHTML = '<div class="empty">暂时没有申请<br>把二维码贴在车位上就行</div>';
            return;
          }
          body.innerHTML = '';
          items.forEach(function (it) {
            var a = document.createElement('a');
            a.className = 'item s-' + it.status;
            a.href = '/owner?sid=' + encodeURIComponent(it.sid);
            var icon = it.status === 'pending' ? '📩' : (it.status === 'overdue' ? '⏰' : '🚗');
            var label = it.status === 'pending' ? '待处理' : (it.status === 'overdue' ? '已超时' : '进行中');
            a.innerHTML =
              '<div class="avatar">' + icon + '</div>' +
              '<div class="body">' +
                '<div class="l1">' + esc(it.plate || '(未填车牌)') + ' · ' + esc(fmtMin(it.minutes)) + '</div>' +
                '<div class="l2">' + esc(it.spot || '私家车位') + ' · ' + esc(it.reason || '') + ' · ' + esc(fmtClock(it.createdAt)) + '</div>' +
              '</div>' +
              '<div class="st">' + label + '</div>';
            body.appendChild(a);
          });
        } catch (e) {
          body.innerHTML = '<div class="empty">读取失败，请刷新</div>';
        }
      }

      async function loadDetail() {
        document.getElementById('listView').style.display = 'none';
        document.getElementById('detailView').style.display = '';
        try {
          var res = await fetch('/api/owner/app?sid=' + encodeURIComponent(SID), { cache: 'no-store' });
          var data = await res.json();
          if (!res.ok || !data.success) {
            document.getElementById('detailCard').innerHTML =
              '<div class="done-panel show"><div class="di">💤</div><h3>申请已过期</h3><p>这条申请已经超过保留时间，可能是很久之前的了。</p></div>';
            return;
          }
          DATA = data;
          renderDetail(data);
        } catch (e) {
          toast('读取失败');
        }
      }

      function renderDetail(data) {
        var app = data.app || {};
        document.getElementById('spotPill').textContent = app.spot || '私家车位';
        document.getElementById('appTitle').textContent = (app.plate || '有人') + ' 想借用 ' + fmtMin(app.minutes);
        document.getElementById('appTime').textContent = '提交于 ' + fmtClock(app.createdAt) + ' · 申请 ' + fmtMin(app.minutes);

        var rows = [
          ['占用时长', fmtMin(app.minutes), true],
          ['原因', app.reason || '临时停一下', true],
          ['车牌', app.plate || '未填写', false],
          ['状态', statusLabel(data.status), false],
        ];
        if (data.status === 'approved' || data.status === 'overdue') {
          rows.push(['到期时间', fmtClock(data.expireAt) + '（批准 ' + fmtMin(data.grantedMin || app.minutes) + '）', true]);
        }
        var html = '';
        rows.forEach(function (r) {
          html += '<div class="cell' + (r[2] ? ' wide' : '') + '"><div class="k">' + esc(r[0]) + '</div>'
            + '<div class="v' + (r[2] ? ' big' : '') + '">' + esc(r[1]) + '</div></div>';
        });
        document.getElementById('detailGrid').innerHTML = html;

        document.getElementById('phoneText').textContent = maskPhone(app.phone);
        var call = document.getElementById('callLink');
        call.href = 'tel:' + String(app.phone || '');
        call.style.display = app.phone ? '' : 'none';

        if (app.note) {
          document.getElementById('noteSection').style.display = '';
          document.getElementById('noteText').textContent = app.note;
        }

        grantMin = data.grantedMin || app.minutes;
        buildGrantChips(app.minutes);
        buildQuickChips();
        renderBubbles(data.messages);

        var isPending = data.status === 'pending' || data.status === 'expired';
        var isActive = data.status === 'approved' || data.status === 'overdue';

        document.getElementById('actionRow').style.display = isPending ? 'flex' : 'none';
        document.getElementById('activeRow').style.display = isActive ? 'flex' : 'none';
        document.getElementById('grantSection').style.display = isPending ? '' : 'none';

        if (!isPending) {
          var panel = document.getElementById('donePanel');
          panel.classList.add('show');
          if (data.status === 'approved' || data.status === 'overdue') {
            document.getElementById('doneIcon').textContent = data.status === 'overdue' ? '⏰' : '✅';
            document.getElementById('doneTitle').textContent = data.status === 'overdue' ? '已超时' : '已同意借用';
            document.getElementById('doneDesc').textContent = data.status === 'overdue'
              ? '原定 ' + fmtClock(data.expireAt) + ' 结束，已经超时了，可以电话催一下。'
              : '可用至 ' + fmtClock(data.expireAt) + '，对方页面会显示倒计时。';
          } else if (data.status === 'declined') {
            document.getElementById('doneIcon').textContent = '🙏';
            document.getElementById('doneTitle').textContent = '已回绝';
            document.getElementById('doneDesc').textContent = data.ownerReply || '已告知对方暂时不方便。';
          } else if (data.status === 'ended') {
            document.getElementById('doneIcon').textContent = '🚗';
            document.getElementById('doneTitle').textContent = '已结束';
            document.getElementById('doneDesc').textContent = '这次占用已经结束，车位空出来了。';
          } else {
            document.getElementById('doneIcon').textContent = '💤';
            document.getElementById('doneTitle').textContent = '已过期';
            document.getElementById('doneDesc').textContent = '申请超过 15 分钟未处理，已自动失效。';
          }
        }
      }

      function statusLabel(s) {
        return ({
          pending: '等待你处理',
          approved: '已同意',
          overdue: '已超时',
          declined: '已回绝',
          expired: '已过期',
          ended: '已结束',
        })[s] || s;
      }

      function maskPhone(p) {
        var s = String(p || '');
        if (s.length >= 10) return s.slice(0, 3) + ' **** ' + s.slice(-4);
        return s || '-';
      }

      function buildGrantChips(applyMin) {
        var box = document.getElementById('grantChips');
        box.innerHTML = '';
        var opts = [];
        [30, 60, 120, 240].forEach(function (m) { if (opts.indexOf(m) < 0) opts.push(m); });
        if (opts.indexOf(applyMin) < 0) opts.push(applyMin);
        opts.sort(function (a, b) { return a - b; });

        opts.forEach(function (m) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'chip' + (m === grantMin ? ' on' : '');
          b.textContent = (m === applyMin ? '按申请 ' : '') + fmtMin(m);
          b.onclick = function () {
            grantMin = m;
            box.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('on'); });
            b.classList.add('on');
          };
          box.appendChild(b);
        });
      }

      function buildQuickChips() {
        var box = document.getElementById('quickChips');
        if (box.dataset.built) return;
        box.dataset.built = '1';
        QUICK.forEach(function (t) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'chip';
          b.textContent = t;
          b.onclick = function () {
            document.getElementById('replyInput').value = t;
            pendingReply = t;
          };
          box.appendChild(b);
        });
      }

      function renderBubbles(msgs) {
        var box = document.getElementById('bubbleList');
        if (!msgs || !msgs.length) { box.innerHTML = ''; return; }
        var sig = msgs.map(function (m) { return m.ts + ':' + m.text; }).join('|');
        if (box.dataset.sig === sig) return;
        box.innerHTML = '';
        msgs.forEach(function (m) {
          var d = document.createElement('div');
          d.className = 'bubble';
          d.textContent = m.text;
          var t = document.createElement('span');
          t.className = 'bt';
          t.textContent = fmtClock(m.ts);
          d.appendChild(t);
          box.appendChild(d);
        });
        box.dataset.sig = sig;
      }

      function currentReply() {
        return (document.getElementById('replyInput').value || '').trim();
      }

      async function sendReply() {
        var text = currentReply();
        if (!text) { toast('写点什么再发'); return; }
        try {
          var res = await fetch('/api/owner/reply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sid: SID, text: text })
          });
          var data = await res.json().catch(function () { return {}; });
          if (res.ok && data.success) {
            document.getElementById('replyInput').value = '';
            renderBubbles(data.messages);
            toast('已发送');
          } else {
            toast(data.error || '发送失败');
          }
        } catch (e) { toast('网络异常'); }
      }

      async function decide(action) {
        var btnA = document.getElementById('approveBtn');
        var btnD = document.getElementById('declineBtn');
        btnA.disabled = true; btnD.disabled = true;
        var reply = currentReply();
        if (!reply && action === 'decline') reply = '这次不太方便，抱歉';

        var body = { sid: SID, action: action, reply: reply };
        if (action === 'approve') body.minutes = grantMin;

        try {
          var res = await fetch('/api/owner/decision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          var data = await res.json().catch(function () { return {}; });
          if (res.ok && data.success) {
            toast(action === 'approve' ? '✅ 已同意' : '已回绝');
            await loadDetail();
          } else {
            toast(data.error || '操作失败');
            btnA.disabled = false; btnD.disabled = false;
          }
        } catch (e) {
          toast('网络异常');
          btnA.disabled = false; btnD.disabled = false;
        }
      }

      // 延长：以当前批准时长 +30 分钟，从此刻重新计时
      async function extend() {
        if (!DATA) return;
        var app = DATA.app || {};
        var base = DATA.grantedMin || app.minutes || 60;
        try {
          var res = await fetch('/api/owner/decision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sid: SID, action: 'approve', minutes: base + 30, reply: '帮你多留了 30 分钟' })
          });
          var data = await res.json().catch(function () { return {}; });
          if (res.ok && data.success) {
            toast('已延长到 ' + fmtClock(data.expireAt));
            await loadDetail();
          } else {
            toast(data.error || '延长失败');
          }
        } catch (e) { toast('网络异常'); }
      }

      async function endNow() {
        if (!confirm('确认结束这次占用？对方页面会立即显示已结束。')) return;
        try {
          var res = await fetch('/api/release', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sid: SID, by: 'owner' })
          });
          var data = await res.json().catch(function () { return {}; });
          if (res.ok && data.success) {
            toast('已结束本次占用');
            await loadDetail();
          } else {
            toast(data.error || '操作失败');
          }
        } catch (e) { toast('网络异常'); }
      }

      window.onload = function () {
        if (SID) loadDetail(); else loadList();
      };
    </script>
  </body>
  </html>
  `;

  return html(page)
}

/* ------------------------------------------------------------------ */
/* 打印告示页                                                          */
/* ------------------------------------------------------------------ */

function renderPosterPage() {
  const page = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>车位二维码告示</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
        background: #e2e8f0; padding: 24px 16px 60px;
        display: flex; flex-direction: column; align-items: center; gap: 18px;
      }
      .toolbar {
        display: flex; gap: 10px; flex-wrap: wrap; justify-content: center;
        max-width: 640px; width: 100%;
      }
      .toolbar input {
        flex: 1; min-width: 160px; height: 44px; padding: 0 14px;
        border: 1px solid #cbd5e1; border-radius: 11px; font-size: 15px;
        font-family: inherit; outline: none;
      }
      .toolbar button {
        height: 44px; padding: 0 20px; border: none; border-radius: 11px;
        background: #0f766e; color: #fff; font-size: 14.5px; font-weight: 700;
        font-family: inherit;
      }

      .poster {
        width: 100%; max-width: 560px; background: #fff;
        border-radius: 20px; overflow: hidden;
        box-shadow: 0 18px 50px rgba(15, 23, 42, .18);
      }
      .poster-top {
        background: linear-gradient(135deg, #0f172a 0%, #134e4a 60%, #0e7490 100%);
        color: #fff; padding: 26px 24px 22px; text-align: center;
      }
      .poster-top .kicker {
        font-size: 12px; letter-spacing: .3em; color: #5eead4; font-weight: 700;
        text-transform: uppercase;
      }
      .poster-top h1 { font-size: 26px; margin: 10px 0 6px; letter-spacing: .01em; }
      .poster-top .spot {
        display: inline-block; margin-top: 10px;
        background: rgba(255,255,255,.14); border: 1px solid rgba(94,234,212,.5);
        color: #ccfbf1; border-radius: 999px; padding: 5px 16px;
        font-size: 14px; font-weight: 700; letter-spacing: .06em;
      }
      .poster-body { padding: 26px 24px 30px; text-align: center; }
      .qr-wrap {
        display: inline-block; padding: 12px; border-radius: 16px;
        border: 2px dashed #94a3b8; background: #fff; line-height: 0;
      }
      .qr-wrap img { display: block; width: auto; height: auto; max-width: 100%; image-rendering: pixelated; }
      .qr-fail {
        display: none; margin: 0 auto 10px; max-width: 320px;
        background: #fef2f2; border: 1px solid #fecdd3; border-radius: 12px;
        padding: 11px 13px; font-size: 12px; color: #9f1239; line-height: 1.6; text-align: left;
      }
      .target-url {
        display: none;
        margin-top: 10px; font-size: 11px; color: #94a3b8;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        word-break: break-all; line-height: 1.5;
      }
      .scan-hint {
        margin: 16px 0 4px; font-size: 19px; font-weight: 800; color: #0f172a;
      }
      .scan-sub { font-size: 13.5px; color: #64748b; line-height: 1.7; }
      .steps {
        margin-top: 20px; display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;
      }
      .step {
        flex: 1 1 30%; min-width: 90px;
        background: #f8fafc; border: 1px solid #e6ecf5; border-radius: 12px;
        padding: 11px 8px; font-size: 12px; color: #475569; line-height: 1.5;
      }
      .step b { display: block; color: #0f766e; font-size: 15px; margin-bottom: 3px; }
      .foot {
        margin-top: 22px; padding-top: 16px; border-top: 1px solid #eef2f7;
        font-size: 12px; color: #94a3b8; line-height: 1.7;
      }
      .foot b { color: #475569; }

      @media print {
        body { background: #fff; padding: 0; }
        .toolbar { display: none; }
        .poster { box-shadow: none; border-radius: 0; max-width: none; }
        @page { size: A4; margin: 12mm; }
      }
    </style>
  </head>
  <body>
    <div class="toolbar">
      <input id="spotInput" placeholder="车位编号，例如 B2-078" maxlength="20">
      <button onclick="applySpot()">更新二维码</button>
      <button onclick="window.print()">打印</button>
    </div>

    <div class="poster">
      <div class="poster-top">
        <div class="kicker">Private Parking</div>
        <h1>想临时停一下？</h1>
        <div style="font-size:13.5px;color:#cbd5e1;line-height:1.7">
          扫码跟车主说一声，选好时间、留个电话就行<br>免费借用，到点挪车，互相方便
        </div>
        <div class="spot" id="spotLabel">私家车位</div>
      </div>

      <div class="poster-body">
        <div class="qr-wrap">
          <img id="qrImg" alt="扫码申请借用">
        </div>
        <div id="qrFail" class="qr-fail">
          二维码图片没能加载出来。用手机浏览器打开下面这个链接，点分享 → 生成二维码，截图替换即可。
        </div>
        <div class="scan-hint">微信扫一扫，申请借用</div>
        <div class="scan-sub">仅需 30 秒，无需下载任何 App</div>
        <div class="target-url" id="targetUrl"></div>

        <div class="steps">
          <div class="step"><b>1</b>扫码</div>
          <div class="step"><b>2</b>选时长、填电话</div>
          <div class="step"><b>3</b>等车主点头</div>
        </div>

        <div class="foot">
          <b>温馨提示</b><br>
          车位主人在家时会尽快回复；若 15 分钟内没有回应，说明车位主人可能不在，请另找位置。<br>
          这是私家车位，未经同意请别久停，谢谢理解 🙏
        </div>
      </div>
    </div>

    <script>
      var BASE = location.origin;
      var CURRENT_TARGET = '';

      function buildTarget(spot) {
        return BASE + '/' + (spot ? '?spot=' + encodeURIComponent(spot) : '');
      }

      // 二维码由 Worker 自己生成（/qr 返回 SVG），不依赖任何第三方图片服务
      function paintQr(target) {
        CURRENT_TARGET = target;
        var img = document.getElementById('qrImg');
        img.style.display = '';
        document.getElementById('qrFail').style.display = 'none';
        document.getElementById('targetUrl').style.display = 'none';
        img.src = '/qr?t=' + encodeURIComponent(target) + '&px=210';
      }

      function qrError() {
        document.getElementById('qrImg').style.display = 'none';
        document.getElementById('qrFail').style.display = 'block';
        var u = document.getElementById('targetUrl');
        u.style.display = 'block';
        u.textContent = CURRENT_TARGET;
      }

      function refresh(spot) {
        document.getElementById('spotLabel').textContent = spot || '私家车位';
        paintQr(buildTarget(spot));
      }

      function applySpot() {
        var v = (document.getElementById('spotInput').value || '').trim();
        try { localStorage.setItem('poster_spot', v); } catch (e) {}
        refresh(v);
        history.replaceState(null, '', '/poster' + (v ? '?spot=' + encodeURIComponent(v) : ''));
      }

      window.onload = function () {
        document.getElementById('qrImg').onerror = qrError;
        var qs = new URLSearchParams(location.search).get('spot') || '';
        var saved = '';
        try { saved = localStorage.getItem('poster_spot') || ''; } catch (e) {}
        var spot = qs || saved;
        document.getElementById('spotInput').value = spot;
        refresh(spot);
      };
    </script>
  </body>
  </html>
  `;

  return html(page)
}
