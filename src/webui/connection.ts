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

  let wsUrl = st.wsUrl;
  let token = '';
  let clearToken = false;
  let ownerId = st.ownerId;
  let ownerToolToken = '';
  let includeTime = st.includeTime;
  let channelHint = st.channelHint;
  let base = String(st.reconnectBaseMs);
  let max = String(st.reconnectMaxMs);
  let saving = false;

  const mark = (): void => {
    setDirty(true);
    bar.dirty();
  };

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

  const ownerTokenInput = ui.input({
    type: 'password',
    placeholder: st.ownerToolTokenSet ? '已设置；留空保持不变' : '填 AstrBot 的独立工具令牌',
    onInput: (value) => {
      ownerToolToken = value;
      mark();
    },
  });
  const ownerToolsEnabled = ui.checkbox('启用主人工具授权', {
    checked: st.ownerToolsEnabled,
    onChange: mark,
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
    title: '仅提示 QQ 消息使用 astrbot_send_message，不改变本地对话的回复方式',
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

  // token 语义是「留空＝保持」，所以清空输入框并不等于删掉已存值；
  // 想真正删掉必须显式点清除（X-005）。
  const tokenHint = ui.h('div', 'astrbot-note');
  const clearBtn = ui.button('清除已存 token', {
    variant: 'plain',
    size: 'sm',
    onClick: () => {
      if (clearBtn.disabled) return;
      clearToken = !clearToken;
      if (clearToken) tokenInput.value = '';
      syncToken();
      mark();
    },
  });
  const tokenRow = ui.h('div', 'astrbot-tokenrow');
  tokenRow.append(tokenInput, clearBtn);

  const syncToken = (): void => {
    tokenInput.disabled = saving || clearToken;
    clearBtn.disabled = saving || !(st.tokenSet || clearToken);
    clearBtn.textContent = clearToken ? '取消清除' : '清除已存 token';
    tokenHint.textContent = clearToken
      ? '保存后会清空桥 token；AstrBot 插件那边也要清空或改成不校验，否则两边对不上。'
      : st.tokenSet
        ? '已存 token。留空＝保持不变；要删掉请点「清除已存 token」。'
        : '两边都没设 token 时不校验；跨机部署请设置同一个 token。';
  };

  const formControls: Array<HTMLInputElement | HTMLButtonElement> = [
    urlInput,
    tokenInput,
    ownerInput,
    ownerTokenInput,
    ownerToolsEnabled.input,
    baseInput,
    maxInput,
    timeBox.input,
    hintBox.input,
    clearBtn,
  ];
  const setSaving = (busy: boolean): void => {
    saving = busy;
    for (const el of formControls) {
      if (el === clearBtn) continue;
      el.disabled = busy;
    }
    syncToken();
  };
  syncToken();

  const bar = saveBar(
    ctx,
    '保存连接设置',
    async () => {
      const url = wsUrl.trim();
      if (url && !/^wss?:\/\/.+/i.test(url)) {
        throw new Error('桥地址要以 ws:// 或 wss:// 开头');
      }
      const owner = ownerId.trim();
      if (owner && !/^\d*$/.test(owner)) {
        throw new Error('主人 QQ 只能填数字');
      }
      if (owner.length > 20) {
        throw new Error('主人 QQ 最长 20 位');
      }
      const ownerCredential = ownerToolToken.trim();
      if (ownerCredential && !/^[\x21-\x7e]+$/.test(ownerCredential)) {
        throw new Error('主人工具令牌请使用无空格的可打印 ASCII 字符');
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
        'worlds.astrbot.wsUrl': url,
        'worlds.astrbot.includeTime': includeTime,
        'worlds.astrbot.channelHint': channelHint,
        'worlds.astrbot.ownerId': owner,
        'worlds.astrbot.ownerToolsEnabled': ownerToolsEnabled.input.checked,
        'worlds.astrbot.reconnectBaseMs': Math.max(200, Math.min(baseMs, 60_000)),
        'worlds.astrbot.reconnectMaxMs': Math.max(1000, Math.min(maxMs, 600_000)),
      };
      if (clearToken) values['worlds.astrbot.token'] = '';
      else if (token.trim()) values['worlds.astrbot.token'] = token.trim();
      if (ownerCredential) await ctx.invoke('save-owner-token', [ownerCredential]);
      await ctx.setConfig(GROUP, values);
      clearToken = false;
      token = '';
      setDirty(false);
      bar.reset();
      reload();
      return '连接设置已保存';
    },
    { onSaving: setSaving },
  );

  const bridge = ui.h('div', 'astrbot-group');
  bridge.append(
    ui.h('div', 'astrbot-glabel', '接入'),
    // 启停是 World 的生命周期，不在 worlds.astrbot 的 schema 里；面板不再假装能改。
    ui.h(
      'div',
      'astrbot-gnote',
      '启停不在这个面板：到 Coo 的 World 页打开或关闭「AstrBot · QQ」。这里保存不会改变启停状态。',
    ),
    ui.field('桥地址', urlInput),
    ui.field('桥 token', tokenRow),
    tokenHint,
  );

  const tools = ui.h('div', 'astrbot-group');
  tools.append(
    ui.h('div', 'astrbot-glabel', '工具身份'),
    ui.field('主人 QQ', ownerInput),
    ui.field('主人工具令牌', ownerTokenInput),
    ownerToolsEnabled.el,
    ui.h(
      'div',
      'astrbot-note',
      st.ownerTools
        ? '桥已授予主人工具权限。主人 QQ 须与 AstrBot 配置中的账号一致。'
        : '桥尚未授予主人工具权限。在 AstrBot 设置主人 QQ 和独立工具令牌，在这里填同一组值。远程地址使用 wss://。',
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
      '地址、令牌和重连参数保存后，点页面底部的「重启 World」生效。',
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
