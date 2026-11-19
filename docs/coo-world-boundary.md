# Coo World 接入边界（2026-11-19）

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
- 工具：`astrbot_send_message` 只允许当前 QQ 轮次；显式 `conv_id` 不能绕过。
- 上一轮 QQ 轮次在 `idle` 或 `onTurnEnded` 清空，超时上限 2 分钟。

### console / webchat

- 属于 AstrBot 自己的对话页，不经过 `astrbot` 桥。
- 桥只处理 UMO 第一段在 `bridge_platforms` 中的事件。

## 事故与修复

2026-11-19 19:03–19:29，用户在 desktop-pet 对话页连续发消息。Coo 收到事件，但：

- `pet_say` 因桌宠窗口未连接直接返回失败，且没有写入对话页；
- 模型随后用 `astrbot_send_message` 显式 `conv_id` 发到 QQ 私聊；
- 对话页因此没有回复。

修复：

1. `cortico-world-desktop-pet/src/world.ts`：`pet_say` 先 `record` 再 `sendPet`；窗口未连接时返回成功并标注“已保存到对话页”。
2. `cortico-world-astrbot/src/world.ts`：移除显式 `conv_id` 绕过；只有 `qqTurnActive()` 才允许 QQ 出口；TTL 2 分钟；`onRunPhase('idle')` 清空轮次。
3. AstrBot 插件：增加 `bridge_platforms`，默认 `default`；`webchat` / `default1` 不再被桥接管。

## 验证

- `cortico-world-astrbot`：`pnpm typecheck` 通过，Vitest 86/86。
- `cortico-world-astrbot`：`describe:extension` + `check:extension` 通过。
- `cortico-world-desktop-pet`：`check:extension` 通过（内置包没有可运行的 package test 脚本）。
- 真实实例：`desktop-pet.message` 20:06:46 → `desktop-pet.self kind=say` 20:07:09；未再出现 `astrbot_send_message` 发往 QQ。
- AstrBot 桥：`connected=True`；平台边界测试 `webchat=False`、`default=True`、`default1=False`。

## 已知限制

- `cortico-world-desktop-pet` 是 Coopanion 安装目录里的内置包，不是当前 git 工作区；本机补丁在 Coopanion 更新时可能被覆盖，长期应回到 Coopanion 源码包。
- `check:extension` 仍报告 `injection-risk` / `unofficial-api` 等既有警告；本次未改变相应事件来源和协议。
