import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { autoload, bridgeHeader } from './shared.ts';
import type { PlatformState } from './types.ts';

function renderPlatforms(ctx: WebUiPanelContext, initial: PlatformState) {
  const { ui } = ctx;
  const panel = ui.h('div', 'astrbot-panel astrbot-workspace');
  const heading = bridgeHeader(ctx, '机器人实例', initial.version);
  const overview = ui.h('div', 'astrbot-directory-heading');
  const summary = ui.h('p', 'astrbot-description', '在 AstrBot 的「Coo 桥控制台」管理每个机器人的接入权限。');
  const status = ui.h('div', 'astrbot-platform-status');
  status.setAttribute('role', 'status');
  overview.append(summary, status);
  const results = ui.h('div', 'astrbot-platform-results');
  const directory = ui.h('div', 'astrbot-instance-cards');
  const unavailable = ui.placeholder('');
  const refreshError = ui.msgline('', true);
  refreshError.setAttribute('role', 'status');
  results.append(overview, directory, unavailable, refreshError);

  const labels: Record<string, string> = { aiocqhttp: 'QQ', discord: 'Discord', wecom_ai_bot: '企业微信', telegram: 'Telegram' };
  let state = initial;
  const render = (): void => {
    const routes = state.platformRoutes ?? [];
    const hasReport = state.connected && state.platformRoutes != null;
    const active = routes.filter(route => route.enabled).length;
    const statusLabel = !state.enabled ? '桥接未启用' : !state.connected ? '等待连接'
      : hasReport ? active + ' / ' + routes.length + ' 已接入' : '桥接已连接';
    status.replaceChildren(ui.pill(statusLabel, active ? 'on' : 'plain'));
    directory.hidden = !routes.length;
    unavailable.hidden = !!routes.length;
    unavailable.textContent = !state.connected ? '连接后自动同步平台实例。'
      : hasReport ? 'AstrBot 暂无机器人实例。' : '当前桥版本未提供平台实例明细。';
    directory.replaceChildren(...routes.map(route => {
      const card = ui.h('article', 'astrbot-instance-card');
      const head = ui.h('div', 'astrbot-instance-card-head');
      const name = ui.h('div');
      const adapter = route.adapterType || route.channel;
      name.append(ui.h('h4', 'astrbot-instance-name', route.name || route.id),
        ui.h('p', 'astrbot-description', (labels[adapter] || adapter)
          + (route.name && route.name !== route.id ? ' · ' + route.id : '')));
      const label = route.enabled ? '已接入' : route.astrbotEnabled === false ? '机器人已停用'
        : route.replySupported === false ? '无法原会话回复' : '待接入';
      head.append(name, ui.pill(label, route.enabled ? 'on' : 'plain'));
      card.append(head, ui.kv([
        { k: '接入模式', v: route.enabled && route.mode ? route.mode === 'full' ? '完整模式' : '安全模式' : '—' },
        { k: '主人私聊', v: route.ownerBound ? '已绑定' : route.enabled ? '待绑定' : '—' },
      ]));
      if (route.replyTextOnly && route.enabled) card.append(ui.msgline('支持原会话文字回复'));
      return card;
    }));
  };

  panel.append(heading, results);
  render();
  return {
    panel,
    update(next: PlatformState) {
      refreshError.textContent = '';
      if (next.enabled === state.enabled && next.connected === state.connected
        && JSON.stringify(next.platformRoutes) === JSON.stringify(state.platformRoutes)) return;
      state = next;
      render();
    },
    showRefreshError() {
      if (!refreshError.textContent) refreshError.textContent = '平台状态刷新失败，仍显示上次同步的结果。';
    },
  };
}

export const platformsPanel: WebUiPanel = {
  mount(ctx) {
    let view: ReturnType<typeof renderPlatforms> | undefined;
    let pending = false;
    const load = () => ctx.invoke<PlatformState>('state');
    autoload(ctx, {
      loading: '正在读取平台状态…',
      failed: '读取平台状态失败',
      load,
      render(state) {
        view = renderPlatforms(ctx, state);
        return [view.panel];
      },
    });
    ctx.interval(() => {
      if (!view || pending) return;
      pending = true;
      void load().then(
        (state) => { if (!ctx.signal.aborted) view?.update(state); },
        () => { if (!ctx.signal.aborted) view?.showRefreshError(); },
      ).finally(() => { pending = false; });
    }, 3000);
  },
};
