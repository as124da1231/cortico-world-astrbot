/**
 * 连接：World 自己的桥地址、密钥、开关和重连参数。
 *
 * 布局分两栏：左边是「状态 + 设置」，右边是只读的运行时事实。
 * 群聊/私聊/工具/语音属于 AstrBot，不在这里重复。
 */

import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { autoload, saveBar } from './shared.ts';
import type { ConnectionState } from './types.ts';

const GROUP = 'world:astrbot';

function lampClass(st: ConnectionState): string {
  if (!st.enabled) return 'off';
  return st.connected ? 'on' : 'wait';
}

function stateText(st: ConnectionState): string {
  if (!st.enabled) return '未启用';
  return st.connected ? '已连接' : '等待连接';
}

function head(ctx: WebUiPanelContext, st: ConnectionState): HTMLElement {
  const { ui } = ctx;
  const wrap = ui.h('div', 'astrbot-head');
  const lamp = ui.h('span', `astrbot-lamp ${lampClass(st)}`);
  lamp.setAttribute('aria-hidden', 'true');
  const text = ui.h('div', 'astrbot-headtext');
  text.append(
    ui.h('div', 'astrbot-state', stateText(st)),
    ui.h('div', 'astrbot-endpoint mono', st.wsUrl || '还没有配置桥地址'),
  );
  wrap.append(lamp, text);
  return wrap;
}

function toggleRow(
  ctx: WebUiPanelContext,
  hint: string,
  box: HTMLElement,
): HTMLElement {
  const { ui } = ctx;
  const wrap = ui.h('div', 'astrbot-toggle');
  wrap.append(box, ui.h('div', 'astrbot-toggle-hint', hint));
  return wrap;
}

function settingsCard(
  ctx: WebUiPanelContext,
  st: ConnectionState,
  reload: () => void,
  setDirty: (value: boolean) => void,
): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '连接',
    en: 'AstrBot ⇄ Coo',
    desc: '只改 Coo 这一端。AstrBot 的群聊、私聊、工具和语音仍在插件页。',
  });

  let enabled = st.enabled;
  let wsUrl = st.wsUrl;
  let token = '';
  let ownerId = st.ownerId;
  let includeTime = st.includeTime;
  let channelHint = st.channelHint;
  let base = String(st.reconnectBaseMs);
  let max = String(st.reconnectMaxMs);

  const mark = (): void => {
    setDirty(true);
    bar.dirty();
  };

  const enableBox = ui.checkbox('启用这个 World', {
    checked: enabled,
    title: '关掉后 Coo 不再连接 AstrBot；桥和 AstrBot 那边不受影响',
    onChange: (checked) => {
      enabled = checked;
      mark();
    },
  });

  const urlInput = ui.input({
    value: wsUrl,
    placeholder: 'ws://127.0.0.1:17999',
    cls: 'mono',
    onInput: (value) => {
      wsUrl = value;
      mark();
    },
  });

  const tokenInput = ui.input({
    type: 'password',
    placeholder: st.tokenSet ? '已设置；留空保持不变' : '留空表示不校验',
    onInput: (value) => {
      token = value;
      mark();
    },
  });

  const ownerInput = ui.input({
    value: ownerId,
    placeholder: '例如 100000001',
    cls: 'mono',
    onInput: (value) => {
      ownerId = value;
      mark();
    },
  });

  const timeBox = ui.checkbox('带时间前缀', {
    checked: includeTime,
    title: '在投递给 Coo 的消息前带 HH:MM，方便判断先后顺序',
    onChange: (checked) => {
      includeTime = checked;
      mark();
    },
  });

  const hintBox = ui.checkbox('回复时带渠道提示', {
    checked: channelHint,
    title: '告诉 Coo 这条回复该用 astrbot_send_message 还是 pet_say',
    onChange: (checked) => {
      channelHint = checked;
      mark();
    },
  });

  const baseInput = ui.input({
    type: 'number',
    value: base,
    cls: 'mono',
    onInput: (value) => {
      base = value;
      mark();
    },
  });

  const maxInput = ui.input({
    type: 'number',
    value: max,
    cls: 'mono',
    onInput: (value) => {
      max = value;
      mark();
    },
  });

  const bar = saveBar(ctx, '保存连接设置', async () => {
    const url = wsUrl.trim();
    if (url && !/^wss?:\/\/.+/i.test(url)) {
      throw new Error('桥地址要以 ws:// 或 wss:// 开头');
    }
    const owner = ownerId.trim();
    if (owner && !/^\d+$/.test(owner)) {
      throw new Error('主人 QQ 只填数字');
    }
    const baseMs = Number.parseInt(base, 10);
    const maxMs = Number.parseInt(max, 10);
    if (!Number.isFinite(baseMs) || !Number.isFinite(maxMs)) {
      throw new Error('重连间隔要填整数毫秒');
    }
    if (baseMs > maxMs) {
      throw new Error('重连初始间隔不能大于上限');
    }
    const values: Record<string, string | number | boolean> = {
      'worlds.astrbot.enabled': enabled,
      'worlds.astrbot.wsUrl': url,
      'worlds.astrbot.includeTime': includeTime,
      'worlds.astrbot.channelHint': channelHint,
      'worlds.astrbot.ownerId': owner,
      'worlds.astrbot.reconnectBaseMs': Math.max(200, Math.min(baseMs, 60_000)),
      'worlds.astrbot.reconnectMaxMs': Math.max(1000, Math.min(maxMs, 600_000)),
    };
    if (token.trim()) values['worlds.astrbot.token'] = token.trim();
    await ctx.setConfig(GROUP, values);
    setDirty(false);
    bar.reset();
    reload();
    return '连接设置已保存';
  });

  const bridge = ui.h('div', 'astrbot-group');
  bridge.append(
    ui.h('div', 'astrbot-glabel', '接入'),
    enableBox.el,
    ui.field('桥地址', urlInput),
    ui.field('桥 token', tokenInput),
  );

  const tools = ui.h('div', 'astrbot-group');
  tools.append(
    ui.h('div', 'astrbot-glabel', '工具身份'),
    ui.field('主人 QQ', ownerInput),
    ui.h(
      'div',
      'astrbot-note',
      st.admins.length
        ? `AstrBot 管理员：${st.admins.join('、')}。Coo 对话轮次以这个身份调工具；留空表示不借身份。`
        : '桥连上后会显示 AstrBot 的管理员。Coo 对话轮次以这个身份调工具；留空表示不借身份。',
    ),
  );

  const behavior = ui.h('div', 'astrbot-group');
  const toggles = ui.h('div', 'astrbot-toggles');
  toggles.append(
    toggleRow(ctx, '带 HH:MM，方便判断先后。', timeBox.el),
    toggleRow(ctx, '说明该用哪个发送工具。', hintBox.el),
  );
  const duo = ui.h('div', 'astrbot-duo');
  duo.append(
    ui.field('重连初始间隔（毫秒）', baseInput),
    ui.field('重连上限（毫秒）', maxInput),
  );
  behavior.append(ui.h('div', 'astrbot-glabel', '行为'), toggles, duo);

  const submit = ui.h('div', 'astrbot-submit');
  submit.append(
    ui.h(
      'div',
      'astrbot-note',
      '地址、token 和重连参数保存后，点页面底部的「重启 World」生效；其余即时生效。',
    ),
    bar.el,
  );

  card.body.append(head(ctx, st), bridge, tools, behavior, submit);
  return card.el;
}

function runtimeCard(ctx: WebUiPanelContext, st: ConnectionState): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '运行时',
    en: 'world',
    desc: 'Coo 这一端看到的事实，只读。',
  });
  const self = st.self?.name || st.self?.id || '—';
  card.body.appendChild(
    ui.kv([
      { k: '自报身份', v: self },
      { k: 'QQ 上的主人', v: st.owners ? `${st.owners} 人` : '未配置' },
      { k: '语音', v: st.tts.ready ? st.tts.provider || '可用' : '不可用' },
      { k: '可用工具', v: `${st.tools} 个` },
      { k: '见过的会话', v: `${st.conversations} 个` },
    ]),
  );
  card.body.appendChild(
    ui.h(
      'div',
      'astrbot-side-note',
      '工具的勾选、群和私聊的范围，以及语音 Provider，都在 AstrBot 的插件页。这里只负责连上它。',
    ),
  );
  return card.el;
}

export const connectionPanel: WebUiPanel = {
  mount(ctx) {
    let dirty = false;
    ctx.guardLeave(() => (dirty ? '连接设置还没保存，确定离开？' : null));
    autoload<ConnectionState>(ctx, {
      loading: '正在读取连接状态…',
      failed: '读取连接状态失败',
      load: () => ctx.invoke<ConnectionState>('state'),
      render: (st, reload) => {
        const { ui } = ctx;
        const layout = ui.h('div', 'astrbot-layout');
        const main = ui.h('div', 'astrbot-main');
        main.appendChild(settingsCard(ctx, st, reload, (value) => {
          dirty = value;
        }));
        layout.append(main, runtimeCard(ctx, st));
        return [layout];
      },
    });
  },
};
