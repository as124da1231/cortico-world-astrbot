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
  /** 桥的连接地址，支持 WS 和 WSS。 */
  wsUrl: string;
  /** 桥 token；本机回环可以留空。 */
  token: string;
  /** 投递给 Coo 的消息是否带 HH:MM 时间前缀。 */
  includeTime: boolean;
  /** 断线后第一次等待时间。 */
  reconnectBaseMs: number;
  /** 重连等待上限。 */
  reconnectMaxMs: number;
  /** 回复 QQ 消息时附带渠道提示（@/图片/私聊）。 */
  channelHint: boolean;
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

export const LOCAL_BRIDGE_URL = 'ws://127.0.0.1:17999';

function isLoopbackBridgeHost(hostname: string): boolean {
  return /^(?:localhost|\[::1\]|127(?:\.\d{1,3}){3})$/i.test(hostname);
}

export function bridgeAddressError(address: string): string | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return '请输入有效的 WebSocket 地址。';
  }
  if (url.username || url.password || [...url.searchParams.keys()].some(key => /^(?:token|access_token|password|auth|authorization|api_?key)$/i.test(key))) {
    return '请将令牌填入专用字段。桥地址不能包含凭据。';
  }
  if (url.hash || (url.protocol !== 'ws:' && url.protocol !== 'wss:')) return '桥地址须以 ws:// 或 wss:// 开头，且不包含片段。';
  return undefined;
}

export function usesRemotePlaintextBridge(address: string): boolean {
  if (bridgeAddressError(address)) return false;
  const url = new URL(address);
  return url.protocol === 'ws:' && !isLoopbackBridgeHost(url.hostname);
}

export function bridgeCredentialError(address: string, token: string, alreadyStored = false): string | undefined {
  if (token && !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) return '请使用 AstrBot 生成的桥接令牌。';
  if (!token && !alreadyStored && address && !bridgeAddressError(address) && !isLoopbackBridgeHost(new URL(address).hostname)) {
    return '跨机连接须填写桥接令牌。';
  }
  return undefined;
}

export const ASTRBOT_DEFAULTS: AstrbotConfigSection = {
  enabled: false,
  wsUrl: LOCAL_BRIDGE_URL,
  token: '',
  includeTime: true,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30_000,
  channelHint: true,
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
          '默认连接 ws://127.0.0.1:17999。跨机支持 ws:// 和 wss://，均需桥接令牌。',
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
