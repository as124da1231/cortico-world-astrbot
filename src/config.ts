import type { ConfigGroup, ConfigProperty } from 'cortico/core/types.ts';

/**
 * `worlds.astrbot` 配置。
 *
 * World 只负责连接和展示；群范围、仅被叫/全部消息、称呼、私聊策略
 * 全部由 AstrBot 插件决定，避免两端各有一套开关。
 */
export interface AstrbotConfigSection {
  /** 本地开关，默认关闭，由插件或 bot 打开。 */
  enabled: boolean;
  /** 桥的 WS 地址，例如 ws://192.0.2.10:17999。 */
  wsUrl: string;
  /** 桥 token；留空表示不校验。 */
  token: string;
  /** 投递给 Coo 的消息是否带 HH:MM 时间前缀。 */
  includeTime: boolean;
  /** 断线后第一次等待时间。 */
  reconnectBaseMs: number;
  /** 重连等待上限。 */
  reconnectMaxMs: number;
  /** 回复 QQ 消息时附带渠道提示（@/图片/私聊）。 */
  channelHint: boolean;
  /**
   * Coo 对话轮次调用 AstrBot 工具时使用的管理员 QQ。
   * 留空表示 Coo 轮次不借工具身份；AstrBot 的管理员名单仍是唯一权限来源。
   */
  ownerId: string;
  /** 允许用 at=["all"] @全体；默认关闭，避免误触发整群。 */
  allowAtAll: boolean;

  /**
   * @deprecated 由 AstrBot 插件控制；仅保留旧配置读取，World 不再使用。
   */
  mode?: AstrbotMode;
  /**
   * @deprecated 由 AstrBot 插件控制；仅保留旧配置读取，World 不再使用。
   */
  nameAliases?: string;
  /**
   * @deprecated 由 AstrBot 插件控制；仅保留旧配置读取，World 不再使用。
   */
  maxSendsPerMinute?: number;
}

/** @deprecated 由 AstrBot 插件控制；保留给旧配置和测试。 */
export type AstrbotMode = 'all' | 'mention';

/** @deprecated 由 AstrBot 插件控制；保留给旧配置和测试。 */
export const ASTRBOT_MODES: readonly AstrbotMode[] = ['all', 'mention'];

/** @deprecated 由 AstrBot 插件控制；保留给旧配置和测试。 */
export function normalizeMode(raw: unknown): AstrbotMode {
  return raw === 'all' ? 'all' : 'mention';
}

/** @deprecated 由 AstrBot 插件控制；保留给旧配置和测试。 */
export function parseAliases(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export const ASTRBOT_DEFAULTS: AstrbotConfigSection = {
  enabled: false,
  wsUrl: '',
  token: '',
  includeTime: true,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30_000,
  channelHint: true,
  ownerId: '',
  allowAtAll: false,
  // 旧配置兼容；World 不再读取，实际策略由 AstrBot 插件决定。
  mode: 'mention',
  nameAliases: '',
  maxSendsPerMinute: 20,
};

/** World 配置分组；`worlds.astrbot.` 下的按钮由这里定义。 */
export const ASTRBOT_CONFIG_GROUP: ConfigGroup = {
  id: 'world:astrbot',
  owner: 'world:astrbot',
  schema: {
    type: 'object',
    title: 'AstrBot 桥',
    description:
      '通过 AstrBot 桥接收 QQ 消息。群范围、仅被叫/全部消息、称呼和私聊策略都在 AstrBot 插件里配置；World 只负责连接和展示。',
    properties: {
      'worlds.astrbot.wsUrl': {
        type: 'string',
        title: '桥地址',
        'x-hot': false,
        description:
          'AstrBot 桥上监听的 WebSocket 地址，例如 ws://192.0.2.10:17999。必须是 World 能访问的地址。',
      },
      'worlds.astrbot.token': {
        type: 'string',
        title: '桥 token',
        'x-hot': false,
        description: '必须和 AstrBot 插件里的 token 完全一致；留空表示不校验。',
      },
      'worlds.astrbot.includeTime': {
        type: 'boolean',
        title: '带时间前缀',
        'x-hot': true,
        description: '在投递给 Coo 的消息前带上 HH:MM 时间，方便判断先后顺序。',
      },
      'worlds.astrbot.reconnectBaseMs': {
        type: 'integer',
        title: '重连初始间隔',
        minimum: 200,
        maximum: 60_000,
        multipleOf: 100,
        'x-suffix': 'ms',
        'x-hot': false,
        description: '断线后第一次等待时间，之后按退避递增。',
      },
      'worlds.astrbot.reconnectMaxMs': {
        type: 'integer',
        title: '重连上限',
        minimum: 1000,
        maximum: 600_000,
        multipleOf: 1000,
        'x-suffix': 'ms',
        'x-hot': false,
        description: '重连等待时间的上限。',
      },
      'worlds.astrbot.channelHint': {
        type: 'boolean',
        title: '回复渠道提示',
        'x-hot': true,
        description:
          '回复 QQ 消息时附带渠道提示（@、图片、私聊），只说明 QQ 发送方式，不改变其他 World 的回复工具。',
      },
      'worlds.astrbot.ownerId': {
        type: 'string',
        title: '主人 QQ',
        'x-hot': true,
        description:
          '主人 QQ：Coo 侧调用 AstrBot 工具时借用的管理员身份，也是从 Coo 主动发 QQ 时的授权依据；必须是 AstrBot 的 admins_id 之一。留空表示不借身份、也不允许主动发送。',
        // JSON Schema 约束：纯数字、20 位以内。Cortico 配置页当前不消费这两项，
        // 面板保存前另做同样校验（见 webui/connection.ts）。
        pattern: '^\\d*$',
        maxLength: 20,
      } as ConfigProperty,
      'worlds.astrbot.allowAtAll': {
        type: 'boolean',
        title: '允许 @全体成员',
        'x-hot': true,
        description:
          '打开后，QQ 群里可以用 at=["all"] @全体成员。默认关闭，避免误触发整群。',
      },
    },
  },
};
