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
- 发送：`astrbot_send_message` 只允许当前 QQ 轮次；显式 `conv_id` 不能绕过，且目标必须是桥见过、带 UMO 的会话。
- 工具：QQ 轮次用触发消息的发言者身份；Coo 对话轮次只有在连接页填了主人 QQ、且该号在 AstrBot `admins_id` 里时才以 owner 执行。mixed 或过期的 QQ 轮次不借主人身份。
- 轮次生命周期：`idle` 或 `onTurnEnded` 清空；纯 QQ 通知不建立轮次；2 分钟 TTL 只作兜底，长工具链会续期。

### Coo 控制台与 AstrBot webchat

- Coo `console.message` 是 Coo 自己的控制台输入，宿主标记 `origin: internal`。宿主的 `onEventsSettled` 只通知事件所属 World；本包通过只读事件库和投递阶段检查它，关闭旧 QQ 出口，不能等待控制台事件回调到 AstrBot。
- AstrBot `webchat` 是另一个服务的对话页，不要与 Coo 控制台或桌宠聊天页混同。
- 桥只处理 UMO 第一段在 `bridge_platforms` 中的事件。

## 当前行为摘要

- 非 QQ 轮次调用 `astrbot_send_message` 会被拒绝并返回中文原因；回执不指定替代桌宠工具。
- 桌宠/控制台轮次要调 AstrBot 工具，必须先在「连接」页填主人 QQ（且是管理员）；否则明确拒绝。
- 桥断开时，范围内的 QQ 通知仍会进入事件流，但不唤醒 bot。
- 事件行始终带渠道前缀：`【QQ群 …】` / `【QQ私聊 …】`，桌宠事件是 `[touch]` / `[typed]` / `[voice]`。

## 已知限制

- 同一会话里其他 World 的工具可能仍然可见，本包不重写或移除它们。提示词收窄并不能代替真实实例中的跨入口回归验证。
- 跨来源输入按游标扫描，启动前历史不参与；发送及身份借用前再检查。扫描超出 512 个事件或读取失败时保守拒绝 QQ 发送，不改写其他来源的记录。
- 此前把聊天页空白直接归因于宿主缺陷的结论未经启停扩展对照，不作为发布依据；宿主热修已撤回。
