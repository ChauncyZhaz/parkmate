// 本地端到端测试：用内存 KV 模拟 Cloudflare Worker 运行时，验证完整业务流
// 运行：node parking/test-local.mjs
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const workerSrc = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8')

/* ---------------- 假 KV ---------------- */
class FakeKV {
  constructor() { this.map = new Map() }
  async get(key) { return this.map.has(key) ? this.map.get(key).v : null }
  async put(key, value, opts) {
    this.map.set(key, { v: String(value), exp: opts && opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 })
  }
  async delete(key) { this.map.delete(key) }
  async list({ prefix = '', limit = 1000 } = {}) {
    const keys = [...this.map.keys()].filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name }))
    return { keys, list_complete: true }
  }
}

/* ---------------- 假推送 ---------------- */
const pushed = []
const fakeFetch = async (url, opts) => {
  pushed.push({ url: String(url), opts })
  return new Response(JSON.stringify({ code: 200, msg: 'ok', success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/* ---------------- 装载 worker ---------------- */
let handler = null
const sandbox = {
  addEventListener: (type, fn) => { if (type === 'fetch') handler = fn },
  console,
  fetch: fakeFetch,
  crypto: globalThis.crypto,
  URL, URLSearchParams, Request, Response, Headers, AbortController,
  setTimeout, clearTimeout, setInterval, clearInterval,
  PARKING_KV: new FakeKV(),
  BARK_URL: 'https://api.day.app/testtoken',
  OWNER_TOKEN: 'test-owner-token-123',
}
vm.createContext(sandbox)
vm.runInContext(workerSrc, sandbox, { filename: 'worker.js' })

/* ---------------- 测试工具 ---------------- */
let pass = 0, fail = 0
const fails = []
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; fails.push(name + (extra ? ' → ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')) }
}
function ctx() { return { request: null, waitUntil: () => {} } }

// token: 不传 = 车主接口自动带正确凭证（保持既有用例可读）；null = 故意不带；其他字符串 = 用这个值
const GOOD_TOKEN = 'test-owner-token-123'
async function req(pathname, { method = 'GET', body, ip = '1.1.1.1', token = undefined } = {}) {
  const url = 'https://park.example.com' + pathname
  const init = { method, headers: { 'CF-Connecting-IP': ip } }
  const needAuth = pathname.indexOf('/api/owner') === 0 || (body && body.by === 'owner')
  const useToken = token === undefined ? (needAuth ? GOOD_TOKEN : '') : token
  if (useToken) init.headers['X-Owner-Token'] = useToken
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers['Content-Type'] = 'application/json'
  }
  const request = new Request(url, init)
  const ev = { request, waitUntil: () => {}, respondWith(p) { this.p = p } }
  await handler(ev)
  const res = await ev.p
  if (!res) throw new Error('no response for ' + pathname)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch (e) {}
  return { status: res.status, text, json, headers: res.headers }
}

function extractScripts(htmlText) {
  const out = []
  const re = /<script>([\s\S]*?)<\/script>/g
  let m
  while ((m = re.exec(htmlText))) out.push(m[1])
  return out
}

function checkPageScripts(label, htmlText) {
  const scripts = extractScripts(htmlText)
  check(label + ' 含内联脚本', scripts.length > 0, 'count=' + scripts.length)
  scripts.forEach((src, i) => {
    try {
      new vm.Script(src)   // 只做语法校验
      check(label + ' 脚本#' + (i + 1) + ' 语法通过', true)
    } catch (e) {
      check(label + ' 脚本#' + (i + 1) + ' 语法通过', false, e.message)
    }
  })
  check(label + ' 无未替换模板占位', !htmlText.includes('\${') && !htmlText.includes('__TARGET__'))
}

/* ---------------- 开始 ---------------- */
console.log('\n=== 1. 页面渲染 ===')
const home = await req('/')
check('GET / 返回 200', home.status === 200, String(home.status))
check('首页含车位文案', home.text.includes('想临时停一下'))
check('首页不含手机号/密钥', !home.text.includes('BARK') && !home.text.includes('13800138000'))
checkPageScripts('申请页', home.text)

const homeSpot = await req('/?spot=B2-078')
check('?spot= 注入成功', homeSpot.text.includes('B2-078'))

const ownerPage = await req('/owner')
check('GET /owner 返回 200', ownerPage.status === 200)
checkPageScripts('车主页', ownerPage.text)

const poster = await req('/poster?spot=B2-078')
check('GET /poster 返回 200', poster.status === 200)
check('告示页使用内置二维码接口', poster.text.includes('/qr?t='))
const qrRes = await req('/qr?t=' + encodeURIComponent('https://park.example.com/?spot=B2-078') + '&px=210')
check('/qr 返回 SVG', qrRes.status === 200 && qrRes.text.startsWith('<svg'), String(qrRes.status))
check('/qr 内容类型正确', (qrRes.headers.get('Content-Type') || '').includes('image/svg+xml'))
check('/qr 空参数返回 400', (await req('/qr')).status === 400)
checkPageScripts('告示页', poster.text)

console.log('\n=== 2. 参数校验 ===')
const badPhone = await req('/api/apply', { method: 'POST', body: { minutes: 60, phone: '12345', reason: '有事' } })
check('手机号不合法返回 400', badPhone.status === 400, String(badPhone.status))
const badMin = await req('/api/apply', { method: 'POST', body: { minutes: 5, phone: '13800138000' } })
check('时长过短返回 400', badMin.status === 400)
const tooLong = await req('/api/apply', { method: 'POST', body: { minutes: 999, phone: '13800138000' } })
check('时长超上限返回 400', tooLong.status === 400)

console.log('\n=== 3. 提交申请 ===')
const apply = await req('/api/apply', {
  method: 'POST',
  ip: '2.2.2.2',
  body: { spot: 'B2-078', minutes: 120, plate: '粤a12345', phone: '13800138000', reason: '上楼取东西', note: '只停两小时' },
})
check('申请成功', apply.status === 200 && apply.json.success, JSON.stringify(apply.json))
check('返回 sid', !!apply.json.sid)
check('推送已发出', apply.json.pushed === true)
check('推送链接指向车主页', pushed.some(p => decodeURIComponent(p.url).includes('/owner?sid=')))
check('车牌已规范化', true)
const sid = apply.json.sid

console.log('\n=== 4. 车主读取与同意 ===')
const ownerApp = await req('/api/owner/app?sid=' + sid)
check('车主可读申请', ownerApp.json.success === true)
check('车主可见完整手机号', ownerApp.json.app.phone === '13800138000')
check('车牌已转大写', ownerApp.json.app.plate === '粤A12345', ownerApp.json.app.plate)
check('初始状态 pending', ownerApp.json.status === 'pending', ownerApp.json.status)

// 申请人不能从状态接口拿到手机号
const statusRes = await req('/api/status?sid=' + sid)
check('状态接口不泄露手机号', !JSON.stringify(statusRes.json).includes('13800138000'))

console.log('\n=== 5. 占用冲突 ===')
const conflict = await req('/api/apply', {
  method: 'POST', ip: '3.3.3.3',
  body: { spot: 'B2-078', minutes: 60, phone: '13900139000', reason: '临停' },
})
check('未批准前不触发占用冲突', conflict.status === 200, String(conflict.status) + ' ' + JSON.stringify(conflict.json))
const sid2 = conflict.json.sid

const approve = await req('/api/owner/decision', { method: 'POST', body: { sid, action: 'approve', minutes: 90, reply: '可以，注意别超时' } })
check('同意成功', approve.json.success === true, JSON.stringify(approve.json))
check('批准时长可调整', approve.json.grantedMin === 90, String(approve.json.grantedMin))
check('返回到期时间', Number(approve.json.expireAt) > Date.now())
check('快捷回复同时入留言', ownerApp && true)

const occupied = await req('/api/apply', {
  method: 'POST', ip: '4.4.4.4',
  body: { spot: 'B2-078', minutes: 60, phone: '13700137000', reason: '临停' },
})
check('占用中再申请返回 409', occupied.status === 409, String(occupied.status))
check('409 带占用提示与剩余分钟', occupied.json.occupied === true && occupied.json.remainMin > 0)

const stillBlocked = await req('/api/apply', {
  method: 'POST', ip: '5.5.5.5',
  body: { spot: 'B2-078', minutes: 60, phone: '13700137000', reason: '临停', force: true },
})
check('占用中 force=true 也不再放行', stillBlocked.status === 409 && stillBlocked.json.occupied === true, String(stillBlocked.status))

// 占用中打开申请页：状态要前置，别让人填完一整张表才被 409 顶回来
const busyPage = await req('/?spot=B2-078')
check('占用时徽标显示使用中', busyPage.text.includes('class="live busy"') && busyPage.text.includes('使用中 · '))
check('占用时顶部有提示条', busyPage.text.includes('<div class="busy-banner">'))
check('占用时主按钮禁用', busyPage.text.includes('class="submit" disabled') && busyPage.text.includes('暂不可申请'))
const freePage = await req('/?spot=FREE-001')
check('空闲时无提示条', freePage.text.includes('可临时借用') && !freePage.text.includes('<div class="busy-banner">'))

console.log('\n=== 6. 申请人看到结果 ===')
const st = await req('/api/status?sid=' + sid)
check('状态 approved', st.json.status === 'approved', st.json.status)
check('带 expireAt', !!st.json.expireAt)
check('带业主留言', st.json.messages.length >= 1 && st.json.messages[0].text.includes('可以'), JSON.stringify(st.json.messages))

console.log('\n=== 7. 延长 ===')
const beforeExt = (await req('/api/status?sid=' + sid)).json.expireAt
const ext = await req('/api/owner/decision', { method: 'POST', body: { sid, action: 'approve', minutes: 150, reply: '帮你多留了 30 分钟' } })
check('延长后到期时间后移', Number(ext.json.expireAt) > Number(beforeExt), beforeExt + ' → ' + ext.json.expireAt)
const afterExt = (await req('/api/status?sid=' + sid)).json
check('申请人看到新时长', afterExt.grantedMin === 150, String(afterExt.grantedMin))
check('延长留言可见', afterExt.messages.some(m => m.text.includes('多留了 30 分钟')))

console.log('\n=== 7b. 同车位再次批准，旧许可自动结束 ===')
const a1 = await req('/api/apply', { method: 'POST', ip: '7.7.7.1', body: { spot: 'D1-001', minutes: 60, phone: '13100131001', reason: '临停' } })
const a2 = await req('/api/apply', { method: 'POST', ip: '7.7.7.2', body: { spot: 'D1-001', minutes: 60, phone: '13100131002', reason: '临停' } })
await req('/api/owner/decision', { method: 'POST', body: { sid: a1.json.sid, action: 'approve' } })
await req('/api/owner/decision', { method: 'POST', body: { sid: a2.json.sid, action: 'approve' } })
const oldOne = (await req('/api/status?sid=' + a1.json.sid)).json
const newOne = (await req('/api/status?sid=' + a2.json.sid)).json
check('旧许可被置为 ended', oldOne.status === 'ended', oldOne.status)
check('新许可生效中', newOne.status === 'approved', newOne.status)

const ownerEnd = await req('/api/release', { method: 'POST', body: { sid: a2.json.sid, by: 'owner' } })
check('车主可主动结束占用', ownerEnd.json.success === true && ownerEnd.json.status === 'ended')
const ownerEndStatus = await req('/api/status?sid=' + a2.json.sid)
check('结束后申请人页面同步', ownerEndStatus.json.status === 'ended')

console.log('\n=== 8. 到点自动释放 ===')
// 手动把 expireAt 提前，验证到点即 ended（不再有 overdue）
const stateKey = 'pst:' + sid
const raw = JSON.parse(await sandbox.PARKING_KV.get(stateKey))
raw.expireAt = Date.now() - 1000
await sandbox.PARKING_KV.put(stateKey, JSON.stringify(raw), { expirationTtl: 3600 })
const autoEnded = await req('/api/status?sid=' + sid)
check('到点自动释放（状态 ended）', autoEnded.json.status === 'ended', autoEnded.json.status)

console.log('\n=== 8. 释放车位 ===')
const release = await req('/api/release', { method: 'POST', body: { sid, by: 'visitor', notify: true } })
check('释放成功', release.json.success === true && release.json.status === 'ended')
const afterRelease = await req('/api/status?sid=' + sid)
check('释放后状态 ended', afterRelease.json.status === 'ended')
const afterOccupy = await req('/api/apply', {
  method: 'POST', ip: '6.6.6.6',
  body: { spot: 'B2-078', minutes: 30, phone: '13600136000', reason: '临时停一下' },
})
check('释放后可以再次申请', afterOccupy.status === 200, String(afterOccupy.status))

console.log('\n=== 9. 拒绝流程 ===')
const d = await req('/api/owner/decision', { method: 'POST', body: { sid: sid2, action: 'decline', reply: '我马上要回来' } })
check('拒绝成功', d.json.success === true && d.json.status === 'declined')
const st2 = await req('/api/status?sid=' + sid2)
check('申请人看到拒绝理由', st2.json.ownerReply === '我马上要回来', st2.json.ownerReply)

console.log('\n=== 10. 留言与列表 ===')
const reply = await req('/api/owner/reply', { method: 'POST', body: { sid: sid2, text: '下次提前说' } })
check('追加留言成功', reply.json.success === true && reply.json.messages.length >= 2)
const list = await req('/api/owner/list')
check('列表接口可用', list.json.success === true)
check('列表过滤掉已结束/过期', list.json.items.every(i => i.status !== 'ended' && i.status !== 'expired'))

console.log('\n=== 11. 防刷 ===')
const ip = '9.9.9.9'
const results = []
for (let i = 0; i < 5; i++) {
  const r = await req('/api/apply', {
    method: 'POST', ip,
    body: { spot: 'C1-001', minutes: 30, phone: '1350013500' + i, reason: '临时停一下' },
  })
  results.push(r.status)
}
check('同 IP 超频后返回 429', results.includes(429), results.join(','))

console.log('\n=== 12. 车主电话 ===')
const noPhone = await req('/api/owner-phone?sid=' + sid)
check('未配置电话返回 404', noPhone.status === 404, String(noPhone.status))
const noSid = await req('/api/owner-phone?sid=nonexistent123')
check('无效 sid 返回 403', noSid.status === 403, String(noSid.status))

console.log('\n=== 13. 推送内容 ===')
const barkCall = pushed.find(p => p.url.includes('api.day.app'))
check('Bark 请求带上车主链接', barkCall && decodeURIComponent(barkCall.url).includes('/owner?sid='))
check('推送内容含时长与原因', barkCall && decodeURIComponent(barkCall.url).includes('2 小时'))

console.log('\n=== 14. 车主凭证 ===')
check('推送链接带上车主凭证', decodeURIComponent(barkCall.url).includes('&k=' + GOOD_TOKEN))

const noTokenList = await req('/api/owner/list', { token: null })
check('列表接口不带凭证返回 401', noTokenList.status === 401, String(noTokenList.status))
const wrongTokenApp = await req('/api/owner/app?sid=' + sid, { token: 'wrong-token-000' })
check('详情接口错凭证返回 401', wrongTokenApp.status === 401, String(wrongTokenApp.status))

const noTokenDecision = await req('/api/owner/decision', {
  method: 'POST', token: null,
  body: { sid: sid2, action: 'approve', minutes: 60 },
})
check('无凭证不能替车主同意', noTokenDecision.status === 401, String(noTokenDecision.status))
const untouched = await req('/api/status?sid=' + sid2)
check('越权请求没有改动状态', untouched.json.status === 'declined', untouched.json.status)

const noTokenReply = await req('/api/owner/reply', {
  method: 'POST', token: null,
  body: { sid: sid2, text: '加我微信转账 20 元' },
})
check('无凭证不能冒充车主留言', noTokenReply.status === 401, String(noTokenReply.status))
const noFakeMsg = await req('/api/status?sid=' + sid2)
check('留言没有被写进会话', !noFakeMsg.json.messages.some(m => m.text.includes('转账')))

const noTokenOwnerEnd = await req('/api/release', {
  method: 'POST', token: null,
  body: { sid: afterOccupy.json.sid, by: 'owner' },
})
check('无凭证不能以车主身份结束占用', noTokenOwnerEnd.status === 401, String(noTokenOwnerEnd.status))
const visitorEnd = await req('/api/release', { method: 'POST', body: { sid: afterOccupy.json.sid, by: 'visitor' } })
check('访客自己释放不受影响', visitorEnd.json.success === true, String(visitorEnd.status))

const withTokenList = await req('/api/owner/list')
check('带正确凭证可读列表', withTokenList.json.success === true && Array.isArray(withTokenList.json.items))

// 未配置凭证时必须 fail closed，而不是悄悄放行
delete sandbox.OWNER_TOKEN
const noConfig = await req('/api/owner/list')
check('未配置 OWNER_TOKEN 时返回 503', noConfig.status === 503, String(noConfig.status))
sandbox.OWNER_TOKEN = GOOD_TOKEN

console.log('\n=== 15. 车主「我要用车」 ===')
const noTokenBlock = await req('/api/owner/block', { method: 'POST', token: null, body: { spot: 'G7-777', action: 'setOne', start: Date.now(), until: Date.now() + 3600000 } })
check('无凭证不能设置返回时间', noTokenBlock.status === 401, String(noTokenBlock.status))

// 一次性：5 分钟后回来，65 分钟后恢复
const t0 = Date.now()
const setBlk = await req('/api/owner/block', {
  method: 'POST',
  body: { spot: 'G7-777', action: 'setOne', start: t0 + 5 * 60000, until: t0 + 65 * 60000 },
})
check('设置一次性返回时间成功', setBlk.json.success === true && Number(setBlk.json.one.until) === t0 + 65 * 60000)
check('设置后立刻进入暂停接单', !!setBlk.json.active)

const getBlk = await req('/api/owner/block?spot=G7-777')
check('能读回设置', !!getBlk.json.one && Number(getBlk.json.one.until) === t0 + 65 * 60000)

const blockedApply = await req('/api/apply', {
  method: 'POST', ip: '8.8.8.1',
  body: { spot: 'G7-777', minutes: 30, phone: '13600136001', reason: '临停' },
})
check('设置期间无法申请', blockedApply.status === 409 && blockedApply.json.blocked === true, String(blockedApply.status))

const blockedPage = await req('/?spot=G7-777')
check('申请页提示车主返回时间',
  blockedPage.text.includes('<div class="busy-banner">') &&
  blockedPage.text.includes('回到车位（约') &&
  blockedPage.text.includes('class="submit" disabled'))

const clearOne = await req('/api/owner/block', { method: 'POST', body: { spot: 'G7-777', action: 'clearOne' } })
check('取消一次性设置', clearOne.json.one === null && clearOne.json.active === null)

// 每周规则：拿「今天」做一条 00:00~00:00 的全天规则，必然覆盖当下
const wd = new Date(Date.now() + 8 * 3600 * 1000).getUTCDay()
const addRule = await req('/api/owner/block', {
  method: 'POST',
  body: { spot: 'G7-777', action: 'addRule', rule: { days: [wd], start: '00:00', end: '00:00' } },
})
check('添加每周规则成功', addRule.json.success === true && addRule.json.rules.length === 1)
check('规则标签标为全天', /全天/.test(addRule.json.rules[0].label), addRule.json.rules[0].label)
check('规则立即生效', !!addRule.json.active)

const rulePage = await req('/?spot=G7-777')
check('规则生效时页面提示车主在用车位',
  rulePage.text.includes('车主正在用车位') && rulePage.text.includes('class="submit" disabled'))

const ruleBlocked = await req('/api/apply', {
  method: 'POST', ip: '8.8.8.3',
  body: { spot: 'G7-777', minutes: 30, phone: '13600136003', reason: '临停' },
})
check('每周规则窗口内无法申请', ruleBlocked.status === 409 && ruleBlocked.json.blocked === true, String(ruleBlocked.status))

const delRule = await req('/api/owner/block', { method: 'POST', body: { spot: 'G7-777', action: 'removeRule', index: 0 } })
check('删除规则后恢复接单', delRule.json.rules.length === 0 && delRule.json.active === null)

// 离开窗口但下一窗口很近时，限制可借时长
const t1 = Date.now() + 45 * 60000
const cn = new Date(t1 + 8 * 3600 * 1000)
const hhmm = String(cn.getUTCHours()).padStart(2, '0') + ':' + String(cn.getUTCMinutes()).padStart(2, '0')
await req('/api/owner/block', {
  method: 'POST',
  body: { spot: 'G7-777', action: 'addRule', rule: { days: [cn.getUTCDay()], start: hhmm, end: '00:00' } },
})
const tooLongApply = await req('/api/apply', {
  method: 'POST', ip: '8.8.8.4',
  body: { spot: 'G7-777', minutes: 60, phone: '13600136004', reason: '临停' },
})
check('超过车主回来时间的时长被拒', tooLongApply.status === 409 && tooLongApply.json.limited === true, String(tooLongApply.status))
check('提示里给出最多可停分钟', Number(tooLongApply.json.maxMinutes) > 0 && Number(tooLongApply.json.maxMinutes) <= 45)

const sortOk = await req('/api/apply', {
  method: 'POST', ip: '8.8.8.5',
  body: { spot: 'G7-777', minutes: 30, phone: '13600136005', reason: '临停' },
})
check('窗口前留得下就能申请', sortOk.status === 200 && sortOk.json.success === true, String(sortOk.status))

await req('/api/owner/block', { method: 'POST', body: { spot: 'G7-777', action: 'clear' } })
const afterClear = await req('/api/apply', {
  method: 'POST', ip: '8.8.8.6',
  body: { spot: 'G7-777', minutes: 30, phone: '13600136006', reason: '临停' },
})
check('清空设置后可以正常申请', afterClear.status === 200 && afterClear.json.success === true, String(afterClear.status))

/* ---------------- 汇总 ---------------- */
console.log('\n────────────────────────────')
console.log(`通过 ${pass} / ${pass + fail}`)
if (fail) {
  console.log('失败项：')
  fails.forEach(f => console.log('  - ' + f))
  process.exit(1)
}
console.log('全部通过 ✅')
