# cortico-world-astrbot

<img src="./assets/icon.png" width="88" alt="AstrBot · QQ" align="right">

QQ + AstrBot + Coo：不用换 QQ，不用搬 AstrBot 插件，只把「说话的人」换成 Coo。

QQ 里的人继续在群和私聊里说话；AstrBot 继续管账号、插件、工具和语音；Coo 带着自己的性格和记忆进来回复。

在 QQ 私聊可以接着 Coo 桌面聊。完整模式可开放指定 QQ 群和私聊，支持点名唤醒或接收群消息、回复时 @ 成员、调用已授权的 AstrBot 工具，以及从桌面以机器人身份给已授权会话发消息。两种模式都沿用当前 Coo 的人格、模型和主会话。

**当前版本 1.3.11，配套 AstrBot 桥插件 1.3.11**

项目地址：[as124da1231/cortico-world-astrbot](https://github.com/as124da1231/cortico-world-astrbot)。

Coo 可以查看 QQ 引用、合并转发和附件详情。引用保留可用的原图和转写，转发可按条展开，图片和语音按需读取。文件和视频提供名称、大小等适配器已返回的信息。媒体来源失效时，Coo 会说明当前能读到的内容。

## Discord 接入

使用支持 Discord 的两端版本。在 AstrBot 的「机器人」页配置 Discord 适配器，再在「Coo 桥控制台 → Discord」选择该实例。填主人用户 ID 并启用接入。该账号首次私信会绑定当前私聊，绑定后可再发一条消息开始对话。完整模式可额外放行指定频道，频道里需直接 @ 机器人。

Coo 使用现有桥地址和桥接令牌。在「平台」页查看桥上报的实例及绑定状态。两种模式共用 Coo 主对话，回复及历史工具按 AstrBot 的会话 UMO 路由。

## 为什么使用 AstrBot 桥

Cortico 自带的 `qq` World 能直接连 OneBot 协议端，但它只做收发消息。如果你的 QQ 号上已经有一整套 AstrBot 插件（画图、点歌、战绩查询、媒体解析……），换掉那套生态的代价很高。

这个 World 因此不碰 QQ：它连的是 **AstrBot 侧的一个桥**，由桥负责 QQ 收发。分工是：

```
QQ 群
  │  OneBot v11
  ▼
AstrBot（现有连接、现有插件，都不动）
  │  OnLLMRequestEvent 钩子拦截
  ▼
插件① astrbot_plugin_cortico_bridge   ← 服务器侧，Python
  │  WebSocket（AstrBot 当服务端）
  ▼
插件② cortico-world-astrbot           ← 本包，Cortico 侧，TypeScript
  │  pushEvent / 工具回执
  ▼
Cortico Core（Persona、Memory、事件流）
```

**方向为什么是「AstrBot 当服务端」**：服务器通常有公网地址，家用机器通常没有。让能被动接受连接的一方当服务端，就不必再搭内网穿透。

## 安装前要知道

这个 World 只负责「说话」，它离不开服务器侧的另一个包：

| 侧 | 包 | 装在哪 |
|---|---|---|
| QQ 侧 | [`astrbot_plugin_cortico_bridge`](https://github.com/as124da1231/astrbot_plugin_cortico_bridge) | AstrBot 的插件目录 |
| Cortico 侧 | `cortico-world-astrbot`（本包） | Cortico 的 `extensions/` |

两个包按同一版协议 v3 通信。QQ 账号和 OneBot 等平台连接照常由 AstrBot 管理。以下步骤从 AstrBot 已能接收 QQ 消息开始。

QQ 账号走的是 OneBot 这类非官方协议，账号有被限制的风险——这个风险来自 QQ 接入方式本身，与本包无关，装之前请自行判断。

## 文档

- [新手图文配置教程](https://github.com/as124da1231/astrbot_plugin_cortico_bridge/blob/main/docs/beginner-guide.md)
- [Coo 侧实现细节](docs/coo-side.md)
- [UMO 桥协议契约](docs/umo-bridge-contract.md)
- [Coo World 边界](docs/coo-world-boundary.md)
- [UMO v2 设计稿](docs/umo-v2-design.md)

## 安装

从扩展市场的卡片安装，或：

```bash
corepack pnpm add cortico-world-astrbot
```

### 同机基础聊天，两步配置

1. 启用 AstrBot 的桥插件和 Coo 的 **World → AstrBot · QQ**。两端默认使用 `ws://127.0.0.1:17999`，直接同机回环可留空桥接令牌。
2. 在 AstrBot 的「Coo 桥控制台 → QQ」绑定主人 QQ 和对应的 QQ 平台实例。使用旧版桥时在「概览」绑定。在 Coo 的「连接」确认模式已同步后，主人给机器人发一条私聊。

同机 Docker 需使桥端口从 Coo 所在的宿主回环可达。容器内非回环监听仍需设置一枚桥接令牌，并在 Coo「连接」中填写。

### 跨机追加两步配置

1. 选择连接地址。直连填 `ws://服务器IP:17999`，AstrBot 桥需监听 Coo 可达的地址。使用 TLS 时填 `wss://` 代理地址，可填域名或公网 IP，证书须覆盖所填地址并受 Coo 信任。`ws://` 本身是明文，已有加密隧道也可以承载 WS。
2. 在 AstrBot 的「Coo 桥控制台 → 连接」生成一枚桥接令牌，旧版入口在「概览」。在 Coo 的「AstrBot → 连接」填入所选地址和该令牌，选择「保存并应用」。

### 开放完整模式和额外能力

1. 在 Coo「连接」申请完整模式，由 AstrBot 管理员在「Coo 桥控制台 → 连接」核对并批准实际开放范围，旧版入口在「概览」。两端同步后，获准会话可以使用 Coo 主会话，回复可能提到 Coo 桌面对话内容。
2. 按需在 AstrBot 选择工具白名单，分别授权桌面工具及机器人主动发送的目标。桌面权限通过同一枚桥接令牌接入。同机用户要启用这些桌面能力，也在两端配置这枚令牌。
3. 需要 QQ 语音转写、语音回复或视觉转述时，在 AstrBot 选好相应的服务。图片、语音原件和附件的实际可读范围取决于 QQ 适配器、附件是否仍可下载与 Coo 当前模型的输入能力。

### 升级至 1.3.11

1. 将 Coo World 和 AstrBot 桥都升到 1.3.11，以使用平台实例上报和 Discord。仅使用 QQ 时，Coo World 仍可搭配桥插件 1.3.9。桥要求 **AstrBot ≥ 4.29.1**。原有模型、群名单、会话和连接配置可以继续使用，包含已有的 `ws://` 地址。
2. 在 AstrBot 插件设置中复核已授权工具。`tools_risks` 中明确标为 `read` 或 `write` 的工具才会被 `*` 纳入。未分类的工具需要单独点名和管理员授权。
3. 在「Coo 桥控制台 → QQ」复核主人绑定、桌面工具权限和主动发送目标。Coo 连接侧只使用桥接令牌。

「连接」页可以确认切换模式，两端同步后生效。安全模式只接收主人 QQ 私聊，允许回复、按需查询私聊历史和读取可用的引用、转发、图片与语音原件。完整模式开放 AstrBot 授权的其他会话与工具。两种模式都通过原版 Coo 的主会话接口工作。

## 它做什么

- 把桥送来的群消息变成 Cortico 事件（`astrbot.message`），行首就是渠道：
  `【QQ群 测试群 18:52】#消息号 昵称(QQ:123)：正文`、`【QQ私聊 18:52】…`。
  图片取不到时写成 `[图片|没取到：原因]`，不让模型猜。
- 提供 `astrbot_send_message`，让 bot 能把话（文字、图片或语音）发回群里；`voice: true` 会请桥用 TTS 合成，桥没开或失败时自动退回文字。
- QQ 轮次可以省略目标，回到触发会话。桌面主动发送只在完整模式开放，且须用 `conv_id` 或 `reply_to` 指定 AstrBot 已授权、桥已经见过的目标会话。
- QQ 轮次用实际发言者的身份执行 AstrBot 工具。桌面轮次由 AstrBot 核对绑定的主人 QQ、管理员资格与工具授权。过期的 QQ 轮次不会借用桌面身份。失败时工具回执会给出中文原因。
- 纯 QQ 通知（撤回、戳一戳、入退群）只作为上下文，不建立 QQ 轮次；`[QQ 人消息 + 工具清单通知]` 这种同批也不算 mixed，仍然可以正常回复。`turnMsgId` 为空（只有通知）时拒绝发消息和调工具。
- 提供 `astrbot_status`，查连接状态、这一轮是不是 QQ 轮次、语音是否可用、见过的会话。
- 提供 `astrbot_read_history`，按关键词或发送者回查自己见过的 QQ 消息。
- 把撤回、戳一戳、入退群、管理员变更、传文件这类通知译成人话，当作上下文记下（不单独唤醒 bot）。
- 桥断了自动按指数退避重连；`open` 只代表 socket 通了，收到 `ready` 才算就绪。token 或版本不对被桥拒绝时，退避至少从 10 秒起步，不会每秒重连刷日志。桥每 20 秒发一次应用层心跳，120 秒没有任何往来才重建连接。

## 渠道

| 这一轮来自 | 事件行 | 该用的出口 |
|---|---|---|
| QQ 群 | `【QQ群 群名 时刻】` | `astrbot_send_message` |
| QQ 私聊 | `【QQ私聊 时刻】` | `astrbot_send_message` |
| Coo 对话页、桌宠或其他非 QQ 输入 | 由来源 World 定义 | 沿用来源 World 的回复规则，本扩展不指定 |

安全模式由 AstrBot 桥核对绑定的主人私聊。工具执行由 AstrBot 根据实际发件人或服务端绑定的桌面主人校验权限。

**接入边界**：本包只定义 QQ 事件与自己的工具，不替 Coo 对话页、桌宠或控制台指定回复工具。不把 `[typed]` 等通用标签一概当成原版桌宠，也不要求混合输入时优先回 QQ。QQ 出口的硬校验只约束本包；本地对话继续由原有 World 处理，不需要修改 Coo 安装目录。

## 主动发送与 @

### 从 Coo 侧主动发 QQ

1.3.6 起，桌宠、Coo 对话等非 QQ 轮次也可以主动发消息，但要同时满足：

1. 完整模式已生效，AstrBot 插件「概览」已开放桌面主动发送并配置目标，两端使用桥接令牌完成鉴权；
2. 调用 `astrbot_send_message` 时用 `conv_id`（群号 / QQ 号，可配 `conv_kind`）或 `reply_to` 指定目标；
3. 目标必须是桥已经见过的会话。桥在 `ready` 里最多报 20 条最近会话；要发到没列出的会话，先在那个会话说一句，让桥记下它。

QQ 轮次不受这些限制：不写目标就回触发这一轮的会话。过期（2 分钟）的 QQ 轮次不会退回主人身份，也不会回退到 `lastConv`。

### @ 与 @全体

- 群里用 `at: ["123456789", …]` 点名，最多 10 个；私聊里 `at` 被忽略，回执会说明。
- `at: ["all"]` 是 @全体。默认关闭，需要在部署的 `config.json` 里打开 `worlds.astrbot.allowAtAll`（面板暂无开关）；没开时工具直接拒绝，不会发出。
- 语音不能和 `at` 同一条，桥返回 `voice_at_conflict`；`at` 格式不对或超过 10 个返回 `bad_at`。

## 它不做什么

- 不连 QQ、不碰 OneBot、不管账号。
- 不管群名单与白名单——那些仍归 AstrBot，它决定把哪些群的消息转过来。
- 不管理 bot 的记忆或人格；那是 Persona 的事。

## 配置

全部在部署的 `config.json` 的 `worlds.astrbot` 段，也可以在 Coo 的「连接」页里改。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 挂载开关。**启停只在 Coo 的 World 页**，面板里没有这个开关 |
| `wsUrl` | `ws://127.0.0.1:17999` | 支持 `ws://` 和 `wss://`。显式空地址暂停连接 |
| `token` | 空 | 与桥一致的访问令牌。同机回环的基础聊天可留空 |
| `includeTime` | `true` | 投递给 Coo 的消息行首带 `HH:MM` |
| `channelHint` | `true` | 在需要回复的 QQ 消息（@、带图、私聊）后加一行「用 astrbot_send_message 回」的提醒 |
| `reconnectBaseMs` | `1000` | 断线后第一次重连等待；之后翻倍 |
| `reconnectMaxMs` | `30000` | 重连等待上限 |
| `allowAtAll` | `false` | 允许 `at: ["all"]` @全体。面板暂无开关，改部署的 `config.json` 里的 `worlds.astrbot.allowAtAll` |

群范围、`mention` / `all` 消息范围、称呼和发送频率都由 AstrBot 插件统一控制，World 不再重复配置。

在 Coo「连接」页修改桥地址、令牌或重连参数后，点「保存并应用」即可让已启用的 World 重新连接。通用配置页只提供非敏感设置。`includeTime`、`channelHint` 保存后即时生效。`allowAtAll` 可在通用配置页或部署的 `config.json` 中修改。

「连接」页的几条行为：

- 「桥接令牌（Token）」留空会保留原值。要删除，点「清除已保存的令牌」再保存。跨机连接清除后会断开。
- 保存期间表单会锁住，避免等待期的修改被刷新覆盖；失败时保留输入，可以直接重试。

## 桥的协议

一条 WS 连接，JSON 帧。客户端连上后先自报身份，并声明自己的能力：

```json
{ "t": "hello", "v": 3, "name": "Cortico",
  "capabilities": { "images": true } }
```

- `v` 必须是 `3`。版本不对桥会以 `4004` 关闭，令牌不对是 `4003`，第一帧不是 hello 是 `4002`。
- 令牌只通过 WebSocket Upgrade 的 `Authorization: Bearer …` 请求头发送。
- `capabilities.images` 表示本端模型能直接读图；为真时桥才附原图，否则自己转成文字。这个值由 Cortico 侧按当前端点的多模态能力算出来，只在**每次重连握手时**刷新——中途改了端点设置要等重连（或重启进程）才生效。

桥在握手后、以及语音/工具配置变化时推 `ready`：

```json
{ "t": "ready", "v": 3, "channel": "qq", "mode": "full", "modeRevision": "当前代次",
  "self": { "id": "…", "name": "…" }, "admins": ["42"],
  "tts": { "ready": true, "provider": "edge_tts" },
  "conversations": [
    { "umo": "default:GroupMessage:123456", "kind": "group", "id": "123456", "age_sec": 12 } ] }
```

`admins` 是 AstrBot 的管理员名单，World 据此判定主人身份。`tts` 表示语音回复是否可用。`conversations` 包含最多 20 条最近会话，供完整模式下的主人主动发送使用。桥收到 `mode-accept` 并回复 `mode-status` 的 `active: true` 后开始接管。

桥推消息：

```json
{ "t": "msg", "id": "消息id", "ts": "2026-10-26T10:00:00+08:00",
  "umo": "default:GroupMessage:123456",
  "channel": "qq",
  "conv": { "kind": "group", "id": "123456", "name": "群名" },
  "sender": { "id": "42", "name": "群昵称" },
  "text": "正文", "mentioned": false,
  "role": "admin", "owner": true, "can": { "screenshot": true },
  "images": [{ "mime": "image/jpeg", "base64": "…" }],
  "image_errors": [{ "index": 0, "reason": "下载超时" }] }

{ "t": "msg", "kind": "notice", "id": "", "ref": "被撤回的消息id",
  "umo": "default:GroupMessage:123456",
  "channel": "qq",
  "conv": { "kind": "group", "id": "123456", "name": "群名" },
  "text": "[撤回] 小明 撤回了一条消息", "mentioned": false }
```

`umo` 是权威会话键，`conv` 只是它的投影；两者不一致时按 UMO 处理并记一条警告。非法 UMO 不会把整条通知丢掉，会回退到 `conv` 记账，但这样的会话没有 UMO，不能作为发送目标。

桥推工具清单（握手后、以及配置变化时）：

```json
{ "t": "tools", "items": [
  { "name": "get_weather", "risk": "read", "desc": "…", "sig": "city" }
] }
```

`risk` 是 `read` / `write` / `exec`，`sig` 是参数签名；World 只把它们拼进提示词，不注册成原生工具。

应用层心跳与发消息回执：

```json
{ "t": "tick", "ts": 1761568800.0 }

{ "t": "ack", "rid": "a-1", "ok": true, "voice": false, "note": "…" }
{ "t": "ack", "rid": "a-2", "ok": false, "error": "send_failed",
  "note": "发送失败，详情见插件日志", "uncertain": true }
```

- `ack.ok` 只表示桥确认的结果；`voice` 表示实际是否按语音发出。
- 失败时 `error` 是稳定英文 code，`note` 是给人看的中文说明；World 优先显示 `note`，有额外 code 时附在括号里。
- `uncertain: true` 表示「可能已经发出」，回执会提醒先确认、不要直接重发。
- `notice` 帧仍被解析，但**当前桥没有发送点**；工具清单变化等状态通过 `astrbot.notice` **事件**进入上下文，不走这个帧。

客户端发给桥：

```json
{ "t": "send", "rid": "a-1",
  "umo": "default:GroupMessage:123456",
  "conv": { "kind": "group", "id": "123456" },
  "text": "要发的话", "replyTo": "可选的消息id",
  "voice": true,
  "at": ["123456789"],
  "image": { "mime": "image/jpeg", "base64": "…" } }
```

- **`umo` 必填**；`conv` 只是投影。World 在发帧前就会检查：QQ 轮次已过期、非 QQ 轮次没填主人 QQ（或该号不是管理员）或没给明确目标、显式目标找不到带 UMO 的已知会话，都直接中文拒绝，不发帧。
- `conv.kind` 取 `group` 或 `private`。`text` 与 `image` 至少给一个；`voice: true` 需要正文，且不能和 `image` 或 `at` 同时用。
- `at` 只对群生效：QQ 号数组，最多 10 个，`["all"]` 是 @全体（World 侧还需 `allowAtAll`）；私聊里忽略并说明。
- 发送只允许到桥已经见过的会话；找不到会回「桥还没见过这个会话（没有 UMO）」。

工具调用：

```json
{ "t": "tool", "rid": "t-1", "name": "get_weather", "args": { "city": "上海" },
  "turn": "触发这一轮的消息id" }

{ "t": "tool", "rid": "t-2", "name": "get_weather", "args": { "city": "上海" },
  "turn": "", "actor": { "kind": "desktop" } }

{ "t": "tool-ack", "rid": "t-1", "ok": true, "result": "晴，26℃" }
{ "t": "tool-ack", "rid": "t-2", "ok": false, "error": "tool_failed",
  "note": "工具执行失败，详情见插件日志" }
```

`turn` 与 `actor` 二选一。QQ 轮次用触发消息 ID，桌面轮次声明 `actor: { "kind": "desktop" }`，由 AstrBot 确定已授权的主人身份及工具权限。

发送错误码（`ack.error`）：

| code | 含义 |
|---|---|
| `missing_umo` | 帧里没有 `umo`，单通道拒绝 |
| `invalid_umo` | UMO 格式不合法 |
| `unknown_umo` | 桥没见过这个 UMO，或超过 30 天 |
| `umo_conv_mismatch` | `umo` 与 `conv` 指向不同会话 |
| `bad_session` | `conv.kind` / `conv.id` 不合法 |
| `empty_message` | 正文和图片都为空 |
| `voice_needs_text` | 语音没有正文 |
| `voice_image_conflict` | 语音和图片同条 |
| `voice_at_conflict` | 语音和 `at` 同条 |
| `bad_at` | `at` 不是数组、含非数字 QQ 号 / 非 `"all"`，或超过 10 个 |
| `bad_image` / `image_too_large` / `image_bad_type` | 图片字段、大小或 mime 不合法 |
| `rate_limited` | 超过插件配置的每分钟上限 |
| `door_closed` | AstrBot 插件未启用，发送门关着 |
| `send_queue_timeout` | 同会话排队超时，确定没发 |
| `send_timeout` / `send_failed` | 平台超时或发送层异常，结果可能未知（带 `uncertain`） |
| `platform_missing` | AstrBot 里找不到对应平台 |
| `tts_unavailable` | 语音不可用 |
| `busy` | 并发帧超过上限，本帧没有执行 |

工具错误码（`tool-ack.error`）：`missing_identity`、`ambiguous_identity`、`bad_actor`（桥层拒绝），以及 `tool_failed`（工具本身抛错，原文只进插件日志）。插件还会用中文 `note` 说明：桥未启用、这一轮的消息已过期、没有在 `tools_allow` 里、工具不存在、主人号不在管理员名单、主人事件构造失败等。

World 侧还有自己的本地校验，不会把帧发出去：QQ 轮次已过期、非 QQ 轮次没有主人 QQ（或该号不是管理员）或没有明确目标、`conv_id` 不是字符串或数字、显式目标没有 UMO、`at` 不是数字 QQ 号或超过 10 个、语音和 `at` 同条。

## 开发

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
```

当前 Vitest 共 141 个用例（world 127 + driver 14），全部通过。

装进实例验证（在 Cortico 检出根下）：

```bash
corepack pnpm describe:extension <本包目录>
corepack pnpm check:extension <本包目录>
```

需要 Node 22 以上。

## 已知问题

- **NapCat / 反向 WS 重连后主动发送全部失败**：桥还连着、也能收消息，但主动发全失败时，先重启 AstrBot。上游问题见 AstrBot #10154，等待修复期间不要连着重发同一条。
- **一个 aiocqhttp 适配器多账号**：可能选不中想用的那个连接（AstrBot #10136）。用 `bridge_platforms` 明确只接管一个平台，或把账号拆成多个适配器。

## 问题解答

交流 QQ 群 **1136066256**

提问时带上这几样，能直接定位：

```text
两侧版本：cortico-world-astrbot / astrbot_plugin_cortico_bridge
Coo「连接」页的状态（已连接 / 等待连接 / 未启用）
AstrBot 插件状态页的「接入安全」和「最近调用」
报错原文，以及是私聊、群聊还是 Coo 对话里触发的
```

## License

[MIT](LICENSE) © 2026 as124da1231
