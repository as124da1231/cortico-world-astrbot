import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope, ToolCallContext } from 'cortico/core/types.ts';
import { ASTRBOT_DEFAULTS, normalizeMode, parseAliases, type AstrbotConfigSection } from '../src/config.ts';
import { ASTRBOT } from '../src/definition.ts';
import { AstrbotWorld, CALL_TOOL_DECL, QQ_TURN_TTL_MS } from '../src/world.ts';
import { readLatest } from '../src/history.ts';
import { parseFrame, parseMessage } from '../src/driver.ts';
import { FakeDriver, FakeHost } from './helpers/fake-bridge.ts';

/** 造一份可改的配置；默认开启，方便测投递。 */
function config(patch: Partial<AstrbotConfigSection> = {}): AstrbotConfigSection {
  return { ...ASTRBOT_DEFAULTS, enabled: true, wsUrl: 'ws://127.0.0.1:17999', ...patch };
}

/** 工具 handler 要的调用上下文；测试只用到 role 与 log。 */
function toolCtx(): ToolCallContext {
  return { role: 'assistant', log: new FakeHost().log } as unknown as ToolCallContext;
}

/** 起一个装好假驱动的 World。 */
async function mount(patch: Partial<AstrbotConfigSection> = {}) {
  const cfg = config(patch);
  const driver = new FakeDriver();
  driver.connected = true;
  const host = new FakeHost();
  const world = new AstrbotWorld({ cfg, timezone: 'Asia/Shanghai', driver });
  await world.start(host);
  return { cfg, driver, host, world };
}

/** 模拟 Core 把这一批事件交给模型；这一轮有没有 QQ 消息由它决定。 */
function settle(world: AstrbotWorld, host: FakeHost): void {
  deliverForCore(world, host, [...host.events]);
}

/** 与目标宿主一致：入库、投递阶段、只通知各 World 自己的事件。 */
function deliverForCore(world: AstrbotWorld, host: FakeHost, events: EventEnvelope[]): void {
  const stored = events.map(event => {
    if (host.events.includes(event)) return event;
    const full = { ...event, cursor: host.events.length + 1, ts: event.ts ?? new Date().toISOString() };
    host.events.push(full);
    return full;
  });
  world.onRunPhase({ state: 'delivering', running: [], enteredAt: new Date().toISOString() });
  const own = stored.filter(event => event.source === world.id);
  if (own.length) world.onEventsSettled(own, 'delivered');
  world.onRunPhase({ state: 'model', running: [], enteredAt: new Date().toISOString() });
}

/** 一条群消息。 */
function groupMsg(patch: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    conv: { kind: 'group' as const, id: '123456', name: '测试群' },
    sender: { id: '42', name: '小明' },
    text: '在吗',
    ...patch,
  };
}

/** 一条私聊消息。 */
function privateMsg(patch: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    conv: { kind: 'private' as const, id: '999' },
    sender: { id: '999', name: '主人' },
    text: '在吗',
    ...patch,
  };
}

describe('配置解析', () => {
  it('未知 mode 收敛成保守的 mention', () => {
    expect(normalizeMode('mention')).toBe('mention');
    expect(normalizeMode('all')).toBe('all');
    expect(normalizeMode(undefined)).toBe('mention');
    expect(normalizeMode('乱写')).toBe('mention');
    expect(ASTRBOT_DEFAULTS.mode).toBe('mention');
  });

  it('称呼按中英文逗号切分并去空', () => {
    expect(parseAliases('Coo, 库 ，小铃,, ')).toEqual(['Coo', '库', '小铃']);
    expect(parseAliases(undefined)).toEqual([]);
  });
});

describe('装配', () => {
  it('工具令牌只存部署密钥，连接状态只返回设置状态', async () => {
    let stored = '';
    const world = new AstrbotWorld({
      cfg: config(),
      timezone: 'Asia/Shanghai',
      ownerToolSecret: { read: () => stored, store: (value) => { stored = value; } },
    });
    const invoke = world.webUi().invoke!;
    await expect(invoke('connection', 'save-owner-token', ['invalid token'])).rejects.toThrow();
    await expect(invoke('connection', 'save-owner-token', ['secret-fixture-owner-token'])).resolves.toEqual({ saved: true });
    const result = await invoke('connection', 'state', []);
    expect(result).toMatchObject({ ownerToolTokenSet: true, ownerTools: false });
    expect(JSON.stringify(result)).not.toContain(stored);
  });

  it('桥未确认主人工具授权时不派发工具调用', async () => {
    const { world, driver } = await mount({ ownerId: '100000001' });
    driver.ownerIds = ['100000001'];
    driver.ownerTools = false;
    const result = await toolHandler(world, 'astrbot_call_tool')({ name: 'test_tool' }, toolCtx());
    expect(result).toMatchObject({ failed: true });
    expect(driver.toolCalls).toEqual([]);
    await world.stop();
  });

  it('定义声明了工具，且默认关闭', () => {
    expect(ASTRBOT.id).toBe('astrbot');
    expect(ASTRBOT.defaults().enabled).toBe(false);
    const names = ASTRBOT.describe?.tools.map((t) => t.name) ?? [];
    expect(names).toContain('astrbot_send_message');
    expect(names).toContain('astrbot_status');
  });

  it('create 不连接：没有驱动也不应抛错', () => {
    const ctx = {
      cfg: { ...ASTRBOT_DEFAULTS },
      timezone: 'Asia/Shanghai',
    } as unknown as Parameters<typeof ASTRBOT.create>[0];
    expect(() => ASTRBOT.create(ctx)).not.toThrow();
  });

  it('wsUrl 为空时 start 直接返回，不建连接', async () => {
    const host = new FakeHost();
    const world = new AstrbotWorld({
      cfg: config({ wsUrl: '' }),
      timezone: 'Asia/Shanghai',
    });
    await expect(world.start(host)).resolves.toBeUndefined();
    await world.stop();
  });

  it('驱动一直连接不返回时，start 到点也会放行', async () => {
    const host = new FakeHost();
    const driver = new FakeDriver();
    driver.startHangs = true;
    const world = new AstrbotWorld({
      cfg: config(),
      timezone: 'Asia/Shanghai',
      driver,
      startTimeoutMs: 30,
    });
    await expect(world.start(host)).resolves.toBeUndefined();
    expect(driver.started).toBe(1);
    await world.stop();
  });

  it('合法 JSON 但不是对象，不能当成帧', () => {
    expect(parseFrame('null')).toBeNull();
    expect(parseFrame('[]')).toBeNull();
    expect(parseFrame('"x"')).toBeNull();
    expect(parseFrame('123')).toBeNull();
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame('{"t":"tick"}')).toEqual({ t: 'tick' });
  });
  it('连接面板只报告 World 自己的状态', async () => {
    const { world, driver } = await mount({ wsUrl: 'ws://127.0.0.1:18099', mode: 'all' });
    driver.self = { id: '10001', name: 'Coo' };
    driver.ownerIds = ['10001'];
    driver.tts = { ready: true, provider: 'edge_tts' };
    driver.tools = [
      { name: 'query_lyrics_by_name' },
      { name: 'play_song_by_name' },
    ];
    const ui = world.webUi();
    expect(ui.panels?.map((p) => p.id)).toEqual(['connection']);
    const st = (await ui.invoke?.('connection', 'state', [])) as Record<string, unknown>;
    expect(st.enabled).toBe(true);
    expect(st.connected).toBe(true);
    expect(st.wsUrl).toBe('ws://127.0.0.1:18099');
    expect(st.tokenSet).toBe(false);
    expect(st.tools).toBe(2);
    expect(st.owners).toBe(1);
    expect(st.tts).toEqual({ ready: true, provider: 'edge_tts' });
    expect(st).not.toHaveProperty('groups');
    expect(st).not.toHaveProperty('privateMode');
  });

  it('连接面板拒绝没有的方法', async () => {
    const { world } = await mount({ mode: 'all' });
    await expect(world.webUi().invoke?.('connection', 'save', [])).rejects.toThrow('没有这个方法');
  });
});

describe('版本显示', () => {
  it('WebUI 角标和状态工具都带上包版本', async () => {
    const { world } = await mount({ mode: 'all' });
    const badge = world.webUi().badges?.find((b) => b.label === '版本');
    expect(badge?.value).toMatch(/^\d+\.\d+\.\d+/);

    const status = world.tools().find((t) => t.name === 'astrbot_status');
    if (!status) throw new Error('没有状态工具');
    const out = await status.handler({}, toolCtx());
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain(`版本：${badge?.value}`);
  });
});

describe('消息投递：B 全部消息', () => {
  it('未点名的群消息也会投递，且走默认合批', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg());
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events).toHaveLength(1);
    expect(host.events[0]?.type).toBe('astrbot.message');
    expect(host.events[0]?.text).toContain('小明');
    expect(host.events[0]?.text).toContain('在吗');
    expect(host.pushOpts[0]).toBeUndefined();
  });

  it('点名的消息立即投递', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ mentioned: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(host.pushOpts[0]).toEqual({ trigger: 'flush' });
    expect(host.events[0]?.text).toContain('@你');
  });
});

describe('消息投递：私聊触发', () => {
  it('主人私聊立即投递', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage(privateMsg({ owner: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events).toHaveLength(1);
    expect(host.pushOpts[0]).toEqual({ trigger: 'flush' });
  });

  it('非主人私聊合批', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage(privateMsg({ owner: false }));
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events).toHaveLength(1);
    expect(host.pushOpts[0]).toBeUndefined();
  });

  it('主人在群里没被叫到也合批', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ owner: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events).toHaveLength(1);
    expect(host.pushOpts[0]).toBeUndefined();
  });
});

describe('消息投递：World 不再按称呼过滤', () => {
  it('没被叫到也投递，由插件决定是否推送', async () => {
    const { driver, host } = await mount({ mode: 'mention' });
    driver.emitMessage(groupMsg());
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events).toHaveLength(1);
  });

  it('被 at 时投递并标记 @你', async () => {
    const { driver, host } = await mount({ mode: 'mention' });
    driver.emitMessage(groupMsg({ mentioned: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events).toHaveLength(1);
    expect(host.events[0]?.text).toContain('@你');
  });

  it('World 不解析称呼，只使用插件传来的 mentioned', async () => {
    const { driver, host } = await mount({ mode: 'mention', nameAliases: 'Coo,库' });
    driver.emitMessage(groupMsg({ text: '库你在干嘛' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events).toHaveLength(1);
    expect(host.events[0]?.text).not.toContain('@你');
  });
});

describe('消息投递：边界', () => {
  it('World 关闭时一条都不投递', async () => {
    const { driver, host } = await mount({ enabled: false, mode: 'all' });
    driver.emitMessage(groupMsg({ mentioned: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events).toHaveLength(0);
  });

  it('空正文的消息不投递', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ text: '   ' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events).toHaveLength(0);
  });

  it('连接状态变化会写事件，且标为 internal', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitState(false);
    await Promise.resolve();
    await Promise.resolve();

    const ev = host.events.find((e) => e.type === 'astrbot.disconnected');
    expect(ev).toBeDefined();
    expect(ev?.origin).toBe('internal');
  });
});

describe('事件行格式：渠道在行首', () => {
  it('群消息以【QQ群 群名 时刻】开头，昵称带 QQ 号', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ id: 'm9', ts: '2026-10-27T18:52:00+08:00' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events[0]?.text).toBe('【QQ群 测试群 18:52】#m9 小明(QQ:42)：在吗');
  });

  it('私聊以【QQ私聊 时刻】开头，不带 @你', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage({
      id: 'p9',
      ts: '2026-10-27T18:52:00+08:00',
      conv: { kind: 'private', id: '42', name: '小明' },
      sender: { id: '42', name: '小明' },
      text: '在吗',
    });
    await Promise.resolve();
    await Promise.resolve();

    const line = host.events[0]?.text ?? '';
    expect(line.startsWith('【QQ私聊 18:52】')).toBe(true);
    expect(line).not.toContain('@你');
  });

  it('主人在群里说话时，标记和号码在同一对括号里', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ owner: true, mentioned: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events[0]?.text).toContain('(QQ:42, 主人, @你)');
  });

  it('通知也用同样的渠道头', async () => {
    const { driver, host } = await mount({ mode: 'mention' });
    driver.emitMessage({
      ...groupMsg({ id: '', text: '[撤回] 123 撤回了一条消息' }),
      notice: true,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events[0]?.text.startsWith('【QQ群 测试群 ')).toBe(true);
  });

  it('需要回复的消息后面带一行渠道提示', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ mentioned: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(host.events[0]?.text).toContain('回复这条 QQ 消息用 astrbot_send_message');
    expect(host.events[0]?.text).not.toContain('pet_say');
  });

  it('channelHint=false 时不加提示', async () => {
    const { driver, host } = await mount({ mode: 'all', channelHint: false });
    driver.emitMessage(groupMsg({ mentioned: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(host.events[0]?.text).not.toContain('回复这条 QQ 消息用 astrbot_send_message');
  });
});

describe('发消息工具', () => {
  function handlerOf(world: AstrbotWorld, name: string) {
    const tool = world.tools().find((t) => t.name === name);
    if (!tool) throw new Error(`没有工具 ${name}`);
    return tool.handler;
  }

  it('不指定会话时发回最后一条消息所在的会话', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg());
    await Promise.resolve();
    settle(world, host);

    const out = await handlerOf(world, 'astrbot_send_message')({ text: '在的' }, toolCtx());
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]?.conv.id).toBe('123456');
    expect(typeof out === 'string' ? out : out.text).toContain('已发到');
  });

  it('QQ 轮次里可以显式指定会话', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage(privateMsg({
      umo: 'default:FriendMessage:999',
      conv: { kind: 'private', id: '999', umo: 'default:FriendMessage:999' },
    }));
    await Promise.resolve();
    settle(world, host);
    await handlerOf(world, 'astrbot_send_message')(
      { text: '你好', conv_kind: 'private', conv_id: '999' },
      toolCtx(),
    );
    expect(driver.sent[0]?.conv).toMatchObject({ kind: 'private', id: '999' });
  });

  it('voice=true 会把语音意图传给桥，并按桥的回执说话', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg());
    await Promise.resolve();
    settle(world, host);
    driver.tts = { ready: true, provider: 'edge_tts' };
    driver.sendResult = { ok: true, voice: true };
    const out = await handlerOf(world, 'astrbot_send_message')(
      { text: '你好呀', voice: true },
      toolCtx(),
    );
    expect(driver.sent[0]?.voice).toBe(true);
    expect(typeof out === 'string' ? out : out.text).toContain('语音');
  });

  it('语音没有正文时直接失败', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    const out = await handlerOf(world, 'astrbot_send_message')(
      { voice: true },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? false : out.failed).toBe(true);
  });

  it('没有会话可推断时如实失败', async () => {
    const { host, world } = await mount({ mode: 'all' });
    settle(world, host);
    const out = await handlerOf(world, 'astrbot_send_message')({ text: '你好' }, toolCtx());
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('不是 QQ 消息');
    expect(typeof out === 'string' ? false : out.failed).toBe(true);
  });

  it('这一轮没有 QQ 事件时，不带 conv_id 不允许发 QQ', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    // 没有 emitMessage，也没有 settle：模拟桌宠轮次
    world.onTurnEnded();
    const out = await handlerOf(world, 'astrbot_send_message')({ text: '去群里说' }, toolCtx());
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain('必须用 conv_id 或 reply_to');
  });

  it('非 QQ 轮次显式给 conv_id，但没有主人 QQ 时拒绝', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    world.onTurnEnded();
    const out = await handlerOf(world, 'astrbot_send_message')(
      { text: '帮你转告', conv_kind: 'group', conv_id: '123456' },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? false : out.failed).toBe(true);
    expect(typeof out === 'string' ? out : out.text).toContain('先在「连接」里填主人 QQ');
  });

  it('回复默认带上 UMO，发送端以 UMO 为主键', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ umo: 'default:GroupMessage:123456' }));
    await Promise.resolve();
    settle(world, host);

    const out = await handlerOf(world, 'astrbot_send_message')({ text: '收到' }, toolCtx());
    expect(typeof out === 'string' ? true : out.failed ?? false).toBe(false);
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]?.conv.umo).toBe('default:GroupMessage:123456');
  });

  it('一轮结束后，下一轮不再默认放行 QQ 出口', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg());
    await Promise.resolve();
    settle(world, host);
    world.onTurnEnded();

    const out = await handlerOf(world, 'astrbot_send_message')({ text: '还在吗' }, toolCtx());
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain('不是 QQ 消息');
  });

  it('同一批有私聊和群时，不指定目标不发 QQ', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage({
      id: 'm-p',
      umo: 'default:FriendMessage:999',
      conv: { kind: 'private', id: '999', umo: 'default:FriendMessage:999' },
      sender: { id: '999', name: '我' },
      text: '私聊里问',
      mentioned: true,
      owner: true,
    });
    driver.emitMessage({
      id: 'm-g',
      umo: 'default:GroupMessage:123456',
      conv: { kind: 'group', id: '123456', name: '群', umo: 'default:GroupMessage:123456' },
      sender: { id: '42', name: '群友' },
      text: '群里说话',
      mentioned: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    settle(world, host);

    const out = await handlerOf(world, 'astrbot_send_message')({ text: '回谁？' }, toolCtx());
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain('多个 QQ 会话');
  });

  it('多会话轮次里，conv_id 和 reply_to 都能指定目标', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage({
      id: 'm-p',
      umo: 'default:FriendMessage:999',
      conv: { kind: 'private', id: '999', umo: 'default:FriendMessage:999' },
      sender: { id: '999', name: '我' },
      text: '私聊里问',
      mentioned: true,
      owner: true,
    });
    driver.emitMessage({
      id: 'm-g',
      umo: 'default:GroupMessage:123456',
      conv: { kind: 'group', id: '123456', name: '群', umo: 'default:GroupMessage:123456' },
      sender: { id: '42', name: '群友' },
      text: '群里说话',
      mentioned: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    settle(world, host);

    await handlerOf(world, 'astrbot_send_message')(
      { text: '回私聊', conv_kind: 'private', conv_id: '999' },
      toolCtx(),
    );
    await handlerOf(world, 'astrbot_send_message')(
      { text: '回私聊', reply_to: 'm-p' },
      toolCtx(),
    );

    expect(driver.sent).toHaveLength(2);
    expect(driver.sent[0]?.conv).toMatchObject({ kind: 'private', id: '999' });
    expect(driver.sent[1]?.conv).toMatchObject({ kind: 'private', id: '999' });
  });

  it('只有 QQ 通知时，不建立轮次也不清上一轮', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    // 先有一条人话，再单独来一条通知：通知不清上一轮。
    world.onEventsSettled(
      [
        {
          type: 'astrbot.message',
          origin: 'external',
          source: 'astrbot',
          text: '在吗',
          meta: { conv: { kind: 'group', id: '123456', name: '测试群' }, message_id: 'm1' },
        } as unknown as EventEnvelope,
      ],
      'delivered',
    );
    world.onEventsSettled(
      [
        {
          type: 'astrbot.message',
          origin: 'external',
          source: 'astrbot',
          text: '[撤回]',
          meta: {
            notice: true,
            conv: { kind: 'group', id: '123456' },
          },
        } as unknown as EventEnvelope,
      ],
      'delivered',
    );
    const out = await handlerOf(world, 'astrbot_send_message')({ text: '看到了' }, toolCtx());
    expect(driver.sent).toHaveLength(1);
    expect(typeof out === 'string' ? true : out.failed ?? false).toBe(false);
  });

  it('桥拒绝时回执带原因且标失败', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ umo: 'default:GroupMessage:123456' }));
    await Promise.resolve();
    settle(world, host);
    driver.sendResult = { ok: false, error: '桥拒绝了' };
    const out = await handlerOf(world, 'astrbot_send_message')(
      { text: '你好', conv_id: '123456' },
      toolCtx(),
    );
    expect(typeof out === 'string' ? false : out.failed).toBe(true);
    expect(typeof out === 'string' ? out : out.text).toContain('桥拒绝了');
  });

  it('结果未知时明确提醒可能已发出，不要直接重试', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ umo: 'default:GroupMessage:123456' }));
    await Promise.resolve();
    settle(world, host);
    driver.sendResult = { ok: false, uncertain: true, error: '桥没有确认' };
    const out = await handlerOf(world, 'astrbot_send_message')(
      { text: '你好', conv_id: '123456' },
      toolCtx(),
    );
    expect(typeof out === 'string' ? false : out.failed).toBe(true);
    expect(typeof out === 'string' ? out : out.text).toContain('可能已经发出');
    expect(typeof out === 'string' ? out : out.text).toContain('不要直接重发');
  });

  it('World 不再本地限流，发送频率交给插件', async () => {
    const { driver, host, world } = await mount({ mode: 'all', maxSendsPerMinute: 1 });
    driver.emitMessage(groupMsg({ umo: 'default:GroupMessage:123456' }));
    await Promise.resolve();
    settle(world, host);
    const send = handlerOf(world, 'astrbot_send_message');
    const first = await send({ text: 'a', conv_id: '123456' }, toolCtx());
    const second = await send({ text: 'b', conv_id: '123456' }, toolCtx());

    expect(driver.sent).toHaveLength(2);
    expect(typeof first === 'string' ? true : first.failed ?? false).toBe(false);
    expect(typeof second === 'string' ? true : second.failed ?? false).toBe(false);
  });

  it('未连接时不发送', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg());
    await Promise.resolve();
    settle(world, host);
    driver.connected = false;
    const out = await handlerOf(world, 'astrbot_send_message')(
      { text: 'x', conv_id: '1' },
      toolCtx(),
    );
    expect(typeof out === 'string' ? out : out.text).toContain('未建立');
    expect(driver.sent).toHaveLength(0);
  });
});

describe('发图', () => {
  function handlerOf(world: AstrbotWorld, name: string) {
    const tool = world.tools().find((t) => t.name === name);
    if (!tool) throw new Error(`没有工具 ${name}`);
    return tool.handler;
  }

  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

  it('有权限时把 log: 句柄解析成图发出去', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    host.blobs.set('log:abc123.jpg', { bytes: jpeg, mime: 'image/jpeg' });
    driver.emitMessage(groupMsg({ canScreenshot: true }));
    await Promise.resolve();
    settle(world, host);

    const out = await handlerOf(world, 'astrbot_send_message')(
      { text: '这是屏幕', image: 'log:abc123.jpg' },
      toolCtx(),
    );

    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]?.image?.mime).toBe('image/jpeg');
    expect(driver.sent[0]?.image?.base64).toBe(Buffer.from(jpeg).toString('base64'));
    expect(typeof out === 'string' ? out : out.text).toContain('图片');
  });

  it('通知不会撤销已经拿到的发图权限', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    host.blobs.set('log:abc123.jpg', { bytes: jpeg, mime: 'image/jpeg' });
    driver.emitMessage(groupMsg({ canScreenshot: true }));
    await Promise.resolve();
    driver.emitMessage({
      ...groupMsg({ id: '', text: '[撤回] 某人 撤回了一条消息' }),
      notice: true,
    });
    await Promise.resolve();
    settle(world, host);

    await handlerOf(world, 'astrbot_send_message')({ image: 'log:abc123.jpg' }, toolCtx());
    expect(driver.sent).toHaveLength(1);
  });

  it('没有权限时拒绝发图', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    host.blobs.set('log:abc123.jpg', { bytes: jpeg, mime: 'image/jpeg' });
    // 桥没有给 canScreenshot
    driver.emitMessage(groupMsg({ umo: 'default:GroupMessage:123456' }));
    await Promise.resolve();
    settle(world, host);

    const out = await handlerOf(world, 'astrbot_send_message')(
      { image: 'log:abc123.jpg', conv_id: '123456' },
      toolCtx(),
    );

    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? false : out.failed).toBe(true);
    expect(typeof out === 'string' ? out : out.text).toContain('权限');
  });

  it('句柄不存在时如实失败', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ canScreenshot: true }));
    await Promise.resolve();
    settle(world, host);

    const out = await handlerOf(world, 'astrbot_send_message')(
      { image: 'log:nope.jpg' },
      toolCtx(),
    );

    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain('找不到附件');
  });

  it('既没正文也没图时不发', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    const out = await handlerOf(world, 'astrbot_send_message')({}, toolCtx());
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain('没有正文也没有图片');
  });
});

describe('入站图片', () => {
  it('帧里的图片变成事件附件', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage({
      ...groupMsg({ id: 'i1', text: '[图片]' }),
      images: [{ mime: 'image/jpeg', base64: Buffer.from([1, 2, 3]).toString('base64') }],
    });
    await Promise.resolve();
    await Promise.resolve();

    const event = host.events[0] as unknown as {
      blobs?: Array<{ mime: string; fallbackText: string }>;
    };
    expect(event.blobs).toHaveLength(1);
    expect(event.blobs?.[0]?.mime).toBe('image/jpeg');
    expect(event.blobs?.[0]?.fallbackText).toBe('[图片]');
  });

  it('没有图片时不动事件形状', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg());
    await Promise.resolve();
    await Promise.resolve();
    expect((host.events[0] as unknown as { blobs?: unknown }).blobs).toBeUndefined();
  });
});

describe('通知事件', () => {
  it('撤回通知按上下文收下，只排队不叫醒', async () => {
    const { driver, host } = await mount({ mode: 'mention' });
    driver.emitMessage({
      ...groupMsg({ id: '', text: '[撤回] 123 撤回了一条消息' }),
      notice: true,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events).toHaveLength(1);
    expect(host.events[0]?.text).toContain('[撤回]');
    // 通知没有消息号，也不该带「谁: 」
    expect(host.events[0]?.text).not.toContain('#');
    expect(host.pushOpts[0]).toEqual({ trigger: 'piggyback' });
  });

  it('戳一戳不当成点名', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage({ ...groupMsg({ id: '', text: '[戳一戳] 1 戳了 2' }), notice: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events[0]?.text).not.toContain('(@你)');
    expect(host.events[0]?.meta?.notice).toBe(true);
  });
});

describe('历史检索', () => {
  function handlerOf(world: AstrbotWorld, name: string) {
    const tool = world.tools().find((t) => t.name === name);
    if (!tool) throw new Error(`没有工具 ${name}`);
    return tool.handler;
  }

  const textOf = (out: string | { text: string }): string =>
    typeof out === 'string' ? out : out.text;

  it('消息行带平台消息号，便于引用回复', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ id: 'abc123' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(host.events[0]?.text).toContain('#abc123');
  });

  it('UMO 会写进事件 meta，供历史和路由使用', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ umo: 'default:GroupMessage:123456' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(host.events[0]?.meta?.umo).toBe('default:GroupMessage:123456');
  });

  it('读最近消息，按时间升序', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ id: 'm1', text: '第一句' }));
    await Promise.resolve();
    driver.emitMessage(groupMsg({ id: 'm2', text: '第二句' }));
    await Promise.resolve();

    const text = textOf(await handlerOf(world, 'astrbot_read_history')({}, toolCtx()));
    expect(text.indexOf('第一句')).toBeLessThan(text.indexOf('第二句'));
  });

  it('关键词搜索命中', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ id: 'm1', text: '今天吃什么' }));
    await Promise.resolve();
    driver.emitMessage(groupMsg({ id: 'm2', text: '随便' }));
    await Promise.resolve();

    const text = textOf(await handlerOf(world, 'astrbot_read_history')({ keyword: '吃' }, toolCtx()));
    expect(text).toContain('今天吃什么');
  });

  it('不同会话互不串台', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ id: 'g1', text: '在这个群' }));
    await Promise.resolve();
    driver.emitMessage(
      groupMsg({ id: 'p1', text: '在另一个群', conv: { kind: 'group', id: '999', name: '别的群' } }),
    );
    await Promise.resolve();

    const text = textOf(
      await handlerOf(world, 'astrbot_read_history')({ conv_id: '999', conv_kind: 'group' }, toolCtx()),
    );
    expect(text).toContain('在另一个群');
    expect(text).not.toContain('在这个群');
  });

  it('没有记录时如实说明', async () => {
    const { world } = await mount({ mode: 'all' });
    const text = textOf(
      await handlerOf(world, 'astrbot_read_history')({ conv_id: '1', conv_kind: 'group' }, toolCtx()),
    );
    expect(text).toContain('没有找到');
  });

  it('别的会话命中再多，也不会把本会话的命中挤掉', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    // 先堆满别的会话的命中，让「先 grep 再过滤」的实现把本会话挤出去。
    for (let i = 0; i < 25; i++) {
      driver.emitMessage(
        groupMsg({
          id: `b${i}`,
          text: `别处的找 ${i}`,
          conv: { kind: 'group', id: '999', name: '别的群' },
        }),
      );
      await Promise.resolve();
    }
    driver.emitMessage(groupMsg({ id: 'a1', text: '我们要找的这句' }));
    await Promise.resolve();
    await Promise.resolve();

    const text = textOf(
      await handlerOf(world, 'astrbot_read_history')({
        conv_id: '123456',
        conv_kind: 'group',
        keyword: '找',
      }, toolCtx()),
    );
    expect(text).toContain('我们要找的这句');
  });

  it('不会把别的会话的上下文当成命中的内容', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    driver.emitMessage(
      groupMsg({
        id: 'b1',
        text: '别处的秘密',
        conv: { kind: 'group', id: '999', name: '别的群' },
      }),
    );
    await Promise.resolve();
    driver.emitMessage(groupMsg({ id: 'a1', text: '本群普通聊天' }));
    await Promise.resolve();
    await Promise.resolve();

    const text = textOf(
      await handlerOf(world, 'astrbot_read_history')({
        conv_id: '123456',
        conv_kind: 'group',
        keyword: '秘密',
        context: 2,
      }, toolCtx()),
    );
    expect(text).toContain('没有找到');
    expect(text).not.toContain('本群普通聊天');
  });
});

describe('QQ 组件入口', () => {
  it('引用图片保留附件，展开引用或图片都能返回原图', async () => {
    const { driver, host, world } = await mount();
    const handle = 'log:quote.png';
    host.blobs.set(handle, { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    driver.emitMessage(groupMsg({
      segments: [{ type: 'reply', fields: { id: 'prior', text: '请看原图' }, children: [
        { type: 'image', fields: { attachment: '0' } },
      ] }],
      images: [{ mime: 'image/png', base64: 'AQID' }],
    }));
    const event = host.events[0]!;
    expect(event.text).toContain('请看原图 [图片]');
    expect(event.blobs).toHaveLength(1);
    event.blobs = [{ handle, mime: 'image/png', fallbackText: '[图片]' }];
    settle(world, host);
    const handler = world.tools().find((tool) => tool.name === 'astrbot_read_message_component')!.handler;
    for (const path of [[1], [1, 1]]) {
      expect(await handler({ message_id: 'm1', path }, toolCtx())).toMatchObject({ blobs: [{ handle }] });
    }
  });

  it('只补用同一 UMO 已保存的引用图片，并遵循桥的原图模式', async () => {
    const { driver, host } = await mount();
    host.modelFacts.accepts = () => true;
    const umo = 'default:GroupMessage:123456';
    const handle = 'log:earlier.png';
    host.blobs.set(handle, { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    driver.emitMessage(groupMsg({ id: 'earlier', umo }));
    host.events[0]!.blobs = [{ handle, mime: 'image/png', fallbackText: '[图片]' }];

    const quote = (id: string, permit: boolean, target = umo) => parseMessage(groupMsg({
      id, umo: target, quote_image_history: permit,
      segments: [{ type: 'reply', fields: { id: 'earlier' } }],
    }))!;
    driver.emitMessage(quote('m1', true));
    expect(host.events[1]?.text).toContain('引用原图');
    expect(host.events[1]?.blobs).toMatchObject([{ handle }]);
    driver.emitMessage(quote('m2', false));
    expect(host.events[2]?.blobs).toBeUndefined();
    driver.emitMessage(quote('m3', true, 'other:GroupMessage:123456'));
    expect(host.events[3]?.blobs).toBeUndefined();
  });

  it('按原顺序入库，能查看引用中的原文和文件详情', async () => {
    const { driver, host, world } = await mount();
    const raw = {
      ...groupMsg(),
      segments: [
        { type: 'reply', fields: { id: 'prior', name: '旧作者' }, children: [
          { type: 'plain', fields: { text: '引用正文' } },
        ] },
        { type: 'plain', fields: { text: '正文' } },
        { type: 'file', fields: { name: '示例.zip', size: '120' } },
      ],
    };
    driver.emitMessage(parseMessage(raw)!);
    settle(world, host);
    const handler = world.tools().find((tool) => tool.name === 'astrbot_read_message_component')!.handler;
    expect(host.events[0]?.text).toContain('[引用 · 组件 1] 旧作者 引用正文 正文 [文件 · 组件 3]');
    expect(await handler({ message_id: 'm1', path: [1, 1] }, toolCtx())).toBe('引用正文');
    expect(await handler({ message_id: 'm1', path: [3] }, toolCtx())).toContain('示例.zip');
    expect(driver.toolCalls).toHaveLength(0);
  });

  it('以当前 QQ 会话身份读取转发，拒绝跨会话组件', async () => {
    const { driver, host, world } = await mount();
    driver.emitMessage(groupMsg({ segments: [{ type: 'forward', fields: { id: 'forward' } }] }));
    driver.toolResult = { ok: true, result: '转发中的原文' };
    settle(world, host);
    const handler = world.tools().find((tool) => tool.name === 'astrbot_read_message_component')!.handler;
    expect(await handler({ message_id: 'm1', path: [1], offset: 8 }, toolCtx())).toBe('转发中的原文');
    expect(driver.toolCalls[0]).toMatchObject({
      name: 'cortico_read_message_component',
      args: { message_id: 'm1', path: [1], offset: 8 },
      turn: 'm1',
    });
    expect(await handler({ message_id: 'm1', path: [1], conv_id: 'other' }, toolCtx()))
      .toMatchObject({ failed: true });
    expect(driver.toolCalls).toHaveLength(1);
  });

  it('远程组件回执携带图片，纯资料仍是文字回执', async () => {
    const { driver, host, world } = await mount();
    driver.emitMessage(groupMsg({ segments: [{ type: 'nodes', fields: {}, children: [
      { type: 'image', fields: { media_state: 'deferred' } },
      { type: 'file', fields: { media_state: 'metadata', name: '测试文档.pdf' } },
    ] }] }));
    driver.toolResult = { ok: true, result: '转发原图', images: [{ mime: 'image/png', base64: 'AQID' }] };
    settle(world, host);
    const handler = world.tools().find((tool) => tool.name === 'astrbot_read_message_component')!.handler;
    expect(await handler({ message_id: 'm1', path: [1, 1] }, toolCtx())).toMatchObject({
      text: '转发原图', blobs: [{ mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) }],
    });
    expect(await handler({ message_id: 'm1', path: [1, 2] }, toolCtx())).toContain('资料信息');
    expect(driver.toolCalls).toHaveLength(1);
  });
});

describe('主人与截图授权', () => {
  function handlerOf(world: AstrbotWorld, name: string) {
    const tool = world.tools().find((t) => t.name === name);
    if (!tool) throw new Error(`没有工具 ${name}`);
    return tool.handler;
  }

  it('owner=true 的消息标 主人', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ owner: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(host.events[0]?.text).toContain('主人');
  });

  it('管理员但不是主人时不标主人', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ role: 'admin', owner: false }));
    await Promise.resolve();
    await Promise.resolve();
    expect(host.events[0]?.text).not.toContain('主人');
  });

  it('普通成员的消息不带标记', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ role: 'member', owner: false, mentioned: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(host.events[0]?.text).not.toContain('主人');
  });

  it('管理员给的授权会被下一个陌生人撤销', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    host.blobs.set('log:shot.jpg', { bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' });

    driver.emitMessage(groupMsg({ owner: true, canScreenshot: true }));
    await Promise.resolve();
    settle(world, host);
    const allowed = await handlerOf(world, 'astrbot_send_message')({ image: 'log:shot.jpg' }, toolCtx());
    expect(typeof allowed === 'string' ? true : allowed.failed ?? false).toBe(false);

    driver.emitMessage(groupMsg({ role: 'member', sender: { id: '99', name: '路人' } }));
    await Promise.resolve();
    const denied = await handlerOf(world, 'astrbot_send_message')({ image: 'log:shot.jpg' }, toolCtx());
    expect(typeof denied === 'string' ? false : denied.failed).toBe(true);
  });

  it('授权只在当前 QQ 轮次有效，桌宠轮次不能拿旧授权发图', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    host.blobs.set('log:shot.jpg', { bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' });

    driver.emitMessage(groupMsg({ id: 'admin1', owner: true, canScreenshot: true }));
    await Promise.resolve();
    settle(world, host);
    world.onTurnEnded();

    const denied = await handlerOf(world, 'astrbot_send_message')({
      conv_id: '123456',
      conv_kind: 'group',
      image: 'log:shot.jpg',
    }, toolCtx());
    expect(typeof denied === 'string' ? false : denied.failed).toBe(true);
  });

  it('当前轮次的授权不能拿去给别的会话发图', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    host.blobs.set('log:shot.jpg', { bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' });

    driver.emitMessage(groupMsg({ id: 'admin1', owner: true, canScreenshot: true }));
    await Promise.resolve();
    settle(world, host);

    const denied = await handlerOf(world, 'astrbot_send_message')({
      conv_id: '999',
      conv_kind: 'group',
      image: 'log:shot.jpg',
    }, toolCtx());
    expect(typeof denied === 'string' ? false : denied.failed).toBe(true);
  });

  it('环境提示词区分 AstrBot 管理员与实际发言者', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    driver.ownerIds = ['10001', '10002'];
    const identity = world.envPromptVars()['astrbot.owner'];
    expect(identity).toContain('管理员 QQ 帐号为 10001、10002');
    expect(identity).toContain('发言者的身份以收到的 QQ 消息为准');
  });

  it('桥未提供管理员名单时按实际消息来源描述', async () => {
    const { world } = await mount({ mode: 'all' });
    expect(world.envPromptVars()['astrbot.owner']).toContain('未提供 AstrBot 管理员名单');
  });
});

describe('环境提示词变量', () => {
  it('未连接与已连接给出不同的话', async () => {
    const { world } = await mount({ mode: 'mention', nameAliases: 'Coo' });
    const vars = world.envPromptVars();
    expect(vars['astrbot.scope']).toContain('AstrBot 插件控制');
    expect(vars['astrbot.connection']).toContain('已连上');
  });

  it('见过会话后列进变量里', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg());
    await Promise.resolve();

    const vars = world.envPromptVars();
    expect(vars['astrbot.conversations']).toContain('123456');
    expect(vars['astrbot.lastConversation']).toContain('123456');
  });
});

describe('私聊与时间前缀', () => {
  /** 一条私聊消息。 */
  function privateMsg(patch: Record<string, unknown> = {}) {
    return {
      id: 'p1',
      ts: '2026-10-26T09:05:00+08:00',
      conv: { kind: 'private' as const, id: '42', name: '小明' },
      sender: { id: '42', name: '小明' },
      text: '在吗',
      ...patch,
    };
  }

  it('A 模式下私聊一律投递，不需要点名', async () => {
    const { driver, host } = await mount({ mode: 'mention' });
    driver.emitMessage(privateMsg());
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events).toHaveLength(1);
    expect(host.events[0]?.text).toContain('私聊');
    // 私聊不该带「@你」的标记
    expect(host.events[0]?.text).not.toContain('@你');
    expect(host.events[0]?.meta?.mentioned).toBe(true);
  });

  it('正文带 HH:MM 时间前缀', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ ts: '2026-10-26T09:05:00+08:00' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events[0]?.text).toMatch(/^【QQ群 测试群 09:05】/);
  });

  it('关掉 includeTime 就不带时间前缀', async () => {
    const { driver, host } = await mount({ mode: 'all', includeTime: false });
    driver.emitMessage(groupMsg({ ts: '2026-10-26T09:05:00+08:00' }));
    await Promise.resolve();
    await Promise.resolve();

    // 关掉时间后，行首仍是渠道，紧接着是消息号。
    expect(host.events[0]?.text).toMatch(/^【QQ群 测试群】#m1 /);
  });
});

describe('帧解析', () => {
  it('收下正常消息帧', () => {
    const m = parseMessage({
      t: 'msg',
      id: 'x1',
      conv: { kind: 'group', id: 123, name: '群' },
      sender: { id: 7, name: '甲' },
      text: '嗨',
      mentioned: true,
    });
    expect(m?.conv).toEqual({ kind: 'group', id: '123', name: '群' });
    expect(m?.sender).toEqual({ id: '7', name: '甲' });
    expect(m?.mentioned).toBe(true);
  });

  it('缺会话或缺 id 的帧丢弃', () => {
    expect(parseMessage({ t: 'msg', text: 'x' })).toBeNull();
    expect(parseMessage({ t: 'msg', conv: { kind: 'group', id: '' } })).toBeNull();
    expect(parseMessage({ t: 'msg', conv: { kind: '别的', id: '1' } })).toBeNull();
  });

  it('帧里的 umo 会同时落到消息和会话上', () => {
    const msg = parseMessage({
      t: 'msg',
      id: 'u1',
      umo: 'default:GroupMessage:123456789',
      conv: { kind: 'group', id: '123456789' },
      text: '在吗',
    });
    expect(msg?.umo).toBe('default:GroupMessage:123456789');
    expect(msg?.conv.umo).toBe('default:GroupMessage:123456789');
  });

  it('can.screenshot 只有明确为 true 才算允许', () => {
    const base = { t: 'msg', conv: { kind: 'group', id: '1' }, text: 'x' };
    expect(parseMessage({ ...base, can: { screenshot: true } })?.canScreenshot).toBe(true);
    expect(parseMessage({ ...base, can: { screenshot: 'yes' } })?.canScreenshot).toBe(false);
    expect(parseMessage({ ...base, can: {} })?.canScreenshot).toBe(false);
    expect(parseMessage(base)?.canScreenshot).toBe(false);
  });

  it('frame 里的 owner / channel / image_errors 都收下', () => {
    const base = { t: 'msg', conv: { kind: 'group', id: '1' }, text: 'x' };
    expect(parseMessage({ ...base, channel: 'qq' })?.channel).toBe('qq');
    expect(parseMessage({ ...base, owner: true })?.owner).toBe(true);
    expect(parseMessage({ ...base, owner: false, role: 'admin' })?.owner).toBe(false);
    // 旧版桥没有 owner：管理员仍然当主人。
    expect(parseMessage({ ...base, role: 'admin' })?.owner).toBe(true);
    expect(parseMessage({ ...base, role: 'member' })?.owner).toBe(false);

    expect(
      parseMessage({
        ...base,
        image_errors: [
          { index: 0, reason: '下载超时' },
          { index: -1, reason: '坏数据' },
        ],
      })?.imageErrors,
    ).toEqual([{ index: 0, reason: '下载超时' }]);
  });

  it('帧里的图片只留形状对的', () => {
    const base = { t: 'msg', conv: { kind: 'group', id: '1' }, text: 'x' };
    expect(parseMessage(base)?.images).toBeUndefined();
    expect(parseMessage({ ...base, kind: 'notice' })?.notice).toBe(true);
    expect(parseMessage(base)?.notice).toBe(false);

    const msg = parseMessage({
      ...base,
      images: [
        { mime: 'image/jpeg', base64: 'AAAA' },
        { mime: 'text/plain', base64: 'AAAA' },
        { mime: 'image/png', base64: '' },
        { mime: 'image/png', base64: 'BBBB' },
      ],
    });
    expect(msg?.images).toEqual([
      { mime: 'image/jpeg', base64: 'AAAA' },
      { mime: 'image/png', base64: 'BBBB' },
    ]);
  });
});

describe('工具桥接', () => {
  function handlerOf(world: AstrbotWorld, name: string) {
    const tool = world.tools().find((t) => t.name === name);
    if (!tool) throw new Error(`没有工具 ${name}`);
    return tool.handler;
  }

  it('带这一轮消息的身份调工具，并把结果回传', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ id: 'm42', text: '点首歌' }));
    await Promise.resolve();
    settle(world, host);

    driver.toolResult = { ok: true, result: '歌单：七里香' };
    const out = await handlerOf(world, 'astrbot_call_tool')(
      { name: 'play_song_by_name', args: { name: '七里香' } },
      toolCtx(),
    );

    expect(driver.toolCalls).toEqual([
      { name: 'play_song_by_name', args: { name: '七里香' }, turn: 'm42' },
    ]);
    expect(typeof out === 'string' ? out : out.text).toBe('歌单：七里香');
  });

  it('桌宠轮次没有主人 QQ 时不借上一条消息的身份', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ id: 'm42' }));
    await Promise.resolve();
    settle(world, host);
    world.onTurnEnded();

    const out = await handlerOf(world, 'astrbot_call_tool')({ name: 'x' }, toolCtx());
    expect(driver.toolCalls).toHaveLength(0);
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('主人 QQ');
  });

  it('Coo 轮次用连接页里的主人 QQ 借身份', async () => {
    const { driver, world } = await mount({ ownerId: '100000001' });
    driver.ownerIds = ['100000001'];
    driver.toolResult = { ok: true, result: '晴天 / 周杰伦' };

    const out = await handlerOf(world, 'astrbot_call_tool')(
      { name: 'query_lyrics_by_name', args: { song: '晴天' } },
      toolCtx(),
    );

    expect(driver.toolCalls).toEqual([
      {
        name: 'query_lyrics_by_name',
        args: { song: '晴天' },
        turn: '',
        actor: { kind: 'owner', id: '100000001' },
      },
    ]);
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toBe('晴天 / 周杰伦');
  });

  it('主人 QQ 不在 AstrBot 管理员里时拒绝', async () => {
    const { driver, world } = await mount({ ownerId: '10001' });
    driver.ownerIds = ['100000001'];

    const out = await handlerOf(world, 'astrbot_call_tool')({ name: 'x' }, toolCtx());
    expect(driver.toolCalls).toHaveLength(0);
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('不在 AstrBot 的管理员名单');
  });

  it('World 不再过滤群消息，最后一条成为工具身份', async () => {
    const { driver, host, world } = await mount({ mode: 'mention' });
    driver.emitMessage(groupMsg({ id: 'm1', mentioned: true }));
    await Promise.resolve();
    driver.emitMessage(
      groupMsg({
        id: 'm2',
        mentioned: false,
        conv: { kind: 'group', id: '999999', name: '别的群' },
        sender: { id: '77', name: '路人' },
      }),
    );
    await Promise.resolve();
    settle(world, host);

    await handlerOf(world, 'astrbot_call_tool')({ name: 'x' }, toolCtx());
    expect(driver.toolCalls[0]?.turn).toBe('m2');
  });

  it('通知不会把默认回复会话带到别的群', async () => {
    const { driver, host, world } = await mount({ mode: 'mention' });
    driver.emitMessage(groupMsg({ id: 'a1', mentioned: true }));
    await Promise.resolve();
    driver.emitMessage({
      ...groupMsg({
        id: '',
        text: '[退群] 某人 退出了群',
        conv: { kind: 'group', id: '999999', name: '别的群' },
      }),
      notice: true,
    });
    await Promise.resolve();
    settle(world, host);

    await handlerOf(world, 'astrbot_send_message')({ text: '在的' }, toolCtx());
    expect(driver.sent[0]?.conv.id).toBe('123456');
  });

  it('还没收到消息时不带身份，直接拒绝', async () => {
    const { driver, world } = await mount();
    const out = await handlerOf(world, 'astrbot_call_tool')({ name: 'x' }, toolCtx());
    expect(driver.toolCalls).toHaveLength(0);
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('主人 QQ');
  });

  it('桥拒绝时把原因带回去', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ id: 'm7' }));
    await Promise.resolve();
    settle(world, host);
    driver.toolResult = { ok: false, error: 'Permission denied' };

    const out = await handlerOf(world, 'astrbot_call_tool')({ name: 'bili_block_user' }, toolCtx());
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('Permission denied');
  });

  it('桥给了中文 note 时优先说人话，错误码放括号里', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ id: 'm8' }));
    await Promise.resolve();
    settle(world, host);
    // 假驱动同样按 ToolResult 收结果，note 是失败回执里的中文说明。
    driver.toolResult = {
      ok: false,
      error: 'tool_failed',
      note: '工具执行失败，详情见插件日志',
    };

    const out = await handlerOf(world, 'astrbot_call_tool')({ name: 'play_song_by_name' }, toolCtx());
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('工具执行失败，详情见插件日志');
    expect(text).toContain('（tool_failed）');
  });

  it('桥没给 note 时仍然显示错误码', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ id: 'm9' }));
    await Promise.resolve();
    settle(world, host);
    driver.toolResult = { ok: false, error: 'busy' };

    const out = await handlerOf(world, 'astrbot_call_tool')({ name: 'play_song_by_name' }, toolCtx());
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('busy');
    expect(text).not.toContain('（busy）');
  });

  it('成功回执不受 note 逻辑影响', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ id: 'ma' }));
    await Promise.resolve();
    settle(world, host);
    driver.toolResult = { ok: true, result: '已处理' };

    const out = await handlerOf(world, 'astrbot_call_tool')({ name: 'play_song_by_name' }, toolCtx());
    expect(typeof out === 'string' ? out : out.text).toBe('已处理');
  });

  it('工具清单进了环境提示词与状态工具', async () => {
    const { driver, world } = await mount();
    driver.emitTools([{ name: 'search_bilibili', risk: 'read', desc: '搜 B 站' }]);

    expect(world.envPromptVars()['astrbot.tools']).toContain('search_bilibili');

    const status = await handlerOf(world, 'astrbot_status')({}, toolCtx());
    const text = typeof status === 'string' ? status : status.text;
    expect(text).toContain('search_bilibili');
  });

  it('状态工具说清这一轮是不是 QQ 轮次', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.tts = { ready: true, provider: 'edge_tts' };

    const first = await handlerOf(world, 'astrbot_status')({}, toolCtx());
    let text = typeof first === 'string' ? first : first.text;
    expect(text).toContain('这一轮：没有投递过 QQ 消息');
    expect(text).toContain('语音：可用（edge_tts）');

    driver.emitMessage(groupMsg({ ts: '2026-10-27T18:52:00+08:00' }));
    await Promise.resolve();
    settle(world, host);

    const out = await handlerOf(world, 'astrbot_status')({}, toolCtx());
    text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('这一轮：QQ群「测试群」');
    expect(text).toContain('最近收到：QQ群「测试群」 小明 18:52');
  });
});

// ---------------------------------------------------------------------------
// W-001 / W-003 / W-008 / W-015：轮次判定与身份收紧
// ---------------------------------------------------------------------------

const QQ_CONV = { kind: 'group', id: '123456', name: '测试群' } as const;

function humanEvent(id = 'm1', conv: Record<string, unknown> = QQ_CONV): EventEnvelope {
  return {
    type: 'astrbot.message',
    origin: 'external',
    source: 'astrbot',
    text: '在吗',
    meta: { conv, message_id: id },
  } as unknown as EventEnvelope;
}

function qqNoticeEvent(conv: Record<string, unknown> = { kind: 'group', id: '999999' }): EventEnvelope {
  return {
    type: 'astrbot.message',
    origin: 'external',
    source: 'astrbot',
    text: '[撤回] 别人撤回了一条消息',
    meta: { notice: true, conv, message_id: 'n1' },
  } as unknown as EventEnvelope;
}

function toolNoticeEvent(): EventEnvelope {
  return {
    type: 'astrbot.notice',
    origin: 'external',
    source: 'astrbot',
    text: '[AstrBot] 可用工具：x',
    meta: { kind: 'tools' },
  } as unknown as EventEnvelope;
}

function toolHandler(world: AstrbotWorld, name: string) {
  const tool = world.tools().find((t) => t.name === name);
  if (!tool) throw new Error(`没有工具 ${name}`);
  return tool.handler;
}

describe('QQ 扩展不接管本地回复出口', () => {
  it('环境提示词和发送工具不指定其他 World 的发言工具或 QQ 优先级', async () => {
    const prompt = readFileSync(new URL('../src/ENV_PROMPT.md', import.meta.url), 'utf8');
    const { world } = await mount();
    const send = world.tools().find(t => t.name === 'astrbot_send_message')!;
    for (const text of [prompt, send.description]) {
      expect(text).not.toMatch(/\b(?:pet_say|pet_act|live2d_pet_say|console_send)\b/);
      expect(text).not.toContain('就优先回 QQ');
      expect(text).not.toContain('先回 QQ');
    }
    expect(prompt).toContain('非 QQ 消息沿用来源 World 的规则与回复工具');
  });

  it('只按本包事件判定：其他 World 的事件不会建立或延长 QQ 轮次', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    const local = {
      type: 'desktop-pet.message', source: 'desktop-pet', origin: 'external',
      text: '本地对话', meta: { via: 'chat', text: '本地对话' },
    } as unknown as EventEnvelope;

    // 只有本地事件：不建立 QQ 轮次。
    world.onEventsSettled([local], 'delivered');
    let out = await toolHandler(world, 'astrbot_send_message')({ text: '答复' }, toolCtx());
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain('不是 QQ 消息');

    // QQ 轮次结束后再来本地事件：不恢复 QQ 出口。
    world.onEventsSettled([humanEvent('m1')], 'delivered');
    world.onTurnEnded();
    world.onEventsSettled([local], 'delivered');
    out = await toolHandler(world, 'astrbot_send_message')({ text: '答复' }, toolCtx());
    expect(driver.sent).toHaveLength(0);
  });
});

describe('轮次判定：通知不建立也不污染 QQ 轮次', () => {
  it('[人话, 工具清单通知] 不算 mixed，正常发 QQ', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    world.onEventsSettled([humanEvent('m1'), toolNoticeEvent()], 'delivered');

    const out = await toolHandler(world, 'astrbot_send_message')({ text: '在的' }, toolCtx());
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]?.conv.id).toBe('123456');
    expect(typeof out === 'string' ? true : out.failed ?? false).toBe(false);
  });

  it('[人话] 之后单独来 [QQ 通知]，发送仍回原群', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    world.onEventsSettled([humanEvent()], 'delivered');
    world.onEventsSettled([qqNoticeEvent()], 'delivered');

    const out = await toolHandler(world, 'astrbot_send_message')({ text: '看到了' }, toolCtx());
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]?.conv.id).toBe('123456');
    expect(typeof out === 'string' ? true : out.failed ?? false).toBe(false);
  });

  it('纯通知（没有上一轮）不建立轮次，发送拒绝', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    world.onEventsSettled([qqNoticeEvent()], 'delivered');

    const out = await toolHandler(world, 'astrbot_send_message')({ text: '发一下' }, toolCtx());
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? false : out.failed).toBe(true);
  });

  it('纯 astrbot.notice 保留上一轮 QQ 出口', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    world.onEventsSettled([humanEvent()], 'delivered');
    world.onEventsSettled([toolNoticeEvent()], 'delivered');

    const out = await toolHandler(world, 'astrbot_send_message')({ text: '还在' }, toolCtx());
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]?.conv.id).toBe('123456');
    expect(typeof out === 'string' ? true : out.failed ?? false).toBe(false);
  });
});

describe('工具身份：过期轮次不得回退 owner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('过期的 QQ 轮次不借主人身份', async () => {
    vi.useFakeTimers();
    const { driver, world } = await mount({ ownerId: '100000001' });
    driver.ownerIds = ['100000001'];
    world.onEventsSettled([humanEvent()], 'delivered');
    vi.advanceTimersByTime(QQ_TURN_TTL_MS + 1);

    const out = await toolHandler(world, 'astrbot_call_tool')({ name: 'x' }, toolCtx());
    expect(driver.toolCalls).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain('过期');
  });

  it('QQ 轮次没有可执行消息 id 时拒绝，不回退 owner', async () => {
    const { driver, world } = await mount({ ownerId: '100000001' });
    driver.ownerIds = ['100000001'];
    // 有人话，但帧里没有 message_id：不能拿来当工具身份。
    const noId = {
      type: 'astrbot.message',
      origin: 'external',
      source: 'astrbot',
      text: '在吗',
      meta: { conv: QQ_CONV },
    } as unknown as EventEnvelope;
    world.onEventsSettled([noId], 'delivered');

    const out = await toolHandler(world, 'astrbot_call_tool')({ name: 'x' }, toolCtx());
    expect(driver.toolCalls).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain('没有可执行工具');
  });

  it('90s 间隔的连续工具调用靠 touchTurn 续期，不被 2 分钟 TTL 误伤', async () => {
    vi.useFakeTimers();
    const { driver, world } = await mount({ mode: 'all' });
    world.onEventsSettled([humanEvent('m42')], 'delivered');

    for (let i = 0; i < 3; i++) {
      await toolHandler(world, 'astrbot_call_tool')({ name: 'x' }, toolCtx());
      vi.advanceTimersByTime(90_000);
    }

    expect(driver.toolCalls.map((c) => c.turn)).toEqual(['m42', 'm42', 'm42']);
    expect(driver.toolCalls.every((c) => !c.actor)).toBe(true);
  });

  it('单个工具耗时超过 2 分钟，返回后仍续期', async () => {
    vi.useFakeTimers();
    const { driver, world } = await mount({ mode: 'all' });
    world.onEventsSettled([humanEvent('m42')], 'delivered');

    driver.callTool = async (name, args, turn, actor) => {
      vi.advanceTimersByTime(QQ_TURN_TTL_MS + 30_000);
      driver.toolCalls.push({ name, args, turn, ...(actor ? { actor } : {}) });
      return { ok: true, result: 'ok' };
    };
    await toolHandler(world, 'astrbot_call_tool')({ name: 'slow_tool' }, toolCtx());
    await toolHandler(world, 'astrbot_call_tool')({ name: 'next' }, toolCtx());

    expect(driver.toolCalls[1]?.turn).toBe('m42');
    expect(driver.toolCalls[1]?.actor).toBeUndefined();
  });

  it('纯 Coo 轮次仍用连接页里的主人 QQ', async () => {
    const { driver, world } = await mount({ ownerId: '100000001' });
    driver.ownerIds = ['100000001'];

    await toolHandler(world, 'astrbot_call_tool')({ name: 'x' }, toolCtx());
    expect(driver.toolCalls[0]?.actor).toEqual({ kind: 'owner', id: '100000001' });
  });
});

describe('会话参数：数字 conv_id 与失败回执', () => {
  async function twoConvs() {
    const mounted = await mount({ mode: 'all' });
    const { driver, host } = mounted;
    driver.emitMessage({
      ...groupMsg({ id: 'g1', text: '甲群说话' }),
      umo: 'default:GroupMessage:111',
      conv: { kind: 'group', id: '111', name: '甲群', umo: 'default:GroupMessage:111' },
    });
    await Promise.resolve();
    driver.emitMessage({
      ...groupMsg({ id: 'g2', text: '乙群说话' }),
      umo: 'default:GroupMessage:222',
      conv: { kind: 'group', id: '222', name: '乙群', umo: 'default:GroupMessage:222' },
    });
    await Promise.resolve();
    settle(mounted.world, host);
    return mounted;
  }

  it('数字 conv_id 正确找到已知会话', async () => {
    const { driver, world } = await twoConvs();
    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: '回甲群', conv_id: 111 },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]?.conv).toMatchObject({ kind: 'group', id: '111' });
    expect(driver.sent[0]?.conv.umo).toBe('default:GroupMessage:111');
    expect(typeof out === 'string' ? true : out.failed ?? false).toBe(false);
  });

  it('conv_id 是对象时明确失败，不落回 reply_to / 当前轮', async () => {
    const { driver, world } = await twoConvs();
    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: 'x', conv_id: { id: 111 } },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain('conv_id 必须是字符串或数字');
  });

  it('conv_kind 非法时明确失败', async () => {
    const { driver, world } = await twoConvs();
    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: 'x', conv_id: '111', conv_kind: 'channel' },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain('conv_kind 只能是');
  });

  it('conv_id 为空串时回退当前轮', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ id: 'g1', umo: 'default:GroupMessage:222' }));
    await Promise.resolve();
    settle(world, host);

    await toolHandler(world, 'astrbot_send_message')({ text: 'x', conv_id: '' }, toolCtx());
    expect(driver.sent[0]?.conv.id).toBe('123456');
  });

  it('显式 conv_id 不在已知会话里：拒发并说明桥没见过', async () => {
    const { driver, world } = await twoConvs();
    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: 'x', conv_id: 999 },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain(
      '桥还没见过这个会话（没有 UMO），先让这个会话发一条消息',
    );
  });

  it('显式 conv_id 命中已知但无 UMO 的会话：拒发，不调用 driver.send', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage({
      ...groupMsg({ id: 'g3', text: '这个群没带 UMO' }),
      conv: { kind: 'group', id: '333', name: '丙群' },
    });
    await Promise.resolve();
    settle(world, host);

    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: 'x', conv_id: 333 },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain('桥还没见过这个会话（没有 UMO）');
  });

  it('显式 conv_id 命中带 UMO 的已知会话：正常发送', async () => {
    const { driver, world } = await twoConvs();
    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: '回乙群', conv_id: '222' },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]?.conv).toMatchObject({ kind: 'group', id: '222' });
    expect(driver.sent[0]?.conv.umo).toBe('default:GroupMessage:222');
    expect(typeof out === 'string' ? true : out.failed ?? false).toBe(false);
  });

  it('历史仍可查没有 UMO 的最近会话（不误伤 allowLast）', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage({
      ...groupMsg({ id: 'g3', text: '这个群没带 UMO' }),
      conv: { kind: 'group', id: '333', name: '丙群' },
    });
    await Promise.resolve();
    settle(world, host);

    const out = await toolHandler(world, 'astrbot_read_history')({}, toolCtx());
    const text = typeof out === 'string' ? out : out.text;
    expect(text).not.toContain('桥还没见过这个会话');
    expect(text).toContain('丙群');
  });

  it('发送失败的英文 code 不吞掉中文 note', async () => {
    const { driver, world } = await twoConvs();
    driver.sendResult = {
      ok: false,
      error: 'send_failed',
      note: '发送失败，详情见插件日志',
      uncertain: true,
    };
    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: 'x', conv_id: 111 },
      toolCtx(),
    );
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('发送失败，详情见插件日志');
    expect(text).toContain('send_failed');
    expect(text).toContain('可能已经发出');
  });
});

describe('历史与提示词（W-006 / W-015 / W-016）', () => {
  it('readLatest 扫描有上限，不会为冷会话翻遍整库', () => {
    let calls = 0;
    const store = {
      latestCursor: () => 10_000_000,
      range: (q: { toCursor?: number; limit?: number }) => {
        calls += 1;
        const size = q.limit ?? 100;
        const end = q.toCursor ?? 10_000_000;
        return Array.from({ length: size }, (_, i) => ({
          cursor: end - i,
          type: 'astrbot.message',
          origin: 'external',
          source: 'astrbot',
          text: '别群消息',
          meta: { conv: { kind: 'group', id: 'other' } },
        })) as unknown as EventEnvelope[];
      },
    } as unknown as Parameters<typeof readLatest>[0];

    const out = readLatest(store, { kind: 'group', id: '123456' }, 100);
    expect(out).toEqual([]);
    expect(calls).toBeLessThanOrEqual(201);
  });

  it('桥通知会变成 astrbot.notice 事件', async () => {
    const { driver, host } = await mount({ mode: 'all' });
    driver.emitNotice({ kind: 'test', text: '桥推来的通知' });
    await Promise.resolve();
    await Promise.resolve();
    const last = host.events[host.events.length - 1];
    expect(last?.type).toBe('astrbot.notice');
    expect(last?.text).toContain('桥推来的通知');
  });

  it('提示词写明两条身份路径，不再说桌宠轮次调不了工具', () => {
    const prompt = readFileSync(new URL('../src/ENV_PROMPT.md', import.meta.url), 'utf8');
    expect(prompt).not.toContain('调不了这些工具');
    expect(prompt).not.toContain('要发到别处再显式');
    expect(prompt).toContain('主人 QQ');
    expect(prompt).toContain('不要假装成功');

    expect(CALL_TOOL_DECL.description).toContain('configured AstrBot owner');
    expect(CALL_TOOL_DECL.description).toContain('separate tool token');
    expect(CALL_TOOL_DECL.description).not.toContain('desktop-pet turn has no QQ identity');
    expect(CALL_TOOL_DECL.description).toContain('say so honestly');
  });
});

// ---------------------------------------------------------------------------
// 主动发送与 @：非 QQ 轮次在主人授权下，按明确目标发送
// ---------------------------------------------------------------------------

const SEEN_GROUP = {
  kind: 'group' as const,
  id: '123456',
  name: '测试群',
  umo: 'default:GroupMessage:123456',
};
const OWNER = '100000001';
const OWNER_PRIVATE = {
  kind: 'private' as const,
  id: OWNER,
  umo: `default:FriendMessage:${OWNER}`,
};

/** 桥见过主人的私聊和一个群，然后结束 QQ 轮次，进入非 QQ 轮次。 */
async function seenBridge(patch: Partial<AstrbotConfigSection> = {}) {
  const mounted = await mount({ mode: 'all', ownerId: OWNER, ...patch });
  mounted.driver.ownerIds = [OWNER];
  mounted.driver.emitMessage({
    id: 'p1', umo: OWNER_PRIVATE.umo, conv: OWNER_PRIVATE,
    sender: { id: OWNER, name: '主人' }, text: '在吗', mentioned: true, owner: true,
  });
  mounted.driver.emitMessage({
    id: 'g1', umo: SEEN_GROUP.umo, conv: SEEN_GROUP,
    sender: { id: '42', name: '群友' }, text: '群里说话', mentioned: true,
  });
  await Promise.resolve();
  await Promise.resolve();
  mounted.world.onTurnEnded();
  return mounted;
}

describe('主动发送与 @', () => {
  it('非 QQ 轮次：主人 + 明确目标 + 桥见过的群，可以发', async () => {
    const { driver, world } = await seenBridge();
    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: '帮你转告', conv_kind: 'group', conv_id: '123456' },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]?.conv.umo).toBe(SEEN_GROUP.umo);
    expect(typeof out === 'string' ? out : out.text).toContain('已发到群');
  });

  it('群里可以 @ 指定的人，参数透传给桥', async () => {
    const { driver, world } = await seenBridge();
    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: '集合', conv_kind: 'group', conv_id: '123456', at: ['123456789'] },
      toolCtx(),
    );
    expect(driver.sent[0]?.at).toEqual(['123456789']);
    expect(typeof out === 'string' ? out : out.text).toContain('@了 1 人');
  });

  it('私聊里的 at 被忽略，但消息照发', async () => {
    const { driver, world } = await seenBridge();
    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: '私聊里说', conv_kind: 'private', conv_id: OWNER, at: ['123456789'] },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]?.at).toBeUndefined();
    expect(typeof out === 'string' ? out : out.text).toContain('私聊里 @ 不生效');
  });

  it('@全体默认关闭', async () => {
    const { driver, world } = await seenBridge();
    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: '通知', conv_kind: 'group', conv_id: '123456', at: ['all'] },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain('@全体成员没有开启');
  });

  it('开启后允许 @全体，并只发一个 all', async () => {
    const { driver, world } = await seenBridge({ allowAtAll: true });
    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: '通知', conv_kind: 'group', conv_id: '123456', at: ['all', '123456789'] },
      toolCtx(),
    );
    expect(driver.sent[0]?.at).toEqual(['all']);
    expect(typeof out === 'string' ? out : out.text).toContain('全体成员');
  });

  it('at 只接受数字 QQ 号', async () => {
    const { driver, world } = await seenBridge();
    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: '你好', conv_kind: 'group', conv_id: '123456', at: ['小明'] },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain('只接受数字');
  });

  it('at 最多 10 个', async () => {
    const { driver, world } = await seenBridge();
    const at = Array.from({ length: 11 }, (_, i) => String(100000000 + i));
    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: '你好', conv_kind: 'group', conv_id: '123456', at },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain('最多 @ 10 人');
  });

  it('语音和 @ 不能同一条', async () => {
    const { driver, world } = await seenBridge();
    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: '你好', voice: true, conv_kind: 'group', conv_id: '123456', at: ['123456789'] },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain('语音和 @ 不能');
  });

  it('主人 QQ 不在管理员名单时拒绝', async () => {
    const { driver, world } = await seenBridge();
    driver.ownerIds = ['999999'];
    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: '你好', conv_kind: 'group', conv_id: '123456' },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain('不在 AstrBot 的管理员名单');
  });

  it('桥没见过的会话不发', async () => {
    const { driver, world } = await seenBridge();
    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: '你好', conv_kind: 'group', conv_id: '555555' },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(0);
    expect(typeof out === 'string' ? out : out.text).toContain('桥还没见过这个会话');
  });

  it('重启后由桥恢复的会话，可以直接主动发送', async () => {
    const { driver, world } = await mount({ mode: 'all', ownerId: OWNER });
    driver.ownerIds = [OWNER];
    driver.emitReady([OWNER_PRIVATE, SEEN_GROUP]);
    await toolHandler(world, 'astrbot_send_message')(
      { text: '我回来了', conv_kind: 'private', conv_id: OWNER },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]?.conv.umo).toBe(OWNER_PRIVATE.umo);
  });

  it('QQ 轮次照旧可以隐式回触发会话，并带上 at', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage({ ...groupMsg({ id: 'g2', text: '在吗' }), umo: SEEN_GROUP.umo, conv: SEEN_GROUP });
    await Promise.resolve();
    settle(world, host);
    const out = await toolHandler(world, 'astrbot_send_message')(
      { text: '收到', at: ['123456789'] },
      toolCtx(),
    );
    expect(driver.sent[0]?.conv.umo).toBe(SEEN_GROUP.umo);
    expect(driver.sent[0]?.at).toEqual(['123456789']);
    expect(typeof out === 'string' ? out : out.text).toContain('已发到群');
  });
});


