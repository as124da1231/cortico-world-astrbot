# Coo 侧：World 的实现细节

插件负责连接、账号、策略和工具；World 负责把 QQ 事件交给 Coo，并把 Coo 的回复送回桥。

---

## 1. 工具

| 工具 | 用途 |
|---|---|
| `astrbot_send_message` | 往 QQ 发文字、图片、语音；只允许当前 QQ 轮次 |
| `astrbot_status` | 查看连接、最近会话、工具清单 |
| `astrbot_read_history` | 读某个会话的历史；默认当前轮，允许最近会话 |
| `astrbot_call_tool` | 调 AstrBot 的工具；需要当前 QQ 轮次的 `turn` |

工具名与声明在 `ASTRBOT_TOOL_DECLS` / `CALL_TOOL_DECL`，`describe.json` 从同一份声明生成。

---

## 2. 环境提示词

`envPromptVars()` 提供：

```text
astrbot.connection        连接状态
astrbot.scope             群范围、消息范围、称呼归插件管
astrbot.self              bot 自己的 QQ 号
astrbot.owner             QQ 上的主人
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
turnMixed       QQ + 桌宠/其他渠道混在一批
turnMultiConv   同一批有多个人话 QQ 会话
turnConv        当前 QQ 会话
turnMsgId       当前人话消息 id
turnChannelAt   置位时间，2 分钟兜底
```

`onEventsSettled` 每批更新一次：

```text
没有 QQ 人话        → 清空 QQ 出口
只有 QQ 人话        → 开 QQ 出口
QQ + 桌宠/其他      → turnMixed = true，QQ 出口关闭
多个人话 QQ 会话    → turnMultiConv = true，隐式发送拒绝
通知               → 不算人话，不改变目标
```

`onTurnEnded` / `onRunPhase('idle')` 清空全部状态。

---

## 4. 目标选择

```text
pickConv(args, { allowLast? }):
  1. conv_id        → 显式目标
  2. reply_to       → 查 knownMsgConv，回到原消息所在会话
  3. turnMultiConv  → 发送时拒绝，要求显式指定
  4. turnConv       → 当前轮
  5. allowLast      → 历史查询才允许回退 lastConv
```

发送永远不回退 `lastConv`。  
历史查询允许，因为桌宠轮次查最近 QQ 历史是只读行为。

`knownMsgConv` 保存最近 200 条消息 id → 会话，用于 `reply_to`。

---

## 5. 出站

```text
astrbot_send_message
  → 检查 qqTurnActive
  → 检查 connected
  → pickConv
  → driver.send(conv, text, replyTo, image, voice)
  → 帧 {t:'send', rid, umo, conv, text, ...}
  → 桥
```

边界：

```text
桌宠/控制台轮次       → 拒绝
混合批次              → 拒绝
多会话但不指定目标    → 拒绝
图片                  → 只接受 host.blob 的 log:/mem: 句柄
语音                  → 需要正文，不能和图片同条
```

`pet_say` 是桌宠聊天页和头顶气泡的出口，不是 QQ 出口。

---

## 6. 工具链

```text
astrbot_call_tool(name, args)
  → 需要 qqTurnActive 和 turnMsgId
  → driver.callTool(name, args, turn)
  → 帧 {t:'tool', rid, name, args, turn}
  → 插件 _on_tool_call
  → tool-ack
```

插件侧还会检查：

```text
enabled
turn 在 _turns 里，600 秒内
tools_allow
AstrBot 工具权限
```

---

## 7. 连接

```text
World 是客户端
start() 不 reject
重连 1s → 30s
心跳 20s ping + 120s idle
握手 10s + 2s guard
```

连接状态变化会写事件：

```text
astrbot.connected
astrbot.disconnected
```

---

## 8. 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | World 开关 |
| `wsUrl` | 空 | `ws://<桥地址>:17999` |
| `token` | 空 | 与插件一致 |
| `mode` | `mention` | deprecated，策略已归插件 |
| `nameAliases` | `[]` | deprecated |
| `maxSendsPerMinute` | `30` | deprecated，限流在插件 |
| `includeTime` | `true` | 消息行首是否带时间 |
| `channelHint` | `true` | 是否在需要回复的消息后加渠道提示 |

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

覆盖：

```text
连接与重连
消息投递
工具调用
QQ / 桌宠混合
多会话显式目标
通知不改变目标
历史查询回退
截图授权
```

当前 92/92。
