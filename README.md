# cortico-world-astrbot

<img src="./assets/icon.png" width="88" alt="AstrBot · QQ" align="right">

QQ + AstrBot + Coo：不用换 QQ，不用搬 AstrBot 插件，只把「说话的人」换成 Coo。

QQ 里的人继续在群和私聊里说话；AstrBot 继续管账号、插件、工具和语音；Coo 带着自己的性格和记忆进来回复。

群聊、私聊、@ 或全部消息、图片、语音转写、TTS、撤回和戳一戳都已接上。AstrBot 里装好的工具——点歌、查歌词、天气、直播弹幕——Coo 在 QQ 里直接调用；在 Coo 对话里填好主人 QQ（该号还要在 AstrBot 的管理员名单里），也能用同一个身份调用。

**当前版本：1.3.6**

项目地址：[as124da1231/cortico-world-astrbot](https://github.com/as124da1231/cortico-world-astrbot)。

已在 **Cortico 0.2.8 / Coopanion 0.2.12** 上实机验证：文字、图片（单图与多图）、语音、撤回/戳一戳通知、断线重连。

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

两个包按同一版协议 v1 通信，**必须都装**，单独装哪一半都不通。先装 AstrBot 插件、拿到它的地址和 token，再来填本包的 `wsUrl` / `token`。

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

装完先到 **Coo 的 World 页**启用「AstrBot · QQ」——World 面板里没有启用开关，启停只在 World 页。然后打开本 World 的「连接」页，填好 `wsUrl` 与 `token`，保存，再按页面提示重启 World。

## 它做什么

- 把桥送来的群消息变成 Cortico 事件（`astrbot.message`），行首就是渠道：
  `【QQ群 测试群 18:52】#消息号 昵称(QQ:123)：正文`、`【QQ私聊 18:52】…`。
  图片取不到时写成 `[图片|没取到：原因]`，不让模型猜。
- 提供 `astrbot_send_message`，让 bot 能把话（文字、图片或语音）发回群里；`voice: true` 会请桥用 TTS 合成，桥没开或失败时自动退回文字。
- **只有当前这一轮是 QQ 轮次时才能发**。不给 `conv_id` 就发回这一轮所在的会话；给 `conv_id` 也只是在这一轮里换目标，必须选桥已经见过、带 UMO 的会话。桌宠、Coo 对话等非 QQ 轮次一律拒绝，显式 `conv_id` 不能绕过。
- 工具也是两条身份路径：QQ 轮次用「触发这一轮的那条消息」的发言者身份，普通群友的管理员工具会被拒绝；Coo 对话轮次只有在「连接」里填了主人 QQ、且这个号在 AstrBot 管理员名单里时，才以该主人身份执行。超过 2 分钟的旧 QQ 轮次不会借主人身份。失败时如实显示中文原因，不假装成功。
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
| `ownerId` | 空 | Coo 对话轮次调用 AstrBot 工具时借用的管理员 QQ；必须纯数字、20 位以内，且在该 AstrBot 的 `admins_id` 里。留空表示不借身份 |

群范围、`mention` / `all` 消息范围、称呼和发送频率都由 AstrBot 插件统一控制，World 不再重复配置。

`wsUrl`、`token`、`reconnect*` 是建立连接时用的，保存后要点「重启 World」才生效；`includeTime`、`channelHint`、`ownerId` 保存后即时生效。

「连接」页的几条行为：

- token 输入框留空表示**保持原值**；要真正删掉，点「清除已存 token」再保存。
- 另建的 token 必须两边一致；AstrBot 插件那边也要同步清空或改成不校验。
- 保存期间表单会锁住，避免等待期的修改被刷新覆盖；失败时保留输入，可以直接重试。
- 主人 QQ 只接受数字、最长 20 位；不在 AstrBot 管理员名单里时，工具调用会失败并说明原因。

## 桥的协议

一条 WS 连接，JSON 帧。客户端连上后先自报身份，并声明自己的能力：

```json
{ "t": "hello", "v": 1, "token": "…", "name": "Cortico",
  "capabilities": { "images": true } }
```

- `v` 必须是 `1`；版本不对桥会以 `4004` 关闭，token 不对是 `4003`，第一帧不是 hello 是 `4002`。
- token 也可以放在 `Authorization: Bearer …` 头里；两种都出现时必须一致。
- `capabilities.images` 表示本端模型能直接读图；为真时桥才附原图，否则自己转成文字。这个值由 Cortico 侧按当前端点的多模态能力算出来，只在**每次重连握手时**刷新——中途改了端点设置要等重连（或重启进程）才生效。

桥在握手后、以及语音/工具配置变化时推 `ready`：

```json
{ "t": "ready", "v": 1, "channel": "qq",
  "self": { "id": "…", "name": "…" }, "admins": ["42"],
  "tts": { "ready": true, "provider": "edge_tts" } }
```

`admins` 就是 AstrBot 的管理员名单，World 据此给出「主人」标记与截图授权——不在两边各维护一份名单。`tts` 从 1.3.0 起从布尔值变成 `{ ready, provider }`；World 两种都认。**收到 `ready` 之后才算真正就绪**；只 TCP 连上不算。

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
  "image": { "mime": "image/jpeg", "base64": "…" } }
```

- **`umo` 必填**；`conv` 只是投影。World 在发帧前就会检查：QQ 轮次已过期、非 QQ 轮次没填主人 QQ 或没给明确目标、显式目标找不到带 UMO 的已知会话，都直接中文拒绝，不发帧。
- `conv.kind` 取 `group` 或 `private`。`text` 与 `image` 至少给一个；`voice: true` 需要正文，且不能和 `image` 同时用。
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
| `bad_image` / `image_too_large` / `image_bad_type` | 图片字段、大小或 mime 不合法 |
| `rate_limited` | 超过插件配置的每分钟上限 |
| `door_closed` | AstrBot 插件未启用，发送门关着 |
| `send_queue_timeout` | 同会话排队超时，确定没发 |
| `send_timeout` / `send_failed` | 平台超时或发送层异常，结果可能未知（带 `uncertain`） |
| `platform_missing` | AstrBot 里找不到对应平台 |
| `tts_unavailable` | 语音不可用 |
| `busy` | 并发帧超过上限，本帧没有执行 |

工具错误码（`tool-ack.error`）：`missing_identity`、`ambiguous_identity`、`bad_actor`（桥层拒绝），以及 `tool_failed`（工具本身抛错，原文只进插件日志）。插件还会用中文 `note` 说明：桥未启用、这一轮的消息已过期、没有在 `tools_allow` 里、工具不存在、主人号不在管理员名单、主人事件构造失败等。

World 侧还有自己的本地校验，不会把帧发出去：QQ 轮次已过期、非 QQ 轮次没有主人 QQ 或没有明确目标、`conv_id` 不是字符串或数字、显式目标没有 UMO、`at` 不是数字 QQ 号或超过 10 个。

## 开发

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
```

当前 Vitest 共 134 个用例（world 120 + driver 14），全部通过。

装进实例验证（在 Cortico 检出根下）：

```bash
corepack pnpm describe:extension <本包目录>
corepack pnpm check:extension <本包目录>
```

需要 Node 22 以上。

## 问题解答

QQ：**1136066256**

提问时带上这几样，能直接定位：

```text
两侧版本：cortico-world-astrbot / astrbot_plugin_cortico_bridge
Coo「连接」页的状态（已连接 / 等待连接 / 未启用）
AstrBot 插件状态页的「接入安全」和「最近调用」
报错原文，以及是私聊、群聊还是 Coo 对话里触发的
```

## License

[MIT](LICENSE) © 2026 as124da1231
