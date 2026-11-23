import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { ASTRBOT_DEFAULTS, type AstrbotConfigSection } from './config.ts';
import {
  ASTRBOT_TOOL_DECLS,
  AstrbotWorld,
  CALL_TOOL_DECL,
} from './world.ts';

export const ASTRBOT: WorldDefinition<AstrbotConfigSection> = {
  id: 'astrbot',
  label: 'AstrBot',
  defaults: () => ({ ...ASTRBOT_DEFAULTS }),
  // 只构造，不连接：装配层会为未启用的 World 也调用一次 create。
  create: (ctx) =>
    new AstrbotWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      restart: () => ctx.restart(),
      storeBridgeToken: (token) => ctx.persist({ token }),
    }),
  describe: {
    tools: describeTools([...ASTRBOT_TOOL_DECLS, CALL_TOOL_DECL], {
      astrbot_send_message: {
        zh: '经 AstrBot 的桥往一个 QQ 会话发一条消息：文字、图片，或两者一起。图片用 pet_cua_screenshot 回执里的 log: 句柄。',
        en: 'Sends text, an image, or both into a QQ conversation through the AstrBot bridge. Images use the log: handle from a pet_cua_screenshot receipt.',
      },
      astrbot_status: {
        zh: '报告桥的连接状态、桥自报的身份与本次见过的 QQ 会话。',
        en: 'Reports bridge connection state, the reported bot identity and the QQ conversations seen this session.',
      },
      astrbot_read_history: {
        zh: '读或搜这个 bot 见过的 QQ 消息：某会话最近的若干条，或含关键词的那些。',
        en: 'Reads or searches the QQ messages this bot has seen: the latest in a conversation, or those containing a keyword.',
      },
      astrbot_read_message_component: {
        zh: '查看已收到的 QQ 消息中的引用、合并转发与其他组件详情。',
        en: 'Reads quoted messages, merged forwards and other details of components in observed QQ messages.',
      },
      astrbot_call_tool: {
        zh: '调用 AstrBot 已授权的工具。QQ 轮次使用发言者身份，Coo 对话需要单独授权的主人身份。',
        en: 'Calls an authorized AstrBot tool as the QQ sender or, in Coo chat, as the separately authorized owner.',
      },
    }),
    events: [
      {
        type: 'astrbot.message',
        description: {
          zh: '桥送来的 QQ 消息；被点名时立即投递，其余按配置合批。',
          en: 'A QQ message from the bridge; delivered at once when the bot is called, otherwise batched per config.',
        },
      },
      {
        type: 'astrbot.connected',
        description: { zh: '与 AstrBot 的桥建立连接。', en: 'The connection to the AstrBot bridge was established.' },
      },
      {
        type: 'astrbot.disconnected',
        description: { zh: '与 AstrBot 的桥断开，正在重连。', en: 'The AstrBot bridge connection dropped and is being retried.' },
      },
      {
        type: 'astrbot.notice',
        description: {
          zh: '桥转述的状态通知，例如 AstrBot 侧的 QQ 掉线。',
          en: 'A status notice relayed by the bridge, such as the QQ side going offline.',
        },
      },
      {
        type: 'astrbot.read_result',
        description: { zh: 'Coo 主动读取的 QQ 外部资料。', en: 'External QQ content explicitly fetched by Coo.' },
      },
    ],
  },
};
