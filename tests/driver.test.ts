import { createServer, type Server, type Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { AstrbotBridgeDriver, parseMessage, parseUmo } from '../src/driver.ts';

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
