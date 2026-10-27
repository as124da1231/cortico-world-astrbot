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

/** 会话种类：群聊或私聊。 */
export type ConvKind = 'group' | 'private';

/** 会话标识；id 用字符串，群号/QQ 号由桥给什么就存什么。 */
export interface Conv {
  kind: ConvKind;
  id: string;
  /** 群名或对方昵称，仅用于展示。 */
  name?: string;
}

/** 桥推进来的一条消息。字段保持扁平，语义由 World 解释。 */
export interface BridgeMessage {
  /** 桥侧的消息唯一标识，用于引用回复与去重。 */
  id: string;
  /** ISO 8601；缺失时由 World 补当前时间。 */
  ts?: string;
  /** 渠道。当前桥只有 QQ；字段与官方 QQ World 的 meta.channel 对齐。 */
  channel?: 'qq';
  conv: Conv;
  sender?: { id?: string; name?: string };
  text: string;
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
  /** 桥是否真的把这条发成了语音（TTS 失败时会退回文字）。 */
  voice?: boolean;
  /** 成功但有需要说明的事，例如「TTS 没开，已改发文字」。 */
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

/** 一次工具调用的回执。 */
export interface ToolResult {
  ok: boolean;
  /** ok 为 true 时的结果文本。 */
  result?: string;
  /** ok 为 false 时的原因。 */
  error?: string;
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
export interface BridgeDriver {
  readonly connected: boolean;
  readonly self?: { id?: string; name?: string };
  /** 桥报来的管理员 QQ 号；空数组表示还没收到。 */
  readonly ownerIds: string[];
  /** 桥自报的语音能力；没收到时按不可用。 */
  readonly tts: BridgeTtsInfo;
  /** 桥那边启用的工具清单；桥没连上时是上一次收到的。 */
  readonly tools: ToolInfo[];
  onMessage(cb: (m: BridgeMessage) => void): void;
  onNotice(cb: (n: BridgeNotice) => void): void;
  onState(cb: (connected: boolean) => void): void;
  /** 工具清单变了（握手后下发，或管理页保存后重推）。 */
  onTools(cb: (tools: ToolInfo[]) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(conv: Conv, text: string, replyTo?: string, image?: OutgoingImage, voice?: boolean): Promise<SendResult>;
  /** 调一个桥那边启用的工具；turn 是触发这一轮的消息 id。 */
  callTool(name: string, args: Record<string, unknown>, turn: string): Promise<ToolResult>;
}

export interface BridgeDriverOptions {
  wsUrl: string;
  token?: string;
  /** 握手时自报的能力；桥据此决定要不要把图片传过来。 */
  capabilities?: Record<string, boolean>;
  /** 重连等待起点。 */
  reconnectBaseMs?: number;
  /** 重连等待封顶。 */
  reconnectMaxMs?: number;
  /** 一次发送等确认的超时。 */
  sendTimeoutMs?: number;
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

/** 发送确认的默认超时。 */
export const DEFAULT_SEND_TIMEOUT_MS = 15_000;

/** 工具回执的默认超时：有些工具本身会查网、生成图片，给宽一点。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 90_000;

/** 心跳间隔：主动 ping 一次，顺便刷新活跃时间。 */
export const DEFAULT_HEARTBEAT_MS = 20_000;

/** 多久没有任何往来就认定连接已死。桥每 20 秒 ping 一次，留六倍余量；
 *  120 秒而不是 60 秒：群安静、机器休眠回来时，60 秒会误判成断线。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

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
  private messageCbs: Array<(m: BridgeMessage) => void> = [];
  private noticeCbs: Array<(n: BridgeNotice) => void> = [];
  private stateCbs: Array<(connected: boolean) => void> = [];
  private toolsCbs: Array<(tools: ToolInfo[]) => void> = [];
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
  /** 桥自报的语音能力；没收到时按不可用。 */
  tts: BridgeTtsInfo = { ready: false };

  connected = false;

  constructor(opts: BridgeDriverOptions) {
    this.opts = opts;
    this.log = opts.log ?? nullLogger();
    this.backoffMs = opts.reconnectBaseMs ?? 1000;
  }

  onMessage(cb: (m: BridgeMessage) => void): void {
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

  /** 调一个桥那边启用的工具。未连接、超时或被拒都返回 ok:false。 */
  callTool(name: string, args: Record<string, unknown>, turn: string): Promise<ToolResult> {
    return new Promise((resolve) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, error: '与 AstrBot 桥的连接未建立' });
        return;
      }
      if (!turn) {
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
        ws.send(JSON.stringify({ t: 'tool', rid, name, args, turn }));
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
    this.rejectAllPending('驱动已停止');
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
  send(conv: Conv, text: string, replyTo?: string, image?: OutgoingImage, voice?: boolean): Promise<SendResult> {
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
        (image ? 15_000 : 0) +
        (voice ? 20_000 : 0);
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        resolve({ ok: false, error: `桥没有在 ${timeout}ms 内确认` });
      }, timeout);
      this.pending.set(rid, { resolve, timer });
      const frame: Record<string, unknown> = {
        t: 'send',
        rid,
        conv: { kind: conv.kind, id: conv.id },
        text,
      };
      if (replyTo) frame.replyTo = replyTo;
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
    const settle = (): void => {
      if (!settled) {
        settled = true;
        onSettled?.();
      }
    };

    const token = this.opts.token;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.wsUrl, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
    } catch (err) {
      this.log.warn('桥地址无法解析', {
        wsUrl: this.opts.wsUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      settle();
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      if (this.stopped || this.ws !== ws) {
        ws.terminate();
        settle();
        return;
      }
      this.connected = true;
      this.backoffMs = this.opts.reconnectBaseMs ?? 1000;
      this.log.info('已连上 AstrBot 桥', { wsUrl: this.opts.wsUrl });
      try {
        // 握手帧：带上 token 与自己的显示名，桥据此认人。
        ws.send(
          JSON.stringify({
            t: 'hello',
            v: 1,
            token: token ?? '',
            name: 'Cortico',
            capabilities: this.opts.capabilities ?? {},
          }),
        );
      } catch (err) {
        this.log.warn('握手帧发送失败', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.emitState(true);
      this.startHeartbeat(ws);
      settle();
    });

    ws.on('message', (data) => {
      if (!this.stopped && this.ws === ws) {
        this.lastActivity = Date.now();
        this.handleFrame(String(data));
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
      this.log.warn('桥连接错误', { error: err.message });
    });

    ws.on('close', () => {
      const isCurrent = this.ws === ws;
      const wasConnected = this.connected;
      if (isCurrent) {
        this.stopHeartbeat();
        this.ws = undefined;
        this.connected = false;
        this.rejectAllPending('与桥的连接已断开');
        if (wasConnected) this.log.info('与 AstrBot 桥的连接已断开');
      }
      settle();
      if (isCurrent && !this.stopped) {
        if (wasConnected) this.emitState(false);
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
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.reconnectMaxMs ?? 30_000);
    this.log.debug(`${delay}ms 后重连桥`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) this.connectAttempt();
    }, delay);
  }

  private handleFrame(raw: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.log.warn('收到无法解析的帧，已忽略');
      return;
    }

    const t = typeof frame.t === 'string' ? frame.t : '';

    // 应用层心跳：只用来刷新活跃时间，不需要进 World。
    if (t === 'tick') return;

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
          : { ok: false, error: String(frame.error ?? '桥拒绝发送') },
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
      call.resolve(
        ok
          ? { ok: true, result: String(frame.result ?? '') }
          : { ok: false, error: String(frame.error ?? '桥拒绝了这次工具调用') },
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
      return;
    }

    if (t === 'msg') {
      const msg = parseMessage(frame);
      if (!msg) {
        this.log.warn('消息帧形状不符，已忽略');
        return;
      }
      for (const cb of [...this.messageCbs]) {
        try {
          cb(msg);
        } catch (err) {
          this.log.error('消息回调抛错', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
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

  private rejectAllPending(reason: string): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.resolve({ ok: false, error: reason });
    }
    this.pending.clear();
    for (const call of this.pendingTools.values()) {
      clearTimeout(call.timer);
      call.resolve({ ok: false, error: reason });
    }
    this.pendingTools.clear();
  }
}

/** 把一帧 `msg` 收敛成 BridgeMessage；形状不对时返回 null。 */
export function parseMessage(frame: Record<string, unknown>): BridgeMessage | null {
  const convRaw = frame.conv as Record<string, unknown> | undefined;
  if (!convRaw) return null;
  const kind = convRaw.kind === 'private' ? 'private' : convRaw.kind === 'group' ? 'group' : null;
  if (!kind) return null;
  const id = convRaw.id === undefined || convRaw.id === null ? '' : String(convRaw.id);
  if (!id) return null;

  const text = typeof frame.text === 'string' ? frame.text : '';
  const senderRaw = frame.sender as Record<string, unknown> | undefined;
  const role = frame.role === 'admin' ? 'admin' : 'member';

  return {
    id: frame.id === undefined ? '' : String(frame.id),
    ts: typeof frame.ts === 'string' ? frame.ts : undefined,
    channel: frame.channel === 'qq' ? 'qq' : undefined,
    conv: {
      kind,
      id,
      name: typeof convRaw.name === 'string' ? convRaw.name : undefined,
    },
    sender: senderRaw
      ? {
          id: senderRaw.id === undefined ? undefined : String(senderRaw.id),
          name: typeof senderRaw.name === 'string' ? senderRaw.name : undefined,
        }
      : undefined,
    text,
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
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const mime = typeof rec.mime === 'string' ? rec.mime : '';
    const base64 = typeof rec.base64 === 'string' ? rec.base64 : '';
    if (!base64 || !mime.startsWith('image/')) continue;
    out.push({ mime, base64 });
    if (out.length >= 4) break;
  }
  return out.length > 0 ? out : undefined;
}
