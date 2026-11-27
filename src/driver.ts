/**
 * AstrbotBridgeDriver —— 薄连接层。
 *
 * 本 World 作 WS **客户端**连 AstrBot 侧的桥。选这个方向是因为服务器有公网地址、
 * 本机没有：让能被动接受连接的一方当服务端，就不必在内网穿透上再搭一层。
 *
 * 这一层不做语义判断：收到什么形状就交给 World，发送失败一律返回结果对象而不抛。
 * 断线按指数退避重连，重连期间 stop() 能干净退出。
 */
import WebSocket from 'ws';
import type { Logger } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { parseSegments, type MessageSegment } from './message-segments.ts';
import { bridgeAddressError, bridgeCredentialError } from './config.ts';

/** 会话种类：群聊或私聊。 */
export type ConvKind = 'group' | 'private';

/** 会话标识；id 用字符串，群号/QQ 号由桥给什么就存什么。 */
export interface Conv {
  /**
   * AstrBot 的统一会话键 `platform:MessageType:session_id`。
   * 新桥必带；旧帧缺失时退回 kind:id。
   */
  umo?: string;
  kind: ConvKind;
  id: string;
  channel?: BridgeChannel;
  /** 群名或对方昵称，仅用于展示。 */
  name?: string;
}

export type BridgeChannel = string;

export interface PlatformRoute {
  id: string;
  channel: string;
  adapterType?: string;
  name?: string;
  enabled: boolean;
  ownerBound: boolean;
  mode?: BridgeMode;
  astrbotEnabled?: boolean;
  replyTextOnly?: boolean;
  replySupported?: boolean;
}

function readPlatformRoutes(raw: unknown): PlatformRoute[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((entry): entry is PlatformRoute =>
    entry && typeof entry.id === 'string' && typeof entry.channel === 'string' && entry.channel.length > 0 &&
    (entry.adapterType === undefined || typeof entry.adapterType === 'string') &&
    (entry.name === undefined || typeof entry.name === 'string') &&
    (entry.mode === undefined || entry.mode === 'safe' || entry.mode === 'full') &&
    (entry.astrbotEnabled === undefined || typeof entry.astrbotEnabled === 'boolean') &&
    (entry.replyTextOnly === undefined || typeof entry.replyTextOnly === 'boolean') &&
    (entry.replySupported === undefined || typeof entry.replySupported === 'boolean') &&
    typeof entry.enabled === 'boolean' && typeof entry.ownerBound === 'boolean');
}

/** 桥推进来的一条消息。字段保持扁平，语义由 World 解释。 */
export interface BridgeMessage {
  /** 桥侧的消息唯一标识，用于引用回复与去重。 */
  id: string;
  /** AstrBot 的统一会话键；新帧必带，旧帧缺失时由 conv 推导。 */
  umo?: string;
  /**
   * 帧里带了 UMO 但解析失败；这条消息已按 `conv` 处理，不丢弃。
   * 主要为了别把撤回/入群通知一起吞掉（契约允许 unknown，按 conv 记账）。
   */
  umoInvalid?: boolean;
  /** 收帧 UMO 与 conv 不一致；以 UMO 为准，但上层记录警告。 */
  convMismatch?: boolean;
  /** ISO 8601；缺失时由 World 补当前时间。 */
  ts?: string;
  channel?: BridgeChannel;
  conv: Conv;
  sender?: { id?: string; name?: string };
  text: string;
  segments?: MessageSegment[];
  /** The bridge is using native images and permits same-conversation archive fallback. */
  quoteImageHistory?: boolean;
  /** 这条消息是否点了名（@ 或叫到称呼）。由桥判断并如实告知。 */
  mentioned?: boolean;
  /** 桥允许这条消息的发送者要截图；没有这个字段一律当作不允许。 */
  canScreenshot?: boolean;
  /** 说话人在 AstrBot 那边是不是管理员（工具权限，不等于主人）。 */
  role?: 'admin' | 'member';
  /** 说话人是不是主人。缺省时退回「管理员即主人」的旧行为。 */
  owner?: boolean;
  /** 随消息一起来的图片；只有本端自报能读图时桥才会带。 */
  images?: Array<{ mime: string; base64: string }>;
  /** 没取到的图片及原因，按消息里的出现顺序。
   *  正文里对应位置已经写成 `[图片|没取到: 原因]`，这里给结构化副本。 */
  imageErrors?: Array<{ index: number; reason: string }>;
  /** 通知类（撤回/入群/戳一戳），不是人说的话，只当上下文。 */
  notice?: boolean;
  /** 撤回通知指向的消息号。 */
  ref?: string;
}

/** 桥的状态通知，例如 QQ 侧掉线、桥重启。 */
export interface BridgeNotice {
  /** 稳定的通知种类，可缺省。 */
  kind?: string;
  text: string;
  ts?: string;
}

export interface SendResult {
  ok: boolean;
  /** ok 为 false 时的原因，可直接进工具回执。 */
  error?: string;
  /** 失败时消息是否可能已经发出；true 表示「结果未知」，不要直接重试。 */
  uncertain?: boolean;
  /** 桥是否真的把这条发成了语音（TTS 失败时会退回文字）。 */
  voice?: boolean;
  /**
   * 需要向人说明的补充信息。成功时例如「TTS 没开，已改发文字」；
   * 失败时是中文说明（`error` 是稳定 code，`note` 才是给人看的原因）。
   */
  note?: string;
}

/** 桥自报的语音能力。 */
export interface BridgeTtsInfo {
  /** 桥那边能不能合成语音。 */
  ready: boolean;
  /** 实际会用的 provider id；空表示桥没报。 */
  provider?: string;
}

/** 桥那边启用的一个 AstrBot 工具。 */
export interface ToolInfo {
  name: string;
  /** 风险分级，给人和模型看的提示：read / write / exec。 */
  risk?: string;
  /** 一句话说明。 */
  desc?: string;
  /** 参数签名，例如 `song_name, limit?`；没有参数时为空。 */
  sig?: string;
}

/** 一次工具调用的身份：QQ 轮次用 turn，Coo 轮次用主人。 */
export interface ToolActor {
  kind: 'desktop';
}

/** 一次工具调用的回执。 */
export interface ToolResult {
  ok: boolean;
  /** ok 为 true 时的结果文本。 */
  result?: string;
  images?: OutgoingImage[];
  audio?: { mime: string; base64: string; name: string };
  /** ok 为 false 时的原因（稳定错误码，例如 tool_failed）。 */
  error?: string;
  /**
   * 需要向人说明的补充信息（T-004）。失败时是中文说明，`error` 才是稳定 code；
   * 成功时桥也可能带一句话说明。
   */
  note?: string;
}

/** 随消息一起发出的图片。桥按 base64 转给 AstrBot 的消息链。 */
export interface OutgoingImage {
  mime: string;
  /** 不带 data: 前缀的 base64。 */
  base64: string;
}

/**
 * World 依赖的连接层形状。抽成接口是为了让测试塞假驱动进来，
 * 不必为了测 World 的投递逻辑去开真的 WebSocket。
 */
export type BridgeMode = 'full' | 'safe';

export interface BridgeDriver {
  readonly connected: boolean;
  readonly mode?: BridgeMode;
  readonly modeRevision?: string;
  changeMode?(mode: BridgeMode): Promise<void>;
  readonly self?: { id?: string; name?: string };
  /** 桥报来的管理员 QQ 号；空数组表示还没收到。 */
  readonly ownerIds: string[];
  readonly ownerTools?: boolean;
  readonly desktopSend?: boolean;
  readonly ownerBound?: boolean;
  readonly platformRoutes?: PlatformRoute[];
  readonly instancePolicies?: boolean;
  readonly modeApprovalPending?: boolean;
  readonly connectionError?: string;
  /** 桥自报的语音能力；没收到时按不可用。 */
  readonly tts: BridgeTtsInfo;
  /** 桥那边启用的工具清单；桥没连上时是上一次收到的。 */
  readonly tools: ToolInfo[];
  onMessage(cb: (m: BridgeMessage) => void | false): void;
  onNotice(cb: (n: BridgeNotice) => void): void;
  onState(cb: (connected: boolean) => void): void;
  /** 桥握手时自报记得的会话（含重启前恢复的），用于主动发送。 */
  onReady?(cb: (convs: Conv[]) => void): void;
  /** 工具清单变了（握手后下发，或管理页保存后重推）。 */
  onTools(cb: (tools: ToolInfo[]) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(conv: Conv, text: string, replyTo?: string, image?: OutgoingImage, voice?: boolean, at?: readonly string[],
    authority?: { turn: string; actor?: ToolActor }): Promise<SendResult>;
  /** 调一个桥那边启用的工具；turn 是触发这一轮的消息 id。 */
  callTool(
    name: string,
    args: Record<string, unknown>,
    turn: string,
    actor?: ToolActor,
    umo?: string,
  ): Promise<ToolResult>;
}

export interface BridgeDriverOptions {
  wsUrl: string;
  token?: string;
  /** 握手时自报的能力；桥据此决定要不要把图片传过来。 */
  capabilities?: Record<string, boolean>;
  requireModeSync?: boolean;
  /** 返回 false 时，让服务端等下一次 World 挂载后再确认这一代模式。 */
  acceptMode?: (mode: BridgeMode) => boolean;
  /** 重连等待起点。 */
  reconnectBaseMs?: number;
  /** 重连等待封顶。 */
  reconnectMaxMs?: number;
  /** 一次发送等确认的超时。 */
  sendTimeoutMs?: number;
  /** WebSocket 握手（HTTP Upgrade）的超时；0 表示不设。 */
  handshakeTimeoutMs?: number;
  /** 一次工具调用等回执的超时。 */
  toolTimeoutMs?: number;
  /** 心跳间隔；0 表示不做活性检测。 */
  heartbeatMs?: number;
  /** 超过这么久没有任何往来就重建连接（休眠唤醒后的死连接靠它发现）。 */
  idleTimeoutMs?: number;
  log?: Logger;
}

interface PendingSend {
  resolve: (r: SendResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 发送确认的默认超时。要覆盖桥侧的排队 + TTS + 平台发送。 */
export const DEFAULT_SEND_TIMEOUT_MS = 30_000;

/** 带图发送额外等待：图片要经桥转给 QQ，慢网下会久一点。 */
export const IMAGE_SEND_EXTRA_MS = 20_000;

/** 语音发送额外等待：桥侧 TTS 最多等 30 秒，再加平台发送。 */
export const VOICE_SEND_EXTRA_MS = 40_000;

/** WebSocket 握手默认超时；对端只接受 TCP、不回 Upgrade 时靠它收尾。 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/** 握手超时之外再留一点余量，防止底层没发 close。 */
const HANDSHAKE_GUARD_EXTRA_MS = 2_000;

/** 工具回执的默认超时：有些工具本身会查网、生成图片，给宽一点。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 90_000;

/** 心跳间隔：主动 ping 一次，顺便刷新活跃时间。 */
export const DEFAULT_HEARTBEAT_MS = 20_000;

/** 多久没有任何往来就认定连接已死。桥每 20 秒 ping 一次，留六倍余量；
 *  120 秒而不是 60 秒：群安静、机器休眠回来时，60 秒会误判成断线。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/** 桥在握手阶段拒绝客户端时用的 close code 与可读原因；重连仍会继续。 */
const CLOSE_REASONS: Record<number, string> = {
  4001: '握手超时',
  4002: '第一帧不是 hello',
  4003: 'token 不匹配（检查两边配置）',
  4004: '协议版本不匹配（升级 World 或插件）',
  4401: 'URL 里带了 token（凭据不能进 URL）',
  4403: '浏览器来源被拒（桥没有网页客户端）',
};

/**
 * 这些 close code 说明“配置不对”，不改配置永远连不上（token/版本/来源）。
 * 退避只在收到 ready 后才重置，这里再抬一个下限，避免每 1 秒重连刷日志。
 */
export const AUTH_REJECT_MIN_BACKOFF_MS = 10_000;

const AUTH_REJECT_CODES: ReadonlySet<number> = new Set([4002, 4003, 4004, 4401, 4403]);

export class AstrbotBridgeDriver implements BridgeDriver {
  private readonly opts: BridgeDriverOptions;
  private readonly log: Logger;
  private ws?: WebSocket;
  private stopped = true;
  private backoffMs: number;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastActivity = 0;
  private ridSeq = 0;
  private pending = new Map<string, PendingSend>();
  private messageCbs: Array<(m: BridgeMessage) => void | false> = [];
  private noticeCbs: Array<(n: BridgeNotice) => void> = [];
  private stateCbs: Array<(connected: boolean) => void> = [];
  private toolsCbs: Array<(tools: ToolInfo[]) => void> = [];
  private readyCbs: Array<(convs: Conv[]) => void> = [];
  /** 工具调用等确认，超时按失败回执。 */
  private pendingTools = new Map<
    string,
    { resolve: (r: ToolResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  /** 桥那边启用的工具。 */
  tools: ToolInfo[] = [];

  /** 最近一次 ready 帧里桥自报的身份。 */
  self?: { id?: string; name?: string };
  /** 桥报来的管理员 QQ 号：QQ 上这些人是主人本人。 */
  ownerIds: string[] = [];
  ownerTools = false;
  desktopSend = false;
  ownerBound = false;
  platformRoutes?: PlatformRoute[];
  instancePolicies = false;
  modeApprovalPending = false;
  private modeOffer?: { mode: BridgeMode; revision: string };
  connectionError?: string;
  /** 桥自报的语音能力；没收到时按不可用。 */
  tts: BridgeTtsInfo = { ready: false };

  connected = false;
  mode?: BridgeMode;
  modeRevision?: string;
  private pendingMode?: { rid: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

  constructor(opts: BridgeDriverOptions) {
    this.opts = opts;
    this.log = opts.log ?? nullLogger();
    this.backoffMs = opts.reconnectBaseMs ?? 1000;
  }

  changeMode(mode: BridgeMode): Promise<void> {
    const ws = this.ws;
    const modeRevision = this.modeRevision;
    if (!ws || ws.readyState !== WebSocket.OPEN || !modeRevision || this.pendingMode) {
      return Promise.reject(new Error('桥尚未同步或正在切换'));
    }
    const rid = `mode-${++this.ridSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.completeMode(rid, '未收到双端确认，正在重新连接');
        ws.close();
      }, 8000);
      this.pendingMode = { rid, resolve, reject, timer };
      try {
        ws.send(JSON.stringify({ t: 'mode-change', rid, mode, modeRevision }));
      } catch {
        this.completeMode(rid, '无法发送模式切换请求');
      }
    });
  }

  private completeMode(rid: string, error?: string): void {
    const pending = this.pendingMode;
    if (!pending || pending.rid !== rid) return;
    this.pendingMode = undefined;
    clearTimeout(pending.timer);
    if (error) pending.reject(new Error(error)); else pending.resolve();
  }

  onMessage(cb: (m: BridgeMessage) => void | false): void {
    this.messageCbs.push(cb);
  }

  onNotice(cb: (n: BridgeNotice) => void): void {
    this.noticeCbs.push(cb);
  }

  onState(cb: (connected: boolean) => void): void {
    this.stateCbs.push(cb);
  }

  onTools(cb: (tools: ToolInfo[]) => void): void {
    this.toolsCbs.push(cb);
  }

  onReady(cb: (convs: Conv[]) => void): void {
    this.readyCbs.push(cb);
  }

  /** 调一个桥那边启用的工具。未连接、超时或被拒都返回 ok:false。 */
  callTool(
    name: string,
    args: Record<string, unknown>,
    turn: string,
    actor?: ToolActor,
    umo?: string,
  ): Promise<ToolResult> {
    return new Promise((resolve) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, error: '与 AstrBot 桥的连接未建立' });
        return;
      }
      if (!turn && !actor) {
        resolve({ ok: false, error: '不知道这一轮是谁说的，不能调工具' });
        return;
      }
      const rid = `t-${++this.ridSeq}`;
      const timeout = this.opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pendingTools.delete(rid);
        resolve({ ok: false, error: `工具 ${name} 在 ${timeout}ms 内没有回执` });
      }, timeout);
      this.pendingTools.set(rid, { resolve, timer });
      try {
        ws.send(JSON.stringify({ t: 'tool', rid, name, args, turn, umo,
          modeRevision: this.modeRevision, ...(actor ? { actor } : {}) }));
      } catch (err) {
        clearTimeout(timer);
        this.pendingTools.delete(rid);
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  /**
   * 开始连接。首次尝试结束（连上或失败）后 resolve；
   * 失败时后台继续按退避重连，**不 reject** —— 装配层不该因为桥没开而挂掉。
   */
  start(): Promise<void> {
    if (!this.opts.wsUrl) {
      this.log.info('未配置桥地址，保持未连接');
      return Promise.resolve();
    }
    this.stopped = false;
    this.backoffMs = this.opts.reconnectBaseMs ?? 1000;
    // 上一次的退避还挂着时重新 start，必须先把定时器撤掉：
    // 否则这次手动连接和定时器各建一条 socket，桥那边会看到两次握手。
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    return new Promise((resolve) => {
      this.connectAttempt(resolve);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.rejectAllPending('驱动已停止', true);
    const ws = this.ws;
    this.ws = undefined;
    const was = this.connected;
    this.connected = false;
    if (ws) ws.terminate();
    if (was) this.emitState(false);
  }

  /**
   * 发一条消息给指定会话。未连接、超时或被桥拒绝都返回 { ok:false }，
   * 由 World 把它写成失败回执，不抛错。
   */
  send(conv: Conv, text: string, replyTo?: string, image?: OutgoingImage, voice?: boolean, at?: readonly string[],
    authority?: { turn: string; actor?: ToolActor }): Promise<SendResult> {
    if (conv.umo) {
      const parsed = parseUmo(conv.umo);
      if (!parsed) return Promise.resolve({ ok: false, error: 'invalid_umo' });
      if (parsed.kind !== conv.kind || parsed.id !== conv.id) {
        return Promise.resolve({ ok: false, error: 'umo_conv_mismatch' });
      }
    }
    return new Promise((resolve) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, error: '与 AstrBot 桥的连接未建立' });
        return;
      }
      const rid = `a-${++this.ridSeq}`;
      // 带图/语音的帧更大、更慢，给桥多一点时间。
      const timeout =
        (this.opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS) +
        (image ? IMAGE_SEND_EXTRA_MS : 0) +
        (voice ? VOICE_SEND_EXTRA_MS : 0);
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        resolve({
          ok: false,
          uncertain: true,
          error: `桥没有在 ${timeout}ms 内确认，消息可能已经发出`,
        });
      }, timeout);
      this.pending.set(rid, { resolve, timer });
      const frame: Record<string, unknown> = {
        t: 'send',
        rid,
        // UMO 是主键；conv 只为旧桥/展示保留。
        ...(conv.umo ? { umo: conv.umo } : {}),
        conv: { kind: conv.kind, id: conv.id },
        text,
        modeRevision: this.modeRevision,
        ...authority,
      };
      if (replyTo) frame.replyTo = replyTo;
      if (at && at.length > 0) frame.at = [...at];
      if (image) frame.image = { mime: image.mime, base64: image.base64 };
      if (voice) frame.voice = true;
      try {
        ws.send(JSON.stringify(frame));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(rid);
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  private connectAttempt(onSettled?: () => void): void {
    if (this.stopped) {
      onSettled?.();
      return;
    }
    let settled = false;
    let guard: ReturnType<typeof setTimeout> | undefined;
    const settle = (): void => {
      if (!settled) {
        settled = true;
        if (guard) clearTimeout(guard);
        onSettled?.();
      }
    };

    const address = this.opts.wsUrl.trim();
    const token = this.opts.token?.trim() ?? '';
    const validationError = bridgeAddressError(address) ?? bridgeCredentialError(address, token);
    if (validationError) {
      this.connectionError = validationError;
      this.log.warn('无法连接 AstrBot 桥', { reason: validationError });
      settle();
      return;
    }
    const handshakeMs = this.opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.ownerTools = false;
    this.desktopSend = false;
    this.ownerBound = false;
    this.platformRoutes = undefined;
    this.instancePolicies = false;
    this.modeOffer = undefined;
    let ws: WebSocket;
    try {
      ws = new WebSocket(address, {
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        rejectUnauthorized: true,
        // 对端只接受 TCP、不回 101 时，ws 自己不会超时；这里必须给。
        ...(handshakeMs > 0 ? { handshakeTimeout: handshakeMs } : {}),
      });
    } catch (err) {
      this.log.warn('桥地址无法解析');
      settle();
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    if (handshakeMs > 0) {
      guard = setTimeout(() => {
        if (this.stopped || this.ws !== ws || settled) return;
        this.log.warn('桥连接在握手超时内没有完成，重建连接', {
          timeoutMs: handshakeMs + HANDSHAKE_GUARD_EXTRA_MS,
        });
        try {
          ws.terminate();
        } catch {
          // 已经断了就算了；close 会接手重连。
        }
        settle();
      }, handshakeMs + HANDSHAKE_GUARD_EXTRA_MS);
    }

    ws.on('open', () => {
      if (this.stopped || this.ws !== ws) {
        ws.terminate();
        settle();
        return;
      }
      this.connected = !this.opts.requireModeSync;
      // 退避不在这里重置：open 只说明 TCP/Upgrade 成功，token/版本错的连接
      // 也是 open 之后才被桥用 4003/4004 拒绝。重置放在收到首个 ready 时。
      this.log.info('已连上 AstrBot 桥');
      try {
        // 凭据仅通过 Upgrade 请求头发送。
        ws.send(
          JSON.stringify({
            t: 'hello',
            v: 3,
            name: 'Cortico',
            capabilities: this.opts.capabilities ?? {},
          }),
        );
      } catch (err) {
        this.log.warn('握手帧发送失败', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!this.opts.requireModeSync) this.emitState(true);
      this.startHeartbeat(ws);
      if (!this.opts.requireModeSync) settle();
    });

    ws.on('message', (data) => {
      if (!this.stopped && this.ws === ws) {
        this.lastActivity = Date.now();
        this.handleFrame(String(data));
        if (this.connected) settle();
      }
    });

    // 桥每 20 秒 ping 一次；收到任何一帧都算「还活着」。
    ws.on('ping', () => {
      if (this.ws === ws) this.lastActivity = Date.now();
    });

    ws.on('pong', () => {
      if (this.ws === ws) this.lastActivity = Date.now();
    });

    ws.on('error', (err) => {
      // 旧 socket 在关闭前还会补一条 error；那不是现在的连接状态，别记成新错误。
      if (this.stopped || this.ws !== ws) return;
      const code = (err as NodeJS.ErrnoException).code ?? '';
      const tlsFailure = /^(?:ERR_(?:TLS|SSL)_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_(?:VERIFY|GET_ISSUER))/.test(code);
      this.connectionError = tlsFailure
        ? 'WSS 校验或握手失败，请检查证书、地址和 TLS 代理。'
        : '无法连接 AstrBot 桥，请检查桥是否启动以及地址是否可达。';
      this.log.warn('桥连接错误', { code });
    });

    ws.on('close', (code) => {
      const isCurrent = this.ws === ws;
      const wasConnected = this.connected;
      if (isCurrent) {
        this.stopHeartbeat();
        this.ws = undefined;
        this.connected = false;
        this.rejectAllPending('与桥的连接已断开', true);
        if (wasConnected) this.log.info('与 AstrBot 桥的连接已断开');
      }
      if (isCurrent && !this.stopped) {
        const hint = CLOSE_REASONS[code];
        if (hint) {
          this.connectionError = hint;
          this.log.warn('桥拒绝了这次连接', {
            code,
            hint,
          });
        }
      }
      settle();
      if (isCurrent && !this.stopped) {
        if (wasConnected) this.emitState(false);
        if (AUTH_REJECT_CODES.has(code)) {
          // 配置错时按 10s 起步，别回到 1s 风暴；下次 ready 再恢复初始值。
          this.backoffMs = Math.max(this.backoffMs, AUTH_REJECT_MIN_BACKOFF_MS);
        }
        this.scheduleReconnect();
      }
    });
  }

  /**
   * 连接死掉时 socket 不一定给我们 close：机器休眠、网络切换、对端进程消失都可能留下
   * 一条「开着但永远没有下文」的连接。定期 ping，超过 idleTimeoutMs 没有任何往来就主动
   * terminate，让 close 走正常重连。
   */
  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    const every = this.opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if (every <= 0) return;
    const idleLimit = this.opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.lastActivity = Date.now();
    this.heartbeat = setInterval(() => {
      if (this.ws !== ws) return;
      const idle = Date.now() - this.lastActivity;
      if (idle > idleLimit) {
        this.log.warn('桥连接长时间没有任何动静，重建连接', {
          idleMs: idle,
          idleLimitMs: idleLimit,
        });
        ws.terminate();
        return;
      }
      try {
        ws.ping();
      } catch {
        // 发不出去就等 close 接手，这里不再多记一条。
      }
    }, every);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    const cap = this.opts.reconnectMaxMs ?? 30_000;
    const delay = Math.min(this.backoffMs, cap);
    this.backoffMs = Math.min(this.backoffMs * 2, cap);
    this.log.debug(`${delay}ms 后重连桥`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) this.connectAttempt();
    }, delay);
  }

  private handleFrame(raw: string): void {
    // 一帧坏数据不能把整个 Coo 带下去：事件回调里抛错会升级成
    // uncaughtException，宿主通常会直接关机。
    try {
      this.handleFrameUnsafe(raw);
    } catch (err) {
      this.log.error('处理桥帧失败，已忽略', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleFrameUnsafe(raw: string): void {
    const frame = parseFrame(raw);
    if (!frame) {
      this.log.warn('收到无法解析的帧，已忽略');
      return;
    }

    const t = typeof frame.t === 'string' ? frame.t : '';

    if (t === 'mode-status') {
      if (frame.mode !== 'full' && frame.mode !== 'safe' || typeof frame.modeRevision !== 'string') return;
      if (this.opts.requireModeSync && (this.modeOffer?.mode !== frame.mode || this.modeOffer.revision !== frame.modeRevision)) return;
      this.mode = frame.mode;
      this.modeRevision = frame.modeRevision;
      this.modeApprovalPending = frame.pending === true;
      const active = frame.active === true;
      if (this.connected !== active) {
        this.connected = active;
        this.emitState(active);
      }
      this.completeMode(String(frame.rid ?? ''), frame.active === true ? undefined : 'Coo 未能接受该模式');
      return;
    }

    if (t === 'mode-prepare') {
      const rid = String(frame.rid ?? '');
      if (rid !== this.pendingMode?.rid) return;
      if (typeof frame.error === 'string' && frame.error) this.completeMode(rid, frame.error);
      else if (frame.pending === true) {
        this.modeApprovalPending = true;
        this.completeMode(rid);
      }
      else if ((frame.mode === 'full' || frame.mode === 'safe') && typeof frame.modeRevision === 'string') {
        if (!this.acceptModeOffer(frame.mode, frame.modeRevision, rid)) this.completeMode(rid);
      }
      return;
    }

    // 旧桥的心跳只刷新活跃时间。新版心跳还同步 AstrBot 的实例列表。
    if (t === 'tick') {
      if (typeof frame.modeApprovalPending === 'boolean') this.modeApprovalPending = frame.modeApprovalPending;
      if (Array.isArray(frame.platformRoutes)) this.platformRoutes = readPlatformRoutes(frame.platformRoutes);
      return;
    }

    if (t === 'ack') {
      const rid = String(frame.rid ?? '');
      const call = this.pending.get(rid);
      if (!call) return;
      this.pending.delete(rid);
      clearTimeout(call.timer);
      const ok = frame.ok === true;
      call.resolve(
        ok
          ? {
              ok: true,
              voice: frame.voice === true,
              note: typeof frame.note === 'string' ? frame.note : undefined,
            }
          : {
              ok: false,
              error: String(frame.error ?? '桥拒绝发送'),
              uncertain: frame.uncertain === true,
              // 失败时桥把中文说明放 note，code 在 error；透传给 World 拼回执。
              note: typeof frame.note === 'string' && frame.note ? frame.note : undefined,
            },
      );
      return;
    }

    if (t === 'tool-ack') {
      const rid = String(frame.rid ?? '');
      const call = this.pendingTools.get(rid);
      if (!call) return;
      this.pendingTools.delete(rid);
      clearTimeout(call.timer);
      const ok = frame.ok === true;
      const images = ok ? parseImages(frame.images) : undefined;
      const audio = ok ? parseAudio(frame.audio) : undefined;
      call.resolve(
        ok
          ? { ok: true, result: String(frame.result ?? ''), ...(images ? { images } : {}), ...(audio ? { audio } : {}) }
          : {
              ok: false,
              error: String(frame.error ?? '桥拒绝了这次工具调用'),
              // 失败时桥把中文说明放 note、code 在 error；原样带上，World 负责拼回执。
              note: typeof frame.note === 'string' && frame.note ? frame.note : undefined,
            },
      );
      return;
    }

    if (t === 'tools') {
      const rawItems = frame.items;
      const next: ToolInfo[] = [];
      if (Array.isArray(rawItems)) {
        for (const item of rawItems) {
          if (!item || typeof item !== 'object') continue;
          const rec = item as Record<string, unknown>;
          const name = typeof rec.name === 'string' ? rec.name.trim() : '';
          if (!name) continue;
          next.push({
            name,
            risk: typeof rec.risk === 'string' ? rec.risk : undefined,
            desc: typeof rec.desc === 'string' ? rec.desc : undefined,
            sig: typeof rec.sig === 'string' ? rec.sig : undefined,
          });
        }
      }
      this.tools = next;
      this.log.info('桥报来可用工具', { count: next.length });
      for (const cb of this.toolsCbs) cb(next);
      return;
    }

    if (t === 'ready') {
      if (this.opts.requireModeSync) {
        if (frame.v !== 3 || (frame.mode !== 'full' && frame.mode !== 'safe') || typeof frame.modeRevision !== 'string' || !frame.modeRevision) {
          this.connectionError = 'AstrBot 桥的协议或模式信息无效，请更新配套插件。';
          this.ws?.close(4004, 'invalid bridge protocol');
          return;
        }
        if (!this.acceptModeOffer(frame.mode, frame.modeRevision)) return;
      }
      this.connectionError = undefined;
      this.ownerTools = frame.ownerTools === true;
      this.desktopSend = frame.desktopSend === true;
      this.ownerBound = frame.ownerBound === true;
      this.platformRoutes = readPlatformRoutes(frame.platformRoutes);
      this.instancePolicies = frame.instancePolicies === true;
      this.modeApprovalPending = frame.modeApprovalPending === true;
      const self = frame.self as { id?: unknown; name?: unknown } | undefined;
      this.self = {
        id: self?.id === undefined ? undefined : String(self.id),
        name: self?.name === undefined ? undefined : String(self.name),
      };
      const admins = frame.admins;
      this.ownerIds = Array.isArray(admins)
        ? admins.map((v) => String(v).trim()).filter((v) => v !== '')
        : [];
      // 旧版桥直接给 bool；新版给 { ready, provider }。
      const ttsRaw = frame.tts;
      if (typeof ttsRaw === 'boolean') {
        this.tts = { ready: ttsRaw };
      } else if (ttsRaw && typeof ttsRaw === 'object') {
        const rec = ttsRaw as Record<string, unknown>;
        this.tts = {
          ready: rec.ready === true,
          provider: typeof rec.provider === 'string' && rec.provider ? rec.provider : undefined,
        };
      } else {
        this.tts = { ready: false };
      }
      this.log.info('桥已就绪', {
        self: this.self,
        owners: this.ownerIds.length,
        tts: this.tts,
      });
      const convs: Conv[] = [];
      if (Array.isArray(frame.conversations)) {
        for (const raw of frame.conversations) {
          if (!raw || typeof raw !== 'object') continue;
          const r = raw as Record<string, unknown>;
          const kind = r.kind === 'group' || r.kind === 'private' ? r.kind : undefined;
          const id = r.id === undefined || r.id === null ? '' : String(r.id).trim();
          const umo = typeof r.umo === 'string' ? r.umo.trim() : '';
          if (!kind || !id || !umo) continue;
          const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : undefined;
          convs.push({ kind, id, umo, ...(name ? { name } : {}), ...(typeof r.channel === 'string' && r.channel ? { channel: r.channel } : {}) });
        }
      }
      for (const cb of this.readyCbs) cb(convs);
      // 首个 ready 才算真正连上；此时才把重连退避收回初始值。
      this.backoffMs = this.opts.reconnectBaseMs ?? 1000;
      return;
    }

    if (t === 'msg') {
      const deliveryId = typeof frame.deliveryId === 'string' && /^[0-9a-f]{32}$/.test(frame.deliveryId)
        ? frame.deliveryId : undefined;
      const acknowledge = (accepted: boolean): void => {
        if (deliveryId) this.ws?.send(JSON.stringify({ t: 'msg-ack', deliveryId, accepted }));
      };
      if (this.opts.requireModeSync && (!this.connected || frame.modeRevision !== this.modeRevision)) {
        acknowledge(false);
        return;
      }
      const msg = parseMessage(frame);
      if (!msg) {
        this.log.warn('消息帧形状不符，已忽略');
        acknowledge(false);
        return;
      }
      if (msg.umoInvalid) {
        this.log.warn('消息帧的 UMO 非法，已按 conv 处理');
      }
      let accepted = false;
      for (const cb of [...this.messageCbs]) {
        try {
          const result = cb(msg);
          if (result !== false) accepted = true;
        } catch (err) {
          this.log.error('消息回调抛错', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      acknowledge(accepted);
      return;
    }

    if (t === 'notice') {
      const notice: BridgeNotice = {
        kind: typeof frame.kind === 'string' ? frame.kind : undefined,
        text: typeof frame.text === 'string' ? frame.text : '',
        ts: typeof frame.ts === 'string' ? frame.ts : undefined,
      };
      if (!notice.text) return;
      for (const cb of [...this.noticeCbs]) {
        try {
          cb(notice);
        } catch (err) {
          this.log.error('通知回调抛错', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return;
    }

    this.log.debug('未知帧类型，已忽略', { t });
  }

  private acceptModeOffer(mode: BridgeMode, revision: string, rid?: string): boolean {
    if (this.connected && this.modeRevision !== revision) {
      this.connected = false;
      this.emitState(false);
    }
    if (this.opts.acceptMode?.(mode) === false) return false;
    this.modeOffer = { mode, revision };
    this.ws?.send(JSON.stringify({ t: 'mode-accept', modeRevision: revision, ...(rid ? { rid } : {}) }));
    return true;
  }

  private emitState(connected: boolean): void {
    for (const cb of [...this.stateCbs]) {
      try {
        cb(connected);
      } catch (err) {
        this.log.error('状态回调抛错', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private rejectAllPending(reason: string, uncertain = false): void {
    if (this.pendingMode) this.completeMode(this.pendingMode.rid, reason);
    this.modeRevision = undefined;
    this.modeApprovalPending = false;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.resolve({ ok: false, error: reason, uncertain });
    }
    this.pending.clear();
    for (const call of this.pendingTools.values()) {
      clearTimeout(call.timer);
      call.resolve({ ok: false, error: reason });
    }
    this.pendingTools.clear();
  }
}

/**
 * 解析一帧文本。合法 JSON 不代表是对象：`null`（以及数字、字符串、数组）
 * 都不能往下走，否则 `frame.t` 会在 null 上抛 TypeError。
 */
export function parseFrame(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** 把一帧 `msg` 收敛成 BridgeMessage；形状不对时返回 null。 */
export interface ParsedUmo {
  raw: string;
  platform: string;
  type: 'GroupMessage' | 'FriendMessage';
  kind: 'group' | 'private';
  id: string;
}

/** 解析 UMO；只切前两个冒号，session 里允许有冒号。 */
export function parseUmo(raw: unknown): ParsedUmo | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 512) return null;
  const first = value.indexOf(':');
  if (first <= 0) return null;
  const second = value.indexOf(':', first + 1);
  if (second <= first + 1 || second >= value.length - 1) return null;
  const platform = value.slice(0, first);
  const type = value.slice(first + 1, second);
  if (type !== 'GroupMessage' && type !== 'FriendMessage') return null;
  const id = value.slice(second + 1);
  if (!platform || !id) return null;
  return {
    raw: value,
    platform,
    type,
    kind: type === 'GroupMessage' ? 'group' : 'private',
    id,
  };
}

/** 把一帧 `msg` 解析成 BridgeMessage；形状不对时返回 null。 */
export function parseMessage(frame: Record<string, unknown>): BridgeMessage | null {
  const convRaw = frame.conv as Record<string, unknown> | undefined;
  const umoRaw = typeof frame.umo === 'string' ? frame.umo : convRaw?.umo;
  const umo = typeof umoRaw === 'string' && umoRaw.trim() !== '' ? umoRaw.trim() : undefined;
  const parsed = umo ? parseUmo(umo) : null;
  const channel = frame.channel;
  if (channel !== undefined && (typeof channel !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(channel))) return null;
  if (channel && channel !== 'qq' && !parsed) return null;
  // 非法 UMO 不能把整条帧（尤其是撤回/入群通知）丢掉：退回 conv 记账，上层打 warn。
  const umoInvalid = Boolean(umo && !parsed);
  const safeUmo = parsed ? parsed.raw : undefined;

  const convKindRaw = convRaw?.kind;
  const kind =
    parsed?.kind ??
    (convKindRaw === 'private' ? 'private' : convKindRaw === 'group' ? 'group' : null);
  if (!kind) return null;
  const id =
    parsed?.id ?? (convRaw?.id === undefined || convRaw?.id === null ? '' : String(convRaw.id));
  if (!id) return null;

  const convMismatch = Boolean(
    parsed &&
      convRaw &&
      (convRaw.kind !== parsed.kind ||
        (convRaw.id !== undefined && convRaw.id !== null && String(convRaw.id) !== parsed.id)),
  );

  const text = typeof frame.text === 'string' ? frame.text : '';
  const senderRaw = frame.sender as Record<string, unknown> | undefined;
  const role = frame.role === 'admin' ? 'admin' : 'member';

  return {
    id: frame.id === undefined ? '' : String(frame.id),
    ...(safeUmo ? { umo: safeUmo } : {}),
    ...(umoInvalid ? { umoInvalid: true } : {}),
    ...(convMismatch ? { convMismatch: true } : {}),
    ts: typeof frame.ts === 'string' ? frame.ts : undefined,
    channel,
    conv: {
      ...(safeUmo ? { umo: safeUmo } : {}),
      kind,
      id,
      ...(channel && channel !== 'qq' ? { channel } : {}),
      name: typeof convRaw?.name === 'string' ? convRaw.name : undefined,
    },
    sender: senderRaw
      ? {
          id: senderRaw.id === undefined ? undefined : String(senderRaw.id),
          name: typeof senderRaw.name === 'string' ? senderRaw.name : undefined,
        }
      : undefined,
    text,
    segments: parseSegments(frame.segments),
    quoteImageHistory: frame.quote_image_history === true,
    mentioned: frame.mentioned === true,
    canScreenshot: (frame.can as Record<string, unknown> | undefined)?.screenshot === true,
    role,
    // 旧版桥没有 owner：那时「管理员」就是主人，保持原样。
    owner: frame.owner === true || (frame.owner === undefined && role === 'admin'),
    images: parseImages(frame.images),
    imageErrors: parseImageErrors(frame.image_errors),
    notice: frame.kind === 'notice',
    ref: typeof frame.ref === 'string' && frame.ref !== '' ? frame.ref : undefined,
  };
}

/** 帧里的图片失败清单；形状不对的项直接丢掉。 */
function parseImageErrors(raw: unknown): Array<{ index: number; reason: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<{ index: number; reason: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const index = Number(rec.index);
    const reason = typeof rec.reason === 'string' ? rec.reason.trim() : '';
    if (!Number.isFinite(index) || index < 0) continue;
    out.push({ index, reason: reason || '未知原因' });
  }
  return out.length > 0 ? out : undefined;
}

/** 帧里的图片数组；形状不对的项直接丢掉。 */
function parseImages(raw: unknown): Array<{ mime: string; base64: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<{ mime: string; base64: string }> = [];
  let total = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const mime = typeof rec.mime === 'string' ? rec.mime : '';
    const base64 = typeof rec.base64 === 'string' ? rec.base64 : '';
    if (!base64 || !mime.startsWith('image/') || base64.length > 8 * 1024 * 1024 ||
        total + base64.length > 10 * 1024 * 1024) continue;
    out.push({ mime, base64 });
    total += base64.length;
    if (out.length >= 4) break;
  }
  return out.length > 0 ? out : undefined;
}

const AUDIO_NAMES = new Map([
  ['audio/silk', 'qq-voice.silk'], ['audio/amr', 'qq-voice.amr'], ['audio/ogg', 'qq-voice.ogg'],
  ['audio/wav', 'qq-voice.wav'], ['audio/mpeg', 'qq-voice.mp3'],
]);

function parseAudio(raw: unknown): ToolResult['audio'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const { mime, base64 } = raw as Record<string, unknown>;
  if (typeof mime !== 'string' || typeof base64 !== 'string') return undefined;
  const name = AUDIO_NAMES.get(mime);
  if (!name || !base64 || base64.length > 8 * 1024 * 1024 || base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return undefined;
  return { mime, base64, name };
}
