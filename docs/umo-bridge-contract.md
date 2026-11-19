# Cortico ↔ AstrBot：UMO 与两端配置契约

状态：v1（已采用）
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

### 2.4 兼容旧帧

旧帧没有 `umo` 时：

1. 如果有 `platform` + `conv`，派生：
   ```text
   platform + ":" + (conv.kind === "group" ? "GroupMessage" : "FriendMessage") + ":" + conv.id
   ```
2. 如果没有 `platform`，只用 `kind:id` 作为 legacy key：
   ```text
   legacy:group:123456789
   legacy:private:100000001
   ```
3. legacy key 只用于兼容和展示，**不能作为新发送目标**，除非已经映射到真实 UMO。

---

## 3. 单一事实来源

当前两端有重复开关，必须先拆干净：

| 能力 | 归属 | 说明 |
|---|---|---|
| 桥地址、token | World | 客户端连接信息 |
| 连接开关、重连 | World | 客户端行为 |
| 时间前缀、回复提示 | World | 展示行为 |
| 群范围（全部群 / 指定群） | 插件 | 谁可以进来 |
| B 模式（全部消息 / 仅被叫） | 插件 | 什么消息进来 |
| 称呼/别名 | 插件 | 判断是否被叫到 |
| 私聊模式/白名单/管理员豁免/拒绝策略 | 插件 | 谁可以私聊 |
| 发送频率硬上限 | 插件 | 防止刷屏 |
| 图片/语音/工具 | 插件 | AstrBot 能力 |

结论：

- **World 删除/隐藏 `mode`、`nameAliases`、`maxSendsPerMinute`。**
- **插件删除/迁移 `observe_all`、`observe_groups`，改为显式的新键。**
- 每帧消息由插件带上 `mentioned` 标记；World 不再自己判断称呼。

---

## 4. AstrBot 插件配置

### 4.1 新配置

```json
{
  "enabled": true,
  "listen_host": "0.0.0.0",
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
  "reconnectBaseMs": 1000,
  "reconnectMaxMs": 30000,
  "includeTime": true,
  "channelHint": true
}
```

### 5.2 废弃

- `mode`：由插件 `group_mode` 接管。
- `nameAliases`：由插件 `name_aliases` 接管。
- `maxSendsPerMinute`：由插件 `max_sends_per_minute` 接管。

处理方式：

- 配置 UI 隐藏或标为“由 AstrBot 管理”。
- World 启动时如果检测到这些旧值，只记录一次日志，不参与运行。
- 不主动删除用户配置，避免回滚时丢失。

---

## 6. 帧契约

### 6.1 基本帧

```json
{ "t": "hello", "v": 1, "token": "…", "name": "Cortico", "capabilities": { "images": true } }
{ "t": "ready", "v": 1 }
```

### 6.2 收消息

```json
{
  "t": "msg",
  "id": "…",
  "umo": "default:GroupMessage:123456789",
  "conv": { "kind": "group", "id": "123456789" },
  "sender": "…",
  "text": "…",
  "mentioned": true,
  "notice": false,
  "ts": "…"
}
```

规则：

- `umo` 必需；`conv` 是投影。
- 两者不一致时，以 UMO 为准，记录警告。
- `mentioned` 由插件计算，World 只展示。
- 通知帧同样带 `umo`。

### 6.3 发消息

```json
{
  "t": "send",
  "rid": "…",
  "umo": "default:GroupMessage:123456789",
  "conv": { "kind": "group", "id": "123456789" },
  "text": "…"
}
```

规则：

- `umo` 必需。
- World 只允许发送到**已知 UMO**；未知 UMO 返回 `unknown_umo`。
- 如果 `conv` 与 UMO 不一致，返回 `umo_conv_mismatch`。
- 旧客户端只发 `conv` 时，World 用 `kind:id` 查已知 UMO；找不到就拒绝 `unknown_conv`。

### 6.4 回执

```json
{ "t": "ack", "rid": "…", "ok": true }
{ "t": "ack", "rid": "…", "ok": false, "error": "unknown_umo" }
```

错误码：

| 错误码 | 含义 |
|---|---|
| `invalid_umo` | UMO 格式非法 |
| `umo_conv_mismatch` | UMO 和 conv 指向不同会话 |
| `unknown_umo` | 桥没见过这个 UMO |
| `unknown_conv` | 旧帧的 conv 无法映射到 UMO |
| `not_connected` | 桥未连接 |

---

## 7. World 会话存储

```ts
type Conv = {
  key: string;        // umo，或 legacy:group:id
  umo?: string;       // 只有真实 UMO 才有
  kind: 'group' | 'private' | 'unknown';
  id: string;
  name?: string;
  lastSeen: number;
};
```

规则：

- `convs` 以 `key` 为唯一键；真实 UMO 优先。
- `lastConv` 存 UMO；没有 UMO 时存 legacy key。
- 历史过滤：先按 UMO，再按 legacy key。
- 截图授权：以 UMO 为键；legacy 会话单独用 legacy key。
- UI 展示 UMO，可点击复制；名称只是显示字段。

---

## 8. 兼容矩阵

| World | 插件 | 行为 |
|---|---|---|
| 1.3.5 | 1.3.5 | UMO 主键，完整功能 |
| 1.3.4 | 1.3.5 | 旧帧无 UMO，插件发 conv；World 走 legacy |
| 1.3.5 | 1.3.4 | 插件不发 UMO；World 用 conv 派生 legacy |
| 更旧 | 更旧 | 只保证基本收发，不保证历史/截图按 UMO |

原则：**新端必须兼容旧端，旧端不要求理解 UMO。**

---

## 9. UI 语义

### 9.1 插件控制台

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

- 只保留：启用、桥地址、token、重连、时间前缀、回复提示。
- 不再出现群范围、B 模式、称呼、发送上限。
- 旧字段如果存在，标注“由 AstrBot 插件管理”，不参与运行。

---

## 10. 实施顺序

1. 本文档定稿。
2. 两端各加 UMO 解析/校验的共享测试向量。
3. 插件：新配置 + 迁移 + 策略单一来源 + UMO 注册表 + 发送校验。
4. World：删除重复策略配置 + 会话存储/历史/截图统一按 UMO。
5. 协议兼容测试：新新、新旧、旧新、旧旧。
6. 端到端：群聊、私聊、未知 UMO、legacy 帧、UMO/conv 不一致。
7. 最后再部署测试服。

---

## 11. 已确定

1. **群范围默认值**：`all`，升级不突然断群聊。
2. **配置键采用** `group_scope` / `group_allow` / `group_mode`；旧键只做迁移。
3. **World 移除/隐藏** `mode` / `nameAliases` / `maxSendsPerMinute`，由插件单一拥有。
4. **发送目标只允许已知 UMO**；注册表在插件，World 只做格式/一致性校验，未知 UMO 由插件拒绝。
