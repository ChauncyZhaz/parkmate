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
- 扫码即见车位状态：空闲是「可临时借用」，占用中是「使用中 · 18:30 释放」+ 黄色提示条，提交按钮直接置灰，等空出来才能申请
- 时长：30 分钟 / 1 小时 / 2 小时 / 4 小时 / 自定义（15 分钟 ~ 8 小时）
- 原因：快捷标签 + 自由补充（"上楼取东西""接人送人"…）
- 车牌（可选，方便车主核对）、手机号（必填，11 位校验）、补充说明
- 提交后实时看状态：等待中 → 已同意（含倒计时）→ 到期提醒 → 已结束
- 到点后页面自动变成「本次借用已结束」，车位同时释放，不用谁去点确认
- 「我已驶离」按钮：提前释放车位，车主会收到一条推送
- 离开页面后重新扫码，凭本地会话自动回到结果页，不用再填一遍

**车主侧**
- 「我要用车」：设「几点回来、几点恢复接单」，可一次性也可按星期重复（工作日 17:00→次日 08:00、周末全天）；窗口内访客页显示「车主 17:00 回来」并禁止申请，窗口外也会限制可借时长，保证你回来前车位能空出来
- 推送里点开就是这条申请：车牌、要停多久、原因、完整手机号（一键拨号）
- 同意时可改批准时长（比如对方要 2 小时，你只给 1 小时）
- 可以回快捷话术（"可以，注意别超时"）或自己写一句，会同时进留言板
- 已同意的还能「＋30 分钟」延长或「结束占用」提前收回
- 不带 `sid` 打开 `/owner` 会列出所有待处理 / 进行中的申请

**工程侧（原挪车项目踩过的坑都保留了）**
- `sid` 会话隔离，所有 KV key 带前缀；只接受 `[A-Za-z0-9_-]`，避免构造任意 key
- 车位同一时刻只认一条生效许可：批准新的会自动把旧的置为 ended
- 车位占用中一律不允许提交（返回 409，提示"预计 HH:MM 释放"），**没有排队**：一个车位同时只挂一条申请，避免批准新的一条把正在停的顶掉
- 待处理申请 15 分钟无人处理自动失效
- 手机号只走 `/api/owner/app` 返回，申请页 HTML 和 `/api/status` 里都没有明文号码
- **二维码由 Worker 自己生成**（`/qr` 返回 SVG），不依赖任何第三方图片接口，断网/墙了也能打印
- 按 IP 限流（3 次/分钟），所有 API `Cache-Control: no-store`
- 「我要用车」存成 `pblk:{spot}`：一次性窗口 + 每周规则取并集，时间按东八区算；规则里 `结束 ≤ 开始` 表示跨夜，`结束 == 开始` 表示全天（周末全天就是这么存的）

## 部署

三种方式任选其一。**推荐方式一**：fork 一次 + 后台关联一次，之后 push 自动部署，全程不改代码。

> ⚠️ 不管用哪种方式，部署完先配 `OWNER_TOKEN`（见下面「车主凭证」）。没配的话 `/owner` 和所有 `/api/owner/*` 会返回 503——这是故意的，不是故障。

### 方式一：Cloudflare 后台关联 Git（推荐，fork 后 0 代码改动）

1. Fork 本仓库到自己账号
2. Cloudflare Dashboard → **Workers & Pages** → **Create application** → 选 **GitHub**
3. 授权 GitHub，选中 fork 后的 `parkmate` 仓库
4. 构建命令留空，直接 **Save and Deploy**（会自动读取仓库里的 `wrangler.toml`）
5. 首次部署时**自动创建 KV**（名字类似 `parkmate-PARKING_KV`）；之后每次 push 到 `main` 自动重新部署，KV 一直保持绑定、数据不丢

> Worker 名称必须与 `wrangler.toml` 里的 `name`（`parkmate`）一致，否则构建会失败。
> 通过后台部署时，KV 的 id 不会写回仓库（在 Dashboard 的 Storage & Databases → KV 里能看到），但资源会一直绑着，不用管。

部署完直接访问 `/poster?spot=B2-078` 打印二维码。

### 方式二：本地命令行一键部署

```bash
git clone https://github.com/你的用户名/parkmate.git
cd parkmate
npm install            # 顺带装上 wrangler
npx wrangler login     # 浏览器里授权一次
npm run deploy         # 自动建 KV + 部署
```

脚本会优先交给 Wrangler 自动供应 KV（4.45+ 默认开启），旧版本则退化为"手动建 KV + 回填 id"，
最后打印你的 `*.workers.dev` 地址。只想看它会做什么：`node scripts/deploy.mjs --dry-run`。

### 方式三：纯手动粘贴（完全不碰命令行）


1. **建 KV**：Workers & Pages → KV → Create namespace，名字随便（如 `parking`）
2. **建 Worker**：Create Worker → 把 `worker.js` 全部内容粘进去 → Deploy
3. **绑 KV**：Worker → Settings → Variables → KV Namespace Bindings，Variable name 填 **`PARKING_KV`**，选中刚建的命名空间
4. **加环境变量**（同页 Variables，按需）：

| 变量 | 说明 |
| --- | --- |
| `OWNER_TOKEN` | **必填**。车主台凭证，至少 8 位，建议加为 Secret（`wrangler secret put OWNER_TOKEN`） |
| `SPOT_NAME` | 默认车位名，如 `B2-078 私家车位` |
| `SPOT_NOTE` | 访客看到的一句说明 |
| `OWNER_PHONE` | 你的手机号，仅用于"联系车主"按钮（建议加为 Secret） |
| `BARK_URL` | `https://api.day.app/你的key` |
| `PUSHPLUS_TOKEN` / `PUSHPLUS_TOPIC` | PushPlus 推送 |
| `WXPUSHER_TOKEN` / `WXPUSHER_UIDS` / `WXPUSHER_TOPIC_IDS` | WxPusher（微信服务号推送） |

> 三个推送渠道配上任意一个就够，全配也行，**任一成功即视为成功**。
> 不配也能用：申请照常记录，只是不会主动提醒你，需要自己打开 `/owner` 看。

5. **对外域名**：可以直接用 `xxx.workers.dev`，也可以绑自己的域名（推荐，扫码域名短、国内访问稳）

## 车主凭证（OWNER_TOKEN）

车主台不是公开页面。`/api/owner/list`、`/api/owner/app`、`/api/owner/decision`、`/api/owner/reply`，以及以车主身份结束占用，全部要凭证。

为什么非要这个：`/api/owner/list` 会把进行中申请的 `sid` 列出来，顺着 `sid` 就能读到明文手机号，还能替车主点同意、替车主回话。`sid` 本身猜不到（UUID），但列表接口会主动把它交出去——不设凭证等于把车主台敞开。

- **配置**：`wrangler secret put OWNER_TOKEN`，随便一串 ≥ 8 位（别用手机号/生日）。本地 `npm run dev` 默认是 `local-preview-token`。
- **链接形态**：推送里是 `/owner?sid=xxx&k=你的token`，点开就带上了；页面会把 `k` 存在本标签页，之后在车主台里跳转不用再带。
- **换凭证**：再执行一次 `secret put`，旧链接立刻失效，从最新一条推送重新进。
- **没配凭证**：车主接口返回 503 并提示怎么配，**不会**退化成"谁都能看"。

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
# 车主台 http://localhost:8788/owner?k=local-preview-token
# 打印页 http://localhost:8788/poster?spot=B2-078
# 手机同网段访问 http://<你的内网IP>:8788
```

本地用内存 KV，重启即清空；推送只打印到控制台不会真发。

```bash
npm test        # 等同于 node test-local.mjs
# 96 项端到端断言，覆盖申请/同意/拒绝/延长/自动释放/冲突/限流/隐私/车主凭证/占用态渲染/我要用车
```

## 状态机

```
pending ──同意──> approved ──到点自动释放──> ended
   │                  └───── 我已驶离 / 车主结束 ─────┘
   ├──拒绝──> declined
   └──15 分钟无人处理──> expired
```

`ended`（到点）和 `expired` 都是按时间**算**出来的，不需要定时任务；车位到点自动释放，不会留一条"已超时"在列表里等你手动收尾。提前走的话仍可以点「我已驶离」，车主也能随时「结束占用」。

## 几个注意点

- **QR 扫不出来**：确认海报里二维码是黑白的、有 4 格白边（已内置），打印不要缩放到模糊；如果域名太长（>200 字节）会生成失败，用短域名。
- **收不到推送**：先看 Worker 日志（`wrangler tail`），Bark 检查 key、PushPlus 检查 token 是否过期、WxPusher 检查 uid 是否订阅。
- **隐私**：KV 里存了访客手机号，4 小时后随 TTL 自动删除。车主链接里的 `k` 等于钥匙，别转发、别截图；外泄了就重新 `secret put` 换一个。访客自己的链接只有 `sid`，读不到手机号。
- **不做的事**：不收款、不锁车位、不接道闸，就是个"打招呼"的通道。
