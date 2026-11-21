# Coo World 接入边界

## 目标

明确 `desktop-pet`、`astrbot` 和 AstrBot `webchat` 各自拥有的事件、工具和回复路径，避免一个 World 复用另一个 World 的出口。

## 边界

### desktop-pet

- 原版桌宠使用 `desktop-pet.message`，聊天页与气泡可由 `meta.via` 区分；语音还有独立事件类型。
- 本地还可能有 Live2D 等其他 World，拥有自己的回复工具与聊天记录实现。
- QQ 扩展不得把所有 `[typed]` / `[voice]` / `[touch]` 输入强制指向 `pet_say`；具体出口遵循来源 World 的契约。
- 不要求用户开启原版桌宠窗口，不通过修改宿主内置 World 来适配本扩展。

### astrbot

- 事件：只接收 `bridge_platforms` 里的平台（默认 `default`）；`webchat`、`console`、`default1` 不推、不 `stop_event`。
- 发送：QQ 轮次可以隐式回触发会话；非 QQ 轮次只有填了主人 QQ、且显式指定目标时才能主动发。两种情况都要求目标是桥见过、带 UMO 的会话。
- @：只对群生效，接受 QQ 号或 `all`（需在连接页开启），最多 10 个；私聊里忽略并说明；语音不能带 @。
- 工具：QQ 轮次用触发消息的发言者身份；Coo 对话轮次只有在连接页填了主人 QQ、且该号在 AstrBot `admins_id` 里时才以 owner 执行。过期的 QQ 轮次不借主人身份。
- 轮次生命周期：`idle` 或 `onTurnEnded` 清空；纯 QQ 通知不建立轮次；2 分钟 TTL 只作兜底，长工具链会续期。
- 来源判定只用自己的事件：宿主按 `source` 分发 `onEventsSettled`，本包不去读、也不会拿到其他 World 的输入。同批是否混有本地输入，本包无法证明。

### Coo 控制台与 AstrBot webchat

- Coo `console.message` 属于 Coo 控制台（`origin: internal`），由 Console World 自己负责；本包不接管它的回复。
- AstrBot `webchat` 是另一个服务的对话页，不要与 Coo 控制台、「对话」页或桌宠聊天页混同。
- 桥只处理 UMO 第一段在 `bridge_platforms` 中的事件。

## 当前行为摘要

- 非 QQ 轮次调 `astrbot_send_message`：没填主人 QQ 或没给目标会被拒绝并说明原因；满足条件时发到指定会话，回执写清发到哪里、@ 了谁。
- 桌宠/控制台轮次要调 AstrBot 工具，必须先在「连接」页填主人 QQ（且是管理员）；否则明确拒绝。
- 桥断开时，范围内的 QQ 通知仍会进入事件流，但不唤醒 bot。
- 事件行始终带渠道前缀：`【QQ群 …】` / `【QQ私聊 …】`，桌宠事件是 `[touch]` / `[typed]` / `[voice]`。

## 已知限制

- 同一会话里其他 World 的工具可能仍然可见，本包不重写或移除它们。
- 本包不读取共享事件库来推断“这一批还有哪些输入”。QQ 轮次里若同时混入本地内容，本包不能识别；这属于现有 World 契约的空白，不用猜测或改写其他来源来补齐。
- Coo「对话」页是 Coo 与用户的界面，由 `desktop-pet` 负责写回；本包不向它写入，也不要求它显示 QQ 内容。核对本包行为看控制台／追踪视图。
- 此前把聊天页空白直接归因于宿主缺陷的结论未经启停扩展对照，不作为发布依据；宿主热修已撤回。
