# 车位临时借用系统（Cloudflare Worker 单文件版）

贴在车位柱子/墙面上的二维码告示：路人想临时占一下，扫码 → 选时长、填原因、留电话 → 车主手机收到推送 →
点开就能「同意 / 不方便 / 回一句话」，访客页面实时显示结果和倒计时。

与挪车版一样，整站只有一个 `worker.js`，跑在 Cloudflare Workers 上，数据存 KV，推送接 Bark / PushPlus / WxPusher。

## 界面预览

不部署也能看效果——直接用浏览器打开本仓库的 `preview-requester.html` / `preview-owner.html`，或在 GitHub 上点下面的在线预览：

| 申请人页面 | 车主页面 |
|:---:|:---:|
| [🔗 在线预览](https://htmlpreview.github.io/?https://github.com/ChauncyZhaz/parkmate/blob/main/preview-requester.html) | [🔗 在线预览](https://htmlpreview.github.io/?https://github.com/ChauncyZhaz/parkmate/blob/main/preview-owner.html) |

## 三条链路

| 页面 | 地址 | 谁用 |
| --- | --- | --- |
| 申请页 | `/` 或 `/?spot=B2-078` | 扫码的路人 |
| 车主台 | `/owner`（列表） / `/owner?sid=xxx`（单条） | 你自己，从推送点进来 |
| 打印页 | `/poster?spot=B2-078` | 你，打印后贴出去 |

## 主要功能

**访客侧**
- 时长：30 分钟 / 1 小时 / 2 小时 / 4 小时 / 自定义（15 分钟 ~ 8 小时）
- 原因：快捷标签 + 自由补充（"上楼取东西""接人送人"…）
- 车牌（可选，方便车主核对）、手机号（必填，11 位校验）、补充说明
- 提交后实时看状态：等待中 → 已同意（含倒计时）→ 到期提醒 → 已结束
- 到期后页面上会变成「已超过允许时间，请尽快驶离」
- 「我已驶离」按钮：提前释放车位，车主会收到一条推送
- 离开页面后重新扫码，凭本地会话自动回到结果页，不用再填一遍

**车主侧**
- 推送里点开就是这条申请：车牌、要停多久、原因、完整手机号（一键拨号）
- 同意时可改批准时长（比如对方要 2 小时，你只给 1 小时）
- 可以回快捷话术（"可以，注意别超时"）或自己写一句，会同时进留言板
- 已同意的还能「＋30 分钟」延长或「结束占用」提前收回
- 不带 `sid` 打开 `/owner` 会列出所有待处理 / 进行中的申请

**工程侧（原挪车项目踩过的坑都保留了）**
- `sid` 会话隔离，所有 KV key 带前缀；只接受 `[A-Za-z0-9_-]`，避免构造任意 key
- 车位同一时刻只认一条生效许可：批准新的会自动把旧的置为 ended
- 车位占用中再提交会返回 409 并提示"预计 HH:MM 释放"，用户可选择仍然排队
- 待处理申请 15 分钟无人处理自动失效
- 手机号只走 `/api/owner/app` 返回，申请页 HTML 和 `/api/status` 里都没有明文号码
- **二维码由 Worker 自己生成**（`/qr` 返回 SVG），不依赖任何第三方图片接口，断网/墙了也能打印
- 按 IP 限流（3 次/分钟），所有 API `Cache-Control: no-store`

## 部署

### 一键部署（推荐，fork 后 0 代码改动）

前提：有 Cloudflare 账号、装了 Node.js 18+。

```bash
git clone https://github.com/你的用户名/parkmate.git
cd parkmate
npm install            # 顺带装上 wrangler
npx wrangler login     # 浏览器里授权一次
npm run deploy         # 建 KV → 回填 id → 部署，全自动
```

`scripts/deploy.mjs` 会自动完成：

1. 发现 `wrangler.toml` 里的 KV id 还是占位符；
2. 去你账号里找同名 KV，找不到才创建（重复执行不会重复建）；
3. 把拿到的 id 回填进 `wrangler.toml`；
4. 执行 `wrangler deploy`，并打印你的 `*.workers.dev` 地址。

全程不用改任何代码。部署完直接打开 `/poster?spot=B2-078` 打印二维码就能贴。

只想看它会做什么、不真正执行：

```bash
node scripts/deploy.mjs --dry-run
```

> 唯一躲不掉的是 `wrangler login`——Cloudflare 的资源都绑在账号下，任何部署方式都得先授权一次。

### 方式一：Dashboard 点几下

1. **建 KV**：Workers & Pages → KV → Create namespace，名字随便（如 `parking`）
2. **建 Worker**：Create Worker → 把 `worker.js` 全部内容粘进去 → Deploy
3. **绑 KV**：Worker → Settings → Variables → KV Namespace Bindings，Variable name 填 **`PARKING_KV`**，选中刚建的命名空间
4. **加环境变量**（同页 Variables，按需）：

| 变量 | 说明 |
| --- | --- |
| `SPOT_NAME` | 默认车位名，如 `B2-078 私家车位` |
| `SPOT_NOTE` | 访客看到的一句说明 |
| `OWNER_PHONE` | 你的手机号，仅用于"联系车主"按钮（建议加为 Secret） |
| `BARK_URL` | `https://api.day.app/你的key` |
| `PUSHPLUS_TOKEN` / `PUSHPLUS_TOPIC` | PushPlus 推送 |
| `WXPUSHER_TOKEN` / `WXPUSHER_UIDS` / `WXPUSHER_TOPIC_IDS` | WxPusher（微信服务号推送） |

> 三个推送渠道配上任意一个就够，全配也行，**任一成功即视为成功**。
> 不配也能用：申请照常记录，只是不会主动提醒你，需要自己打开 `/owner` 看。

5. **对外域名**：可以直接用 `xxx.workers.dev`，也可以绑自己的域名（推荐，扫码域名短、国内访问稳）

### 方式二：wrangler

```bash
npm i -g wrangler
wrangler login
wrangler kv namespace create PARKING_KV   # 把输出的 id 填进 wrangler.toml
wrangler deploy
```

`wrangler.toml` 已经放在同目录，改 `id` 即可。手机号建议用 Secret：

```bash
wrangler secret put OWNER_PHONE
```

## 打印告示

打开 `https://你的域名/poster?spot=B2-078`：

- 输入框里填车位编号 → 点"更新二维码" → 点"打印"
- 二维码指向 `https://你的域名/?spot=B2-078`，扫一下就能申请
- 打印用 A4，建议塑封或塞进透明文件袋，贴在柱子朝向车位的一侧

**一个 Worker 管多个车位**：每张告示用不同的 `?spot=` 参数即可，占用状态按车位分别记录，互不影响。

## 本地预览 / 测试

```bash
npm run dev
# 申请页 http://localhost:8788/?spot=B2-078
# 车主台 http://localhost:8788/owner
# 打印页 http://localhost:8788/poster?spot=B2-078
# 手机同网段访问 http://<你的内网IP>:8788
```

本地用内存 KV，重启即清空；推送只打印到控制台不会真发。

```bash
npm test        # 等同于 node test-local.mjs
# 64 项端到端断言，覆盖申请/同意/拒绝/延长/释放/冲突/限流/隐私
```

## 状态机

```
pending ──同意──> approved ──到点未走──> overdue ──驶离──> ended
   │                  └────────延长/提前结束──────┘
   ├──拒绝──> declined
   └──15 分钟无人处理──> expired
```

`overdue` 和 `expired` 都是按时间**算**出来的，不需要定时任务。

## 几个注意点

- **QR 扫不出来**：确认海报里二维码是黑白的、有 4 格白边（已内置），打印不要缩放到模糊；如果域名太长（>200 字节）会生成失败，用短域名。
- **收不到推送**：先看 Worker 日志（`wrangler tail`），Bark 检查 key、PushPlus 检查 token 是否过期、WxPusher 检查 uid 是否订阅。
- **隐私**：KV 里存了访客手机号，4 小时后随 TTL 自动删除；车主链接请勿外传，谁拿到 `sid` 谁就能看到号码。
- **不做的事**：不收款、不锁车位、不接道闸，就是个"打招呼"的通道。
