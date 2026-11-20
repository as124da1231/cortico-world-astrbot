# Coo World 接入边界

## 目标

明确 `desktop-pet`、`astrbot` 和 AstrBot `webchat` 各自拥有的事件、工具和回复路径，避免一个 World 复用另一个 World 的出口。

## 边界

### desktop-pet

- 事件：`desktop-pet.message`（`typed` / `bubble` / `voice`）。
- 工具：`pet_say` / `pet_ask`。
- 环境提示词：对话页和头顶气泡都是 `pet_say` 的出口。
- `pet_say` 必须先把回复写入 `desktop-pet.self`（`kind: say`），再尝试桌宠窗口气泡；窗口未连接不能让对话页丢回复。

### astrbot

- 事件：只接收 `bridge_platforms` 里的平台（默认 `default`）；`webchat`、`console`、`default1` 不推、不 `stop_event`。
- 发送：`astrbot_send_message` 只允许当前 QQ 轮次；显式 `conv_id` 不能绕过，且目标必须是桥见过、带 UMO 的会话。
- 工具：QQ 轮次用触发消息的发言者身份；Coo 对话轮次只有在连接页填了主人 QQ、且该号在 AstrBot `admins_id` 里时才以 owner 执行。mixed 或过期的 QQ 轮次不借主人身份。
- 轮次生命周期：`idle` 或 `onTurnEnded` 清空；纯 QQ 通知不建立轮次；2 分钟 TTL 只作兜底，长工具链会续期。

### console / webchat

- 属于 AstrBot 自己的对话页，不经过 `astrbot` 桥。
- 桥只处理 UMO 第一段在 `bridge_platforms` 中的事件。

## 当前行为摘要

- 桌宠轮次调用 `astrbot_send_message` 会被拒绝并返回中文原因；不会把对话页的回复发到 QQ。
- 桌宠/控制台轮次要调 AstrBot 工具，必须先在「连接」页填主人 QQ（且是管理员）；否则明确拒绝。
- 桥断开时，范围内的 QQ 通知仍会进入事件流，但不唤醒 bot。
- 事件行始终带渠道前缀：`【QQ群 …】` / `【QQ私聊 …】`，桌宠事件是 `[touch]` / `[typed]` / `[voice]`。

## 已知限制

- `cortico-world-desktop-pet` 是 Coopanion 安装目录里的内置包，不是当前 git 工作区；本机补丁在 Coopanion 更新时可能被覆盖，长期应回到 Coopanion 源码包。
- `cortico-world-astrbot` 不能把 `pet_say` 从工具表里移除；要彻底隔离 QQ 轮次，需给 QQ 单独建只启用 AstrBot World 的会话/人格。
