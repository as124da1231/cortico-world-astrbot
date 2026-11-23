import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { AstrbotBridgeDriver, AUTH_REJECT_MIN_BACKOFF_MS, parseMessage, parseUmo } from '../src/driver.ts';

/** 只接受 TCP、永远不回 HTTP Upgrade 的对端：模拟半开握手。 */
function hangingServer(): Promise<{ server: Server; port: number; sockets: Socket[] }> {
  return new Promise((resolve) => {
    const sockets: Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => {});
      // 故意不写任何响应。
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, sockets });
    });
  });
}

describe('AstrbotBridgeDriver 握手', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('对端只接 TCP 不回 Upgrade 时，start 仍会在超时后返回', async () => {
    const { server, port, sockets } = await hangingServer();
    cleanup = async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };

    const driver = new AstrbotBridgeDriver({
      wsUrl: `ws://127.0.0.1:${port}`,
      handshakeTimeoutMs: 100,
      reconnectBaseMs: 10_000,
      reconnectMaxMs: 10_000,
    });

    const started = await Promise.race([
      driver.start().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
    expect(started).toBe(true);
    await driver.stop();
  });

  it('收到合法 JSON null 也不会把驱动带崩', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as { port: number }).port;
    cleanup = async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    };

    const driver = new AstrbotBridgeDriver({
      wsUrl: `ws://127.0.0.1:${port}`,
      reconnectBaseMs: 10_000,
      reconnectMaxMs: 10_000,
    });

    const noticed = new Promise<string>((resolve) => {
      driver.onNotice((n) => resolve(n.text));
    });
    await driver.start();

    const socket = await new Promise<import('ws').WebSocket>((resolve) => {
      wss.once('connection', (client) => resolve(client));
      // start 时可能已经连上；已连上的情况从 clients 取。
      const existing = [...wss.clients][0];
      if (existing) resolve(existing);
    });
    socket.send('null');
    socket.send(JSON.stringify({ t: 'notice', text: 'still alive' }));

    await expect(noticed).resolves.toBe('still alive');
    await driver.stop();
  });

  it('只有收到对端模式确认才更新生效模式，并丢弃旧模式消息', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as { port: number }).port;
    const driver = new AstrbotBridgeDriver({ wsUrl: `ws://127.0.0.1:${port}`, requireModeSync: true });
    cleanup = async () => {
      await driver.stop();
      await new Promise<void>(resolve => wss.close(() => resolve()));
    };
    const seen: string[] = [];
    driver.onMessage(msg => seen.push(msg.id ?? ''));
    let socket: import('ws').WebSocket;
    let switchRid = '';
    wss.on('connection', ws => {
      socket = ws;
      ws.on('message', raw => {
        const packet = JSON.parse(String(raw));
        if (packet.t === 'hello') {
          ws.send(JSON.stringify({ t: 'ready', v: 2, mode: 'full', modeRevision: 'old' }));
        } else if (packet.t === 'mode-accept' && packet.modeRevision === 'old') {
          ws.send(JSON.stringify({ t: 'mode-status', mode: 'full', modeRevision: 'old', active: true }));
        } else if (packet.t === 'mode-change') {
          switchRid = packet.rid;
          ws.send(JSON.stringify({ t: 'mode-prepare', mode: 'safe', modeRevision: 'new', rid: switchRid }));
        }
      });
    });
    const started = new Promise<void>(resolve => driver.onState(connected => { if (connected) resolve(); }));
    await driver.start();
    await started;
    const changing = driver.changeMode('safe');
    await import('vitest').then(({ vi }) => vi.waitFor(() => expect(switchRid).not.toBe('')));
    expect(driver.mode).toBe('full');
    socket!.send(JSON.stringify({ t: 'mode-status', mode: 'safe', modeRevision: 'new', rid: switchRid, active: true }));
    await changing;
    expect(driver.mode).toBe('safe');
    for (const id of ['old', 'new']) socket!.send(JSON.stringify({ t: 'msg', umo: 'qq:GroupMessage:10000', id, modeRevision: id, text: id }));
    await import('vitest').then(({ vi }) => vi.waitFor(() => expect(seen).toEqual(['new'])));
  });
});

describe('UMO 契约', () => {
  it('解析 platform/type/session，session 里允许冒号', () => {
    expect(parseUmo('default:GroupMessage:123:456')).toMatchObject({
      platform: 'default',
      type: 'GroupMessage',
      kind: 'group',
      id: '123:456',
    });
  });

  it('拒绝非法 UMO', () => {
    expect(parseUmo('default:GroupMessage')).toBeNull();
    expect(parseUmo('default:OtherMessage:1')).toBeNull();
    expect(parseUmo(':GroupMessage:1')).toBeNull();
    expect(parseUmo('')).toBeNull();
  });

  it('收帧以 UMO 为准，并派生 conv', () => {
    const msg = parseMessage({
      t: 'msg',
      id: '1',
      umo: 'default:GroupMessage:123',
      conv: { kind: 'private', id: '999' },
      text: 'x',
    });
    expect(msg?.conv).toMatchObject({
      kind: 'group',
      id: '123',
      umo: 'default:GroupMessage:123',
    });
    expect(msg?.convMismatch).toBe(true);
  });

  it('发送时 UMO 与 conv 不一致直接拒绝', async () => {
    const driver = new AstrbotBridgeDriver({ wsUrl: 'ws://127.0.0.1:1' });
    const result = await driver.send(
      { kind: 'group', id: '123', umo: 'default:GroupMessage:999' },
      'x',
    );
    expect(result).toEqual({ ok: false, error: 'umo_conv_mismatch' });
  });
});


describe('重连退避', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  interface Bridge {
    port: number;
    count: () => number;
    close: () => Promise<void>;
  }

  async function openBridge(handler: (client: import('ws').WebSocket) => void): Promise<Bridge> {
    const wss = new WebSocketServer({ port: 0 });
    let count = 0;
    wss.on('connection', (client) => {
      count += 1;
      handler(client);
    });
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', () => resolve());
      wss.once('error', reject);
    });
    const port = (wss.address() as { port: number }).port;
    return {
      port,
      count: () => count,
      close: async () => {
        for (const client of wss.clients) {
          try {
            client.terminate();
          } catch {
            // 已经断了
          }
        }
        await new Promise<void>((resolve) => wss.close(() => resolve()));
      },
    };
  }

  async function until(ok: () => boolean, ms = 2_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (ok()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('等待条件超时');
  }

  /** 退避是内部状态；用行为验证太啰嗦，这里直接读来断言“有没有被重置”。 */
  const backoff = (driver: AstrbotBridgeDriver): number =>
    (driver as unknown as { backoffMs: number }).backoffMs;

  const makeDriver = (port: number): AstrbotBridgeDriver =>
    new AstrbotBridgeDriver({
      wsUrl: `ws://127.0.0.1:${port}`,
      reconnectBaseMs: 20,
      reconnectMaxMs: 1_000,
      heartbeatMs: 0,
    });

  it('只有 ready 重置退避；open 后未 ready 时继续翻倍', async () => {
    const bridge = await openBridge((client) => client.close(1000, 'bye'));
    const driver = makeDriver(bridge.port);
    cleanup = async () => {
      await driver.stop();
      await bridge.close();
    };

    await driver.start();
    await until(() => backoff(driver) >= 80);
    // 老实现每次 open 都写回起点 20ms；那样这里永远到不了 80ms。
    expect(backoff(driver)).toBeGreaterThanOrEqual(80);
    expect(bridge.count()).toBeGreaterThan(1);
  });

  it('收到 ready 后把退避收回初始值', async () => {
    let connections = 0;
    const bridge = await openBridge((client) => {
      connections += 1;
      if (connections === 1) {
        client.terminate();
        return;
      }
      // 第二条连接先不 ready：这段时间退避必须还是上一轮的翻倍值。
      setTimeout(() => {
        try {
          client.send(JSON.stringify({ t: 'ready', self: { name: '桥' }, admins: [] }));
        } catch {
          // 连接已关
        }
      }, 150);
    });
    const driver = makeDriver(bridge.port);
    cleanup = async () => {
      await driver.stop();
      await bridge.close();
    };

    await driver.start();
    await until(() => connections >= 2);
    // 第二次 open 之后、ready 之前：退避仍是第一轮 close 后的 40ms，未被 open 重置。
    expect(backoff(driver)).toBeGreaterThanOrEqual(40);

    await until(() => driver.self?.name === '桥');
    expect(backoff(driver)).toBe(20);
  });

  it('token 被拒（4003）后按 10s 起步，不再 1s 一次重连', async () => {
    const bridge = await openBridge((client) => client.close(4003, 'bad token'));
    const driver = new AstrbotBridgeDriver({
      wsUrl: `ws://127.0.0.1:${bridge.port}`,
      reconnectBaseMs: 20,
      reconnectMaxMs: 30_000,
      heartbeatMs: 0,
    });
    cleanup = async () => {
      await driver.stop();
      await bridge.close();
    };

    await driver.start();
    await until(() => backoff(driver) >= AUTH_REJECT_MIN_BACKOFF_MS);
    const attempts = bridge.count();
    // 300ms 内不能出现第二次尝试：老实现会在 20ms 后就回来。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(bridge.count()).toBe(attempts);
  });
});

describe('发送失败回执', () => {
  it('失败时透传桥的 note（T-004）', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as { port: number }).port;
    wss.on('connection', (client) => {
      client.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.t !== 'send') return;
        client.send(
          JSON.stringify({
            t: 'ack',
            rid: frame.rid,
            ok: false,
            error: 'send_timeout',
            note: '平台超时，可能已发出',
            uncertain: true,
          }),
        );
      });
    });

    const driver = new AstrbotBridgeDriver({ wsUrl: `ws://127.0.0.1:${port}`, heartbeatMs: 0 });
    try {
      await driver.start();
      const result = await driver.send(
        { kind: 'group', id: '123', umo: 'default:GroupMessage:123' },
        'x',
      );
      expect(result).toEqual({
        ok: false,
        error: 'send_timeout',
        note: '平台超时，可能已发出',
        uncertain: true,
      });
    } finally {
      await driver.stop();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});

describe('工具失败回执', () => {
  it('失败时透传桥的 note，error 仍是稳定 code（T-004）', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as { port: number }).port;
    wss.on('connection', (client) => {
      client.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.t !== 'tool') return;
        client.send(
          JSON.stringify({
            t: 'tool-ack',
            rid: frame.rid,
            ok: false,
            error: 'tool_failed',
            note: '工具执行失败，详情见插件日志',
          }),
        );
      });
    });

    const driver = new AstrbotBridgeDriver({ wsUrl: `ws://127.0.0.1:${port}`, heartbeatMs: 0 });
    try {
      await driver.start();
      const result = await driver.callTool('play_song_by_name', {}, 'm1');
      expect(result).toEqual({
        ok: false,
        error: 'tool_failed',
        note: '工具执行失败，详情见插件日志',
      });
    } finally {
      await driver.stop();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});

describe('非法 UMO 回退（G-004）', () => {
  it('带着 conv 的非法 UMO 按 conv 记账，通知不丢', () => {
    const msg = parseMessage({
      t: 'msg',
      id: 'm1',
      kind: 'notice',
      umo: 'not-a-umo',
      conv: { kind: 'group', id: '123' },
      text: '某人撤回了一条消息',
    });
    expect(msg).not.toBeNull();
    expect(msg?.umo).toBeUndefined();
    expect(msg?.umoInvalid).toBe(true);
    expect(msg?.notice).toBe(true);
    expect(msg?.conv).toMatchObject({ kind: 'group', id: '123' });
    expect(msg?.conv.umo).toBeUndefined();
  });

  it('非法 UMO 的帧仍交给消息回调', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as { port: number }).port;
    wss.on('connection', (client) => {
      client.send(
        JSON.stringify({
          t: 'msg',
          id: 'm2',
          kind: 'notice',
          umo: 'bad',
          conv: { kind: 'private', id: '9' },
          text: '入群',
        }),
      );
    });

    const driver = new AstrbotBridgeDriver({ wsUrl: `ws://127.0.0.1:${port}`, heartbeatMs: 0 });
    try {
      const received = new Promise<string>((resolve) => {
        driver.onMessage((m) => resolve(`${m.conv.kind}:${m.conv.id}`));
      });
      await driver.start();
      await expect(received).resolves.toBe('private:9');
    } finally {
      await driver.stop();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});

describe('UMO 共享测试向量', () => {
  it('两端使用同一份向量', () => {
    const cases = JSON.parse(
      readFileSync(new URL('../shared/umo-vectors.json', import.meta.url), 'utf8'),
    ) as Array<{ in: string; ok: boolean; platform?: string; kind?: string; id?: string }>;
    for (const item of cases) {
      const parsed = parseUmo(item.in);
      if (!item.ok) {
        expect(parsed, item.in).toBeNull();
      } else {
        expect(parsed, item.in).toMatchObject({
          platform: item.platform,
          kind: item.kind,
          id: item.id,
        });
      }
    }
  });
});
