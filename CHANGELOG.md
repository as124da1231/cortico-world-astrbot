# 更新日志

## 1.3.6

### 新增

- 从 Coo 侧主动发 QQ：桌宠、Coo 对话等非 QQ 轮次也可以调用 `astrbot_send_message`。条件是「连接」里填了主人 QQ（该号必须是 AstrBot 管理员）、用 `conv_id` / `reply_to` 显式指定目标，而且目标是桥已经见过的会话。QQ 轮次仍然可以省略目标，隐式回触发会话。
- 群内 `at`：可以把 QQ 号放进 `at` 数组 @ 人，最多 10 个。`["all"]` 是 @全体，默认关闭，需要在配置里打开 `worlds.astrbot.allowAtAll`（面板暂无开关）。私聊里 `at` 不生效；语音不能和 `at` 同一条。
- `ready` 帧上报已知会话：桥把重启前恢复的会话一起带给 World，World 因此能在非 QQ 轮次里选到这些会话作为主动发送目标。最多 20 条，按最近出现排序；要发到没列出的会话，先在目标会话说一句。

### 修复

- 路由收窄：只按本 World 的 `astrbot.message` 事件建立 QQ 轮次，不再把其他 World 的输入卷进来；非 QQ 回复留在来源 World。
- 工具身份：QQ 轮次使用触发消息的发言者身份，非 QQ 轮次使用主人 QQ（必须是管理员）；过期轮次不会借主人身份，也不回退 `lastConv`。
- 工具 tags 修正：`astrbot_send_message` 标记为 `speak`，`astrbot_call_tool` 标记为 `act`。
- 换行统一为 LF（新增 `.gitattributes`），文档、错误码表和协议说明同步到 1.3.6 的行为。

### 文档

- README、UMO 桥协议契约、Coo World 边界与 UMO v2 设计稿更新：主动发送规则、`at`、`bad_at` / `voice_at_conflict`、`allowAtAll` 的实际开关位置。
- 补充已知问题：NapCat 反向 WS 重连后主动发送全部失败的临时处理，以及一个 aiocqhttp 适配器多账号时的连接选择问题。

## 1.3.5

- 桥协议以 UMO 为主键；入站帧必须带 `umo`，`conv` 只做投影。
- 旧帧与旧 `umos.json` 自动迁移，迁移前备份为 `umos.v1.json`。
- 群/私聊策略改为两端单一来源：World 不再重复配置群范围、称呼与发送上限。
