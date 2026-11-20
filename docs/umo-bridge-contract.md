# Cortico ↔ AstrBot：UMO 与两端配置契约

状态：v1（已采用，单通道）

适用范围：`cortico-world-astrbot`（World）与 `astrbot_plugin_cortico_bridge`（插件）

---

## 1. 目标

这份文档只解决三件事：

1. **UMO 怎么定义、怎么解析、谁说了算。**
2. **两端各自拥有哪些设置，避免同一个开关两边都有。**
3. **旧配置和旧帧怎么迁移，升级后不突然断聊。**

不在本文范围：图片/语音/工具的具体实现、UI 视觉细节。

---

## 2. UMO 定义

### 2.1 格式

```text
umo = platform_id ":" message_type ":" session_id
```

示例：

```text
default:GroupMessage:123456789
default:FriendMessage:100000001
```

- `platform_id`：AstrBot 平台实例 ID，例如 `default`。
- `message_type`：
  - `GroupMessage` → 群聊
  - `FriendMessage` → 私聊
  - 其他类型保留，按 `unknown` 处理，不主动投递。
- `session_id`：群号或用户号。**允许包含冒号**，解析时只切前两个冒号。

### 2.2 UMO 是唯一主键

- 收消息、发消息、历史、截图授权、最近会话，全部以 UMO 为主键。
- `conv = { kind, id }` 是 UMO 的**投影**，用于旧逻辑和 UI 展示，不是权威键。
- 同时存在 UMO 和 conv 时：
  - **UMO 优先**。
  - 发送时如果两者不一致，直接拒绝，返回 `umo_conv_mismatch`，避免把消息发错会话。

### 2.3 解析规则

```text
parseUmo("default:GroupMessage:123456789")
→ { platform: "default", type: "GroupMessage", kind: "group", id: "123456789" }
```

- 只按前两个 `:` 切分。
- `platform`、`type`、`session` 任一为空 → 非法。
- 最大长度 512。
- `type` 大小写敏感；只接受 `GroupMessage` / `FriendMessage`。
- 不在 UMO 里解析群名、昵称、平台显示名；这些是展示字段。

### 2.4 旧帧（历史兼容，仅 1.3.4）

1.3.4 及更早的桥发过没有 `umo` 的帧；当时的 World 用 `platform` + `conv` 派生，或退化成 `kind:id` 的 legacy key。

当前是**单通道**：

- 插件发出的消息帧必须带 `umo`；`conv` 只做投影。
- World 收到非法 UMO 时不会丢掉整条帧（尤其是撤回/入群通知），会按 `conv` 记账并记警告，但这样的会话**没有 UMO**，不能作为发送目标。
- World 发送必须带 UMO；找不到带 UMO 的已知会话时在本地就拒绝，不会让桥回 `missing_umo`。
- 历史上出现过的 `unknown_conv` 已不再使用；桥对无 UMO 的发送返回 `missing_umo`。

---

## 3. 单一事实来源

| 能力 | 归属 | 说明 |
|---|---|---|
| 桥地址、token | World | 客户端连接信息 |
| 启停 | Coo World 页 | `worlds.astrbot.enabled` 是挂载开关，面板里没有这个开关 |
| 重连、时间前缀、回复提示、主人 QQ | World | 客户端行为 |
| 群范围（全部群 / 指定群） | 插件 | 谁可以进来 |
| B 模式（全部消息 / 仅被叫） | 插件 | 什么消息进来 |
| 称呼/别名 | 插件 | 判断是否被叫到 |
| 私聊模式/白名单/管理员豁免/拒绝策略 | 插件 | 谁可以私聊 |
| 发送频率硬上限 | 插件 | 防止刷屏 |
| 图片/语音/工具 | 插件 | AstrBot 能力 |

结论：

- **World 不再把 `mode`、`nameAliases`、`maxSendsPerMinute` 暴露给用户。** 三个键仅为旧配置读取保留，运行时不参与。
- **插件删除/迁移 `observe_all`、`observe_groups`，改为显式的新键。**
- 每帧消息由插件带上 `mentioned` 标记；World 不再自己判断称呼。

---

## 3.1 平台边界

AstrBot 可能同时接多个平台/账号（例如 `default`、`default1`、WebUI 的 `webchat`、Cortico 的 `console`）。桥只拥有 `bridge_platforms` 里列出的平台：

- 只处理 UMO 第一段在列表中的事件。
- 列表外的平台（`webchat`、`console`、`default1` 等）**不推送、不 stop**，完全交回 AstrBot / 对应 World。
- 默认 `["default"]`，避免两个 QQ 账号同时接同一群造成重复。
- 这样桥只接管自己的 QQ 会话，不会杀死正常控制台对话。

## 4. AstrBot 插件配置

### 4.1 新配置

```json
{
  "enabled": true,
  "listen_host": "127.0.0.1",
  "listen_port": 17999,
  "token": "…",

  "group_scope": "all",
  "group_allow": [],
  "group_mode": "mention",
  "name_aliases": ["Coo", "库"],

  "private_mode": "all",
  "private_allow": [],
  "private_admin_bypass": true,
  "private_deny": "ignore",

  "max_sends_per_minute": 30
}
```

`listen_host` 默认回环；跨机部署才改 `0.0.0.0`，并同时设置 token。

### 4.2 群聊语义

- `group_scope = "all"`：所有群都可以进入，`group_allow` 不生效。
- `group_scope = "allowlist"`：只处理 `group_allow` 里的群。
  - `group_allow` 为空 → **配置非法**，不能保存；避免“空列表=全部群”的歧义。
  - 列表项接受 UMO 或旧群号；匹配时 UMO 优先，旧群号回退。
- `group_mode = "mention"`：只有 @ 或命中 `name_aliases` 才投递。
- `group_mode = "all"`：群里每条消息都投递；Coo 自己决定回不回。
- `group_mode` 取代旧的 `observe_all`。

### 4.3 私聊语义

- `private_mode = "off"`：私聊不交给 Coo；`private_deny` 决定是否把消息留给 AstrBot。
- `private_mode = "allowlist"`：
  - `private_allow` 里的 UMO/QQ 可以进来。
  - `private_admin_bypass = true` 时，AstrBot 管理员绕过名单。
  - `private_deny` 处理名单外的人。
- `private_mode = "all"`：所有私聊都进来；`private_allow`、`private_admin_bypass`、`private_deny` 都不生效。
- 管理员名单只来自 AstrBot 全局 `admins_id`，插件不另存一份。

### 4.4 旧配置迁移

| 旧键 | 新键 | 规则 |
|---|---|---|
| `observe_groups: []` | `group_scope: "all"` | 空列表原本就是全部群 |
| `observe_groups: [...]` | `group_scope: "allowlist"`, `group_allow: [...]` | 保留原列表 |
| `observe_all: true` | `group_mode: "all"` | |
| `observe_all: false` | `group_mode: "mention"` | |
| `private_*` | 不变 | 旧配置没有 `private_mode` 时按 `all` |

迁移原则：

- 读取时优先新键；新键不存在时从旧键推导。
- 保存时写新键，同时镜像旧键一个版本，方便回滚。
- UI 只展示新语义，不再出现“空列表=全部群”。

---

## 5. World 配置

### 5.1 保留

```json
{
  "enabled": true,
  "wsUrl": "ws://…:17999",
  "token": "…",
  "includeTime": true,
  "channelHint": true,
  "reconnectBaseMs": 1000,
  "reconnectMaxMs": 30000,
  "ownerId": ""
}
```

- `enabled` 是挂载开关，默认关闭；**启停只在 Coo 的 World 页**，不在本 World 的面板里。
- `reconnectBaseMs` / `reconnectMaxMs` 默认 1000 / 30000；token 或版本被桥拒绝时，退避至少 10 秒起步，收到 `ready` 后才恢复初始值。
- `ownerId` 是 Coo 对话轮次调用 AstrBot 工具时借用的管理员 QQ；纯数字、20 位以内，留空表示不借身份。

### 5.2 废弃

- `mode`：由插件 `group_mode` 接管。
- `nameAliases`：由插件 `name_aliases` 接管。
- `maxSendsPerMinute`：由插件 `max_sends_per_minute` 接管。

处理方式：

- 配置 UI 不展示这些键。
- World 启动时如果检测到这些旧值，不参与运行。
- 不主动删除用户配置，避免回滚时丢失。

---

## 6. 帧契约

### 6.1 基本帧

```json
{ "t": "hello", "v": 1, "token": "…", "name": "Cortico", "capabilities": { "images": true } }

{ "t": "ready", "v": 1, "channel": "qq",
  "self": { "id": "…", "name": "…" },
  "admins": ["42"],
  "tts": { "ready": true, "provider": "edge_tts" } }
```

- 第一帧必须是 `hello`；`v` 必须是 `1`。版本不对 → close `4004`，token 不对 → `4003`，第一帧不是 hello → `4002`。URL 带 token → `4401`，带 Origin → `4403`。
- token 也可放在 `Authorization: Bearer …`；头和帧都出现时必须一致。
- `ready` 之前的连接不算就绪。`admins` 是 AstrBot 管理员名单，`tts` 是语音能力（旧版是布尔值，World 两种都认）。

### 6.2 收消息

```json
{
  "t": "msg",
  "id": "…",
  "ts": "2026-10-26T10:00:00+08:00",
  "umo": "default:GroupMessage:123456789",
  "conv": { "kind": "group", "id": "123456789", "name": "…" },
  "sender": { "id": "42", "name": "…" },
  "text": "…",
  "mentioned": true,
  "notice": false,
  "role": "admin",
  "owner": true,
  "can": { "screenshot": true },
  "images": [{ "mime": "image/jpeg", "base64": "…" }],
  "image_errors": [{ "index": 0, "reason": "下载超时" }]
}
```

通知帧形状相同，多一个 `kind: "notice"` 与 `ref`：

```json
{ "t": "msg", "kind": "notice", "id": "", "ref": "被撤回的消息id",
  "umo": "default:GroupMessage:123456789",
  "conv": { "kind": "group", "id": "123456789" },
  "text": "[撤回] 小明 撤回了一条消息", "mentioned": false }
```

规则：

- `umo` 必需；`conv` 是投影。
- 两者不一致时，以 UMO 为准，记录警告。
- `mentioned` 由插件计算，World 只展示。
- 通知同样带 `umo`，但通知**不建立 QQ 轮次**，也不能当发送目标或工具身份。
- 非法 UMO 回退 `conv` 记账并记警告，不丢通知；这种会话不能用于发送。

### 6.3 发消息

```json
{
  "t": "send",
  "rid": "a-1",
  "umo": "default:GroupMessage:123456789",
  "conv": { "kind": "group", "id": "123456789" },
  "text": "…",
  "replyTo": "可选的消息id",
  "voice": true,
  "image": { "mime": "image/jpeg", "base64": "…" }
}
```

规则：

- `umo` **必填**；`conv` 只是投影。
- World 只允许发送到**已知 UMO**：显式目标找不到带 UMO 的会话时，World 本地就返回中文原因，不发帧。
- 如果 `conv` 与 UMO 不一致，返回 `umo_conv_mismatch`。
- 桥没见过 UMO（或超过 30 天）返回 `unknown_umo`。
- 只有当前这一轮是 QQ 轮次才能发；桌宠/控制台、mixed、过期轮次一律拒绝，显式 `conv_id` 不能绕过。

### 6.4 回执

```json
{ "t": "ack", "rid": "a-1", "ok": true, "voice": false, "note": "…" }
{ "t": "ack", "rid": "a-2", "ok": false, "error": "send_failed",
  "note": "发送失败，详情见插件日志", "uncertain": true }
```

- `error` 放稳定英文 code，`note` 放中文说明；World 优先展示 `note`，有额外 code 时附在括号里。
- `uncertain: true` 表示「可能已经发出，先确认再重试」。

发送错误码：

| 错误码 | 含义 |
|---|---|
| `missing_umo` | 发送帧没有 `umo`，单通道拒绝 |
| `invalid_umo` | UMO 格式非法 |
| `unknown_umo` | 桥没见过这个 UMO，或超过 30 天 |
| `umo_conv_mismatch` | UMO 和 conv 指向不同会话 |
| `bad_session` | `conv.kind` / `conv.id` 不合法 |
| `empty_message` | 正文和图片都为空 |
| `voice_needs_text` | 语音没有正文 |
| `voice_image_conflict` | 语音和图片同条 |
| `bad_image` / `image_too_large` / `image_bad_type` | 图片字段、大小或 mime 不合法 |
| `rate_limited` | 超过每分钟发送上限 |
| `door_closed` | 插件未启用，发送门关着 |
| `send_queue_timeout` | 同会话排队超时，确定没发 |
| `send_timeout` / `send_failed` | 平台超时或发送层异常，结果可能未知（带 `uncertain`） |
| `platform_missing` | AstrBot 里找不到对应平台 |
| `tts_unavailable` | 语音不可用 |
| `busy` | 并发帧超限，本帧未执行 |

### 6.5 工具帧

```json
{ "t": "tools", "items": [
  { "name": "get_weather", "risk": "read", "desc": "…", "sig": "city" }
] }

{ "t": "tool", "rid": "t-1", "name": "get_weather", "args": { "city": "上海" },
  "turn": "触发这一轮的消息id" }
{ "t": "tool", "rid": "t-2", "name": "get_weather", "args": { "city": "上海" },
  "turn": "", "actor": { "kind": "owner", "id": "42" } }

{ "t": "tool-ack", "rid": "t-1", "ok": true, "result": "…" }
{ "t": "tool-ack", "rid": "t-2", "ok": false, "error": "tool_failed", "note": "…" }
```

- `turn` 与 `actor` 只能二选一；都没有 → `missing_identity`，同时都有 → `ambiguous_identity`，actor 形状不对 → `bad_actor`。
- 插件再次校验 `turn` 未过期（600 秒）、`actor.id` 在 `admins_id`、`tools_allow` 与 AstrBot 工具权限。
- 工具异常返回 `tool_failed`，异常原文只进插件日志。

---

## 7. World 会话存储

```ts
type Conv = {
  umo?: string;              // 真实 UMO；旧帧回退 kind:id 时没有
  kind: 'group' | 'private';
  id: string;
  name?: string;             // 只用于展示
};
```

规则：

- World 的 `convs` 是本次连接见过的会话；真实 UMO 优先。
- `lastConv` 可能是没有 UMO 的旧会话，只用于展示/历史，不用于发送授权。
- 历史过滤：先按 UMO，再按 `kind:id`。
- 截图授权：以会话为键，并绑定到这一轮最后一条人话消息 id。
- UI 展示 id，名称只是显示字段。

插件侧会话表 `umos.json` 的 v2 形状（已实施）：

```json
{
  "version": 2,
  "umos": {
    "default:GroupMessage:123456789": {
      "umo": "default:GroupMessage:123456789",
      "platform": "default",
      "kind": "group",
      "id": "123456789",
      "name": "测试群",
      "firstSeen": 1763500000.0,
      "lastSeen": 1763510000.0,
      "lastMessageId": "528745781",
      "lastSender": "100000001"
    }
  },
  "legacy": { "default|group|123456789": "default:GroupMessage:123456789" }
}
```

- 时间是 **epoch 浮点秒**，不是 ISO 字符串。
- 当前没有 `type`、`caps`、`source` 字段；`type` 可由 UMO 派生，截图能力看消息帧的 `can.screenshot`。
- 上限 500 条，30 天未出现不参与发送；原子写 + 权限 600；旧表迁移后备份 `umos.v1.json`。

---

## 8. 兼容矩阵

| World | 插件 | 行为 |
|---|---|---|
| 1.3.6 | 1.3.6 | UMO 单通道，完整功能 |
| 1.3.5 | 1.3.5 | UMO 主键；发送帧已要求 UMO |
| 1.3.6 | 1.3.4 及更早 | 入站可能无 UMO：能显示，不能回发 |
| 1.3.4 及更早 | 1.3.6 | 发送无 UMO → `missing_umo`；建议两端同步升级 |

原则：**当前单通道要求 UMO；旧帧只做只读兼容。** 升级时先升插件再升 World，或两端一起升。

---

## 9. UI 语义

### 9.1 插件控制台

- 概览 / 群聊 / 私聊 / 工具 / 语音五栏。
- 群聊：
  - 范围：全部群 / 指定群
  - 指定群列表（空时禁止保存）
  - 消息范围：仅被叫 / 全部消息
- 私聊：
  - 模式：关闭 / 仅名单 / 全部
  - 名单、管理员豁免、拒绝策略按模式联动
- 概览：
  - 消息流显示 UMO，可复制
  - 显示“生效中的范围/模式”，不显示无效项

### 9.2 World 设置

- 只保留：桥地址、token（可清除）、重连、时间前缀、回复提示、主人 QQ。
- 启停只在 Coo 的 World 页，面板里没有「启用这个 World」开关。
- 不再出现群范围、B 模式、称呼、发送上限。
- 旧字段如果存在，不参与运行，也不在面板展示。

---

## 10. 实施顺序

1. 本文档定稿。
2. 两端各加 UMO 解析/校验的共享测试向量。
3. 插件：新配置 + 迁移 + 策略单一来源 + UMO 注册表 + 发送校验。
4. World：删除重复策略配置 + 会话存储/历史/截图统一按 UMO。
5. 协议兼容测试：新新、新旧、旧新、旧旧。
6. 端到端：群聊、私聊、未知 UMO、legacy 帧、UMO/conv 不一致。

---

## 11. 已确定

1. **群范围默认值**：`all`，升级不突然断群聊。
2. **配置键采用** `group_scope` / `group_allow` / `group_mode`；旧键只做迁移。
3. **World 不再展示** `mode` / `nameAliases` / `maxSendsPerMinute`，由插件单一拥有。
4. **发送目标只允许已知 UMO**：World 先做格式/一致性/已知会话校验，插件最终校验；无 UMO 一律拒绝。
