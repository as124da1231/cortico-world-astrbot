/**
 * 连接：World 自己的桥地址、密钥、开关和重连参数。
 *
 * 布局分两栏：左边是「状态 + 设置」，右边是只读的运行时事实。
 * 群聊/私聊/工具/语音属于 AstrBot，不在这里重复。
 */

import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { autoload, saveBar } from './shared.ts';
import type { ConnectionState } from './types.ts';
import { bridgeAddressError, bridgeCredentialError, LOCAL_BRIDGE_URL, usesRemotePlaintextBridge } from '../config.ts';

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

function modeCard(
  ctx: WebUiPanelContext,
  st: ConnectionState,
  reload: () => void,
  isDirty: () => boolean,
): HTMLElement {
  const { ui } = ctx;
  const card = ui.h('div', 'astrbot-group');
  const active = st.mode === 'safe' ? '安全模式' : '完整模式';
  const next = st.mode === 'safe' ? 'full' : 'safe';
  const nextName = next === 'safe' ? '安全模式' : '完整模式';
  const label = ui.pill(st.mode ? active : '等待 AstrBot 同步模式');
  const feedback = ui.h('div', 'astrbot-note');
  feedback.setAttribute('role', 'status');
  const button = ui.button(`切换为${nextName}`, { size: 'sm' });
  button.disabled = st.switching || !st.modeSynced || st.modeApprovalPending;
  if (st.modeApprovalPending) feedback.textContent = '待 AstrBot 管理员在桥插件的概览页确认开放范围。';
  else if (st.mode === 'safe' && !st.ownerBound) feedback.textContent = '请在 AstrBot 桥插件的概览页指定主人 QQ 私聊。';
  button.addEventListener('click', async () => {
    if (isDirty()) {
      feedback.textContent = '请先保存当前页的连接设置。';
      return;
    }
    const confirmed = await ui.confirm({
      title: `切换为${nextName}`,
      body: next === 'full'
        ? '接入的 QQ 群和私聊将使用 Coo 的主对话，Coo 可能在 QQ 回复中提到控制台里聊过的内容。已授权的插件工具和主动发送也会启用。请在 AstrBot 管理页确认开放范围后生效。'
        : '仅放行指定主人的 QQ 私聊，继续使用 Coo 主对话。通用 AstrBot 工具和桌面主动发 QQ 将关闭。',
    });
    if (!confirmed || isDirty()) return;
    button.disabled = true;
    feedback.textContent = '正在同步 Coo 和 AstrBot…';
    try {
      await ctx.invoke('switch-mode', [next, true]);
      reload();
    } catch (error) {
      feedback.textContent = error instanceof Error ? error.message : String(error);
      button.disabled = false;
    }
  }, { signal: ctx.signal });
  const controls = ui.h('div', 'astrbot-inline');
  controls.append(label, button);
  card.append(ui.h('div', 'astrbot-glabel', '桥接模式'), controls, feedback);
  return card;
}

function settingsCard(
  ctx: WebUiPanelContext,
  st: ConnectionState,
  reload: () => void,
  dirty: { value: boolean },
): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '连接 AstrBot',
    desc: '同机使用默认地址。跨机填写 ws:// 或 wss:// 地址和桥接令牌。',
  });

  let wsUrl = st.wsUrl;
  let token = '';
  let clearToken = false;
  let includeTime = st.includeTime;
  let channelHint = st.channelHint;
  let base = String(st.reconnectBaseMs);
  let max = String(st.reconnectMaxMs);
  let saving = false;

  const mark = (): void => {
    dirty.value = true;
    bar.dirty();
  };

  const transportNote = ui.h('div', 'astrbot-note', '此跨机连接未启用 TLS，消息和令牌通过 WebSocket 明文传输。');
  transportNote.hidden = !usesRemotePlaintextBridge(wsUrl.trim());
  const urlInput = ui.input({
    value: wsUrl,
    placeholder: LOCAL_BRIDGE_URL,
    cls: 'mono',
    onInput: (value) => {
      wsUrl = value;
      transportNote.hidden = !usesRemotePlaintextBridge(value.trim());
      mark();
    },
  });

  const tokenInput = ui.input({
    type: 'password',
    placeholder: st.tokenSet ? '留空保留已保存的令牌' : '粘贴 AstrBot 的访问 token',
    onInput: (value) => {
      token = value;
      mark();
    },
  });
  tokenInput.autocomplete = 'new-password';
  tokenInput.spellcheck = false;

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
  const tokenStatus = ui.h('span', 'astrbot-note', st.tokenSet ? '已保存' : '未设置');
  tokenStatus.setAttribute('role', 'status');
  const clearBtn = ui.button('清除已保存的令牌', {
    variant: 'plain',
    size: 'sm',
    onClick: () => {
      if (clearBtn.disabled) return;
      clearToken = !clearToken;
      if (clearToken) {
        token = '';
        tokenInput.value = '';
      }
      syncToken();
      mark();
    },
  });
  const tokenActions = ui.h('div', 'astrbot-inline astrbot-token-actions');
  tokenActions.append(tokenStatus, clearBtn);
  clearBtn.hidden = !st.tokenSet;

  const syncToken = (): void => {
    tokenInput.disabled = saving || clearToken;
    clearBtn.disabled = saving || !(st.tokenSet || clearToken);
    clearBtn.textContent = clearToken ? '取消清除' : '清除已保存的令牌';
    tokenStatus.textContent = clearToken
      ? '保存时将清除令牌，跨机连接会断开'
      : st.tokenSet ? '已保存' : '未设置';
  };

  const retry = ui.button('重新连接', { size: 'sm', onClick: async () => {
    if (dirty.value) {
      ui.toast('请先保存当前页的连接设置。');
      return;
    }
    setSaving(true);
    try {
      await ctx.invoke('reconnect');
      reload();
    } catch {
      ui.toast('暂时无法重连 AstrBot，请等当前 QQ 处理结束后重试。', 'bad');
    } finally {
      setSaving(false);
    }
  } });
  retry.hidden = !st.enabled;

  const formControls: Array<HTMLInputElement | HTMLButtonElement> = [
    urlInput,
    tokenInput,
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
    retry.disabled = busy;
  };
  syncToken();

  const bar = saveBar(
    ctx,
    st.enabled ? '保存并应用' : '保存连接设置',
    async () => {
      const url = wsUrl.trim();
      const addressError = url ? bridgeAddressError(url) : undefined;
      const error = addressError ?? bridgeCredentialError(url, token.trim(), st.tokenSet && !clearToken);
      if (error) throw new Error(error);
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
        'worlds.astrbot.reconnectBaseMs': Math.max(200, Math.min(baseMs, 60_000)),
        'worlds.astrbot.reconnectMaxMs': Math.max(1000, Math.min(maxMs, 600_000)),
      };
      const bridgeCredential = token.trim();
      const bridgeCredentialChanged = clearToken || !!bridgeCredential;
      const needsReconnect = bridgeCredentialChanged || url !== st.wsUrl
        || values['worlds.astrbot.reconnectBaseMs'] !== st.reconnectBaseMs
        || values['worlds.astrbot.reconnectMaxMs'] !== st.reconnectMaxMs;
      await ctx.setConfig(GROUP, values);
      if (bridgeCredentialChanged) await ctx.invoke('save-bridge-token', [bridgeCredential]);
      dirty.value = false;
      let result = '连接设置已保存';
      if (st.enabled && needsReconnect) {
        try {
          await ctx.invoke('reconnect');
          result = '设置已保存，已发起重连';
        } catch {
          result = '设置已保存，请在当前页重试重新连接';
        }
      }
      reload();
      return result;
    },
    { onSaving: setSaving },
  );

  const bridge = ui.h('div', 'astrbot-group');
  bridge.append(
    ui.field('桥地址', urlInput),
    transportNote,
    ui.field('桥接令牌（Token）', tokenInput),
    tokenActions,
    ui.h('div', 'astrbot-note', '在 AstrBot 桥插件的「概览」→「谁能连进来」复制访问 token。跨机连接必填。'),
  );

  const authorization = ui.h('div', 'astrbot-group');
  authorization.append(
    ui.h('div', 'astrbot-glabel', '桌面权限'),
    ui.kv([
      { k: '主人工具', v: st.ownerTools ? '已授权' : '未授权' },
      { k: '主动发送 QQ', v: st.desktopSend ? '已授权' : '未授权' },
    ]),
    ui.h('div', 'astrbot-note', '在 AstrBot 管理页分别授权工具及主动发送目标。'),
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
  behavior.append(toggles, duo);
  const advanced = ui.h('details', 'astrbot-advanced');
  advanced.append(ui.h('summary', '', '高级设置'), behavior);

  const submit = ui.h('div', 'astrbot-submit');
  submit.append(retry, bar.el);

  const connection = ui.h('details', 'astrbot-advanced');
  connection.open = !st.connected && st.wsUrl !== LOCAL_BRIDGE_URL;
  connection.append(ui.h('summary', '', '地址和令牌'), bridge, advanced, submit);
  card.body.append(head(ctx, st), modeCard(ctx, st, reload, () => dirty.value || saving));
  if (st.connectionError) card.body.append(ui.h('div', 'astrbot-note', st.connectionError));
  if (st.mode === 'full') card.body.append(authorization);
  card.body.append(connection);
  return card.el;
}

function runtimeCard(ctx: WebUiPanelContext, st: ConnectionState): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '运行时',
  });
  const self = st.self?.name || st.self?.id || '—';
  card.body.appendChild(
    ui.kv([
      { k: '自报身份', v: self },
      { k: 'AstrBot 管理员', v: st.owners ? `${st.owners} 人` : '—' },
      { k: '语音回复（TTS）', v: st.tts.ready ? st.tts.provider || '可用' : '不可用' },
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
    const dirty = { value: false };
    let snapshot: ConnectionState | undefined;
    let refresh: (() => void) | undefined;
    ctx.interval(() => {
      if (!snapshot || !refresh || dirty.value) return;
      void ctx.invoke<ConnectionState>('state').then((state) => {
        if (!snapshot || dirty.value || ctx.signal.aborted) return;
        if (state.mode !== snapshot.mode || state.modeApprovalPending !== snapshot.modeApprovalPending
          || state.connected !== snapshot.connected || state.ownerBound !== snapshot.ownerBound
          || state.ownerTools !== snapshot.ownerTools || state.desktopSend !== snapshot.desktopSend
          || state.connectionError !== snapshot.connectionError) refresh?.();
      }).catch(() => {});
    }, 3000);
    ctx.guardLeave(() => (dirty.value ? '连接设置还没保存，确定离开？' : null));
    autoload<ConnectionState>(ctx, {
      loading: '正在读取连接状态…',
      failed: '读取连接状态失败',
      load: () => ctx.invoke<ConnectionState>('state'),
      render: (st, reload) => {
        snapshot = st;
        refresh = reload;
        const { ui } = ctx;
        const layout = ui.h('div', 'astrbot-layout');
        const main = ui.h('div', 'astrbot-main');
        main.appendChild(settingsCard(ctx, st, reload, dirty));
        layout.append(main, runtimeCard(ctx, st));
        return [layout];
      },
    });
  },
};
