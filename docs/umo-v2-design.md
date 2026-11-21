# UMO v2 设计：从“会话字符串”升级为桥的主承载对象

状态：§3 注册表 v2 已部分实施（字段比本稿少，见 3.2）；§4–§6 仍是设计稿，未实施。
范围：`cortico-world-astrbot` + `astrbot_plugin_cortico_bridge`

> 历史设计稿：本文保留当时的推理与未实施项，**行为以当前代码与 README 为准**。文中「非 QQ 轮次一律拒绝」等结论已被 1.3.6 的主动发送规则取代。

---

## 1. 目标

把 UMO 从“消息里附带的一个字段”升级为桥的**唯一会话承载对象**：

- 所有入站事件、出站发送、历史、截图授权、去重、工具调用、UI 会话列表，都以 UMO 为主键。
- UMO 的**格式、注册表、当前轮次、目标校验**分别有明确归属，不再靠 `lastConv` 和时间窗口猜。
- QQ 侧和 Coo 侧的边界保持独立：QQ 用 UMO；Coo 的 desktop-pet/console 用各自的 World 会话，不伪造 UMO。

非目标：

- 不把 desktop-pet/console 的会话强行塞进 AstrBot UMO。
- 不把整个桥改成通用多框架协议；只把当前 AstrBot 桥做稳。

---

## 2. UMO 模型

### 2.1 线上格式不变

```text
umo = platform ":" message_type ":" session_id
```

例：

```text
default:GroupMessage:123456789
default:FriendMessage:100000001
```

保留现有格式，避免 1.3.x 客户端升级时断链。

### 2.2 内部值对象

两端各自解析成结构体，不在业务代码里反复 `split`：

```ts
interface Umo {
  raw: string;
  platform: string;
  type: 'GroupMessage' | 'FriendMessage';
  kind: 'group' | 'private';
  session: string;
}
```

规则：

- 只切前两个冒号，`session` 里允许冒号。
- 平台、类型、会话任一为空 → 非法。
- 最大长度 512。
- UMO 是**不透明键**：不解析群名、昵称、平台显示名。
- `canonicalUmo()` 只做去除首尾空白，不做大小写/编码改写。

### 2.3 与 `conv` 的关系

- UMO 是权威键。
- `conv { kind, id }` 是投影，只用于旧逻辑和 UI。
- 入站：有 UMO 时由 UMO 派生 conv；conv 不一致只记录警告。
- 出站：UMO 必填；conv 可选，出现时必须与 UMO 一致，否则拒绝 `umo_conv_mismatch`。

---

## 3. 注册表 v2（插件拥有）

### 3.1 定位

插件是**唯一 UMO 注册表**；World 只持有只读快照，不另存权威列表。

注册表负责：

- 已知 UMO 的发送白名单
- 最近会话/UI
- 平台、类型、显示名、首次/最后出现
- 截图能力、主人身份等元数据
- 去重与历史索引

不负责：

- 当前轮次（temporary）
- 消息正文
- World 侧的会话状态

### 3.2 磁盘格式

`umos.json` v2（**当前实际形状**）：

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
  "legacy": {
    "default|group|123456789": "default:GroupMessage:123456789"
  }
}
```

规则：

- 键是原始 UMO，不再用 `platform|kind|id` 作为主键；`legacy` 只做迁移索引。
- 时间是 **epoch 浮点秒**，不是 ISO 字符串。
- 当前**没有** `type`、`caps`、`source` 字段；`type` 可由 UMO 派生，截图能力看消息帧的 `can.screenshot`。
- 原子写、临时文件 + `os.replace`、权限 600。
- 上限 500 条；30 天未出现不参与发送，但可保留历史。
- 发送白名单只认 `lastSeen` 在 TTL 内的条目。
- 一个 UMO 可以对应多个平台账号；不同平台就是不同 UMO，不合并。
- v2 空表或坏值不会让插件起不来；旧版 v1 表迁移后备份为 `umos.v1.json`。

### 3.3 迁移

- 读取 v1 的 `platform|kind|id -> {umo, ts}`：
  - 转换为 v2 条目；
  - 保留 `legacyKeys` 映射，供旧帧解析。
- 写回 v2；旧文件备份为 `umos.v1.json`（只保留一次，权限 600）。
- 迁移失败不启动发送白名单，记录错误，桥仍可接收但发送拒绝 `unknown_umo`。

---

## 4. 协议 v1.1（设计稿，未实施）

> 当前线上仍是协议 v1：`hello.v = 1`，只有 hello/ready/msg/tick/ack/send/tools/tool/tool-ack。下面带 `v: 2`、`platforms`、`umos`、`umo` 增量帧的设计都**没有实现**。

### 4.1 握手

```json
{
  "t": "hello",
  "v": 2,
  "token": "…",
  "name": "Cortico",
  "platforms": ["default"],
  "capabilities": { "images": true }
}
```

`ready` 返回：

```json
{
  "t": "ready",
  "v": 2,
  "self": { "id": "…", "name": "…" },
  "platforms": ["default"],
  "umos": [
    { "umo": "…", "kind": "group", "id": "…", "name": "…", "lastSeen": "…" }
  ]
}
```

- 插件是注册表权威；World 只缓存 `ready.umos` 快照。
- 增量：插件在 UMO 新增/更新时发 `{t:"umo", op:"upsert"|"remove", umo:{...}}`；World 更新本地缓存。
- World 发 `send` 时仍带 UMO；插件最终校验。

### 4.2 入站

```json
{
  "t": "msg",
  "id": "…",
  "umo": "default:GroupMessage:123456789",
  "conv": { "kind": "group", "id": "123456789" },
  "sender": { "id": "…", "name": "…" },
  "text": "…",
  "mentioned": false,
  "notice": false,
  "ts": "…"
}
```

规则：

- `umo` 必填（v2 帧）。
- `conv` 可省略；出现时不匹配只记录 `convMismatch`，以 UMO 为准。
- `platform` 字段不再必需；从 UMO 派生。
- 旧 v1 帧无 UMO：按 `conv` 派生 legacy key，只做兼容展示，不作为新发送目标。

### 4.3 出站

```json
{
  "t": "send",
  "rid": "…",
  "umo": "default:GroupMessage:123456789",
  "text": "…"
}
```

规则：

- UMO 必填；不再允许只给 `conv` 的新帧。
- 目标必须在插件注册表内且未过期，否则 `unknown_umo`。
- 不允许 `lastConv` 回退。
- 当前轮次工具发送还要求 `umo === currentUmo`，否则 `umo_not_current`。

### 4.4 错误码

设计稿里列过 `umo_not_current` / `umo_stale` / `invalid_conv`，**当前没有实现**。线上实际使用：

```text
发送参数   missing_umo / invalid_umo / unknown_umo / umo_conv_mismatch
           bad_session / empty_message / voice_needs_text / voice_image_conflict
           voice_at_conflict / bad_at
           bad_image / image_too_large / image_bad_type
发送执行   rate_limited / door_closed / send_queue_timeout / send_timeout
           send_failed / platform_missing / tts_unavailable / busy
工具       missing_identity / ambiguous_identity / bad_actor / tool_failed
```

`ack.error` / `tool-ack.error` 只放上面这些稳定 code；`ack.note` / `tool-ack.note` 放中文说明。旧客户端只读 `error` 字符串也能看到 code。完整表见 `docs/umo-bridge-contract.md` §6.4。

---

## 5. 当前轮次与工具边界

这是这次升级的核心。

### 5.1 当前轮次的现状

设计稿想用一个 `currentUmo` 值对象；**当前代码没有它**，用的是：

```ts
private turnChannel?: 'qq';
private turnConv?: Conv;
private turnMsgId = '';
private turnMixed = false;
private turnMultiConv = false;
private turnChannelAt = 0;
```

来源与生命周期：

- `onEventsSettled` 只接受 `astrbot.message` 中的人话事件；纯通知不建立轮次。
- 只有 `astrbot.*` 通知不改变上一轮；纯桌宠/控制台才清空。
- `onTurnEnded` / `onRunPhase('idle')` 清空；`turnChannelAt` 是 2 分钟兜底 TTL，长工具链用 `touchTurn()` 续期。
- 过期轮次不借主人身份，也不复活。

### 5.2 工具

当前实现没有 `astrbot_draft` / `astrbot_confirm`，也没有 `umo` 参数；工具参数是 `conv_kind` / `conv_id` / `reply_to`。

- `astrbot_send_message`
  - 设计稿结论：只允许当前 QQ 轮次；桌宠/控制台、mixed、过期一律拒绝。**1.3.6 已放宽**：非 QQ 轮次在填了主人 QQ（管理员）+ 显式 `conv_id`/`reply_to` + 已知会话时可以主动发，以 README 为准；
  - 不传目标就发回这一轮；
  - 传了 `conv_id` 也必须能找到带 UMO 的已知会话，否则本地拒绝；
  - `conv_id` 接受字符串或数字，其他类型明确失败。
- `astrbot_read_history`
  - 默认当前轮；允许回退 `lastConv`（只读）；
  - 单次扫描有上限，安静会话不会扫全库。
- `astrbot_call_tool`
  - QQ 轮次传 `turn`（这一轮的消息 id）；
  - Coo 对话轮次传 `actor: {kind:'owner', id: ownerId}`；
  - 与 5.3 的桌宠边界一致。

### 5.3 桌宠/控制台

- `astrbot_send_message` 在桌宠/控制台轮次的放行规则已按 1.3.6 更新（主人 QQ 是管理员 + 显式目标 + 已知会话）；设计稿时期的“一律拒绝”只作历史记录。
- 非 QQ 输入沿用来源 World 的回复规则；本包不为 desktop-pet、Live2D 或 console 指定发言工具。
- `astrbot_call_tool` 在 Coo 对话轮次可以走 owner actor，前提是连接页填了主人 QQ 且该号在 AstrBot 管理员名单里。

---

## 6. 配置与 UI（未实施）

> 当前插件已有 `bridge_platforms`、群/私聊策略和工具/语音页；下面的 `umos` 覆盖表、UMO 归一化保存、面板过期标记都还没有做。

### 6.1 配置

- `bridge_platforms`：只接管这些平台。
- `group_allow` / `private_allow`：优先存 UMO；旧群号/QQ 号保存时归一化为 UMO（能解析时）。
- `group_scope` / `group_mode` / `private_mode` 保持。
- 新增可选 `umos` 覆盖表（第二阶段）：
  ```json
  {
    "default:GroupMessage:123": {
      "enabled": true,
      "mode": "all",
      "screenshot": true
    }
  }
  ```
  只做已经需要的覆盖，不先做全量策略矩阵。

### 6.2 UI

- 概览消息流：UMO 独立一行，可复制。
- 群聊/私聊：最近会话来自注册表，显示平台、类型、名称、最后出现、过期标记。
- 添加会话时支持 UMO/旧 ID；保存时显示归一化后的 UMO。
- 会话详情：最后消息、发送状态、截图能力、TTL。
- 过期 UMO 灰显，不能直接作为新发送目标。

---

## 7. 历史、截图与去重（部分实施）

- 历史：World 按 UMO 优先、legacy key 回退过滤；单次扫描有上限。
- 截图授权：绑定当前轮次最后一条人话消息 id + 会话 + 2 分钟有效期；不能跨会话。
- 去重：`umo + message_id` 层面的跨平台去重**未实施**；当前靠 `bridge_platforms` 只接管一个平台来避免重复。
- `lastConv`：只用于 UI 展示和历史只读查询，不用于发送授权。

---

## 8. 与参考 `qq` World 的对照

| 维度 | `qq` World | UMO v2 |
|---|---|---|
| 会话键 | watched group/private | 注册表 UMO |
| 目标 | 显式 `to` | 显式 `umo` |
| 主动发送 | draft + confirm | draft + confirm |
| 当前回复 | 显式目标 | `umo === currentUmo` 直发 |
| 边界 | watch list | 注册表 + platform + current turn |
| 审核 | 发送前确认 | 主动发送确认；当前回复不确认 |

结论（设计）：**当前回复直发，主动发送 draft/confirm**。不把两步确认强加到每条聊天回复。当前版本还没有 draft/confirm；1.3.6 起非 QQ 轮次在主人 QQ + 显式目标 + 已知会话时可以主动发送，不再一律拒绝（以 README 为准）。

---

## 9. 实施阶段（实际进度）

1. ~~契约与类型~~：已采用协议 v1 与 UMO 字符串；v2 值对象/协议 v1.1 未做。
2. **注册表 v2**：已做磁盘迁移、TTL、原子写；`ready.umos` 快照未做。
3. **World 当前轮次**：已做 `turnConv` / `turnMsgId` / `turnMixed` / TTL；`currentUmo` 值对象未做。
4. **工具拆分**：未做；仍只有 `astrbot_send_message`，没有 draft/confirm。
5. **协议增量**：未做；没有 ready.umos / umo upsert。
6. **UI**：部分；插件有会话列表，World 只展示 id，没有过期标记/归一化保存。
7. **兼容与验证**：旧帧只读兼容、旧注册表迁移已测；QQ/私聊/群聊/桌宠/控制台有单测与手工验收。

---

## 10. 待确认

1. **UMO 范围**：只覆盖 AstrBot 会话，还是也给 Coo 的 desktop-pet/console 定义 `coo:` UMO？
   建议：只覆盖 AstrBot；Coo 侧用各自 World 会话，不伪造 UMO。
2. **主动发送**：是否引入 `astrbot_draft`/`astrbot_confirm`？
   建议：是，仅非当前轮次使用。
3. **注册表上限/TTL**：500 条 / 30 天，是否合适？
4. **旧 `conv_id`**：新协议是否完全拒绝，还是只读兼容一个版本？
   建议：v1.1 新帧拒绝；旧帧只读兼容。
