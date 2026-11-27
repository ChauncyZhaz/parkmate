// 本地预览：把 worker.js 跑在 Node 上（内存 KV，不写盘），方便在电脑/手机上先看界面
// 用法：node parking/preview.mjs  → http://localhost:8788
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import os from 'node:os'

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const PORT = Number(process.env.PORT || 8788)

class MemoryKV {
  constructor() { this.map = new Map() }
  async get(key) { return this.map.has(key) ? this.map.get(key).v : null }
  async put(key, value, opts) {
    this.map.set(key, { v: String(value), exp: opts && opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 })
  }
  async delete(key) { this.map.delete(key) }
  async list({ prefix = '', limit = 1000 } = {}) {
    return { keys: [...this.map.keys()].filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name })), list_complete: true }
  }
}

let handler = null
const sandbox = {
  addEventListener: (type, fn) => { if (type === 'fetch') handler = fn },
  console,
  // 本地预览默认不真推送到手机，只打印到控制台，避免误触发
  fetch: async (url, opts) => {
    console.log('[push]', String(url).slice(0, 160))
    return new Response(JSON.stringify({ code: 200, msg: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  },
  crypto: globalThis.crypto,
  URL, URLSearchParams, Request, Response, Headers,
  setTimeout, clearTimeout, setInterval, clearInterval,
  PARKING_KV: new MemoryKV(),
  SPOT_NAME: process.env.SPOT_NAME || '私家车位',
  OWNER_PHONE: process.env.OWNER_PHONE || '13800138000',
  // 本地固定凭证，方便直接打开 /owner?k=... 预览；线上请用 wrangler secret put OWNER_TOKEN
  OWNER_TOKEN: process.env.OWNER_TOKEN || 'local-preview-token',
  BARK_URL: process.env.BARK_URL || 'https://api.day.app/local-preview',
}
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8'), sandbox, { filename: 'worker.js' })

const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = chunks.length ? Buffer.concat(chunks) : undefined

  const url = 'http://' + (req.headers.host || 'localhost:' + PORT) + req.url
  const request = new Request(url, {
    method: req.method,
    headers: { ...req.headers, 'CF-Connecting-IP': req.socket.remoteAddress || '127.0.0.1' },
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  })

  const ev = { request, waitUntil: () => {}, respondWith(p) { this.p = p } }
  try {
    await handler(ev)
    const response = await ev.p
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch (e) {
    console.error(e)
    res.writeHead(500, { 'Content-Type': 'text/plain;charset=utf-8' })
    res.end('preview error: ' + (e && e.message))
  }
})

server.listen(PORT, () => {
  const nets = os.networkInterfaces()
  const lan = Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address)
  const k = encodeURIComponent(sandbox.OWNER_TOKEN)
  console.log('\n  本地预览已启动')
  console.log('  申请页   http://localhost:' + PORT + '/?spot=B2-078')
  console.log('  车主台   http://localhost:' + PORT + '/owner?k=' + k)
  console.log('  打印页   http://localhost:' + PORT + '/poster?spot=B2-078')
  if (lan.length) console.log('  手机同网段可访问  http://' + lan[0] + ':' + PORT + '/')
  console.log('\n  数据存在内存里，重启即清空；推送只打印不真发。')
  console.log('  车主台必须带 ?k=' + sandbox.OWNER_TOKEN + '（或设 OWNER_TOKEN 环境变量覆盖）\n')
})
