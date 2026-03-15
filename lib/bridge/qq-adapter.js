/**
 * qq-adapter.js — QQ 机器人适配器
 *
 * 使用 qq-guild-bot SDK 通过 WebSocket 接收消息。
 * 支持 QQ 频道消息（PUBLIC_GUILD_MESSAGES）和私信（DIRECT_MESSAGE）。
 *
 * 凭证：appID + token，从 QQ 机器人开放平台（open.qq.com/bot）获取。
 */

import pkg from "qq-guild-bot";
const { createOpenAPI, createWebsocket } = pkg;
import { debugLog } from "../debug-log.js";

const MAX_MSG_SIZE = 100_000;

/**
 * @param {object} opts
 * @param {string} opts.appID
 * @param {string} opts.token
 * @param {(msg: object) => void} opts.onMessage
 * @param {Record<string,string>} [opts.dmGuildMap] - 持久化的 userId→guildId 映射（启动时注入）
 * @param {(userId: string, guildId: string) => void} [opts.onDmGuildDiscovered] - 新映射发现时的回调（用于持久化）
 * @param {(status: string, error?: string) => void} [opts.onStatus]
 * @returns {{ sendReply, sendBlockReply, stop, getMe, resolveOwnerChatId }}
 */
export function createQQAdapter({ appID, token, onMessage, dmGuildMap, onDmGuildDiscovered, onStatus }) {
  const config = {
    appID,
    token,
    intents: ["PUBLIC_GUILD_MESSAGES", "DIRECT_MESSAGE"],
  };

  const client = createOpenAPI(config);
  const ws = createWebsocket(config);

  /** 记录哪些 chatId 是私信（guild_id），用于 sendReply 区分 API */
  const dmChatIds = new Set();
  /** userId → guild_id 映射，用于主动发起私信 */
  const userGuildMap = new Map(Object.entries(dmGuildMap || {}));
  // 从持久化映射恢复 dmChatIds
  for (const guildId of userGuildMap.values()) dmChatIds.add(guildId);

  // ── 频道消息 ──
  ws.on("PUBLIC_GUILD_MESSAGES", (data) => {
    const msg = data.msg;
    if (!msg?.content) return;

    // 去掉 @机器人 的 mention
    let text = msg.content.replace(/<@!?\d+>/g, "").trim();
    if (!text) return;
    if (text.length > MAX_MSG_SIZE) text = text.slice(0, MAX_MSG_SIZE);

    onMessage({
      platform: "qq",
      chatId: msg.channel_id,
      userId: msg.author.id,
      sessionKey: `qq_group_${msg.channel_id}`,
      text,
      senderName: msg.author.username || "User",
      isGroup: true,
    });
  });

  // ── 私信 ──
  ws.on("DIRECT_MESSAGE", (data) => {
    const msg = data.msg;
    if (!msg?.content) return;

    let text = msg.content.trim();
    if (!text) return;
    if (text.length > MAX_MSG_SIZE) text = text.slice(0, MAX_MSG_SIZE);

    // 私信用 guild_id 作为 chatId（QQ DM API 需要 guild_id）
    const chatId = msg.guild_id;
    dmChatIds.add(chatId);
    if (userGuildMap.get(msg.author.id) !== chatId) {
      userGuildMap.set(msg.author.id, chatId);
      onDmGuildDiscovered?.(msg.author.id, chatId);
    }

    onMessage({
      platform: "qq",
      chatId,
      userId: msg.author.id,
      sessionKey: `qq_dm_${msg.author.id}`,
      text,
      senderName: msg.author.username || "User",
      isGroup: false,
    });
  });

  ws.on("ERROR", (err) => {
    const errMsg = err?.message || String(err);
    console.error("[qq] websocket error:", errMsg);
    debugLog()?.error("bridge", `qq websocket error: ${errMsg}`);
    onStatus?.("error", errMsg);
  });

  let lastBlockTs = 0;

  return {
    async sendReply(chatId, text) {
      const MAX = 2000; // QQ 单条消息建议不超过 2000 字符
      for (let i = 0; i < text.length; i += MAX) {
        const chunk = text.slice(i, i + MAX);
        if (dmChatIds.has(chatId)) {
          await client.directMessageApi.postDirectMessage(chatId, { content: chunk });
        } else {
          await client.messageApi.postMessage(chatId, { content: chunk });
        }
      }
    },

    async sendBlockReply(chatId, text) {
      const now = Date.now();
      const elapsed = now - lastBlockTs;
      const delay = 800 + Math.random() * 1200;
      if (lastBlockTs && elapsed < delay) {
        await new Promise((r) => setTimeout(r, delay - elapsed));
      }
      await this.sendReply(chatId, text);
      lastBlockTs = Date.now();
    },

    stop() {
      ws.disconnect?.();
    },

    async getMe() {
      return client.meApi.me();
    },

    /** 将 userId 解析为可用于私信发送的 guild_id，未曾私信过则返回 null */
    resolveOwnerChatId(userId) {
      return userGuildMap.get(userId) || null;
    },
  };
}
