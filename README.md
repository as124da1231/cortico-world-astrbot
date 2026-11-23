# cortico-world-astrbot

<img src="./assets/icon.png" width="88" alt="AstrBot · QQ" align="right">

QQ + AstrBot + Coo：不用换 QQ，不用搬 AstrBot 插件，只把「说话的人」换成 Coo。

QQ 里的人继续在群和私聊里说话；AstrBot 继续管账号、插件、工具和语音；Coo 带着自己的性格和记忆进来回复。

群聊、私聊、@ 或全部消息、图片、语音转写、TTS、撤回和戳一戳都已接上。AstrBot 里装好的工具——点歌、查歌词、天气、直播弹幕——Coo 在 QQ 里直接调用；Coo 对话里可以使用 AstrBot 已授权的主人身份和独立工具令牌调用。

**当前版本 1.3.9**

项目地址：[as124da1231/cortico-world-astrbot](https://github.com/as124da1231/cortico-world-astrbot)。

Coo 可以查看 QQ 引用、合并转发和附件详情。引用保留可用的原图和转写，转发可按条展开，图片和语音按需读取。文件和视频提供名称、大小等适配器已返回的信息。媒体来源失效时，Coo 会说明当前能读到的内容。

从 1.2.5 起，本包与 `astrbot_plugin_cortico_bridge` 的版本号保持一致。

## 为什么是这样一个形状

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

两个包按同一版协议 v2 通信。先装 AstrBot 插件、拿到它的地址和 token，再来填本包的 `wsUrl` / `token`。

QQ 账号走的是 OneBot 这类非官方协议，账号有被限制的风险——这个风险来自 QQ 接入方式本身，与本包无关，装之前请自行判断。

## 文档

- [Coo 侧实现细节](docs/coo-side.md)
- [UMO 桥协议契约](docs/umo-bridge-contract.md)
- [Coo World 边界](docs/coo-world-boundary.md)
- [UMO v2 设计稿](docs/umo-v2-design.md)

## 安装

从扩展市场的卡片安装，或：

```bash
corepack pnpm add cortico-world-astrbot
```

装完到 **Coo → World → AstrBot · QQ → 连接**，填写 AstrBot 桥地址和「桥接令牌（Token）」，保存并应用。在 Coo 的 World 页启用扩展。跨机连接使用 `wss://`，令牌在 AstrBot 桥插件的「概览」复制。

### 升级至 1.3.9

1. 将 AstrBot 桥和 Coo World 一起升到 1.3.9。桥要求 **AstrBot ≥ 4.29.1**。两端交换协议 v2，和 1.3.8 及更早版本混装时会停止接管。原有模型、群名单、会话和连接配置可继续使用。
2. 在 AstrBot 插件设置中复核已授权工具。`tools_risks` 中明确标为 `read` 或 `write` 的工具才会被 `*` 纳入。未分类的工具需要单独点名和管理员授权。
3. 如需在 Coo 对话里用主人身份调用工具，在 AstrBot 设置 `owner_tool_qq` 和 `owner_tool_token`，再到 Coo「连接」填写相同的账号和工具令牌。工具令牌独立于桥 token。跨机工具授权使用 `wss://`。

「连接」页可以确认切换模式，两端同步后生效。完整模式使用 Coo 主对话，QQ 回复可能引用控制台里的对话内容，也能调用已授权的工具。安全模式按 QQ 会话隔离上下文，只开放当前 QQ 会话的聊天工具。两种模式都用 Coo 当前的模型。

**宿主兼容性：** 原版 Coopanion 0.2.23 支持完整模式。安全模式需要额外提供独立轮次接口的宿主，扩展包安装后可在「连接」页检查是否可用。如果 AstrBot 此前保存为安全模式，换回原版 Coo 后可以在「连接」页确认切换为完整模式，再恢复 QQ 接管。

## 它做什么

- 把桥送来的群消息变成 Cortico 事件（`astrbot.message`），行首就是渠道：
  `【QQ群 测试群 18:52】#消息号 昵称(QQ:123)：正文`、`【QQ私聊 18:52】…`。
  图片取不到时写成 `[图片|没取到：原因]`，不让模型猜。
- 提供 `astrbot_send_message`，让 bot 能把话（文字、图片或语音）发回群里；`voice: true` 会请桥用 TTS 合成，桥没开或失败时自动退回文字。
- QQ 轮次可以省略目标，隐式回触发会话；**非 QQ 轮次**只有在「连接」填了主人 QQ（且该号是 AstrBot 管理员）、并用 `conv_id` / `reply_to` 指定已知会话时才允许主动发送。缺任何一条都会被拒绝并说明原因；显式目标必须是桥见过、带 UMO 的会话。
- 工具也是两条身份路径：QQ 轮次用「触发这一轮的那条消息」的发言者身份，普通群友的管理员工具会被拒绝；Coo 对话轮次须在「连接」填写 AstrBot 授权的主人 QQ 和独立工具令牌。远程工具授权通过 wss:// 连接。超过 2 分钟的旧 QQ 轮次不会借主人身份。失败时如实显示中文原因，不假装成功。
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

`owner` 与 `role` 分开：`role` 是 AstrBot 的工具权限，`owner` 才是「主人」。当前两者都取 AstrBot 管理员名单。

**接入边界**：本包只定义 QQ 事件与自己的工具，不替 Coo 对话页、桌宠或控制台指定回复工具。不把 `[typed]` 等通用标签一概当成原版桌宠，也不要求混合输入时优先回 QQ。QQ 出口的硬校验只约束本包；本地对话继续由原有 World 处理，不需要修改 Coo 安装目录。

## 主动发送与 @

### 从 Coo 侧主动发 QQ

1.3.6 起，桌宠、Coo 对话等非 QQ 轮次也可以主动发消息，但要同时满足：

1. 「连接」页填了主人 QQ，且该号在 AstrBot 的 `admins_id` 里；
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
| `wsUrl` | 空 | 桥的地址，如 `ws://127.0.0.1:17999`。空串表示还没配置 |
| `token` | 空 | 与桥一致的校验 token；两边都留空表示不校验 |
| `includeTime` | `true` | 投递给 Coo 的消息行首带 `HH:MM` |
| `channelHint` | `true` | 在需要回复的 QQ 消息（@、带图、私聊）后加一行「用 astrbot_send_message 回」的提醒 |
| `reconnectBaseMs` | `1000` | 断线后第一次重连等待；之后翻倍 |
| `reconnectMaxMs` | `30000` | 重连等待上限 |
| `ownerId` | 空 | Coo 对话轮次调用 AstrBot 工具、以及非 QQ 轮次主动发 QQ 时借用的管理员 QQ；必须纯数字、20 位以内，且在该 AstrBot 的 `admins_id` 里。留空表示不借身份、也不允许主动发送 |
| `ownerToolsEnabled` | `true` | 使用连接页存入部署密钥的独立工具令牌。停用后重启 World 释放连接授权。 |
| `allowAtAll` | `false` | 允许 `at: ["all"]` @全体。面板暂无开关，改部署的 `config.json` 里的 `worlds.astrbot.allowAtAll` |

群范围、`mention` / `all` 消息范围、称呼和发送频率都由 AstrBot 插件统一控制，World 不再重复配置。

在 Coo「连接」页修改桥地址、令牌或重连参数后，点「保存并应用」即可让已启用的 World 重新连接。桥接令牌保存在部署配置里，通用配置页只提供非敏感设置。`includeTime`、`channelHint`、`ownerId` 保存后即时生效。`allowAtAll` 可在通用配置页或部署的 `config.json` 中修改。

「连接」页的几条行为：

- 「桥接令牌（Token）」留空会保留原值。要删除，点「清除已保存的令牌」再保存。跨机连接清除后会断开。
- 保存期间表单会锁住，避免等待期的修改被刷新覆盖；失败时保留输入，可以直接重试。
- 主人 QQ 只接受数字、最长 20 位；不在 AstrBot 管理员名单里时，工具调用会失败并说明原因。

## 桥的协议

一条 WS 连接，JSON 帧。客户端连上后先自报身份，并声明自己的能力：

```json
{ "t": "hello", "v": 2, "token": "…", "name": "Cortico",
  "capabilities": { "images": true } }
```

- `v` 必须是 `2`；版本不对桥会以 `4004` 关闭，token 不对是 `4003`，第一帧不是 hello 是 `4002`。
- token 也可以放在 `Authorization: Bearer …` 头里；两种都出现时必须一致。
- `capabilities.images` 表示本端模型能直接读图；为真时桥才附原图，否则自己转成文字。这个值由 Cortico 侧按当前端点的多模态能力算出来，只在**每次重连握手时**刷新——中途改了端点设置要等重连（或重启进程）才生效。

桥在握手后、以及语音/工具配置变化时推 `ready`：

```json
{ "t": "ready", "v": 2, "channel": "qq", "mode": "full", "modeRevision": "当前代次",
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
  "turn": "", "actor": { "kind": "owner", "id": "42" } }

{ "t": "tool-ack", "rid": "t-1", "ok": true, "result": "晴，26℃" }
{ "t": "tool-ack", "rid": "t-2", "ok": false, "error": "tool_failed",
  "note": "工具执行失败，详情见插件日志" }
```

`turn` 与 `actor` 只能二选一：QQ 轮次用消息 id，Coo 对话轮次用 owner actor（`id` 必须在 `admins_id` 里）。两个都没有、同时都有、或 actor 形状不对，桥会在执行前直接拒绝。

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
