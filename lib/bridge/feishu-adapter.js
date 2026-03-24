/**
 * feishu-adapter.js — 飞书 Bot WebSocket 长连接适配器
 *
 * 使用 @larksuiteoapi/node-sdk 的 WSClient 接收消息，
 * 通过 onMessage 回调将标准化消息交给 BridgeManager。
 */

import * as lark from "@larksuiteoapi/node-sdk";
import { debugLog } from "../debug-log.js";
import { downloadMedia, detectMime, streamToBuffer } from "./media-utils.js";

/**
 * @param {object} opts
 * @param {string} opts.appId - 飞书 App ID
 * @param {string} opts.appSecret - 飞书 App Secret
 * @param {(msg: BridgeMessage) => void} opts.onMessage
 * @param {(status: string, error?: string) => void} [opts.onStatus]
 * @returns {{ sendReply, stop }}
 */
export function createFeishuAdapter({ appId, appSecret, onMessage, onStatus }) {
  const client = new lark.Client({ appId, appSecret });

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

      // 忽略 bot 自身消息
      if (sender.sender_type === "bot") return;

      const attachments = [];
      let text = "";

      try {
        if (message.message_type === "text") {
          text = JSON.parse(message.content).text || "";
        } else if (message.message_type === "image") {
          const { image_key } = JSON.parse(message.content);
          attachments.push({ type: "image", platformRef: image_key, mimeType: "image/jpeg" });
        } else if (message.message_type === "file") {
          const { file_key, file_name } = JSON.parse(message.content);
          attachments.push({ type: "file", platformRef: file_key, filename: file_name,
            _messageId: message.message_id });
        } else if (message.message_type === "audio") {
          const { file_key, duration } = JSON.parse(message.content);
          attachments.push({ type: "audio", platformRef: file_key,
            duration: duration ? duration / 1000 : undefined, _messageId: message.message_id });
        } else if (message.message_type === "media") {
          // 飞书 "media" = 视频
          const { file_key, file_name, duration } = JSON.parse(message.content);
          attachments.push({ type: "video", platformRef: file_key, filename: file_name,
            duration: duration ? duration / 1000 : undefined, _messageId: message.message_id });
        } else {
          return; // sticker 等暂不支持
        }
      } catch (e) {
        console.error("[feishu] Failed to parse message content:", e.message);
        return;
      }

      if (!text && !attachments.length) return;

      const MAX_MSG_SIZE = 100_000;
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
        attachments: attachments.length ? attachments : undefined,
      });
    },
  });

  const wsClient = new lark.WSClient({
    appId,
    appSecret,
    loggerLevel: lark.LoggerLevel.warn,
  });

  // start() 返回 Promise，但不等待 WebSocket 真正连通
  wsClient.start({ eventDispatcher }).catch((err) => {
    console.error("[feishu] WSClient start failed:", err.message);
    debugLog()?.error("bridge", `feishu WSClient start failed: ${err.message}`);
    onStatus?.("error", err.message);
  });

  // WSClient.start() resolves before the WebSocket connects — verify manually
  setTimeout(() => {
    if (wsClient._ws && wsClient._ws.readyState === 1) {
      onStatus?.("connected");
    } else {
      console.error("[feishu] WSClient failed to connect within timeout");
      onStatus?.("error", "WebSocket connection failed");
    }
  }, 10_000);

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

    /** 下载飞书图片（通过 image_key） */
    async downloadImage(imageKey) {
      const resp = await client.im.image.get({ path: { image_key: imageKey } });
      return streamToBuffer(resp);
    },

    /** 下载飞书文件/音频/视频（通过 message_id + file_key） */
    async downloadFile(messageId, fileKey) {
      const resp = await client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: "file" },
      });
      return streamToBuffer(resp);
    },

    /** 发送媒体（图片走 image API，其他走 file API） */
    async sendMedia(chatId, url) {
      const buffer = await downloadMedia(url);
      const mime = detectMime(buffer, "application/octet-stream");
      const filename = (() => { try { return new URL(url).pathname.split("/").pop() || "file"; } catch { return "file"; } })();
      await this.sendMediaBuffer(chatId, buffer, { mime, filename });
    },

    /** 发送本地 Buffer（sendMediaFile 专用，无需公开 URL） */
    async sendMediaBuffer(chatId, buffer, { mime, filename }) {
      if (mime.startsWith("image/")) {
        const res = await client.im.image.create({
          data: { image_type: "message", image: buffer },
        });
        await client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId, msg_type: "image",
            content: JSON.stringify({ image_key: res.data.image_key }),
          },
        });
      } else {
        const ext = (filename || "").split(".").pop()?.toLowerCase() || "";
        const fileType = { pdf: "pdf", doc: "doc", docx: "doc", xls: "xls",
          xlsx: "xls", ppt: "ppt", pptx: "ppt", mp4: "mp4" }[ext] || "stream";
        const res = await client.im.file.create({
          data: { file_type: fileType, file_name: filename || "file", file: buffer },
        });
        await client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId, msg_type: "file",
            content: JSON.stringify({ file_key: res.data.file_key }),
          },
        });
      }
    },

    stop() {
      try { wsClient.close(); } catch {}
    },
  };
}
