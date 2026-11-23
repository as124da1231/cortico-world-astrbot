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
- 发送：QQ 轮次可隐式回触发会话。完整模式中的桌面主动发送需 AstrBot 授权，而且要用 `conv_id` 或 `reply_to` 指定一个获准的已知会话。
- @：只对群生效，接受 QQ 号或 `all`（需在配置里打开 `worlds.astrbot.allowAtAll`，面板暂无开关），最多 10 个；私聊里忽略并说明；语音不能带 @。
- 工具：QQ 轮次用触发消息的发言者身份。Coo 桌面工具使用 AstrBot 已授权的主人 QQ，连接共用一枚桥接令牌。过期的 QQ 轮次不借主人身份。
- 轮次生命周期：`idle` 或 `onTurnEnded` 清空；纯 QQ 通知不建立轮次；2 分钟 TTL 只作兜底，长工具链会续期。
- 来源判定只用自己的事件：宿主按 `source` 分发 `onEventsSettled`，本包不去读、也不会拿到其他 World 的输入。同批是否混有本地输入，本包无法证明。

### Coo 控制台与 AstrBot webchat

- Coo `console.message` 属于 Coo 控制台（`origin: internal`），由 Console World 自己负责；本包不接管它的回复。
- AstrBot `webchat` 是另一个服务的对话页，不要与 Coo 控制台、「对话」页或桌宠聊天页混同。
- 桥只处理 UMO 第一段在 `bridge_platforms` 中的事件。

## 当前行为摘要

- 安全模式和完整模式都通过原版 Coo 的 World 接口接入主会话。主人私聊可以接着桌面对话。读消息和发回复分别检查当前 QQ 会话和触发消息。
- 从安全模式转入完整模式由 AstrBot 管理员确认。Coo World 用宿主的正常重载接口刷新模型工具表，两端同步后恢复接管。

- 桌面调用 `astrbot_send_message` 时，按授权目标以机器人身份发送，回执说明送达会话与 @ 对象。
- 桌宠和控制台轮次在完整模式使用 AstrBot 管理页已批准的主人工具。
- 桥在线时，范围内的 QQ 通知进入 Coo 事件流，且不唤醒人格。桥断开时，通知继续由 AstrBot 处理，重连后从新通知恢复转发。
- 事件行始终带渠道前缀：`【QQ群 …】` / `【QQ私聊 …】`，桌宠事件是 `[touch]` / `[typed]` / `[voice]`。

## 已知限制

- 两种模式都使用共享主会话。安全模式限制桥接对象和桥工具。其他 World 的工具可见性仍由 Coo 宿主及各 World 的授权决定。
- 本包不读取共享事件库来推断“这一批还有哪些输入”。QQ 轮次里若同时混入本地内容，本包不能识别；这属于现有 World 契约的空白，不用猜测或改写其他来源来补齐。
- Coo「对话」页是 Coo 与用户的界面，由 `desktop-pet` 负责写回；本包不向它写入，也不要求它显示 QQ 内容。核对本包行为看控制台／追踪视图。
- 此前把聊天页空白直接归因于宿主缺陷的结论未经启停扩展对照，不作为发布依据；宿主热修已撤回。
