/** 「连接」面板的状态；只包含 World 自己的连接信息。 */

export interface ConnectionState {
  enabled: boolean;
  connected: boolean;
  wsUrl: string;
  tokenSet: boolean;
  includeTime: boolean;
  channelHint: boolean;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  self: { id?: string; name?: string } | null;
  owners: number;
  tts: { ready: boolean; provider?: string };
  tools: number;
  conversations: number;
}
