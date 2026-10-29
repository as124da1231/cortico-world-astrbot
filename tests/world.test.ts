import { describe, expect, it } from 'vitest';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { ASTRBOT_DEFAULTS, normalizeMode, parseAliases, type AstrbotConfigSection } from '../src/config.ts';
import { ASTRBOT } from '../src/definition.ts';
import { AstrbotWorld } from '../src/world.ts';
import { parseMessage } from '../src/driver.ts';
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
  world.onEventsSettled(host.events, 'delivered');
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

describe('消息投递：A 只回应被叫到时', () => {
  it('没被叫到就不投递', async () => {
    const { driver, host } = await mount({ mode: 'mention' });
    driver.emitMessage(groupMsg());
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events).toHaveLength(0);
  });

  it('被 at 时投递', async () => {
    const { driver, host } = await mount({ mode: 'mention' });
    driver.emitMessage(groupMsg({ mentioned: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events).toHaveLength(1);
  });

  it('正文里叫到称呼也算叫到自己', async () => {
    const { driver, host } = await mount({ mode: 'mention', nameAliases: 'Coo,库' });
    driver.emitMessage(groupMsg({ text: '库你在干嘛' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(host.events).toHaveLength(1);
    expect(host.events[0]?.text).toContain('@你');
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
    expect(host.events[0]?.text).toContain('pet_say 只在电脑上显示');
  });

  it('channelHint=false 时不加提示', async () => {
    const { driver, host } = await mount({ mode: 'all', channelHint: false });
    driver.emitMessage(groupMsg({ mentioned: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(host.events[0]?.text).not.toContain('pet_say 只在电脑上显示');
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

  it('可以显式指定会话', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    await handlerOf(world, 'astrbot_send_message')(
      { text: '你好', conv_kind: 'private', conv_id: '999' },
      toolCtx(),
    );
    expect(driver.sent[0]?.conv).toEqual({ kind: 'private', id: '999' });
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
    expect(typeof out === 'string' ? out : out.text).toContain('pet_say');
  });

  it('桌宠轮次显式给 conv_id 仍可发到 QQ', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    world.onTurnEnded();
    const out = await handlerOf(world, 'astrbot_send_message')(
      { text: '帮你转告', conv_kind: 'group', conv_id: '123456' },
      toolCtx(),
    );
    expect(driver.sent).toHaveLength(1);
    expect(typeof out === 'string' ? true : out.failed ?? false).toBe(false);
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

  it('桥拒绝时回执带原因且标失败', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    driver.sendResult = { ok: false, error: '桥拒绝了' };
    const out = await handlerOf(world, 'astrbot_send_message')(
      { text: '你好', conv_id: '1' },
      toolCtx(),
    );
    expect(typeof out === 'string' ? false : out.failed).toBe(true);
    expect(typeof out === 'string' ? out : out.text).toContain('桥拒绝了');
  });

  it('超过每分钟上限后拒绝发送', async () => {
    const { driver, world } = await mount({ mode: 'all', maxSendsPerMinute: 1 });
    const send = handlerOf(world, 'astrbot_send_message');
    const first = await send({ text: 'a', conv_id: '1' }, toolCtx());
    const second = await send({ text: 'b', conv_id: '1' }, toolCtx());

    expect(driver.sent).toHaveLength(1);
    expect(typeof second === 'string' ? second : second.text).toContain('上限');
    expect(typeof first === 'string' ? true : first.failed ?? false).toBe(false);
  });

  it('未连接时不发送', async () => {
    const { driver, world } = await mount({ mode: 'all' });
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
    driver.emitMessage(groupMsg());
    await Promise.resolve();

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

  it('环境提示词写明 QQ 上的主人', async () => {
    const { driver, world } = await mount({ mode: 'all' });
    driver.ownerIds = ['10001'];
    expect(world.envPromptVars()['astrbot.owner']).toContain('10001');
  });

  it('还不知道主人时如实说明', async () => {
    const { world } = await mount({ mode: 'all' });
    expect(world.envPromptVars()['astrbot.owner']).toContain('还没有报来管理员');
  });
});

describe('环境提示词变量', () => {
  it('未连接与已连接给出不同的话', async () => {
    const { world } = await mount({ mode: 'mention', nameAliases: 'Coo' });
    const vars = world.envPromptVars();
    expect(vars['astrbot.scope']).toContain('点名');
    expect(vars['astrbot.scope']).toContain('Coo');
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

  it('桌宠轮次不能借用上一条 QQ 消息的身份调工具', async () => {
    const { driver, host, world } = await mount({ mode: 'all' });
    driver.emitMessage(groupMsg({ id: 'm42' }));
    await Promise.resolve();
    settle(world, host);
    world.onTurnEnded();

    const out = await handlerOf(world, 'astrbot_call_tool')({ name: 'x' }, toolCtx());
    expect(driver.toolCalls).toHaveLength(0);
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('人话消息');
  });

  it('点名过滤掉的群消息不会变成工具身份', async () => {
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
    expect(driver.toolCalls[0]?.turn).toBe('m1');
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
    expect(text).toContain('人话消息');
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