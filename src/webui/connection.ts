/**
 * 连接：World 自己的桥地址、密钥、开关和重连参数。
 *
 * 管理 AstrBot 桥连接参数和运行状态。
 * 群聊/私聊/工具/语音属于 AstrBot，不在这里重复。
 */

import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { autoload, bridgeHeader, saveBar } from './shared.ts';
import type { ConnectionState } from './types.ts';
import { bridgeAddressError, bridgeCredentialError, LOCAL_BRIDGE_URL, usesRemotePlaintextBridge } from '../config.ts';

const GROUP = 'world:astrbot';

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
  const card = ui.h('div', 'astrbot-mode');
  if (st.instancePolicies) {
    card.append(ui.section('实例模式', '在 AstrBot 的「Coo 桥控制台 → 实例接入」切换。Coo 会同步每个实例的模式。'));
    return card;
  }
  const active = st.mode === 'safe' ? '安全模式' : '完整模式';
  const next = st.mode === 'safe' ? 'full' : 'safe';
  const nextName = next === 'safe' ? '安全模式' : '完整模式';
  const overview = ui.section('桥接模式', st.modeSynced
    ? st.mode === 'safe' ? '仅接入已绑定的主人私聊。' : '按 AstrBot 的授权接入群聊、频道和私聊。'
    : '连接后从 AstrBot 同步模式。');
  const feedback = ui.msgline();
  feedback.setAttribute('role', 'status');
  const button = ui.button(`切换为${nextName}`, { size: 'sm' });
  button.disabled = st.switching || !st.modeSynced || st.modeApprovalPending;
  if (st.modeApprovalPending) feedback.textContent = '等待审批。请在 AstrBot 的「Coo 桥控制台 → 连接与令牌」确认开放范围。';
  else if (st.mode === 'safe' && !st.ownerBound) feedback.textContent = '在 AstrBot 的「Coo 桥控制台 → QQ」绑定主人私聊。';
  button.addEventListener('click', async () => {
    if (isDirty()) {
      feedback.textContent = '请先保存当前页的连接设置。';
      feedback.classList.remove('bad');
      return;
    }
    const confirmed = await ui.confirm({
      title: `切换为${nextName}`,
      body: next === 'full'
        ? '放行的群、频道和私聊将使用 Coo 主对话，平台回复可能提到桌面聊过的内容。已授权的插件工具和主动发送也会启用。请在 AstrBot 管理页确认开放范围。'
        : '仅放行已绑定的主人私聊，继续使用 Coo 主对话。通用 AstrBot 工具和桌面主动发送将关闭。',
    });
    if (!confirmed || isDirty()) return;
    button.disabled = true;
    feedback.textContent = '正在同步 Coo 和 AstrBot…';
    feedback.classList.remove('bad');
    try {
      await ctx.invoke('switch-mode', [next, true]);
      reload();
    } catch (error) {
      feedback.textContent = error instanceof Error ? error.message : String(error);
      feedback.classList.add('bad');
      button.disabled = false;
    }
  }, { signal: ctx.signal });
  const controls = ui.rowbar();
  controls.classList.add('astrbot-mode-actions');
  controls.append(ui.pill(st.modeSynced ? active : '等待同步', st.modeSynced ? 'on' : 'plain'), button);
  const head = ui.h('div', 'astrbot-mode-head');
  head.append(overview, controls);
  card.append(head, feedback);
  return card;
}

function diagnosticsCard(
  ctx: WebUiPanelContext,
  st: ConnectionState,
): HTMLElement {
  const { ui } = ctx;
  const card = ui.foldSheet('astrbot-diagnostics', { title: '运行详情', defaultOpen: false });
  card.el.classList.add('astrbot-diagnostics');
  card.body.append(
    ui.kv(st.connected ? [
      { k: '自报身份', v: st.self?.name || st.self?.id || '—' },
      { k: '语音回复（TTS）', v: st.tts.ready ? st.tts.provider || '可用' : '不可用' },
      { k: '可用工具', v: `${st.tools} 个` },
      { k: '见过的会话', v: `${st.conversations} 个` },
    ] : [{ k: '运行数据', v: '连接后同步' }]),
  );
  if (st.modeSynced && st.mode === 'full') {
    card.body.append(
      ui.section('桌面权限', st.instancePolicies ? '在 AstrBot 的「Coo 桥控制台 → 实例接入」调整。' : '在 AstrBot 的「Coo 桥控制台」调整。'),
      ui.kv([
        { k: '主人工具', v: st.ownerTools ? '已授权' : '未授权' },
        { k: '主动发送', v: st.desktopSend ? '已授权' : '未授权' },
      ]),
    );
  }
  return card.el;
}

function settingsCard(
  ctx: WebUiPanelContext,
  st: ConnectionState,
  reload: () => void,
  dirty: { value: boolean; busy: boolean },
): { el: HTMLElement; retry: HTMLButtonElement } {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '连接参数',
  });

  let wsUrl = st.wsUrl;
  let token = '';
  let clearToken = false;
  let includeTime = st.includeTime;
  let channelHint = st.channelHint;
  let base = String(st.reconnectBaseMs);
  let max = String(st.reconnectMaxMs);

  const mark = (): void => {
    dirty.value = true;
    bar.dirty();
  };

  const transportNote = ui.msgline('此跨机连接未启用 TLS，消息和令牌通过 WebSocket 明文传输。', true);
  transportNote.hidden = !usesRemotePlaintextBridge(wsUrl.trim());
  const protocolOf = (address: string): string => address.trim().match(/^(wss?):\/\//i)?.[1]?.toLowerCase() ?? '';
  const protocolInput = ui.select({
    value: protocolOf(wsUrl || LOCAL_BRIDGE_URL),
    options: [{ value: '', label: '从地址识别' }, { value: 'ws', label: 'WS' }, { value: 'wss', label: 'WSS' }],
    onChange: (protocol) => {
      if (!protocol) {
        protocolInput.value = protocolOf(wsUrl);
        return;
      }
      const address = wsUrl.trim() || LOCAL_BRIDGE_URL;
      wsUrl = `${protocol}://${address.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')}`;
      urlInput.value = wsUrl;
      transportNote.hidden = !usesRemotePlaintextBridge(wsUrl);
      mark();
    },
  });
  const urlInput = ui.input({
    value: wsUrl,
    placeholder: LOCAL_BRIDGE_URL,
    cls: 'mono',
    onInput: (value) => {
      wsUrl = value;
      protocolInput.value = protocolOf(value);
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
  const tokenStatus = ui.h('div', 'astrbot-token-status');
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
  const tokenActions = ui.rowbar();
  tokenActions.classList.add('astrbot-token-actions');
  tokenActions.append(tokenStatus, clearBtn);
  clearBtn.hidden = !st.tokenSet;

  const syncToken = (): void => {
    tokenInput.disabled = dirty.busy || clearToken;
    clearBtn.disabled = dirty.busy || !(st.tokenSet || clearToken);
    clearBtn.textContent = clearToken ? '取消清除' : '清除已保存的令牌';
    tokenStatus.replaceChildren(clearToken
      ? ui.chip('保存时将清除令牌，跨机连接会断开', 'warn')
      : ui.pill(st.tokenSet ? '已保存' : '未设置', st.tokenSet ? 'on' : 'plain'));
  };

  const retry = ui.button('重新连接', { variant: st.connected ? 'plain' : 'primary', size: 'sm', onClick: async () => {
    if (dirty.value) {
      ui.toast('请先保存当前页的连接设置。');
      return;
    }
    setSaving(true);
    try {
      await ctx.invoke('reconnect');
      reload();
    } catch {
      ui.toast('暂时无法重连 AstrBot，请等当前 AstrBot 会话处理结束后重试。', 'bad');
    } finally {
      setSaving(false);
    }
  } });
  retry.hidden = !st.enabled;

  const formControls = [
    protocolInput,
    urlInput,
    tokenInput,
    baseInput,
    maxInput,
    timeBox.input,
    hintBox.input,
    clearBtn,
  ];
  const setSaving = (busy: boolean): void => {
    dirty.busy = busy;
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

  const bridge = ui.h('div', 'astrbot-fields');
  const address = ui.h('div', 'astrbot-address-fields');
  address.append(ui.field('协议', protocolInput), ui.field('桥地址', urlInput));
  bridge.append(
    address,
    transportNote,
    ui.field('桥接令牌（Token）', tokenInput),
    tokenActions,
    ui.msgline('跨机时，从 AstrBot 的「Coo 桥控制台 → 连接与令牌」复制访问令牌。同机回环可留空。'),
  );

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
  const advanced = ui.foldSheet('astrbot-advanced', {
    title: '高级设置',
    defaultOpen: ctx.memo.get('astrbotAdvancedOpen', false),
  });
  advanced.el.classList.add('astrbot-advanced', 'fold-plain');
  advanced.body.append(ui.section('消息格式'), toggles, ui.section('自动重连'), duo);

  const submit = ui.h('div', 'astrbot-submit');
  if (st.enabled) {
    submit.append(ui.h('p', 'astrbot-description', '修改地址、令牌或重连间隔后，保存会发起重连。'));
  }
  submit.append(bar.el);
  card.body.append(bridge, advanced.el, submit);
  return { el: card.el, retry };
}

export const connectionPanel: WebUiPanel = {
  mount(ctx) {
    const dirty = { value: false, busy: false };
    let snapshot: ConnectionState | undefined;
    let refresh: (() => void) | undefined;
    ctx.interval(() => {
      if (!snapshot || !refresh || dirty.value || dirty.busy) return;
      void ctx.invoke<ConnectionState>('state').then((state) => {
        if (!snapshot || dirty.value || dirty.busy || ctx.signal.aborted) return;
        if (state.enabled !== snapshot.enabled || state.mode !== snapshot.mode || state.modeApprovalPending !== snapshot.modeApprovalPending
          || state.instancePolicies !== snapshot.instancePolicies || state.modeSynced !== snapshot.modeSynced || state.switching !== snapshot.switching
          || state.connected !== snapshot.connected || state.ownerBound !== snapshot.ownerBound
          || state.ownerTools !== snapshot.ownerTools || state.desktopSend !== snapshot.desktopSend
          || state.connectionError !== snapshot.connectionError
          || state.self?.name !== snapshot.self?.name || state.self?.id !== snapshot.self?.id
          || state.tts.ready !== snapshot.tts.ready
          || state.tts.provider !== snapshot.tts.provider || state.tools !== snapshot.tools
          || state.conversations !== snapshot.conversations) refresh?.();
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
        const panel = ui.h('div', 'astrbot-panel astrbot-workspace');
        const heading = bridgeHeader(ctx, '连接与令牌', st.version);
        const settings = settingsCard(ctx, st, reload, dirty);
        const summary = ui.h('section', 'astrbot-connection-summary');
        const summaryLine = ui.h('div', 'astrbot-connection-line');
        const endpoint = ui.h('div', 'astrbot-connection-identity');
        endpoint.append(
          ui.pill(!st.enabled ? '未启用' : st.connected ? '已连接' : '等待连接', st.connected ? 'on' : st.enabled ? 'plain' : 'off'),
          ui.h('span', 'astrbot-endpoint', st.wsUrl || '尚未设置桥地址'),
        );
        summaryLine.append(endpoint, settings.retry);
        summary.append(ui.section('连接状态'), summaryLine);
        if (st.connectionError) summary.append(ui.msgline(st.connectionError, true));
        const layout = ui.h('div', 'astrbot-layout');
        const aside = ui.h('div', 'astrbot-connection-aside');
        aside.append(summary, modeCard(ctx, st, reload, () => dirty.value || dirty.busy), diagnosticsCard(ctx, st));
        layout.append(settings.el, aside);
        panel.append(heading, layout);
        return [panel];
      },
    });
  },
};
