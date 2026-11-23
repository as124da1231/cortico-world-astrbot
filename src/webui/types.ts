/** 「连接」面板的状态；只包含 World 自己的连接信息。 */

export interface ConnectionState {
  enabled: boolean;
  connected: boolean;
  mode?: 'full' | 'safe';
  modeKnown: boolean;
  modeSynced: boolean;
  switching: boolean;
  safeAvailable: boolean;
  wsUrl: string;
  tokenSet: boolean;
  includeTime: boolean;
  channelHint: boolean;
  ownerId: string;
  ownerToolTokenSet: boolean;
  ownerToolsEnabled: boolean;
  ownerTools: boolean;
  admins: string[];
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  self: { id?: string; name?: string } | null;
  owners: number;
  tts: { ready: boolean; provider?: string };
  tools: number;
  conversations: number;
}
