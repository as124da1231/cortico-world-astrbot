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
import type { EventEnvelope, RunPhase, ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import {
  ASTRBOT_CONFIG_GROUP,
  type AstrbotConfigSection,
} from './config.ts';
import {
  AstrbotBridgeDriver,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  type BridgeDriver,
  type BridgeMessage,
  type Conv,
  type OutgoingImage,
  type ToolActor,
  type ToolInfo,
} from './driver.ts';
import { convOfEvent, renderLatest, renderSearch } from './history.ts';
import { EXTENSION_VERSION } from './version.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 一条消息最多带多大的图（原始字节）；再大就拒绝，免得把桥和 QQ 撑爆。 */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

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

export interface AstrbotWorldOptions {
  /** `worlds.astrbot` 的活引用：热改的键现读即生效。 */
  cfg: AstrbotConfigSection;
  timezone: string;
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
      'must be answered with this tool. Do NOT use pet_say for QQ messages — pet_say only ' +
      'shows on the host computer screen, and nobody in the QQ group can see or hear it. ' +
      'Text, an image, or both. Set voice=true to speak a short text reply out loud ' +
      '(TTS; falls back to text if the bridge has no TTS). ' +
      'Only in a QQ turn: omit conv_id to reply in the conversation this turn came from. ' +
      'Without a QQ event in this turn it refuses, so wait for a QQ message instead of ' +
      'guessing. The bridge can only deliver to a conversation it has already seen, so ' +
      'an unknown conversation fails with a reason.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'Message text to send. Plain text only.' },
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
];

/** `astrbot_call_tool` 的静态声明；describe 与实例共用这一份。 */
export const CALL_TOOL_DECL: Omit<ToolDef, 'handler'> = {
  name: 'astrbot_call_tool',
  description:
    'Call one of the AstrBot tools enabled for this bridge, by name and with its own arguments. ' +
    'The list of available tools is in your environment prompt (astrbot.tools); if it looks stale, ' +
    'call astrbot_status. There are two identity paths: in a QQ turn the tool runs with the ' +
    'identity of the person whose message started this turn, so admin-only tools are refused ' +
    'when a group member is talking; in a Coo conversation turn (desktop pet or console) it runs ' +
    'as the owner QQ filled in the connection settings, but only when that number is in AstrBot ' +
    'admins—otherwise it is refused. When a tool fails or is refused, say so honestly and do not ' +
    'pretend it succeeded.',
  tags: ['write'],
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
  /** 同一批里既有 QQ 又有桌宠/其他渠道：QQ 出口关闭，宁可不发也不发错。 */
  private turnMixed = false;
  /** 同一批里出现多个 QQ 会话（比如私聊 + 群）：隐式发送会猜错，必须显式指定。 */
  private turnMultiConv = false;
  /** 最近见过的消息 id → 会话；reply_to 用它解析目标。 */
  private knownMsgConv = new Map<string, Conv>();
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

    const scope = '群范围、仅被叫/全部消息、称呼都由 AstrBot 插件控制。';

    const convList =
      this.convs.size === 0
        ? ''
        : [...this.convs.values()]
            .map((c) => `- ${c.kind === 'group' ? '群' : '私聊'} id=${c.id}`)
            .join('\n');

    const last = this.lastConv
      ? `${this.lastConv.kind === 'group' ? '群' : '私聊'} id=${this.lastConv.id}`
      : '';

    const owners = this.driver?.ownerIds ?? [];
    const owner = owners.length
      ? `QQ 上用这些号说话的是主人本人：${owners.join('、')}。他们说「我」就是指这台电脑的主人。`
      : '桥还没有报来管理员，暂时不知道 QQ 上哪个人是主人；先按普通聊天对象对待。';

    const tools = this.toolList.length
      ? this.toolList
          .map((t) => {
            const sig = t.sig ? `(${t.sig})` : '';
            const flag = t.risk === 'write' ? '（会改变状态）' : '';
            return `- ${t.name}${sig}${flag}：${t.desc ?? ''}`;
          })
          .join('\n')
      : '（连接时桥那边还没有启用任何工具。如果主人刚在 AstrBot 里开过，调 astrbot_status 看最新清单。）';

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
    return [this.sendMessageTool(), this.statusTool(), this.historyTool(), this.callToolDef()];
  }

  /** 「连接」面板的只读状态；只报 World 自己知道的事，不替 AstrBot 报策略。 */
  private connectionState(): Record<string, unknown> {
    const cfg = this.opts.cfg;
    return {
      enabled: cfg.enabled !== false,
      connected: this.connected,
      wsUrl: cfg.wsUrl,
      tokenSet: !!cfg.token,
      includeTime: cfg.includeTime !== false,
      channelHint: cfg.channelHint !== false,
      ownerId: String(cfg.ownerId ?? ''),
      admins: this.driver?.ownerIds ?? [],
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
      invoke: async (panel, method) => {
        if (panel !== 'connection' || method !== 'state') {
          throw new Error(`没有这个方法：${panel}.${method}`);
        }
        return this.connectionState();
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
    const cfg = this.opts.cfg;

    const driver =
      this.opts.driver ??
      new AstrbotBridgeDriver({
        wsUrl: cfg.wsUrl,
        token: cfg.token,
        // 告诉桥「我这边能不能读图」，桥据此决定原图要不要过来。
        capabilities: { images: this.acceptsImages(host) },
        reconnectBaseMs: cfg.reconnectBaseMs,
        reconnectMaxMs: cfg.reconnectMaxMs,
        handshakeTimeoutMs: this.opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
        log: host.log,
      });
    this.driver = driver;
    this.connected = driver.connected;

    driver.onState((connected) => {
      this.connected = connected;
      void this.pushState(connected);
    });
    driver.onMessage((msg) => {
      void this.onBridgeMessage(msg);
    });
    // 桥在握手后、以及配置变了都会重推这份清单。
    this.toolList = driver.tools;
    this.toolsSeen = false;
    driver.onTools((tools) => {
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
    this.connected = driver.connected;
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
    this.clearTurn();
    if (driver) await driver.stop();
  }

  /**
   * Core 在把这一批事件交给模型前回调。只认本 World 投递成功的 QQ 事件：
   * 这一轮有 QQ 消息，才允许用 QQ 出口。比「最近 N 秒来过 QQ 消息」准，
   * 因为桌宠轮次不会把上一轮的 QQ 消息误算进来。
   *
   * 判定只看「人话」（human）：纯 QQ 通知（撤回/入群/戳一戳）既不能建立轮次，
   * 也不能把上一轮打成 mixed。`others` 排除所有 `astrbot.*`，工具清单/桥通知
   * 不算桌宠/控制台渠道。
   */
  onEventsSettled(events: readonly EventEnvelope[], outcome: 'delivered' | 'discarded'): void {
    if (outcome !== 'delivered') return;

    const messages = events.filter((e) => {
      if (e.origin !== 'external') return false;
      if (e.type.endsWith('.self')) return false;
      const meta = e.meta as { kind?: string } | undefined;
      if (meta?.kind === 'activity') return false;
      return true;
    });
    if (messages.length === 0) return;

    const qq = messages.filter((e) => e.type === 'astrbot.message');
    const human = qq.filter((e) => {
      const meta = e.meta as { notice?: boolean } | undefined;
      return meta?.notice !== true;
    });
    // 桌宠/控制台等非 AstrBot 渠道；工具清单、桥通知等 astrbot.* 通知不算。
    const others = messages.filter(
      (e) => e.type !== 'astrbot.message' && !e.type.startsWith('astrbot.'),
    );

    if (qq.length === 0) {
      // 纯 astrbot.notice（工具清单、桥通知）：保留上一轮，不建立也不清空。
      if (others.length === 0) return;
      // 纯桌宠/控制台：QQ 出口立刻关掉。
      this.clearTurn();
      return;
    }
    if (human.length === 0) {
      // 纯 QQ 通知：不建立新轮次，也不改上一轮；和桌宠同批时才清空。
      if (others.length > 0) this.clearTurn();
      return;
    }

    this.turnMixed = others.length > 0;
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
        mixed: this.turnMixed,
      });
    }
  }

  /** 清掉 QQ 轮次的全部状态；stop / 轮次结束 / 纯桌宠批次都走这里。 */
  private clearTurn(): void {
    this.turnChannel = undefined;
    this.turnConv = undefined;
    this.turnMsgId = '';
    this.turnMixed = false;
    this.turnMultiConv = false;
    this.turnChannelAt = 0;
  }

  /** 一轮结束：下一轮如果只有桌宠事件，QQ 出口就该关上。 */
  onTurnEnded(): void {
    this.clearTurn();
  }

  /** 运行阶段回到 idle 时也清掉 QQ 轮次，避免桌宠/控制台复用上一轮 QQ 工具。 */
  onRunPhase(phase: RunPhase): void {
    if (phase.state !== 'idle') return;
    this.clearTurn();
  }

  /** 这一轮是不是 QQ 轮次；onTurnEnded 万一没来，短 TTL 后自动失效。 */
  private qqTurnActive(): boolean {
    if (this.turnMixed) return false;
    if (this.turnChannel !== 'qq') return false;
    return Date.now() - this.turnChannelAt < QQ_TURN_TTL_MS;
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

  /** 桥送来一条消息：按配置的范围决定要不要投递，投递时把事实写清楚。 */
  private async onBridgeMessage(msg: BridgeMessage): Promise<void> {
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
      this.knownMsgConv.set(String(msg.id), msg.conv);
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

    const body = msg.text.trim();
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
    // 桥只在「本端模型能读图」时才带原图；带了就作为附件投递，模型直接看。
    const blobs = (msg.images ?? []).map((img) => ({
      bytes: new Uint8Array(Buffer.from(img.base64, 'base64')),
      mime: img.mime,
      fallbackText: '[图片]',
    }));

    // 通知类没有「谁在说话」，只记一条事实；撤回时补上被撤回的原文。
    let noticeBody = body;
    if (isNotice && msg.ref) {
      const recalled = this.findMessageBody(host, msg.conv, msg.ref);
      if (recalled) noticeBody = `${body}（原文：${recalled}）`;
    }
    // 就在这条消息后面提醒一次：模型最容易在这里顺手用错身体。
    // 只给「需要回复」的（@、私聊、带图），避免每条群聊都加一行。
    const wantsReply = !isNotice && (isPrivate || called || (msg.images?.length ?? 0) > 0);
    const channelHint =
      wantsReply && this.opts.cfg.channelHint !== false
        ? '\n（回这条用 astrbot_send_message；pet_say 只在电脑上显示，群里看不到）'
        : '';
    const line = isNotice
      ? `${head}${noticeBody}`
      : `${head}${idPart}${senderName}${senderTag}：${body}${channelHint}`;

    await host
      .pushEvent(
        {
          type: 'astrbot.message',
          ts: msg.ts ?? nowIso(this.opts.timezone),
          source: this.id,
          origin: 'external',
          text: line,
          senderKey: msg.sender?.id ?? senderName,
          ...(blobs.length > 0 ? { blobs } : {}),
          meta: {
            channel: 'qq',
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
          },
        },
        // 主人私聊立即；群只认被叫到；其他私聊和群聊合批；通知只排队。
        isNotice
          ? { trigger: 'piggyback' }
          : isPrivate
            ? isOwner
              ? { trigger: 'flush' }
              : undefined
            : called
              ? { trigger: 'flush' }
              : undefined,
      )
      .catch((err: unknown) => {
        host.log.warn('消息事件投递失败', { error: String(err) });
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
      handler: async (raw) => {
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
        // mixed 或过期的 QQ 轮次直接拒绝，不借上一条 QQ 消息，也不回退 owner。
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
        } else if (this.turnMixed) {
          return {
            text: '这一轮同时有 QQ 和非 QQ 事件，不能借主人身份，工具没有执行。',
            failed: true,
          };
        } else if (this.turnExpired()) {
          return {
            text: '本轮 QQ 消息已过期，不能借主人身份，工具没有执行；等 QQ 那边有人说话再试。',
            failed: true,
          };
        } else {
          const ownerId = String(this.opts.cfg.ownerId ?? '').trim();
          if (!ownerId) {
            return {
              text:
                '这一轮不是 QQ 消息。要在 Coo 对话里用 AstrBot 工具，先在「连接」里填主人 QQ。',
              failed: true,
            };
          }
          const admins = driver.ownerIds;
          if (admins.length > 0 && !admins.includes(ownerId)) {
            return {
              text: `主人 QQ ${ownerId} 不在 AstrBot 的管理员名单里，工具没有执行。`,
              failed: true,
            };
          }
          actor = { kind: 'owner', id: ownerId };
        }
        const res = await driver.callTool(name, args, turn, actor);
        // 调用开始时还 active：工具耗时再长也不把它误判成过期（过期轮次不复活）。
        if (startedActive) this.turnChannelAt = Date.now();
        if (!res.ok) {
          return { text: `工具 ${name} 没有执行：${res.error ?? '未知原因'}`, failed: true };
        }
        return res.result && res.result.trim() !== ''
          ? res.result
          : `工具 ${name} 执行完了，没有返回文字。`;
      },
    };
  }

  private sendMessageTool(): ToolDef {
    return {
      ...ASTRBOT_TOOL_DECLS[0],
      handler: async (args) => {
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        const handle = typeof args.image === 'string' ? args.image.trim() : '';
        const voice = args.voice === true;
        if (!text && !handle) return { text: '没有正文也没有图片，未发送。', failed: true };
        if (voice && !text) return { text: '语音需要正文，未发送。', failed: true };
        if (voice && handle) return { text: '语音和图片不能是同一条消息，未发送。', failed: true };

        // 渠道硬校验：只有当前这一轮确实是 QQ 事件时，才允许用 QQ 出口。
        // 显式 conv_id 也不能绕过 World 边界；桌宠/控制台请用 pet_say 或直接回复。
        const qqTurn = this.qqTurnActive();
        if (!qqTurn) {
          const why = this.turnMixed
            ? '这一轮不是 QQ 消息独占：同时有 QQ 和非 QQ 事件，为避免发错，QQ 出口已关闭。'
            : this.turnExpired()
              ? '本轮 QQ 消息已过期，QQ 出口已关闭；等 QQ 那边有人说话再回。'
              : '这一轮不是 QQ 消息；astrbot_send_message 只用于当前 QQ 事件，' +
                '桌宠/控制台聊天请用 pet_say 或直接回复。';
          this.host?.log.warn('QQ 出口被拒：这一轮不是 QQ 事件', {
            mixed: this.turnMixed,
            expired: this.turnExpired(),
          });
          return { text: why, failed: true };
        }

        const driver = this.driver;
        if (!driver || !driver.connected) {
          return { text: '与 AstrBot 桥的连接未建立，消息没有发出。', failed: true };
        }

        // 发送必须是桥见过的会话：没有 UMO 的显式目标先拒绝，别让桥回误导性的 missing_umo。
        const picked = this.pickConv(args, { requireUmo: true });
        if (picked.error) {
          this.host?.log.warn('QQ 出口被拒：会话参数不合法或桥没见过该会话', { error: picked.error });
          return { text: picked.error, failed: true };
        }
        const conv = picked.conv;
        if (!conv) {
          return {
            text: this.turnMultiConv
              ? '这一轮有多个 QQ 会话（私聊和群）。请用 conv_id 或 reply_to 指定回哪个，不要猜。'
              : '还不知道发到哪个会话：没有指定 conv_id，也还没有收到过消息。',
            failed: true,
          };
        }

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
        const result = await driver.send(conv, text, replyTo, image, voice);
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
        return { text: `${what}${where}。${note}` };
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
    opts: { allowLast?: boolean; requireUmo?: boolean } = {},
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
      const fallbackKind = this.turnConv?.kind ?? this.lastConv?.kind ?? 'group';
      const kind =
        kindArg === 'private' ? 'private' : kindArg === 'group' ? 'group' : fallbackKind;
      // 桥已改成单通道：显式目标必须能补上 UMO，否则这一帧会被拒。
      const known = [...this.convs.values()].find(
        (c) => c.kind === kind && c.id === id && !!c.umo,
      );
      if (known) return { conv: { ...known, kind, id } };
      // 发送要求桥真的见过这个会话；历史和已知但没 UMO 的 id 仍按 kind:id 查询。
      if (opts.requireUmo) {
        return { error: '桥还没见过这个会话（没有 UMO），先让这个会话发一条消息' };
      }
      return { conv: { kind, id } };
    }

    const replyTo = args.reply_to;
    if (typeof replyTo === 'string' && replyTo.trim() !== '') {
      const key = replyTo.trim().replace(/^#/, '');
      const hit = this.knownMsgConv.get(key);
      if (hit) return { conv: hit };
    }
    // 同一批里既有私聊又有群：隐式目标会猜错，发送必须显式指定。
    if (this.turnMultiConv && !opts.allowLast) return {};
    // 这一轮有 QQ 消息就以这一轮的会话为准；没有就拒绝，不回退 lastConv。
    if (this.qqTurnActive() && this.turnConv) return { conv: this.turnConv };
    const last = opts.allowLast ? this.lastConv : undefined;
    return last ? { conv: last } : {};
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

  private historyTool(): ToolDef {
    return {
      ...ASTRBOT_TOOL_DECLS[2],
      handler: async (args) => {
        const host = this.host;
        if (!host) return { text: '这个 World 还没启动，读不到历史。', failed: true };

        const picked = this.pickConv(args, { allowLast: true });
        if (picked.error) {
          return { text: picked.error, failed: true };
        }
        const conv = picked.conv;
        if (!conv) {
          return { text: '还不知道查哪个会话：没有指定 conv_id，也还没有收到过消息。', failed: true };
        }

        const limit = clampInt(args.limit, 20, 1, 100);
        const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : '';
        const sender = typeof args.sender === 'string' ? args.sender.trim() : '';
        const context = clampInt(args.context, 2, 0, 10);

        const text = keyword
          ? renderSearch(host.store, conv, keyword, limit, context, sender || undefined)
          : renderLatest(host.store, conv, limit, sender || undefined);

        if (text) return text;
        const where = conv.kind === 'group' ? `群「${conv.name ?? conv.id}」` : '私聊';
        return `${where}里没有找到符合条件的消息。`;
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
        lines.push(`桥地址：${cfg.wsUrl || '（未配置）'}`);
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
              '不要用 astrbot_send_message 兜底；要发 QQ 先等 QQ 那边有人说话。',
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
