/**
 * AstrbotWorld —— 通过 AstrBot 的桥接入 QQ 的 World。
 *
 * 职责边界：
 * - 本 World **不**连 QQ、不碰账号、不碰 OneBot。QQ 的一切仍归 AstrBot。
 * - 它只做两件事：把桥送来的群消息变成事件，把 bot 的回复交给桥发出去。
 *
 * 约束（装配层会为未启用的 World 也 create 一次，所以这些不是风格问题）：
 * - 构造函数只存配置，不建连接、不读密钥、不 await 任何外部资源。
 * - 连接只发生在 start(host)；连不上只写日志，绝不抛错。
 */
import { fileURLToPath } from 'node:url';
import type { BlobInput, BlobRef, EventEnvelope, RunPhase, ToolCallContext, ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import {
  ASTRBOT_CONFIG_GROUP,
  bridgeAddressError,
  bridgeCredentialError,
  type AstrbotConfigSection,
} from './config.ts';
import {
  AstrbotBridgeDriver,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  type BridgeDriver,
  type BridgeMode,
  type BridgeMessage,
  type Conv,
  type OutgoingImage,
  type ToolActor,
  type ToolInfo,
  type ToolResult,
} from './driver.ts';
import { convOfEvent, findMessage, renderLatest, renderSearch } from './history.ts';
import { describeSegment, imageAttachmentIndex, needsBridge, parseSegments, renderSegmentLine, type MessageSegment } from './message-segments.ts';
import { EXTENSION_VERSION } from './version.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

type QqEvent = Parameters<WorldHost['pushEvent']>[0];

/** 一条消息最多带多大的图（原始字节）；再大就拒绝，免得把桥和 QQ 撑爆。 */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const INBOUND_IMAGE_LIMIT = 2;

function imageBlobs(images: OutgoingImage[] = []): BlobInput[] {
  return images.map((img) => ({
    bytes: new Uint8Array(Buffer.from(img.base64, 'base64')),
    mime: img.mime,
    fallbackText: '[图片]',
  }));
}

function componentBlobs(reply: ToolResult): BlobInput[] {
  const blobs = imageBlobs(reply.images);
  if (reply.audio) blobs.push({
    name: reply.audio.name, mime: reply.audio.mime,
    bytes: Buffer.from(reply.audio.base64, 'base64'), fallbackText: '[QQ 语音原件]',
  });
  return blobs;
}

function savedImage(segment: MessageSegment, blobs: BlobRef[] = []): BlobRef | undefined {
  const index = imageAttachmentIndex(segment);
  const blob = index === undefined ? undefined : blobs[index];
  return blob?.mime.startsWith('image/') ? blob : undefined;
}

function directSavedImages(event: EventEnvelope | undefined): BlobRef[] {
  if (!event) return [];
  const segments = parseSegments(event.meta?.segments);
  if (segments.length) return segments.flatMap((part) => savedImage(part, event.blobs) ?? []);
  return (event.blobs ?? []).filter((blob) => blob.mime.startsWith('image/'));
}

/** 收到带权限的消息后，这个会话在多久内可以发图。 */
export const SCREENSHOT_GRANT_MS = 120_000;

/**
 * QQ 轮次里身份和发送的安全 TTL。正常靠 onTurnEnded / onRunPhase 清理；
 * 长工具链靠 touchTurn() 续期。过期后不再借 QQ 身份，也不回退到主人身份。
 */
export const QQ_TURN_TTL_MS = 2 * 60_000;

/**
 * 等桥完成首次连接的默认上限。到点先让 Coo 继续启动，驱动在后台继续重连；
 * 单个 World 不该把整条启动链拖死。
 */
export const DEFAULT_START_TIMEOUT_MS = 12_000;
const MAX_PENDING_QQ_MESSAGES = 64;

/** 从 ISO 时间里取 HH:MM；取不到就返回 --:--。 */
function hhmm(iso: string | undefined): string {
  if (!iso) return '--:--';
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m?.[1] ?? '--:--';
}

/** 工具参数收敛成 [min, max] 的整数；不是数字就用默认值。 */
function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 一条消息最多 @ 多少人，避免误触发整群。 */
export const MENTIONS_MAX = 10;

/**
 * 解析 `at` 参数。只接受 QQ 号（数字）或 "all"；"all" 需要配置允许。
 * 返回错误原因而不是抛错。
 */
function parseMentions(
  raw: unknown,
  allowAll: boolean,
): { ok: true; list: string[] } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, list: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: 'at 必须是 QQ 号数组，未发送。' };
  if (raw.length === 0) return { ok: true, list: [] };
  if (raw.length > MENTIONS_MAX) {
    return { ok: false, reason: `一条消息最多 @ ${MENTIONS_MAX} 人，未发送。` };
  }
  const list: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' && typeof item !== 'number') {
      return { ok: false, reason: 'at 里只能是 QQ 号或 "all"，未发送。' };
    }
    const value = String(item).trim();
    if (value === 'all') {
      if (!allowAll) {
        return { ok: false, reason: '@全体成员没有开启：在配置里打开 worlds.astrbot.allowAtAll（面板暂无开关）。' };
      }
      list.push('all');
      continue;
    }
    if (!/^\d{5,20}$/.test(value)) {
      return { ok: false, reason: `「${value}」不是 QQ 号，at 只接受数字，未发送。` };
    }
    list.push(value);
  }
  // @全体 已覆盖所有人，再列其他人没有意义。
  return { ok: true, list: list.includes('all') ? ['all'] : [...new Set(list)] };
}

export interface AstrbotWorldOptions {
  /** `worlds.astrbot` 的活引用：热改的键现读即生效。 */
  cfg: AstrbotConfigSection;
  timezone: string;
  storeBridgeToken?: (value: string) => void;
  restart?: () => Promise<void>;
  /** 测试用：换掉真实驱动。 */
  driver?: BridgeDriver;
  /** 首次连接最多等多久；到点先继续启动，后台继续重连。 */
  startTimeoutMs?: number;
  /** WebSocket 握手超时；0 表示不设。 */
  handshakeTimeoutMs?: number;
}

/** 全部工具的声明；`describe` 与 `tools()` 都取这一份。 */
export const ASTRBOT_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'astrbot_send_message',
    description:
      'Send a message into a QQ conversation through the AstrBot bridge. This is the ONLY ' +
      'way to speak on QQ: lines starting with 【QQ群 …】 or 【QQ私聊 …】 are QQ messages and ' +
      'can be answered with this tool. This tool only controls QQ delivery; it does not ' +
      'select or replace the reply tools of local chat, desktop pets, or other Worlds. ' +
      'In a QQ turn you may omit conv_id to reply where that turn came from. Outside a QQ turn ' +
      'the owner (the admin QQ set on the connection page) may send on purpose, but only with ' +
      'an explicit conv_id or reply_to, and only to a conversation the bridge has already seen. ' +
      'Text, an image, or both. Set voice=true to speak a short text reply out loud ' +
      '(TTS; falls back to text if the bridge has no TTS). ' +
      'In a group, at takes QQ numbers to mention (max 10); at=["all"] mentions everyone only ' +
      'when worlds.astrbot.allowAtAll is on in the config (there is no panel toggle yet), ' +
      'and is ignored in private chats.',
    tags: ['speak'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: {
          type: 'string',
          description: 'Text for the QQ recipient. Keep desktop-pet performance cues such as 【shy】 or <dance> in desktop-pet tool calls. Quote them literally if the conversation is about the markup itself.',
        },
        voice: {
          type: 'boolean',
          description:
            'Send the text as a voice message instead of a text bubble. Use it for short, ' +
            'spoken-style replies (roughly one or two sentences); long text stays text.',
        },
        image: {
          type: 'string',
          description:
            'A log: attachment handle to send as an image, for example the one printed as ' +
            '[blob log:abcdef12.jpg image/jpeg] in a pet_cua_screenshot receipt. ' +
            'Only when the person who asked has screenshot permission.',
        },
        conv_kind: {
          type: 'string',
          enum: ['group', 'private'],
          description: 'Conversation kind. Defaults to the conversation of this QQ turn.',
        },
        conv_id: {
          type: 'string',
          description: 'Group id or user id. Defaults to the conversation of this QQ turn.',
        },
        reply_to: {
          type: 'string',
          description: 'Optional bridge message id to quote as a reply.',
        },
        at: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 10,
          description:
            'Group only. QQ numbers to mention, for example ["123456789"]; "all" mentions ' +
            'everyone when worlds.astrbot.allowAtAll is on (no panel toggle yet). Ignored in private chats.',
        },
      },
      required: [],
    },
  },
  {
    name: 'astrbot_status',
    description:
      'Report the AstrBot bridge connection state, which channel the current turn came from, ' +
      'whether QQ voice is available, and the QQ conversations seen in this session. ' +
      'Call it when you are unsure whether this turn is a QQ turn.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: 'astrbot_read_history',
    description:
      'Read the QQ messages this bot has seen: the latest ones in a conversation, or those ' +
      'containing a keyword. Use it when someone refers to something said earlier.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keyword: {
          type: 'string',
          description: 'Only messages containing this text (case-insensitive). Leave out to read the latest.',
        },
        limit: { type: 'integer', description: 'How many messages, default 20, at most 100.' },
        context: {
          type: 'integer',
          description: 'With keyword: how many messages around each hit, default 2.',
        },
        sender: { type: 'string', description: 'Only messages from this QQ number.' },
        conv_kind: { type: 'string', enum: ['group', 'private'], description: 'Defaults to the latest conversation.' },
        conv_id: { type: 'string', description: 'Group id or user id. Defaults to the latest conversation.' },
      },
      required: [],
    },
  },
  {
    name: 'astrbot_read_message_component',
    description:
      'Read a QQ quote, merged forward, attachment details or another component of an observed message. ' +
      'Use the message #id and the 1-based component number shown in the QQ message. ' +
      'A nested path such as [2,3] selects the third entry of the second component. ' +
      'To retrieve the original QQ voice file, select its exact component and set audio_file to true. ' +
      'Use the returned offset for more entries. In a QQ turn only the current conversation can be read.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        message_id: { type: 'string', description: 'The observed outer QQ message ID, without #.' },
        path: {
          type: 'array', items: { type: 'integer', minimum: 1, maximum: 120 },
          minItems: 1, maxItems: 6, description: 'The component number and optional nested entry numbers.',
        },
        offset: { type: 'integer', minimum: 0, description: 'Page offset from the previous result.' },
        audio_file: { type: 'boolean', description: 'Fetch the selected voice component as a file, even if a transcript exists.' },
        conv_kind: { type: 'string', enum: ['group', 'private'] },
        conv_id: { type: 'string', description: 'Specify the QQ conversation when reading outside a QQ turn.' },
      },
      required: ['message_id', 'path'],
    },
  },
];

/** `astrbot_call_tool` 的静态声明；describe 与实例共用这一份。 */
export const CALL_TOOL_DECL: Omit<ToolDef, 'handler'> = {
  name: 'astrbot_call_tool',
  description:
    'Call one of the AstrBot tools enabled for this bridge, by name and with its own arguments. ' +
    'The list of available tools is in your environment prompt (astrbot.tools); if it looks stale, ' +
    'call astrbot_status. There are two identity paths: in a QQ turn the tool runs with the ' +
    'identity of the person whose message started this turn, so admin-only tools are refused ' +
    'when a group member is talking. In a Coo conversation turn, it runs as the configured ' +
    'AstrBot owner only after the bridge verifies the separate tool token. Execution-class tools ' +
    'require explicit authorization, an administrator identity, and an authorized connection. ' +
    'When a tool fails or is refused, say so honestly and do not ' +
    'pretend it succeeded.',
  tags: ['act'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: {
        type: 'string',
        description: 'Tool name exactly as listed in astrbot.tools.',
      },
      args: {
        type: 'object',
        description: 'Arguments for that tool, following its own parameter description.',
        additionalProperties: true,
      },
    },
    required: ['name'],
  },
};

export class AstrbotWorld implements World {
  readonly id = 'astrbot';

  private opts: AstrbotWorldOptions;
  private host?: WorldHost;
  private driver?: BridgeDriver;
  private connected = false;
  private switching = false;
  private queueBusy = false;
  private readonly incoming: BridgeMessage[] = [];
  private conversationGeneration = 0;
  private readonly pendingQq = new Set<number>();
  private settledQqCursor = 0;
  private mountedToolMode?: BridgeMode;
  private refreshingTools = false;
  private toolRefreshError?: string;
  /** 见过的会话，按出现顺序；给环境提示词和状态工具用。 */
  private readonly convs = new Map<string, Conv>();
  /** 最后一条消息所在的会话；工具不指定会话时用它。 */
  private lastConv?: Conv;
  /** 会话 -> 可发图授权；绑定到给权限的那条消息，轮次结束即失效。 */
  private readonly shotGrants = new Map<string, { until: number; msgId: string }>();
  /** 发送时间戳，用于每分钟上限。 */
  /** 桥那边启用的工具；只在环境提示词里列出来，不注册成原生工具。 */
  private toolList: ToolInfo[] = [];
  /** 是否已经收到过第一份清单（区分「连上」和「清单变了」）。 */
  private toolsSeen = false;
  /** 这一轮真正投递出去的最后一条人话消息 id；工具调用用它说明「谁在说话」。 */
  private turnMsgId = '';
  /** 这一轮有没有投递过 QQ 事件；由 onEventsSettled 置位，onTurnEnded 清掉。 */
  private turnChannel?: 'qq';
  /** 同一批里出现多个 QQ 会话（比如私聊 + 群）：隐式发送会猜错，必须显式指定。 */
  private turnMultiConv = false;
  /** 最近见过的消息 id → 会话；reply_to 用它解析目标。 */
  private knownMsgConv = new Map<string, Conv | null>();
  /** 置位时刻；作为 onTurnEnded 万一没来时的兜底。 */
  private turnChannelAt = 0;
  /** 这一轮最后投递的 QQ 会话；状态工具用。 */
  private turnConv?: Conv;
  /** 最近一条真正的人话消息；状态工具用来说清「最近一条从哪来」。 */
  private lastInbound?: { conv: Conv; sender: string; ts: string };

  constructor(opts: AstrbotWorldOptions) {
    this.opts = opts;
  }

  /**
   * 只报值，文案一律来自 ENV_PROMPT.md。
   * 前缀重建时会被反复调用，因此这里只读内存、不做 I/O。
   */
  envPromptVars(): Record<string, string> {
    const cfg = this.opts.cfg;

    const connection = !cfg.enabled
      ? '这个 World 当前是关闭的。'
      : this.connected
        ? '桥已连上。'
        : '桥未连上：消息收不到，也发不出去。';

    const safe = this.driver?.mode !== 'full';
    const scope = safe
      ? '仅接入已授权的主人 QQ 私聊。只能回复本轮私聊和读取该私聊资料。'
      : '群范围、私聊范围、仅被叫/全部消息、工具权限由 AstrBot 管理。';

    const convList =
      safe || this.convs.size === 0
        ? ''
        : [...this.convs.values()]
            .map((c) => `- ${c.kind === 'group' ? '群' : '私聊'} id=${c.id}`)
            .join('\n');

    const last = !safe && this.lastConv
      ? `${this.lastConv.kind === 'group' ? '群' : '私聊'} id=${this.lastConv.id}`
      : '';

    const owners = safe ? [] : this.driver?.ownerIds ?? [];
    const owner = owners.length
      ? `AstrBot 的管理员 QQ 帐号为 ${owners.join('、')}。每位发言者的身份以收到的 QQ 消息为准。`
      : '桥未提供 AstrBot 管理员名单，按实际消息来源辨认发言者。';

    const tools = !safe && this.toolList.length
      ? this.toolList
          .map((t) => {
            const sig = t.sig ? `(${t.sig})` : '';
            const flag = t.risk === 'write' ? '（会改变状态）' : '';
            return `- ${t.name}${sig}${flag}：${t.desc ?? ''}`;
          })
          .join('\n')
      : '（当前模式没有公布通用 AstrBot 工具。）';

    return {
      'astrbot.connection': connection,
      'astrbot.scope': scope,
      'astrbot.self': this.driver?.self?.name ?? '',
      'astrbot.owner': owner,
      'astrbot.conversations': convList,
      'astrbot.lastConversation': last,
      'astrbot.tools': tools,
    };
  }

  tools(): ToolDef[] {
    const chat = [this.sendMessageTool(), this.historyTool(), this.readComponentTool()];
    return this.driver?.mode === 'full' ? [...chat, this.statusTool(), this.callToolDef()] : chat;
  }

  /** 「连接」面板的只读状态；只报 World 自己知道的事，不替 AstrBot 报策略。 */
  private connectionState(): Record<string, unknown> {
    const cfg = this.opts.cfg;
    return {
      enabled: cfg.enabled !== false,
      connected: this.connected,
      mode: this.driver?.mode,
      modeKnown: !!this.driver?.modeRevision,
      modeSynced: this.connected && !!this.driver?.modeRevision,
      switching: this.switching || this.refreshingTools,
      modeApprovalPending: this.driver?.modeApprovalPending === true,
      connectionError: this.toolRefreshError ?? this.driver?.connectionError,
      ownerBound: this.driver?.ownerBound === true,
      wsUrl: cfg.wsUrl && !bridgeAddressError(cfg.wsUrl.trim()) ? cfg.wsUrl : '',
      tokenSet: !!cfg.token,
      includeTime: cfg.includeTime !== false,
      channelHint: cfg.channelHint !== false,
      ownerTools: this.connected && this.driver?.ownerTools === true,
      desktopSend: this.connected && this.driver?.desktopSend === true,
      reconnectBaseMs: cfg.reconnectBaseMs ?? 1000,
      reconnectMaxMs: cfg.reconnectMaxMs ?? 30_000,
      self: this.driver?.self ?? null,
      owners: this.driver?.ownerIds.length ?? 0,
      tts: this.driver?.tts ?? { ready: false },
      tools: this.driver?.tools.length ?? 0,
      conversations: this.convs.size,
    };
  }

  webUi(): WorldWebUiDecl {
    return {
      ...(EXTENSION_VERSION
        ? { badges: [{ label: '版本', value: EXTENSION_VERSION, tone: 'plain' as const }] }
        : {}),
      config: [ASTRBOT_CONFIG_GROUP],
      panels: [
        {
          id: 'connection',
          title: '连接',
          description: 'World 自己的桥地址、密钥和重连参数；群聊、私聊、工具和语音仍在 AstrBot 配置。',
        },
      ],
      invoke: async (panel, method, args) => {
        if (panel === 'connection') {
          if (method === 'state') return this.connectionState();
          if (method === 'save-bridge-token') {
            if (typeof args[0] !== 'string') throw new Error('桥接令牌格式无效');
            if (!this.opts.storeBridgeToken) throw new Error('当前部署无法保存桥接令牌');
            const token = args[0].trim();
            const error = bridgeCredentialError('', token);
            if (error) throw new Error(error);
            this.opts.storeBridgeToken(token);
            return { saved: true };
          }
          if (method === 'reconnect') {
            if (this.opts.cfg.enabled === false || !this.opts.restart) throw new Error('AstrBot World 当前未启用');
            if (this.switching || this.queueBusy || this.turnChannel) throw new Error('请等当前 QQ 处理结束后重连');
            await this.opts.restart();
            return { restarted: true };
          }
          if (method === 'switch-mode') {
            const mode = args[0];
            if ((mode !== 'full' && mode !== 'safe') || args[1] !== true) throw new Error('请先确认切换模式');
            await this.switchMode(mode);
            return this.connectionState();
          }
        }
        throw new Error(`没有这个方法：${panel}.${method}`);
      },
      promptDocs: [
        {
          key: 'worlds.astrbot.envPrompt',
          title: 'AstrBot · 环境提示词',
          description: '说明你在哪些 QQ 会话里、什么时候会被叫到，以及怎么回话。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'astrbot.connection', description: '桥的连接状态。' },
            { name: 'astrbot.scope', description: '当前的消息范围与称呼设置。' },
            { name: 'astrbot.self', description: '桥自报的 bot 名字，未连接时为空。' },
            { name: 'astrbot.owner', description: 'QQ 上哪个人是主人（AstrBot 管理员）。' },
            { name: 'astrbot.conversations', description: '本次会话里见过的 QQ 会话。' },
            { name: 'astrbot.lastConversation', description: '最后一条消息所在的会话。' },
            { name: 'astrbot.tools', description: '桥那边启用的工具清单，没有时说明为空。' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.mountedToolMode = undefined;
    this.refreshingTools = false;
    this.toolRefreshError = undefined;
    const cfg = this.opts.cfg;

    const driver =
      this.opts.driver ??
      new AstrbotBridgeDriver({
        wsUrl: cfg.wsUrl,
        token: cfg.token,
        capabilities: {
          images: this.acceptsImages(host), message_segments: true, component_media: true,
          component_audio: true, message_delivery_ack: true,
        },
        requireModeSync: true,
        acceptMode: mode => this.acceptModeForMountedTools(mode),
        reconnectBaseMs: cfg.reconnectBaseMs,
        reconnectMaxMs: cfg.reconnectMaxMs,
        handshakeTimeoutMs: this.opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
        log: host.log,
      });
    this.driver = driver;
    this.connected = driver.connected;

    driver.onState((connected) => {
      if (this.driver !== driver) return;
      if (!connected) this.invalidateQueue();
      this.connected = connected;
      void this.pushState(connected);
    });
    driver.onMessage((msg) => {
      if (driver.modeRevision && !msg.notice) {
        if (!this.connected || this.incoming.length >= MAX_PENDING_QQ_MESSAGES
          || (driver.mode === 'safe' && msg.conv.kind !== 'private')) return false;
        this.incoming.push(msg);
        this.drainIncoming();
      } else if (driver.mode !== 'safe') void this.onBridgeMessage(msg);
    });
    // 桥会带上它记得的会话（含重启前恢复的），主动发送要靠这份清单。
    driver.onReady?.((convs) => {
      for (const conv of convs) {
        if (conv.kind !== 'group' && conv.kind !== 'private') continue;
        if (!conv.id || !conv.umo) continue;
        this.convs.set(this.convKey(conv), conv);
      }
    });
    // 桥在握手后、以及配置变了都会重推这份清单。
    this.toolList = driver.tools;
    this.toolsSeen = false;
    driver.onTools((tools) => {
      if (driver.mode === 'safe' || !driver.connected) return;
      const before = this.toolList.map((t) => t.name).join(',');
      const first = !this.toolsSeen;
      this.toolList = tools;
      const after = tools.map((t) => t.name).join(',');
      host.log.info('可用工具清单更新', { count: tools.length });
      // 提示词是连接时的快照；第一次拿到清单（且非空）或清单变了，都推一条通知带进上下文。
      if ((first && tools.length > 0) || (!first && before !== after)) {
        const names = tools.length ? tools.map((t) => t.name).join('、') : '（空）';
        void host
          .pushEvent(
            {
              type: 'astrbot.notice',
              ts: nowIso(this.opts.timezone),
              source: this.id,
              origin: 'external',
              text: `[AstrBot] 可用工具：${names}`,
              senderKey: this.id,
              meta: { kind: 'tools' },
            },
            { trigger: 'piggyback' },
          )
          .catch((err: unknown) => {
            host.log.warn('工具清单通知投递失败', { error: String(err) });
          });
      }
      this.toolsSeen = true;
    });
    driver.onNotice((notice) => {
      if (driver.mode === 'safe') return;
      void host
        .pushEvent({
          type: 'astrbot.notice',
          ts: notice.ts ?? nowIso(this.opts.timezone),
          source: this.id,
          origin: 'external',
          text: `[AstrBot 通知] ${notice.text}`,
          senderKey: this.id,
          meta: notice.kind ? { kind: notice.kind } : undefined,
        })
        .catch((err: unknown) => {
          host.log.warn('通知事件投递失败', { error: String(err) });
        });
    });

    // 连不上不抛错，也不无限等：桥没起来或握手卡住都不该拖垮整个装配。
    // 到点后驱动仍在后台重连，连上会通过 onState 把状态推回来。
    await this.waitDriverStart(driver, this.opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    if (this.driver !== driver) return;
    this.connected = driver.connected;
    this.mountedToolMode = driver.connected && driver.mode === 'full' ? 'full' : 'safe';
  }

  private acceptModeForMountedTools(mode: BridgeMode): boolean {
    const restart = this.opts.restart;
    if (!restart || this.mountedToolMode === undefined || this.mountedToolMode === mode) return true;
    if (!this.refreshingTools) {
      this.refreshingTools = true;
      this.toolRefreshError = undefined;
      // 原版 Coo 在 World 挂载时重建主会话的工具表，保留已聊过的内容。
      void Promise.resolve().then(restart).catch(() => {
        this.toolRefreshError = 'Coo 未能刷新桥接工具，请重新连接后再试。';
      }).finally(() => { this.refreshingTools = false; });
    }
    return false;
  }

  private async switchMode(mode: BridgeMode): Promise<void> {
    const driver = this.driver;
    if (!driver?.changeMode || this.switching) throw new Error('桥未连接或正在切换');
    this.switching = true;
    try {
      if (this.queueBusy || this.turnChannel) throw new Error('Coo 正在处理 QQ 消息，请等这一轮结束');
      await driver.changeMode(mode);
      if (!driver.modeApprovalPending) this.invalidateQueue();
    } finally {
      this.switching = false;
      this.drainIncoming();
    }
  }

  private invalidateQueue(): void {
    const hadQqTurn = this.turnChannel === 'qq';
    this.conversationGeneration++;
    this.incoming.length = 0;
    this.queueBusy = false;
    this.clearTurn();
    if (hadQqTurn) this.turnChannel = 'qq'; // Until idle, deny desktop fallback for the invalidated QQ turn.
    this.shotGrants.clear();
    for (const cursor of this.pendingQq) {
      void this.host?.withdrawPending?.(cursor).catch(() => {});
    }
    this.pendingQq.clear();
  }

  private drainIncoming(): void {
    if (this.queueBusy || this.switching || !this.connected) return;
    const next = this.incoming.shift();
    if (!next) return;
    this.queueBusy = true;
    const generation = this.conversationGeneration;
    void this.onBridgeMessage(next).then(queued => {
      if (!queued && generation === this.conversationGeneration) this.finishIncoming();
    }, error => {
      this.host?.log.warn('QQ 消息处理失败', { error: String(error) });
      if (generation === this.conversationGeneration) this.finishIncoming();
    });
  }

  private finishIncoming(): void {
    this.queueBusy = false;
    this.drainIncoming();
  }

  /** 等首次连接，但最多等 timeoutMs；超时只记日志，不终止后台重连。 */
  private async waitDriverStart(driver: BridgeDriver, timeoutMs: number): Promise<void> {
    const limit = Math.max(1, timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), limit);
    });
    const started = driver
      .start()
      .then(() => true)
      .catch((err: unknown) => {
        this.host?.log.warn('连接 AstrBot 桥失败', {
          error: err instanceof Error ? err.message : String(err),
        });
        return true;
      });
    try {
      const ok = await Promise.race([started, timedOut]);
      if (!ok) {
        this.host?.log.warn('连接 AstrBot 桥超时，先继续启动，后台继续重连', {
          timeoutMs: limit,
        });
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    const driver = this.driver;
    this.driver = undefined;
    this.connected = false;
    this.invalidateQueue();
    if (driver) await driver.stop();
  }

  /**
   * Core 只通知本 World 自己产生的事件。本包只据此判断“这一轮有没有 QQ 人话”：
   * 有，才允许用 QQ 出口；纯 QQ 通知（撤回/入群/戳一戳）不能建立轮次。
   *
   * 其他来源的输入不出现在这个回调里，本包也不去猜：本地对话由各自的 World
   * 处理，QQ 出口只服务本包自己收到的消息。
   */
  onEventsSettled(events: readonly EventEnvelope[], outcome: 'delivered' | 'discarded'): void {
    for (const event of events) {
      if (Number.isSafeInteger(event.cursor)) {
        this.pendingQq.delete(event.cursor);
        this.settledQqCursor = Math.max(this.settledQqCursor, event.cursor);
      }
    }
    if (outcome !== 'delivered') {
      if (events.some(e => e.source === this.id && e.type === 'astrbot.message' && e.meta?.notice !== true)) this.finishIncoming();
      return;
    }

    const qq = events.filter(e => e.source === this.id && e.origin === 'external'
      && e.type === 'astrbot.message');
    const human = qq.filter((e) => {
      const meta = e.meta as { notice?: boolean } | undefined;
      return meta?.notice !== true;
    });
    if (human.length === 0) return;
    if (human.some(e => e.meta?.bridgeGeneration !== undefined && e.meta.bridgeGeneration !== this.conversationGeneration)) {
      this.clearTurn();
      this.turnChannel = 'qq';
      this.turnMultiConv = true;
      return;
    }

    // 只有「人话」跨会话才算歧义；通知不该把回复目标带到别的群。
    const convKeys = new Set(
      human
        .map((e) => {
          const conv = (e.meta as { conv?: Conv } | undefined)?.conv;
          return conv ? conv.umo || `${conv.kind}:${conv.id}` : '';
        })
        .filter((key) => key !== ''),
    );
    this.turnMultiConv = convKeys.size > 1;

    const lastHuman = human[human.length - 1]!;
    const first = this.turnChannel !== 'qq';
    this.turnChannel = 'qq';
    this.turnChannelAt = Date.now();
    // 会话、消息 id、时间都只从人话取；通知不能当发送目标或工具身份。
    const meta = lastHuman.meta as { conv?: Conv; message_id?: unknown } | undefined;
    if (meta?.conv) this.turnConv = meta.conv;
    this.turnMsgId = String(meta?.message_id ?? '');

    if (first) {
      const c = this.turnConv;
      this.host?.log.info('本轮渠道：QQ', {
        conv: c ? `${c.kind}:${c.id}` : 'unknown',
        events: human.length,
      });
    }
  }

  /** 清掉 QQ 轮次的全部状态；stop / 轮次结束都走这里。 */
  private clearTurn(): void {
    this.turnChannel = undefined;
    this.turnConv = undefined;
    this.turnMsgId = '';
    this.turnMultiConv = false;
    this.turnChannelAt = 0;
  }

  /** 一轮结束：下一次只有非 QQ 输入时，QQ 出口就该关上。 */
  onTurnEnded(): void {
    const wasQq = this.turnChannel === 'qq';
    this.clearTurn();
    if (wasQq) queueMicrotask(() => this.finishIncoming());
  }

  /** 运行阶段回到 idle 时也清掉 QQ 轮次，避免下一轮复用上一轮的 QQ 出口。 */
  onRunPhase(phase: RunPhase): void {
    if (phase.state !== 'idle') return;
    this.clearTurn();
  }

  /** 这一轮是不是 QQ 轮次；onTurnEnded 万一没来，短 TTL 后自动失效。 */
  private qqTurnActive(): boolean {
    if (this.turnChannel !== 'qq') return false;
    return Date.now() - this.turnChannelAt < QQ_TURN_TTL_MS;
  }

  private ownerActor(driver: BridgeDriver): ToolActor | undefined {
    return driver.mode === 'full' && driver.ownerTools === true ? { kind: 'desktop' } : undefined;
  }

  /** 这一轮建立过 QQ 轮次但已经超过安全 TTL。 */
  private turnExpired(): boolean {
    if (this.turnChannel !== 'qq') return false;
    return Date.now() - this.turnChannelAt >= QQ_TURN_TTL_MS;
  }

  /**
   * 工具/发送开始时若这一轮仍然有效，就把 TTL 起点推到现在。
   * 过期轮次不会被复活。
   */
  private touchTurn(): void {
    if (this.qqTurnActive()) this.turnChannelAt = Date.now();
  }

  /** 当前端点的模型能不能直接读图；读不了就让桥只发文字描述。 */
  private acceptsImages(host: WorldHost): boolean {
    try {
      return host.modelFacts.accepts('image/jpeg') || host.modelFacts.accepts('image/png');
    } catch {
      return false;
    }
  }

  private attachStoredQuoteImages(host: WorldHost, msg: BridgeMessage, blobs: BlobInput[]): void {
    if (!msg.quoteImageHistory || !this.acceptsImages(host)) return;
    const reused = new Map<string, number>();
    for (const part of msg.segments ?? []) {
      if (part.type !== 'reply' || !part.fields.id || part.fields.id === msg.id) continue;
      const children = part.children ?? [];
      const imageParts = children.filter((child) => child.type === 'image');
      if (imageParts.some((child) => imageAttachmentIndex(child) !== undefined)) continue;
      const original = findMessage(host.store, msg.conv, part.fields.id);
      if (original && convOfEvent(original)?.umo !== msg.conv.umo) continue;
      const archived = directSavedImages(original).filter((blob) => host.blob(blob.handle));
      for (const [slot, blob] of archived.entries()) {
        let index = reused.get(blob.handle);
        if (index === undefined) {
          if (blobs.length >= INBOUND_IMAGE_LIMIT) break;
          index = blobs.length;
          blobs.push({ handle: blob.handle, fallbackText: '[QQ 引用图片]' });
          reused.set(blob.handle, index);
        }
        const image = imageParts.length === archived.length ? imageParts[slot] : undefined;
        const fields = { attachment: String(index), text: '[图片：引用原图]', media_state: 'attached' };
        if (image) Object.assign(image.fields, fields);
        else children.push({ type: 'image', fields });
      }
      if (children.length) part.children = children;
    }
  }

  /** 桥送来一条消息：按配置的范围决定要不要投递，投递时把事实写清楚。 */
  private async onBridgeMessage(msg: BridgeMessage): Promise<boolean | undefined> {
    const host = this.host;
    if (!host) return;
    if (!this.opts.cfg.enabled) return;

    if (!msg.conv.umo && msg.umo) msg.conv.umo = msg.umo;
    if (msg.convMismatch) {
      this.host?.log.warn('AstrBot 帧 UMO 与 conv 不一致，已按 UMO 处理', {
        umo: msg.umo,
        conv: msg.conv,
      });
    }
    this.rememberConv(msg.conv);
    if (msg.id) {
      const key = String(msg.id);
      const current = this.knownMsgConv.get(key);
      this.knownMsgConv.set(key, current === null || (current && this.convKey(current) !== this.convKey(msg.conv)) ? null : msg.conv);
      while (this.knownMsgConv.size > 200) {
        const oldest = this.knownMsgConv.keys().next().value;
        if (oldest === undefined) break;
        this.knownMsgConv.delete(oldest);
      }
    }
    const isPrivate = msg.conv.kind === 'private';
    const isNotice = msg.notice === true;
    // 管理员（= 主人）说话才给发图授权；别人一说话就撤销，不给顶替的机会。
    // 通知不是人说的话，不能拿它撤销授权。
    if (!isNotice) {
      if (msg.canScreenshot) {
        this.grantScreenshot(msg.conv, msg.id);
      } else {
        this.shotGrants.delete(this.convKey(msg.conv));
      }
    }

    const blobs = imageBlobs(msg.images);
    if (!isNotice) this.attachStoredQuoteImages(host, msg, blobs);

    const body = (msg.segments?.length ? renderSegmentLine(msg.segments) : '').trim() || msg.text.trim();
    // 桥会把非文字消息转成占位文字；真空的丢掉。
    if (!body) return;

    // 私聊天然就是对着自己说的；通知类不是人说的话，永远不算点名。
    const called = !isNotice && (isPrivate || msg.mentioned === true);

    // 只有真的投递出去的人话才更新「默认会话」和「最近收到」。
    // 通知、以及被 mode 过滤掉的群消息不能改默认回复目标。
    if (!isNotice) {
      this.lastConv = msg.conv;
      this.lastInbound = {
        conv: msg.conv,
        sender: msg.sender?.name?.trim() || msg.sender?.id || '某人',
        ts: msg.ts ?? nowIso(this.opts.timezone),
      };
    }

    const senderName = msg.sender?.name?.trim() || '某人';
    const senderId = (msg.sender?.id ?? '').trim();
    const cachedName = this.convs.get(this.convKey(msg.conv))?.name;
    const convName = msg.conv.name || cachedName || msg.conv.id;
    // 主人与管理员分开：owner 是「谁属于这个 bot」，role=admin 只是工具权限。
    const isOwner = msg.owner === true;
    // 渠道放在行首，和 qq-final 的【QQ群 …】对齐：不用读上下文就知道这条从哪来。
    const tags: string[] = [];
    if (senderId) tags.push(`QQ:${senderId}`);
    if (isOwner && !isNotice) tags.push('主人');
    if (!isPrivate && called) tags.push('@你');
    const clock = this.opts.cfg.includeTime === false ? '' : hhmm(msg.ts);
    const head = `【${isPrivate ? 'QQ私聊' : `QQ群 ${convName}`}${clock ? ` ${clock}` : ''}】`;
    const idPart = msg.id ? `#${msg.id} ` : '';
    const senderTag = tags.length ? `(${tags.join(', ')})` : '';
    // 通知类没有「谁在说话」，只记一条事实；撤回时补上被撤回的原文。
    let noticeBody = body;
    if (isNotice && msg.ref) {
      const recalled = this.findMessageBody(host, msg.conv, msg.ref);
      if (recalled) noticeBody = `${body}（原文：${recalled}）`;
    }
    // 就在这条消息后面提醒一次：模型最容易在这里顺手用错身体。
    // 只给「需要回复」的（@、私聊、带图），避免每条群聊都加一行。
    const wantsReply = !isNotice && (isPrivate || called || blobs.length > 0);
    const channelHint =
      wantsReply && this.opts.cfg.channelHint !== false
        ? '\n（回复这条 QQ 消息用 astrbot_send_message；其他界面的消息不会自动转发到 QQ）'
        : '';
    const line = isNotice
      ? `${head}${noticeBody}`
      : `${head}${idPart}${senderName}${senderTag}：${body}${channelHint}`;

    const generation = this.conversationGeneration;
    const input: QqEvent = {
          type: 'astrbot.message',
          ts: msg.ts ?? nowIso(this.opts.timezone),
          source: this.id,
          origin: 'external',
          text: line,
          senderKey: msg.sender?.id ?? senderName,
          ...(blobs.length > 0 ? { blobs } : {}),
          meta: {
            channel: 'qq',
            bridgeGeneration: generation,
            ...(msg.conv.umo || msg.umo ? { umo: msg.conv.umo ?? msg.umo } : {}),
            conv: {
              ...(msg.conv.umo || msg.umo ? { umo: msg.conv.umo ?? msg.umo } : {}),
              kind: msg.conv.kind,
              id: msg.conv.id,
              name: msg.conv.name,
            },
            message_id: msg.id,
            ...(isNotice ? {} : { body }),
            mentioned: called,
            owner: isOwner,
            notice: isNotice,
            ...(msg.imageErrors ? { image_errors: msg.imageErrors } : {}),
            ...(msg.segments?.length ? { segments: msg.segments } : {}),
          },
        };

    return await host.pushEvent(
        input,
        // 主人私聊立即；群只认被叫到；其他私聊和群聊合批；通知只排队。
        isNotice
          ? { trigger: 'piggyback' }
          : isPrivate
            ? isOwner || this.driver?.mode === 'safe'
              ? { trigger: 'flush' }
              : undefined
            : called
              ? { trigger: 'flush' }
              : undefined,
      ).then(async (event) => {
        if (isNotice) return false;
        if (event.cursor > this.settledQqCursor) {
          if (generation !== this.conversationGeneration) {
            await host.withdrawPending?.(event.cursor);
            return false;
          }
          this.pendingQq.add(event.cursor);
        }
        return true;
      })
      .catch((err: unknown) => {
        host.log.warn('消息事件投递失败', { error: String(err) });
        return false;
      });
  }

  /** 在最近的事件里找某条消息的正文，用来给撤回补原文。 */
  private findMessageBody(host: WorldHost, conv: Conv, ref: string): string {
    const recent = host.store.range({ source: this.id, origin: 'external', limit: 300 });
    for (let i = recent.length - 1; i >= 0; i--) {
      const event = recent[i];
      if (!event || event.type !== 'astrbot.message') continue;
      const c = convOfEvent(event);
      if (!c) continue;
      const same = c.umo && conv.umo ? c.umo === conv.umo : c.kind === conv.kind && c.id === conv.id;
      if (!same) continue;
      if (String(event.meta?.message_id ?? '') !== ref) continue;
      const body = event.meta?.body;
      if (typeof body === 'string' && body) {
        return body.length > 60 ? `${body.slice(0, 60)}…` : body;
      }
    }
    return '';
  }

  /** 会话在 World 内部的唯一键：优先 UMO，旧帧退回 kind:id。 */
  private convKey(conv: Conv): string {
    return conv.umo?.trim() || `${conv.kind}:${conv.id}`;
  }

  /** 记住见过的会话，上限 50 条，避免长期运行后无限增长。 */
  private rememberConv(conv: Conv): void {
    const key = this.convKey(conv);
    if (this.convs.has(key)) {
      // 重新插入以维持「最近」顺序
      this.convs.delete(key);
    }
    this.convs.set(key, conv);
    while (this.convs.size > 50) {
      const oldest = this.convs.keys().next();
      if (oldest.done) break;
      this.convs.delete(oldest.value);
    }
  }

  private async pushState(connected: boolean): Promise<void> {
    const host = this.host;
    if (!host) return;
    await host
      .pushEvent({
        type: connected ? 'astrbot.connected' : 'astrbot.disconnected',
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: 'internal',
        text: connected
          ? '与 AstrBot 的桥已连上，QQ 会话可以进出消息了。'
          : '与 AstrBot 的桥断开了，正在重连。',
        senderKey: this.id,
      })
      .catch((err: unknown) => {
        host.log.warn('连接状态事件投递失败', { error: String(err) });
      });
  }

  private callToolDef(): ToolDef {
    return {
      ...CALL_TOOL_DECL,
      handler: async (raw, ctx) => {
        if (this.switching || this.driver?.mode === 'safe' || this.turnMultiConv || (this.queueBusy && !this.qqTurnActive())) {
          return { text: '当前模式或消息范围不允许调用通用 AstrBot 工具。', failed: true };
        }
        const name = typeof raw.name === 'string' ? raw.name.trim() : '';
        if (!name) return { text: '没有给工具名。', failed: true };
        const args =
          raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args)
            ? (raw.args as Record<string, unknown>)
            : {};
        const driver = this.driver;
        if (!driver || !driver.connected) {
          return { text: '与 AstrBot 桥的连接未建立，工具没有执行。', failed: true };
        }
        // QQ 轮次用触发这一轮的人话消息；Coo 对话轮次用「连接」里指定的主人 QQ。
        // 过期的 QQ 轮次直接拒绝，不借上一条 QQ 消息，也不回退 owner。
        let turn = '';
        let actor: ToolActor | undefined;
        const startedActive = this.qqTurnActive();
        if (startedActive) {
          if (!this.turnMsgId) {
            return {
              text: '这一轮没有可执行工具的人话消息（只有 QQ 通知），工具没有执行。',
              failed: true,
            };
          }
          // 长工具链靠这里续期；调用返回后再补一次，见下方。
          this.touchTurn();
          turn = this.turnMsgId;
        } else if (this.turnExpired()) {
          return {
            text: '本轮 QQ 消息已过期，不能借主人身份，工具没有执行；等 QQ 那边有人说话再试。',
            failed: true,
          };
        } else {
          actor = this.ownerActor(driver);
          if (!actor) {
            return { text: '请在 AstrBot 管理页授权桌面对话使用主人 QQ 和工具。', failed: true };
          }
        }
        const res = await driver.callTool(name, args, turn, actor, this.turnConv?.umo);
        // 调用开始时还 active：工具耗时再长也不把它误判成过期（过期轮次不复活）。
        if (startedActive) this.turnChannelAt = Date.now();
        if (!res.ok) {
          // T-004：桥把中文说明放 note、稳定错误码放 error；优先说人话，code 附在括号里。
          const note = res.note;
          const reason = note || res.error || '未知原因';
          const code = note && res.error && res.error !== note ? `（${res.error}）` : '';
          return { text: `工具 ${name} 没有执行：${reason}${code}`, failed: true };
        }
        const text = res.result?.trim() ? res.result : `工具 ${name} 执行完了，没有返回文字。`;
        const blobs = name === 'cortico_read_message_component' ? componentBlobs(res) : [];
        return this.externalRead(ctx, text, this.turnConv, blobs);
      },
    };
  }

  private sendMessageTool(): ToolDef {
    return {
      ...ASTRBOT_TOOL_DECLS[0],
      handler: async (args) => {
        if (this.switching || this.turnMultiConv || (this.queueBusy && !this.qqTurnActive())) {
          return { text: this.turnMultiConv ? '本轮包含多个 QQ 会话，请按原会话重试。' : '本轮没有可用的 QQ 发送授权。', failed: true };
        }
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        const handle = typeof args.image === 'string' ? args.image.trim() : '';
        const voice = args.voice === true;
        if (!text && !handle) return { text: '没有正文也没有图片，未发送。', failed: true };
        if (voice && !text) return { text: '语音需要正文，未发送。', failed: true };
        if (voice && handle) return { text: '语音和图片不能是同一条消息，未发送。', failed: true };

        // 目标：QQ 轮次可以省略，回触发会话；其他轮次必须显式指定。
        const explicitTarget = (args.conv_id != null && args.conv_id !== '')
          || (typeof args.reply_to === 'string' && args.reply_to.trim() !== '');

        // 渠道校验：
        // - QQ 轮次：可以隐式回触发会话；
        // - 非 QQ 轮次：只有配置了主人 QQ，且目标是桥见过的会话，才允许主动发送。
        const qqTurn = this.qqTurnActive();
        const safe = this.driver?.mode === 'safe';
        if (safe && (!qqTurn || this.turnConv?.kind !== 'private' || handle)) {
          return { text: '安全模式只允许向当前主人私聊回复文字或语音。', failed: true };
        }
        if (!qqTurn) {
          if (this.turnExpired()) {
            return {
              text: '本轮 QQ 消息已过期，QQ 出口已关闭；等 QQ 那边有人说话再回。',
              failed: true,
            };
          }
          if (!explicitTarget) {
            return {
              text: '这一轮不是 QQ 消息。要主动发 QQ，必须用 conv_id 或 reply_to 指定目标会话。',
              failed: true,
            };
          }

        }

        const driver = this.driver;
        if (!driver || !driver.connected) {
          return { text: '与 AstrBot 桥的连接未建立，消息没有发出。', failed: true };
        }
        if (!qqTurn && !driver.desktopSend) {
          return { text: '请在 AstrBot 管理页授权桌面主动发送和目标会话。', failed: true };
        }

        // 发送必须是桥见过的会话：没有 UMO 的显式目标先拒绝，别让桥回误导性的 missing_umo。
        const picked = this.pickConv(args, { requireUmo: true, bound: qqTurn ? this.turnConv : undefined });
        if (picked.error) {
          this.host?.log.warn('QQ 出口被拒：会话参数不合法或桥没见过该会话', { error: picked.error });
          return { text: picked.error, failed: true };
        }
        const conv = picked.conv;
        if (!conv) {
          return {
            text: !qqTurn
              ? '主动发送必须指定目标会话：用 conv_id（群号或 QQ 号）或 reply_to。'
              : this.turnMultiConv
                ? '这一轮有多个 QQ 会话（私聊和群）。请用 conv_id 或 reply_to 指定回哪个，不要猜。'
                : '还不知道发到哪个会话：没有指定 conv_id，也还没有收到过消息。',
            failed: true,
          };
        }

        const at = parseMentions(args.at, this.opts.cfg.allowAtAll === true);
        if (!at.ok) return { text: at.reason, failed: true };
        if (voice && at.list.length > 0) {
          return { text: '语音和 @ 不能是同一条消息，未发送。', failed: true };
        }
        // @ 只在群里有效；私聊里忽略并说明，不因此整条失败。
        const mention = conv.kind === 'group' ? at.list : [];
        const atNote = conv.kind !== 'group' && at.list.length > 0 ? '（私聊里 @ 不生效，已忽略）' : '';

        let image: OutgoingImage | undefined;
        if (handle) {
          if (!this.mayScreenshot(conv)) {
            return {
              text: '这条消息没有发图权限：只有被允许的人要截图时才能发，而且要先调 pet_cua_screenshot 拿到图。',
              failed: true,
            };
          }
          const blob = this.host?.blob(handle) ?? null;
          if (!blob) {
            return { text: `找不到附件 ${handle}：句柄可能写错了，或者这份附件已经被清理。`, failed: true };
          }
          if (blob.bytes.byteLength > MAX_IMAGE_BYTES) {
            return {
              text: `图片太大（${Math.round(blob.bytes.byteLength / 1024)}KB），没有发出。`,
              failed: true,
            };
          }
          image = { mime: blob.mime, base64: Buffer.from(blob.bytes).toString('base64') };
        }

        const replyTo = typeof args.reply_to === 'string' && args.reply_to !== '' ? args.reply_to : undefined;
        this.touchTurn();
        const actor: ToolActor | undefined = qqTurn ? undefined : { kind: 'desktop' };
        const result = await driver.send(conv, text, replyTo, image, voice, mention, {
          turn: qqTurn ? this.turnMsgId : '', actor,
        });
        // 发送本身耗时不该把这一轮挤到过期；开始时就 active 才续期。
        if (qqTurn) this.turnChannelAt = Date.now();
        const where = conv.kind === 'group' ? `群「${conv.name ?? conv.id}」` : '私聊';
        if (!result.ok) {
          // T-004：桥把中文说明放 note、稳定错误码放 error；优先说人话，code 附在括号里。
          const reason = result.note || result.error || '未知原因';
          const code = result.note && result.error && result.error !== result.note ? `（${result.error}）` : '';
          const lead = result.uncertain ? '没有确认发出' : '没有发出';
          const hint = result.uncertain
            ? '；这条可能已经发出，先确认再决定要不要重试，不要直接重发'
            : '';
          return { text: `${lead}：${reason}${code}${hint}`, failed: true };
        }
        const what = result.voice
          ? image
            ? '已把语音和图片发到'
            : '已用语音发到'
          : image
            ? '已把图片发到'
            : '已发到';
        const note = result.note ? `（${result.note}）` : '';
        const atPart = mention.length > 0
          ? `，@了 ${mention.includes('all') ? '全体成员' : `${mention.length} 人`}`
          : '';
        return { text: `${what}${where}${atPart}。${note}${atNote}` };
      },
    };
  }

  /**
   * 工具参数里的会话；发送只认当前轮，历史允许回退 lastConv。
   * `conv_id` 接受字符串或数字（数字不能转成字符串丢掉精度）；其他类型明确失败。
   * `requireUmo` 只给发送用：显式目标必须是桥见过的、带 UMO 的会话。
   * 返回错误而不是抛错，两个调用点的失败文案不同。
   */
  private pickConv(
    args: Record<string, unknown>,
    opts: { requireUmo?: boolean; bound?: Conv } = {},
  ): { conv?: Conv; error?: string } {
    const idArg = args.conv_id;
    let id = '';
    if (typeof idArg === 'string') {
      id = idArg.trim();
    } else if (typeof idArg === 'number') {
      if (!Number.isFinite(idArg)) return { error: 'conv_id 必须是字符串或数字，未发送。' };
      id = String(idArg);
    } else if (idArg !== undefined && idArg !== null) {
      return { error: 'conv_id 必须是字符串或数字，未发送。' };
    }

    const bound = opts.bound;
    if (bound) {
      if (opts.requireUmo && !bound.umo) return { error: '桥还没见过这个会话（没有 UMO）。' };
      if (id && id !== bound.id && id !== bound.umo || args.conv_kind && args.conv_kind !== bound.kind) {
        return { error: '只能操作当前 QQ 会话。' };
      }
      return { conv: bound };
    }

    if (id !== '') {
      const kindArg = args.conv_kind;
      if (
        kindArg !== undefined &&
        kindArg !== null &&
        kindArg !== '' &&
        kindArg !== 'group' &&
        kindArg !== 'private'
      ) {
        return { error: `conv_kind 只能是 group 或 private，收到 ${String(kindArg)}，未发送。` };
      }
      const known = [...this.convs.values()].filter(c => c.umo && (c.id === id || c.umo === id) && (!kindArg || c.kind === kindArg));
      if (known.length === 1) return { conv: known[0] };
      if (known.length > 1) return { error: '多个平台有同一会话号，请指定完整 UMO。' };
      return { error: '桥还没见过这个会话（没有 UMO），先让这个会话发一条消息' };
    }

    const replyTo = args.reply_to;
    if (typeof replyTo === 'string' && replyTo.trim() !== '') {
      const key = replyTo.trim().replace(/^#/, '');
      const hit = this.knownMsgConv.get(key);
      if (hit) return { conv: hit };
    }
    return {};
  }

  /** 记下「这个会话、这条消息可以发图到什么时候」；顺手清掉过期项。 */
  private grantScreenshot(conv: Conv, msgId: string): void {
    if (!msgId) return;
    const now = Date.now();
    for (const [key, grant] of this.shotGrants) {
      if (grant.until <= now) this.shotGrants.delete(key);
    }
    this.shotGrants.set(this.convKey(conv), {
      until: now + SCREENSHOT_GRANT_MS,
      msgId,
    });
  }

  /**
   * 这一轮能不能发图：必须是当前 QQ 轮次、必须是授权所在的会话，
   * 而且授权要来自这一轮最后一条人话。桌宠轮次和只收到通知的轮次都不行。
   */
  private mayScreenshot(conv: Conv): boolean {
    if (!this.qqTurnActive()) return false;
    if (!this.turnConv) return false;
    const same =
      this.turnConv.umo && conv.umo
        ? this.turnConv.umo === conv.umo
        : this.turnConv.kind === conv.kind && this.turnConv.id === conv.id;
    if (!same) return false;
    if (!this.turnMsgId) return false;
    const grant = this.shotGrants.get(this.convKey(conv));
    return !!grant && grant.until > Date.now() && grant.msgId === this.turnMsgId;
  }

  private readTarget(args: Record<string, unknown>): { conv?: Conv; error?: string } {
    if (this.switching || this.turnMultiConv || this.turnExpired() || (this.queueBusy && !this.qqTurnActive())
      || (this.driver?.mode === 'safe' && (!this.qqTurnActive() || this.turnConv?.kind !== 'private'))) {
      return { error: '无法确认本轮的 QQ 读取授权。' };
    }
    return this.pickConv(args, { bound: this.qqTurnActive() ? this.turnConv : undefined });
  }

  private async authorizeRead(conv: Conv): Promise<boolean> {
    const driver = this.driver;
    if (!driver?.modeRevision) return true;
    if (!driver.connected || !conv.umo) return false;
    const turn = this.qqTurnActive() ? this.turnMsgId : '';
    const revision = driver.modeRevision;
    const actor = turn ? undefined : this.ownerActor(driver);
    if (!turn && !actor) return false;
    const reply = await driver.callTool('cortico_authorize_history', { umo: conv.umo }, turn, actor, turn ? conv.umo : undefined);
    return reply.ok && driver === this.driver && driver.modeRevision === revision && !this.switching
      && (!turn || (this.qqTurnActive() && this.turnMsgId === turn && this.turnConv?.umo === conv.umo));
  }

  private async externalRead(ctx: ToolCallContext, text: string, conv?: Conv, blobs: BlobInput[] = []) {
    if (!this.host || !ctx.queueExternalEvents || !this.driver?.modeRevision) {
      return blobs.length ? { text, blobs } : text;
    }
    const record = await this.host.pushEvent({
      source: this.id, origin: 'external', type: 'astrbot.read_result',
      ts: nowIso(this.opts.timezone), text, blobs, meta: conv ? { umo: conv.umo } : undefined,
    }, { deliver: false });
    ctx.queueExternalEvents([record]);
    return '已读取，内容见随本次调用返回的 QQ 外部资料。';
  }

  private historyTool(): ToolDef {
    return {
      ...ASTRBOT_TOOL_DECLS[2],
      handler: async (args, ctx) => {
        const host = this.host;
        if (!host) return { text: '这个 World 还没启动，读不到历史。', failed: true };

        const picked = this.readTarget(args);
        if (picked.error) {
          return { text: picked.error, failed: true };
        }
        const conv = picked.conv;
        if (!conv) {
          return { text: '没有当前 QQ 会话，请显式指定目标。', failed: true };
        }
        if (!await this.authorizeRead(conv)) return { text: '该 QQ 会话未获读取授权。', failed: true };

        const limit = clampInt(args.limit, 20, 1, 100);
        const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : '';
        const sender = typeof args.sender === 'string' ? args.sender.trim() : '';
        const context = clampInt(args.context, 2, 0, 10);

        const text = keyword
          ? renderSearch(host.store, conv, keyword, limit, context, sender || undefined)
          : renderLatest(host.store, conv, limit, sender || undefined);

        if (text) return this.externalRead(ctx, text, conv);
        const where = conv.kind === 'group' ? `群「${conv.name ?? conv.id}」` : '私聊';
        return `${where}里没有找到符合条件的消息。`;
      },
    };
  }

  private readComponentTool(): ToolDef {
    return {
      ...ASTRBOT_TOOL_DECLS[3],
      handler: async (args, ctx) => {
        const host = this.host;
        if (!host) return { text: 'QQ 消息库尚未就绪。', failed: true };
        const id = typeof args.message_id === 'string' ? args.message_id.trim().replace(/^#/, '') : '';
        const path = args.path;
        if (!id || !Array.isArray(path) || path.length < 1 || path.length > 6 ||
            path.some((index) => !Number.isInteger(index) || index < 1 || index > 120)) {
          return { text: '请提供消息号和有效的组件位置。', failed: true };
        }
        const { conv, error } = this.readTarget(args);
        if (!conv) return { text: error || '请指定这条消息所在的 QQ 会话。', failed: true };
        if (this.qqTurnActive() && (!this.turnConv || this.turnMultiConv ||
            (this.turnConv.umo && conv.umo ? this.turnConv.umo !== conv.umo :
              this.turnConv.kind !== conv.kind || this.turnConv.id !== conv.id))) {
          return { text: '只可查看当前 QQ 会话中的组件。', failed: true };
        }
        if (!await this.authorizeRead(conv)) return { text: '该 QQ 会话未获读取授权。', failed: true };
        const event = findMessage(host.store, conv, id);
        if (!event) return { text: '这个会话没有这条消息的记录。', failed: true };
        let parts = parseSegments(event.meta?.segments);
        if (!parts.length) return { text: '这条历史消息只有旧版正文。', failed: true };

        let part: MessageSegment | undefined;
        const offset = clampInt(args.offset, 0, 0, 120);
        for (const [depth, index] of path.entries()) {
          part = parts[index - 1];
          if (!part) return { text: '该位置没有可查看的组件。', failed: true };
          const wantsAudio = args.audio_file === true;
          if (needsBridge(part) || (wantsAudio && part.type === 'record' && depth === path.length - 1)) {
            const driver = this.driver;
            if (!driver?.connected) return { text: '桥未连接。', failed: true };
            const turn = this.qqTurnActive() ? this.turnMsgId : '';
            const revision = driver.modeRevision;
            const actor = turn ? undefined : this.ownerActor(driver);
            if (!turn && !actor) return { text: '读取组件需要明确授权。', failed: true };
            const request = { message_id: id, path, offset, ...(wantsAudio ? { audio_file: true } : {}), ...(revision ? { umo: conv.umo } : {}) };
            const result = await driver.callTool('cortico_read_message_component', request, turn, actor, turn ? conv.umo : undefined);
            const activeTurn = !turn || (this.qqTurnActive() && this.turnMsgId === turn && this.turnConv?.umo === conv.umo);
            if (!result.ok || driver !== this.driver || driver.modeRevision !== revision || ctx.signal?.aborted || this.switching || !activeTurn) {
              return { text: result.note || result.error || '读取授权已失效。', failed: true };
            }
            const blobs = componentBlobs(result);
            const text = (result.result ?? '') + (result.audio && !host.modelFacts.accepts(result.audio.mime)
              ? '\n原件已作为附件交给 Coo；当前模型无法直接听此格式，可用语音转写读取内容。' : '');
            return this.externalRead(ctx, text, conv, blobs);
          }
          parts = part.children ?? [];
        }
        if (!part) return { text: '该位置没有可查看的组件。', failed: true };
        const details = [describeSegment(part)];
        if (part.type === 'reply' && part.fields.id && !part.fields.text && parts.length === 0) {
          const original = findMessage(host.store, conv, part.fields.id);
          const body = original?.meta?.body;
          details.push(typeof body === 'string' && body ? `原消息：${body.slice(0, 3000)}` : '原消息未出现在已记录的会话中。');
        }
        if (parts.length) {
          const end = Math.min(offset + 8, parts.length);
          for (let i = offset; i < end; i++) {
            const child = parts[i]!;
            const ref = [...path, i + 1].join('.');
            details.push(`${ref} ${describeSegment(child).slice(0, 380)}`);
          }
          if (offset >= parts.length) details.push('已读到本次可获取内容的末尾。');
          if (end < parts.length) details.push(`下一页 offset=${end}`);
        }
        if (part.type === 'image' || part.type === 'reply') {
          const selected = part.type === 'image' ? [part] : parts.slice(offset, offset + 8);
          let images = selected.flatMap((item) => savedImage(item, event.blobs) ?? []);
          if (!images.length && offset === 0 && part.type === 'reply' && part.fields.id
              && part.fields.id !== id) {
            const original = findMessage(host.store, conv, part.fields.id);
            if (original && convOfEvent(original)?.umo === conv.umo) images = directSavedImages(original);
          }
          const handles = new Set(images.filter((blob) => host.blob(blob.handle)).map((blob) => blob.handle));
          if (handles.size) return this.externalRead(ctx, details.join('\n'), conv,
            [...handles].map((handle) => ({ handle, fallbackText: '[QQ 图片]' })));
          if (part.type === 'image' && imageAttachmentIndex(part) !== undefined) {
            details.push('图片附件未在当前历史中找到。');
          }
        }
        return this.externalRead(ctx, details.join('\n'), conv);
      },
    };
  }

  private statusTool(): ToolDef {
    return {
      ...ASTRBOT_TOOL_DECLS[1],
      handler: async () => {
        const cfg = this.opts.cfg;
        const lines: string[] = [];
        if (EXTENSION_VERSION) lines.push(`版本：${EXTENSION_VERSION}`);
        lines.push(`桥地址：${cfg.wsUrl && !bridgeAddressError(cfg.wsUrl.trim()) ? cfg.wsUrl : '（未配置或不可用）'}`);
        lines.push(`连接：${this.connected ? '已连上' : '未连上'}`);
        lines.push('渠道：QQ（经 AstrBot 桥）');

        const convName = (c: Conv): string =>
          c.kind === 'group' ? `QQ群「${c.name ?? c.id}」` : `QQ私聊「${c.name ?? c.id}」`;
        if (this.lastInbound) {
          const t = hhmm(this.lastInbound.ts);
          lines.push(`最近收到：${convName(this.lastInbound.conv)} ${this.lastInbound.sender}${t ? ` ${t}` : ''}`);
        } else {
          lines.push('最近收到：还没有 QQ 消息');
        }
        if (this.qqTurnActive()) {
          const where = this.turnConv ? convName(this.turnConv) : 'QQ';
          lines.push(`这一轮：${where}，回复用 astrbot_send_message。`);
        } else {
          lines.push(
            '这一轮：没有投递过 QQ 消息（可能是桌宠事件或 Coo 对话）。' +
              '这一轮不是 QQ；要主动发，用 conv_id/reply_to 指定已见过的会话，' +
              '且需在「连接」里填主人 QQ 并且该号是 AstrBot 管理员。',
          );
        }

        const tts = this.driver?.tts;
        if (!tts?.ready) {
          lines.push('语音：桥上次上报不可用（没开 TTS 或没有 provider）；实际能不能发以回执为准。');
        } else {
          lines.push(`语音：可用${tts.provider ? `（${tts.provider}）` : ''}；只在 QQ 轮次用 voice。`);
        }

        const selfName = this.driver?.self?.name;
        const selfId = this.driver?.self?.id;
        let identity = '（未收到）';
        if (selfName && selfId) identity = `${selfName} (${selfId})`;
        else if (selfName) identity = selfName;
        else if (selfId) identity = selfId;
        lines.push(`桥自报的身份：${identity}`);
        lines.push('消息范围：由 AstrBot 插件控制。');
        const owners = this.driver?.ownerIds ?? [];
        lines.push(`主人（AstrBot 管理员）：${owners.length ? owners.join('、') : '（未收到）'}`);
        lines.push(
          this.toolList.length
            ? `可用工具（${this.toolList.length}）：${this.toolList.map((t) => t.name).join('、')}`
            : '可用工具：桥那边一个都没启用',
        );
        if (this.convs.size === 0) {
          lines.push('见过的会话：无');
        } else {
          lines.push('见过的会话：');
          for (const c of this.convs.values()) {
            lines.push(`- ${c.kind === 'group' ? '群' : '私聊'}「${c.name ?? c.id}」id=${c.id}`);
          }
        }
        return lines.join('\n');
      },
    };
  }
}
