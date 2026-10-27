import type { ConfigGroup } from 'cortico/core/types.ts';

/**
 * `worlds.astrbot` 段。
 *
 * 这个 World 不自己连 QQ：它连的是 AstrBot 侧的桥（插件①），由桥负责 QQ 收发。
 * 因此这里的配置全是「怎么连桥」和「什么样的消息才算说到我」。
 */
export interface AstrbotConfigSection {
  /** 挂载开关；默认关闭，由部署或 bot 打开。 */
  enabled: boolean;
  /** 桥的 WS 地址，例如 ws://192.0.2.10:17999。空串表示还没有配置。 */
  wsUrl: string;
  /** 桥要求的 token，空串表示不带。 */
  token: string;
  /**
   * A：`mention` 只投递点名（@ 或叫名字）的消息，其余忽略。私聊一律投递。
   * B：`all` 群里每条消息都投递，要不要说话由 bot 自己判断。
   */
  mode: AstrbotMode;
  /** 除 @ 之外，正文里出现这些称呼也算叫到了自己；逗号分隔。 */
  nameAliases: string;
  /** 事件正文前带上消息的本地时间（HH:MM），合批后仍能看出先后。 */
  includeTime: boolean;
  /** 断线重连的首次等待；之后逐次翻倍。 */
  reconnectBaseMs: number;
  /** 重连等待的上限。 */
  reconnectMaxMs: number;
  /** 每分钟最多发几条，防止失控刷屏；0 表示不限。 */
  maxSendsPerMinute: number;
  /** 在需要回复的 QQ 消息后加一行渠道提示（@、图片、私聊）。 */
  channelHint: boolean;
}

export type AstrbotMode = 'all' | 'mention';

export const ASTRBOT_MODES: readonly AstrbotMode[] = ['all', 'mention'];

export const ASTRBOT_DEFAULTS: AstrbotConfigSection = {
  enabled: false,
  wsUrl: '',
  token: '',
  mode: 'mention',
  nameAliases: '',
  includeTime: true,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30_000,
  maxSendsPerMinute: 20,
  channelHint: true,
};

/** 把配置里读到的任意值收敛成合法值；WebUI 存进来的东西不保证类型。 */
export function normalizeMode(raw: unknown): AstrbotMode {
  return raw === 'all' ? 'all' : 'mention';
}

/** 解析逗号分隔的称呼列表，去掉空项与首尾空白。 */
export function parseAliases(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** World 的配置组；`worlds.astrbot.` 段内的旋钮，路径必须落在自己的段里。 */
export const ASTRBOT_CONFIG_GROUP: ConfigGroup = {
  id: 'world:astrbot',
  owner: 'world:astrbot',
  schema: {
    type: 'object',
    title: 'AstrBot 桥',
    description:
      '通过 AstrBot 的桥接入 QQ。这个 World 只负责把群消息变成事件、把回复发回去；QQ 账号与插件能力仍归 AstrBot。',
    properties: {
      'worlds.astrbot.wsUrl': {
        type: 'string',
        title: '桥地址',
        'x-hot': false,
        description:
          'AstrBot 侧桥监听的 WebSocket 地址，形如 ws://192.0.2.10:17999。改完要重启本 World 才生效。',
      },
      'worlds.astrbot.token': {
        type: 'string',
        title: '桥 token',
        'x-hot': false,
        description: '与桥配置一致的 token。留空表示桥不校验。',
      },
      'worlds.astrbot.mode': {
        type: 'string',
        title: '消息范围',
        enum: [...ASTRBOT_MODES],
        'x-hot': true,
        description:
          'all：群里每条消息都送进来，要不要说话自己决定。mention（默认）：只有 @ 我或叫到我名字时才送进来。这里是第二道过滤：桥那边的「接管全部群消息」决定消息会不会送进来，mode 决定送进来后哪些算叫到你。',
      },
      'worlds.astrbot.nameAliases': {
        type: 'string',
        title: '叫我的称呼',
        'x-hot': true,
        description:
          '除 @ 之外，正文里出现这些词也算叫到自己。多个用逗号分隔，例如：Coo,库,小铃。',
      },
      'worlds.astrbot.includeTime': {
        type: 'boolean',
        title: '正文带时间',
        'x-hot': true,
        description:
          '在事件正文前加上消息的本地时间（HH:MM）。消息合批后仍能看出先后顺序。',
      },
      'worlds.astrbot.reconnectBaseMs': {
        type: 'integer',
        title: '重连起点',
        minimum: 200,
        maximum: 60_000,
        multipleOf: 100,
        'x-suffix': 'ms',
        'x-hot': false,
        description: '断线后第一次等待多久再连，之后逐次翻倍。',
      },
      'worlds.astrbot.reconnectMaxMs': {
        type: 'integer',
        title: '重连上限',
        minimum: 1000,
        maximum: 600_000,
        multipleOf: 1000,
        'x-suffix': 'ms',
        'x-hot': false,
        description: '重连等待翻倍到多少就封顶。',
      },
      'worlds.astrbot.maxSendsPerMinute': {
        type: 'integer',
        title: '每分钟发送上限',
        minimum: 0,
        maximum: 600,
        multipleOf: 1,
        'x-hot': true,
        description: '防止连续发消息刷屏。0 表示不限。',
      },
      'worlds.astrbot.channelHint': {
        type: 'boolean',
        title: '回复渠道提示',
        'x-hot': true,
        description:
          '在需要回复的 QQ 消息（@、带图、私聊）正文后加一行提醒：用 astrbot_send_message 回，pet_say 只在电脑上显示。可关掉以减少提示词长度。',
      },
    },
  },
};
