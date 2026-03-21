/**
 * feishu-adapter.js — 飞书 Bot WebSocket 长连接适配器
 *
 * 使用 @larksuiteoapi/node-sdk 的 WSClient 接收消息，
 * 通过 onMessage 回调将标准化消息交给 BridgeManager。
 */

import * as lark from "@larksuiteoapi/node-sdk";
import { debugLog } from "../debug-log.js";

/**
 * @param {object} opts
 * @param {string} opts.appId - 飞书 App ID
 * @param {string} opts.appSecret - 飞书 App Secret
 * @param {'feishu'|'lark'} [opts.domain] - 'feishu'=国内版(默认), 'lark'=国际版
 * @param {(msg: BridgeMessage) => void} opts.onMessage
 * @param {(status: string, error?: string) => void} [opts.onStatus]
 * @returns {{ sendReply, stop }}
 */
export function createFeishuAdapter({ appId, appSecret, domain = 'feishu', onMessage, onStatus }) {
  const larkDomain = domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
  const client = new lark.Client({ appId, appSecret, domain: larkDomain });

  /** 用户信息缓存 { [openId]: { name, avatarUrl } } */
  const userCache = new Map();

  async function getUserInfo(openId) {
    const cached = userCache.get(openId);
    // 只使用成功缓存（有 name 的），失败的下次重试
    if (cached?.name) return cached;

    try {
      const res = await client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: "open_id" },
      });
      const user = res?.data?.user;
      // 优先 nickname（用户昵称）→ en_name → name（真名，最后 fallback）
      const displayName = user?.nickname || user?.en_name || user?.name || null;
      const avatarUrl = user?.avatar?.avatar_240 || user?.avatar?.avatar_72 || null;
      console.log("[feishu] getUserInfo succeeded (cached:", !!cached, ")");
      const info = { name: displayName, avatarUrl };
      if (info.name) userCache.set(openId, info);
      return info;
    } catch (err) {
      const detail = err?.response?.data || err?.data || err.message;
      console.error("[feishu] getUserInfo failed");
      return { name: null, avatarUrl: null };
    }
  }

  const eventDispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      const { message, sender } = data;

      // 只处理文本消息
      if (message.message_type !== "text") return;
      // 忽略 bot 自身消息
      if (sender.sender_type === "bot") return;

      let text;
      try {
        const content = JSON.parse(message.content);
        text = content.text;
      } catch {
        return;
      }
      if (!text) return;

      const MAX_MSG_SIZE = 100_000; // 100KB
      if (text.length > MAX_MSG_SIZE) {
        console.warn(`[feishu] 消息过大（${text.length} chars），已截断`);
        text = text.slice(0, MAX_MSG_SIZE);
      }

      const chatId = message.chat_id;
      const openId = sender.sender_id?.open_id || "unknown";
      const userId = sender.sender_id?.user_id || openId;
      const chatType = message.chat_type; // "p2p" | "group"
      const isGroup = chatType === "group";
      const sessionKey = isGroup ? `fs_group_${chatId}` : `fs_dm_${openId}`;

      // 异步获取用户信息
      const userInfo = await getUserInfo(openId);

      onMessage({
        platform: "feishu",
        chatId,
        userId,
        sessionKey,
        text,
        senderName: userInfo.name,
        avatarUrl: userInfo.avatarUrl,
        isGroup,
      });
    },
  });

  const wsClient = new lark.WSClient({
    appId,
    appSecret,
    domain: larkDomain,
    loggerLevel: lark.LoggerLevel.warn,
  });

  // start() 返回 Promise，连接失败会打日志但不会 throw
  wsClient.start({ eventDispatcher }).catch((err) => {
    console.error("[feishu] WSClient start failed:", err.message);
    debugLog()?.error("bridge", `feishu WSClient start failed: ${err.message}`);
    onStatus?.("error", err.message);
  });

  /** 上次 block streaming 发送时间（用于 humanDelay） */
  let lastBlockTs = 0;

  return {
    async sendReply(chatId, text) {
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      });
    },

    /** block streaming 专用：发一条气泡，两条之间加 humanDelay */
    async sendBlockReply(chatId, text) {
      const now = Date.now();
      const elapsed = now - lastBlockTs;
      const delay = 800 + Math.random() * 1200; // 800~2000ms
      if (lastBlockTs && elapsed < delay) {
        await new Promise(r => setTimeout(r, delay - elapsed));
      }
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      });
      lastBlockTs = Date.now();
    },

    stop() {
      try { wsClient.close(); } catch {}
    },
  };
}
