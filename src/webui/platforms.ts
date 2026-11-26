import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { autoload } from './shared.ts';
import type { PlatformState } from './types.ts';
import type { BridgeChannel } from '../driver.ts';

const PLATFORMS = {
  qq: {
    label: 'QQ',
    description: '通过 AstrBot 在 QQ 群聊和私聊中接续 Coo 主对话。',
  },
  discord: {
    label: 'Discord',
    description: '通过 AstrBot 在 Discord 主人私聊和获准频道中接续 Coo 主对话。',
  },
} satisfies Record<BridgeChannel, { label: string; description: string }>;

function renderPlatforms(ctx: WebUiPanelContext, initial: PlatformState) {
  const { ui } = ctx;
  const panel = ui.h('div', 'astrbot-panel astrbot-workspace');
  const heading = ui.h('header', 'astrbot-panel-head');
  const connectionLink = ui.h('a', 'btn sm astrbot-connection-link', '连接设置');
  connectionLink.href = `#/provider/${encodeURIComponent(ctx.pageId)}/connection`;
  heading.append(ui.h('h3', 'astrbot-panel-title', '平台接入'), connectionLink);
  const toolbar = ui.rowbar();
  toolbar.classList.add('astrbot-platform-toolbar');

  const overview = ui.h('header', 'astrbot-platform-overview');
  const identity = ui.h('div');
  const title = ui.h('h3', 'astrbot-panel-title');
  const description = ui.h('p', 'astrbot-description');
  identity.append(title, description);
  const status = ui.h('div', 'astrbot-platform-status');
  status.setAttribute('role', 'status');
  overview.append(identity, status);

  const sheet = ui.sheet({ title: '平台实例' });
  const instances = ui.table({ head: ['实例 ID', '桥接状态', '主人私聊'] });
  instances.el.classList.add('astrbot-platform-table');
  const unavailable = ui.placeholder('');
  const refreshError = ui.msgline('', true);
  refreshError.setAttribute('role', 'status');
  const management = ui.h('p', 'astrbot-description astrbot-platform-management');
  sheet.body.append(instances.el, unavailable, management, refreshError);
  const results = ui.h('div', 'astrbot-platform-results');
  results.append(sheet.el);

  let selected: BridgeChannel = ctx.memo.get<string>('astrbotPlatform', 'qq') === 'discord' ? 'discord' : 'qq';
  let state = initial;
  const render = (): void => {
    const platform = PLATFORMS[selected];
    const routes = (state.platformRoutes ?? []).filter((route) => route.channel === selected);
    const hasReport = state.connected && state.platformRoutes != null;
    title.textContent = platform.label;
    description.textContent = platform.description;
    const active = routes.filter(route => route.enabled).length;
    const statusLabel = !state.enabled ? '桥接未启用' : !state.connected ? '等待连接' : hasReport ? `${active} / ${routes.length} 已启用` : '桥接已连接';
    status.replaceChildren(ui.pill(statusLabel, active ? 'on' : 'plain'));
    instances.el.hidden = !routes.length;
    unavailable.hidden = !!routes.length;
    unavailable.textContent = !state.connected ? '连接后会自动同步平台实例。'
      : hasReport ? `AstrBot 未上报 ${platform.label} 实例。` : '当前桥版本未提供平台实例明细。';
    management.textContent = `在 AstrBot 的「Coo 桥控制台 → ${platform.label}」管理实例、主人绑定和会话范围。`;
    instances.clear();
    for (const route of routes) {
      instances.addRow([
        route.id,
        ui.pill(route.enabled ? '已启用' : '未启用', route.enabled ? 'on' : 'off'),
        ui.pill(route.ownerBound ? '已绑定' : '待绑定', route.ownerBound ? 'on' : 'plain'),
      ]);
    }
  };

  const selector = ui.segmented([{ value: 'qq', label: PLATFORMS.qq.label }, { value: 'discord', label: PLATFORMS.discord.label }], {
    value: selected,
    size: 'sm',
    onSelect: (value) => {
      selected = value === 'discord' ? 'discord' : 'qq';
      ctx.memo.set('astrbotPlatform', selected);
      render();
    },
  });
  toolbar.append(selector.el);
  panel.append(heading, toolbar, overview, results);
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
