/**
 * AstrBot World 的 Coo 侧面板。
 *
 * 只做 World 自己的连接配置；群聊/私聊/工具/语音仍在 AstrBot。
 */
import type { WebUiClientBundle } from 'cortico/web/shared/client-panel.ts';
import './style.css';
import { connectionPanel } from './connection.ts';

const bundle: WebUiClientBundle = {
  panels: {
    connection: connectionPanel,
  },
};

export default bundle;
