# cortico-world-astrbot

<img src="./assets/icon.png" width="88" alt="AstrBot · QQ" align="right">

让 Cortico 的人格 Bot 进 QQ 群说话，同时把 QQ 账号与插件能力留在 AstrBot 手里。

**当前版本：1.3.2**

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

## 安装

从扩展市场的卡片安装，或：

```bash
corepack pnpm add cortico-world-astrbot
```

装完后在部署的 `config.json` 里把 `worlds.astrbot.enabled` 打开（也可以在 WebUI 的 AstrBot 页里打开），填好 `wsUrl` 与 `token`，重启进程。

## 它做什么

- 把桥送来的群消息变成 Cortico 事件（`astrbot.message`），行首就是渠道：
  `【QQ群 测试群 18:52】#消息号 昵称(QQ:123)：正文`、`【QQ私聊 18:52】…`。
  图片取不到时写成 `[图片|没取到：原因]`，不让模型猜。
- 提供 `astrbot_send_message`，让 bot 能把话（文字、图片或语音）发回群里；`voice: true` 会请桥用 TTS 合成，桥没开或失败时自动退回文字。
- 这一轮没有投递过 QQ 事件时，`astrbot_send_message` 不带 `conv_id` 会被拒绝——桌宠轮次不会误把话发进 QQ。显式给 `conv_id` 仍可主动发到 QQ（前提是桥见过这个会话）。
- 工具也只在 QQ 轮次可用：桌宠轮次没有 QQ 身份，`astrbot_call_tool` 会被拒绝。默认回复用「这一轮」的会话，通知或被过滤掉的群消息不会把默认目标带跑。
- 提供 `astrbot_status`，查连接状态、这一轮是不是 QQ 轮次、语音是否可用、见过的会话。
- 提供 `astrbot_read_history`，按关键词或发送者回查自己见过的 QQ 消息。
- 把撤回、戳一戳、入退群、管理员变更、传文件这类通知译成人话，当作上下文记下（不单独唤醒 bot）。
- 桥断了自动按指数退避重连；桥每 20 秒发一次应用层心跳，120 秒没有任何往来才重建连接。

## 渠道

| 这一轮来自 | 事件行 | 该用的出口 |
|---|---|---|
| QQ 群 | `【QQ群 群名 时刻】` | `astrbot_send_message` |
| QQ 私聊 | `【QQ私聊 时刻】` | `astrbot_send_message` |
| 桌宠 | `[touch]` / `[typed]` / `[voice]` | `pet_say` / `pet_act` |

`owner` 与 `role` 分开：`role` 是 AstrBot 的工具权限，`owner` 才是「主人」。当前两者都取 AstrBot 管理员名单。

**一个边界要说清**：`pet_say` 是 desktop-pet 的 World，本包**不能**把它从工具表里拿掉。要保证 QQ 轮次完全看不到桌宠出口，唯一硬办法是给 QQ 单独建一个只启用 AstrBot World 的会话/人格。本包能做的是：事件行写清渠道、自己的 QQ 出口有硬校验、提示词点名 `pet_say` 不能用。

## 它不做什么

- 不连 QQ、不碰 OneBot、不管账号。
- 不管群名单与白名单——那些仍归 AstrBot，它决定把哪些群的消息转过来。
- 不管理 bot 的记忆或人格；那是 Persona 的事。

## 配置

全部在部署的 `config.json` 的 `worlds.astrbot` 段，也可以在 WebUI 的 AstrBot 页里改。

| 键 | 说明 |
|---|---|
| `enabled` | 挂载开关，默认关闭 |
| `wsUrl` | 桥的地址，如 `ws://<服务器IP>:17999`。空串表示还没配置 |
| `token` | 与桥一致的校验 token，留空表示不校验 |
| `mode` | `mention`（默认）只在被 @ 或叫到称呼时送进来；`all` 每条群消息都送进来，要不要说话由 bot 自己决定 |
| `nameAliases` | 除 @ 之外算作「叫我」的称呼，逗号分隔，例如 `Coo,库` |
| `reconnectBaseMs` / `reconnectMaxMs` | 重连退避的起点与封顶 |
| `maxSendsPerMinute` | 每分钟发送上限，防止刷屏；0 表示不限 |
| `channelHint` | 在需要回复的 QQ 消息（@、带图、私聊）后加一行「用 astrbot_send_message 回」的提醒，默认开 |

`wsUrl`、`token` 是建立连接时用的，改完要重启本 World 才生效；`mode`、`nameAliases`、`maxSendsPerMinute`、`channelHint` 热改即生效。

## 桥的协议

一条 WS 连接，JSON 帧。连接建立后客户端先发握手，并自报能力：

```json
{ "t": "hello", "v": 1, "token": "…", "name": "Cortico",
  "capabilities": { "images": true } }
```

`capabilities.images` 表示本端模型能直接读图；为真时桥才附原图，否则自己转成文字。
这个值由 Cortico 侧按当前端点的多模态能力算出来，只在**每次重连握手时**刷新——中途改了端点设置要等重连（或重启进程）才生效。

桥推给客户端：

```json
{ "t": "ready", "v": 1, "channel": "qq",
  "self": { "id": "…", "name": "…" }, "admins": ["42"],
  "tts": { "ready": true, "provider": "edge_tts" } }

{ "t": "msg", "id": "消息id", "ts": "2026-10-26T10:00:00+08:00",
  "channel": "qq",
  "conv": { "kind": "group", "id": "123456", "name": "群名" },
  "sender": { "id": "42", "name": "群昵称" },
  "text": "正文", "mentioned": false,
  "role": "admin", "owner": true, "can": { "screenshot": true },
  "images": [{ "mime": "image/jpeg", "base64": "…" }],
  "image_errors": [{ "index": 0, "reason": "下载超时" }] }

{ "t": "msg", "kind": "notice", "id": "", "ref": "被撤回的消息id",
  "channel": "qq",
  "conv": { "kind": "group", "id": "123456", "name": "群名" },
  "text": "[撤回] 小明 撤回了一条消息", "mentioned": false }

{ "t": "tick", "ts": 1761568800.0 }

{ "t": "notice", "kind": "qq-offline", "text": "QQ 侧已掉线" }

{ "t": "ack", "rid": "a-1", "ok": true }
```

`admins` 就是 AstrBot 的管理员名单，World 据此给出「主人」标记与截图授权——不在两边各维护一份名单。`tts` 从 1.3.0 起从布尔值变成 `{ ready, provider }`；World 两种都认。

客户端发给桥：

```json
{ "t": "send", "rid": "a-1",
  "conv": { "kind": "group", "id": "123456" },
  "text": "要发的话", "replyTo": "可选的消息id",
  "voice": true,
  "image": { "mime": "image/jpeg", "base64": "…" } }
```

`conv.kind` 取 `group` 或 `private`。`mentioned` 由桥判断并如实告知（@ 到了，或正文出现配置的称呼）。`image` 可省略；`text` 与 `image` 至少给一个；`voice: true` 不能和 `image` 同时用。

## 开发

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
```

装进实例验证（在 Cortico 检出根下）：

```bash
corepack pnpm describe:extension <本包目录>
corepack pnpm check:extension <本包目录>
```

需要 Node 22 以上。

## License

[MIT](LICENSE) © 2026 as124da1231
