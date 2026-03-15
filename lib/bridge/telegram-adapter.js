/**
 * telegram-adapter.js — Telegram Bot 长轮询适配器
 *
 * 使用 node-telegram-bot-api 监听消息，
 * 通过 onMessage 回调将标准化消息交给 BridgeManager。
 */

import TelegramBot from "node-telegram-bot-api";
import { debugLog } from "../debug-log.js";

const MAX_MSG_SIZE = 100_000; // 100KB

/**
 * @param {object} opts
 * @param {string} opts.token - Telegram Bot Token（从 @BotFather 获取）
 * @param {(msg: BridgeMessage) => void} opts.onMessage
 * @param {(status: string, error?: string) => void} [opts.onStatus]
 * @returns {{ sendReply, stop, getMe }}
 */
export function createTelegramAdapter({ token, onMessage, onStatus }) {
  let bot = new TelegramBot(token, { polling: true });
  let stopped = false;
  let consecutiveErrors = 0;
  let restartTimer = null;

  function attachListeners(b) {
    b.on("message", (msg) => {
      if (!msg.text) return;
      consecutiveErrors = 0;
      if (msg.text.length > MAX_MSG_SIZE) {
        console.warn(`[telegram] 消息过大（${msg.text.length} chars），已截断`);
        msg.text = msg.text.slice(0, MAX_MSG_SIZE);
      }

      const chatId = String(msg.chat.id);
      const userId = String(msg.from.id);
      const chatType = msg.chat.type; // "private" | "group" | "supergroup" | "channel"
      const isGroup = chatType !== "private";
      const sessionKey = isGroup ? `tg_group_${chatId}` : `tg_dm_${userId}`;

      onMessage({
        platform: "telegram",
        chatId,
        userId,
        sessionKey,
        text: msg.text,
        senderName: msg.from.first_name || "User",
        isGroup,
      });
    });

    b.on("polling_error", (err) => {
      consecutiveErrors++;
      const errMsg = err.message || String(err);
      console.error("[telegram] polling error:", errMsg);
      debugLog()?.error("bridge", `telegram polling error (${consecutiveErrors}): ${errMsg}`);

      // 连续错误超过 3 次且没有 pending restart，尝试重建 polling
      if (consecutiveErrors >= 3 && !stopped && !restartTimer) {
        debugLog()?.warn("bridge", `telegram polling failed ${consecutiveErrors}x, restarting...`);
        scheduleRestart();
      }
    });
  }

  function scheduleRestart() {
    if (stopped || restartTimer) return;
    const delay = Math.min(5000 * consecutiveErrors, 30_000);
    restartTimer = setTimeout(async () => {
      restartTimer = null;
      if (stopped) return;
      const oldBot = bot;
      try {
        oldBot.removeAllListeners();
        await oldBot.stopPolling();
      } catch (e) {
        debugLog()?.warn("bridge", `telegram old bot cleanup: ${e.message}`);
      }
      try {
        bot = new TelegramBot(token, { polling: true });
        attachListeners(bot);
        consecutiveErrors = 0;
        debugLog()?.log("bridge", "telegram polling restarted");
        onStatus?.("connected");
      } catch (err) {
        debugLog()?.error("bridge", `telegram restart failed: ${err.message}`);
        onStatus?.("error", err.message);
      }
    }, delay);
  }

  attachListeners(bot);

  /** 上次 block streaming 发送时间（用于 humanDelay） */
  let lastBlockTs = 0;

  return {
    async sendReply(chatId, text) {
      // Telegram 单条消息限制 4096 字符，超长时分段发送
      const MAX = 4096;
      for (let i = 0; i < text.length; i += MAX) {
        await bot.sendMessage(chatId, text.slice(i, i + MAX));
      }
    },

    /** block streaming 专用：发一条气泡，两条之间加 humanDelay */
    async sendBlockReply(chatId, text) {
      const now = Date.now();
      const elapsed = now - lastBlockTs;
      const delay = 800 + Math.random() * 1200; // 800~2000ms
      if (lastBlockTs && elapsed < delay) {
        await new Promise(r => setTimeout(r, delay - elapsed));
      }
      const MAX = 4096;
      for (let i = 0; i < text.length; i += MAX) {
        await bot.sendMessage(chatId, text.slice(i, i + MAX));
      }
      lastBlockTs = Date.now();
    },

    /** 流式草稿（Bot API 9.5 sendMessageDraft） */
    async sendDraft(chatId, text) {
      return bot._request("sendMessageDraft", {
        form: { chat_id: chatId, text },
      });
    },

    stop() {
      stopped = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      bot.removeAllListeners();
      bot.stopPolling();
    },

    /** 验证 token 有效性 */
    async getMe() {
      return bot.getMe();
    },
  };
}
