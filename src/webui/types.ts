/** 「连接」面板的状态；只包含 World 自己的连接信息。 */

import type { PlatformRoute } from '../driver.ts';

export interface PlatformState {
  version?: string;
  enabled: boolean;
  connected: boolean;
  /** null 表示桥未上报明细；空数组表示桥已上报且没有实例。 */
  platformRoutes: PlatformRoute[] | null;
}

export interface ConnectionState extends PlatformState {
  mode?: 'full' | 'safe';
  modeKnown: boolean;
  instancePolicies?: boolean;
  modeSynced: boolean;
  switching: boolean;
  ownerBound: boolean;
  modeApprovalPending: boolean;
  connectionError?: string;
  wsUrl: string;
  tokenSet: boolean;
  includeTime: boolean;
  channelHint: boolean;
  ownerTools: boolean;
  desktopSend: boolean;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  self: { id?: string; name?: string } | null;
  owners: number;
  tts: { ready: boolean; provider?: string };
  tools: number;
  conversations: number;
}
