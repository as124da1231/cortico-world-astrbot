# Coo 侧：World 的实现细节

插件负责连接、账号、策略和工具；World 负责把 QQ 事件交给 Coo，并把 Coo 的回复送回桥。

---

## 1. 工具

| 工具 | 用途 |
|---|---|
| `astrbot_send_message` | 往 QQ 发文字、图片、语音；QQ 轮次可隐式回触发会话，非 QQ 轮次需主人 QQ + 显式目标 + 已知会话；群里可用 `at` |
| `astrbot_status` | 查看连接、最近会话、工具清单 |
| `astrbot_read_history` | 读某个会话的历史；默认当前轮，允许回退最近会话 |
| `astrbot_call_tool` | 调 AstrBot 的工具；QQ 轮次传 `turn`，Coo 对话轮次传 owner actor |

工具名与声明在 `ASTRBOT_TOOL_DECLS` / `CALL_TOOL_DECL`，`describe.json` 从同一份声明生成。

---

## 2. 环境提示词

`envPromptVars()` 提供：

```text
astrbot.connection        连接状态
astrbot.scope             群范围、消息范围、称呼归插件管
astrbot.self              桥自报的 bot 名字（不是 QQ 号），未连接时为空
astrbot.owner             QQ 上的主人（AstrBot 管理员名单）
astrbot.conversations     最近见过的会话
astrbot.lastConversation  最近一条消息所在会话
astrbot.tools             可调用工具及参数签名
```

环境提示词只说明「什么时候用哪个工具」，不替 Coo 决定说什么。

---

## 3. 轮次边界

World 记录：

```text
turnChannel     'qq' / undefined
turnMultiConv   同一批有多个人话 QQ 会话
turnConv        当前 QQ 会话
turnMsgId       当前人话消息 id
turnChannelAt   置位时间，2 分钟兜底 TTL
```

`onEventsSettled` 每批更新一次（只收本 World 自己的事件）：

```text
没有 QQ 消息、只有 astrbot.* 通知   → 保留上一轮，不建立也不清空
只有 QQ 通知（撤回/入群/戳一戳）    → 不建立新轮次
只有 QQ 人话                         → 开 QQ 出口
QQ 人话 + 工具清单通知               → 仍可回复
多个人话 QQ 会话                     → turnMultiConv = true，隐式发送拒绝
```

只有 `astrbot.message` 里的「人话」能建立轮次；`astrbot.notice`（工具清单、桥状态）与 QQ 通知都不参与。其他 World 的输入不会进入这个回调，本包也不去读共享事件库推断它们。

`onTurnEnded` / `onRunPhase('idle')` 清空全部状态。TTL 只是 `onTurnEnded` 没来时的兜底；工具调用和发送开始时会 `touchTurn()` 续期，所以 90 秒的长工具链不会被 2 分钟 TTL 误伤。过期后不借上一轮身份，也不回退主人身份。非 QQ 轮次的主动发送不受这个 TTL 影响，但要求主人 QQ + 显式目标 + 已知会话。

---

## 4. 目标选择

```text
pickConv(args, { allowLast?, requireUmo? }):
  1. conv_id        → 显式目标（接受字符串或数字，其他类型明确失败）
  2. reply_to       → 查 knownMsgConv，回到原消息所在会话
  3. turnMultiConv  → 发送时拒绝，要求显式指定
  4. turnConv       → 当前轮
  5. allowLast      → 历史查询才允许回退 lastConv
```

发送永远不回退 `lastConv`，并且要求显式目标能找到带 UMO 的已知会话；找不到就回「桥还没见过这个会话（没有 UMO）」，不发帧。历史查询允许回退，因为桌宠轮次查最近 QQ 历史是只读行为。

`knownMsgConv` 保存最近 200 条消息 id → 会话，用于 `reply_to`。历史检索从最新往前翻，单次最多扫 20,000 条，安静会话不会把主循环卡死。

---

## 5. 出站

```text
astrbot_send_message
  → 检查 qqTurnActive
  → 检查 connected
  → pickConv({ requireUmo: true })
  → driver.send(conv, text, replyTo, image, voice)
  → 帧 {t:'send', rid, umo, conv, text, ...}
  → 桥
```

边界：

```text
非 QQ 轮次            → 只有填了主人 QQ、且显式指定目标才允许主动发
过期轮次              → 拒绝
多会话但不指定目标    → 拒绝
显式目标没有 UMO      → 拒绝，不发帧
@                     → 仅群聊；QQ 号或 all（需开启）；最多 10 个；语音不能带 @
图片                  → 只接受 host.blob 的 log:/mem: 句柄，单张 ≤ 6MB
语音                  → 需要正文，不能和图片同条
```

`onEventsSettled` 只收到本包自己的事件，用来确认 QQ 人话已投递；本包不读共享事件库去推断其他来源，也不为本地聊天页或气泡指定出口。发送失败时优先显示桥回的中文 `note`，`uncertain` 会明确提示「可能已经发出，先确认再重试」。

---

## 6. 工具链

```text
QQ 轮次
  astrbot_call_tool(name, args)
  → 用这一轮的消息 id 当 turn
  → 帧 {t:'tool', rid, name, args, turn}
  → 插件用那条消息的身份执行

Coo 对话轮次
  → 桥的 ready 确认独立工具令牌已获授权
  → 连接页填写 AstrBot 指定的主人 QQ（ownerId）
  → 帧 {t:'tool', rid, name, args, turn:'', actor:{kind:'owner', id}}
  → 插件校验连接授权、指定 QQ 和管理员名单
  → 合成「主人私聊」事件，role=admin
  → 工具的 event.send 落到主人私聊

tool-ack → 模型
```

没有 `ownerId` 时 Coo 轮次不借身份，直接告诉 Coo 去填。过期的 QQ 轮次直接拒绝，不借上一条 QQ 消息，也不回退 owner。World 侧若已经收到管理员名单，会先检查 `ownerId` 是否在名单里；名单还没到时不拦，由插件最终校验。

插件侧还会检查：

```text
enabled
turn 在 _turns 里，600 秒内（QQ 轮次）
actor.id 在 admins_id 里（Coo 轮次）
tools_allow
AstrBot 工具权限
```

工具失败时 World 显示插件的 `note`（中文）和/或 `error`（稳定 code）；工具清单可能运行中变化，提示词建议先调 `astrbot_status`。

---

## 7. 连接

```text
World 是客户端
start() 不 reject
重连 1s → 30s；token/版本被拒时退避至少 10s
收到首个 ready 才把退避收回 1s
心跳 20s ping + 120s idle
握手 10s + 2s guard
```

`open` 只说明 WebSocket 通了；token 错（4003）或版本不匹配（4004）也是在 open 之后才被桥拒绝，所以状态与就绪以 `ready` 为准。非法 UMO 的入站帧不会丢，会回退 `conv` 记账并记警告，只是不能作为发送目标。

连接状态变化会写事件：

```text
astrbot.connected
astrbot.disconnected
```

启动最多等 12 秒；超时先让 Coo 继续启动，驱动在后台继续重连。

---

## 8. 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 挂载开关；启停由 Coo 的 World 页控制 |
| `wsUrl` | 空 | `ws://<桥地址>:17999` |
| `token` | 空 | 与插件一致；两边都空表示不校验 |
| `mode` | `mention` | deprecated，策略已归插件 |
| `nameAliases` | 空 | deprecated |
| `maxSendsPerMinute` | `20` | deprecated，限流在插件 |
| `includeTime` | `true` | 消息行首是否带时间 |
| `channelHint` | `true` | 是否在需要回复的消息后加渠道提示 |
| `reconnectBaseMs` | `1000` | 断线后第一次重连等待 |
| `reconnectMaxMs` | `30000` | 重连等待上限 |
| `ownerId` | 空 | Coo 对话轮次调用 AstrBot 工具时借用的管理员 QQ；留空表示不借 |

### Coo 侧「连接」页

World 页的第一个页签是「连接」，只放 Coo 这一端的东西：

```text
状态        已连接 / 等待连接 / 未启用，桥地址
接入        桥地址、桥 token（含「清除已存 token」）
工具身份    主人 QQ + 当前 AstrBot 管理员名单
行为        时间前缀、渠道提示、重连初始间隔与上限
运行时      自报身份、主人、语音、工具数、会话数（只读）
```

启停不在这个面板：需要到 Coo 的 World 页打开或关闭「AstrBot · QQ」。面板里的保存不会改变启停状态。

保存经 `ctx.setConfig('world:astrbot', ...)` 写回配置：

```text
includeTime / channelHint / ownerId   保存后即时生效
wsUrl / token / reconnect*            保存后要点「重启 World」
```

token 输入框留空表示保持原值；要清空必须显式点「清除已存 token」。保存期间表单锁定，等待期的改动会提示尚未提交，不会被刷新静默覆盖。主人 QQ 只接受数字、最长 20 位。

群聊范围、私聊白名单、工具勾选和语音 Provider 仍在 AstrBot 插件页；
「配置」页签保留同一个 World 的通用表单，作为兜底。

构建：

```bash
pnpm build:web   # src/webui/client.ts → dist/webui.js + dist/webui.css
```

`package.json` 的 `cortico.webUiClient` / `webUiStyle` 指向这两个产物。
改了 WebUI 代码要重新 build 并**重启 Coo**（扩展资源在启动时缓存）。

---

## 9. 重启与加载

World 是 link 加载时：

```text
改 src/world.ts
→ /api/worlds/restart 只重建实例
→ 不一定清 ESM 模块缓存
→ 完整重启 Coo 才可靠
```

确认加载：

```text
GET http://127.0.0.1:17788/api/worlds
→ astrbot status = active
```

---

## 10. 测试

```bash
pnpm typecheck
pnpm test
```

当前 Vitest 共 134 个用例（world 120 + driver 14），全部通过。覆盖：

```text
连接与重连（含 token 错时的 10s 退避）
消息投递与非法 UMO 回退
工具调用两条身份路径
QQ / 桌宠混合
多会话显式目标
通知不建立/不清空轮次
轮次过期与长工具链续期
历史查询回退
截图授权
```
