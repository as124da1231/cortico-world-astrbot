/** World 测试共用的假宿主与假驱动。 */
import type { EventEnvelope, PushOptions, WorldHost } from 'cortico/core/types.ts';
import type {
  BridgeDriver,
  BridgeMessage,
  BridgeNotice,
  Conv,
  OutgoingImage,
  SendResult,
  ToolInfo,
  ToolResult,
} from '../../src/driver.ts';

/** 记录投递的事件与唤醒口径，其余宿主接口空实现。 */
export class FakeHost implements WorldHost {
  events: EventEnvelope[] = [];
  pushOpts: Array<PushOptions | undefined> = [];
  /** 按句柄放的附件；测试用来冒充 Core 的 log: 存储。 */
  blobs = new Map<string, { bytes: Uint8Array; mime: string }>();
  pushDeferred(): void {}
  /** 内存版的只读事件库：够跑历史检索的测试。 */
  store = {
    get: (cursor: number): EventEnvelope | undefined =>
      this.events.find((e) => e.cursor === cursor),
    latestCursor: (): number => this.events.length,
    range: (q: {
      fromCursor?: number;
      toCursor?: number;
      fromTs?: string;
      toTs?: string;
      senderKey?: string;
      source?: string;
      origin?: string;
      limit?: number;
    }): EventEnvelope[] => {
      let out = this.events.filter((e) => {
        if (q.fromCursor !== undefined && e.cursor < q.fromCursor) return false;
        if (q.toCursor !== undefined && e.cursor > q.toCursor) return false;
        if (q.fromTs !== undefined && e.ts < q.fromTs) return false;
        if (q.toTs !== undefined && e.ts > q.toTs) return false;
        if (q.senderKey !== undefined && String(e.senderKey ?? '') !== q.senderKey) return false;
        if (q.source !== undefined && e.source !== q.source) return false;
        if (q.origin !== undefined && e.origin !== q.origin) return false;
        return true;
      });
      if (q.limit !== undefined) out = out.slice(-q.limit);
      return out;
    },
    around: (cursor: number, before: number, after: number): EventEnvelope[] =>
      this.events.filter((e) => e.cursor >= cursor - before && e.cursor <= cursor + after),
    grep: (q: { keyword: string; context: number; limit?: number; source?: string; origin?: string }) => {
      const needle = q.keyword.toLowerCase();
      const seen = new Set<number>();
      const hits: Array<{ hitCursor: number; events: EventEnvelope[] }> = [];
      for (const e of this.events) {
        if (q.source !== undefined && e.source !== q.source) continue;
        if (q.origin !== undefined && e.origin !== q.origin) continue;
        if (!e.text.toLowerCase().includes(needle)) continue;
        if (seen.has(e.cursor)) continue;
        seen.add(e.cursor);
        hits.push({
          hitCursor: e.cursor,
          events: this.events.filter(
            (x) => x.cursor >= e.cursor - q.context && x.cursor <= e.cursor + q.context,
          ),
        });
        if (q.limit !== undefined && hits.length >= q.limit) break;
      }
      return hits;
    },
  } as unknown as WorldHost['store'];
  blob = (handle: string): { bytes: Uint8Array; mime: string } | null => this.blobs.get(handle) ?? null;
  modelFacts = { model: () => 'test', accepts: () => false, contextWindow: () => 128000 };
  log = {
    child() {
      return this;
    },
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    emit() {},
  } as unknown as WorldHost['log'];

  async pushEvent(
    e: Omit<EventEnvelope, 'cursor'>,
    opts?: PushOptions,
  ): Promise<EventEnvelope> {
    const full = { ...e, cursor: this.events.length + 1 } as EventEnvelope;
    this.events.push(full);
    this.pushOpts.push(opts);
    return full;
  }
  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }
  reportUsage(): void {}
}

/** 假驱动：把回调收集起来，由测试手工触发。 */
export class FakeDriver implements BridgeDriver {
  connected = false;
  self?: { id?: string; name?: string };
  ownerIds: string[] = [];
  tts = { ready: false } as { ready: boolean; provider?: string };
  tools: ToolInfo[] = [];
  started = 0;
  stopped = 0;
  sent: Array<{ conv: Conv; text: string; replyTo?: string; image?: OutgoingImage; voice?: boolean }> = [];
  sendResult: SendResult = { ok: true };
  /** 工具调用记录，测试用来断言 name / args / turn。 */
  toolCalls: Array<{ name: string; args: Record<string, unknown>; turn: string }> = [];
  toolResult: ToolResult = { ok: true, result: 'ok' };

  private messageCbs: Array<(m: BridgeMessage) => void> = [];
  private noticeCbs: Array<(n: BridgeNotice) => void> = [];
  private stateCbs: Array<(connected: boolean) => void> = [];
  private toolsCbs: Array<(tools: ToolInfo[]) => void> = [];

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
  async callTool(
    name: string,
    args: Record<string, unknown>,
    turn: string,
  ): Promise<ToolResult> {
    this.toolCalls.push({ name, args, turn });
    return this.toolResult;
  }
  async start(): Promise<void> {
    this.started += 1;
  }
  async stop(): Promise<void> {
    this.stopped += 1;
    this.connected = false;
  }
  async send(
    conv: Conv,
    text: string,
    replyTo?: string,
    image?: OutgoingImage,
    voice?: boolean,
  ): Promise<SendResult> {
    this.sent.push({ conv, text, replyTo, image, voice });
    return this.sendResult;
  }

  /** 测试入口：模拟桥推来一条消息。 */
  emitMessage(m: BridgeMessage): void {
    for (const cb of this.messageCbs) cb(m);
  }
  /** 测试入口：模拟桥推来一条通知。 */
  emitNotice(n: BridgeNotice): void {
    for (const cb of this.noticeCbs) cb(n);
  }
  /** 测试入口：模拟连接状态变化。 */
  emitState(connected: boolean): void {
    this.connected = connected;
    for (const cb of this.stateCbs) cb(connected);
  }
  /** 测试入口：模拟桥推来工具清单。 */
  emitTools(tools: ToolInfo[]): void {
    this.tools = tools;
    for (const cb of this.toolsCbs) cb(tools);
  }
}
