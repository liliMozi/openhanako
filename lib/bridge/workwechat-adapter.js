/**
 * workwechat-adapter.js — 企业微信智能机器人 WebSocket 长连接适配器
 *
 * 协议：所有通信通过单个 WebSocket 连接双向收发 JSON 命令帧。
 * 每条命令帧格式：{ cmd, headers: { req_id }, body? }
 * 响应帧格式：{ headers: { req_id }, errcode, errmsg, body? }
 *
 * 建立连接流程：
 *   1. 建立 WebSocket 连接到 wss://openws.work.weixin.qq.com
 *   2. 发送 aibot_subscribe（携带 bot_id + secret）
 *   3. 收到响应 errcode=0 后开始接收消息推送
 *
 * 接收：服务端推送 cmd=aibot_msg_callback / aibot_event_callback
 * 发送：通过同一 WS 发送 aibot_respond_msg / aibot_send_msg
 * 心跳：每 30s 发送 cmd=ping
 *
 * 凭证存储在 preferences.bridge.workwechat 中（botId + secret）。
 */

import { debugLog } from "../debug-log.js";
import WebSocket from "ws";

// ── 常量 ──────────────────────────────────────────────────
const WS_URL = "wss://openws.work.weixin.qq.com";
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const CMD_TIMEOUT_MS = 10_000;
const MAX_MSG_SIZE = 100_000;

// ── 适配器工厂 ────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.botId  - 智能机器人 BotID
 * @param {string} opts.secret - 长连接专用密钥 Secret
 * @param {(msg: object) => void} opts.onMessage
 * @param {(status: string, error?: string) => void} [opts.onStatus]
 * @returns {{ sendReply, sendBlockReply, sendProactive, stop }}
 */
export function createWorkwechatAdapter({ botId, secret, onMessage, onStatus, agentName, userMap = {} }) {
  let ws = null;
  let running = true;
  let subscribed = false;
  let reconnectDelay = RECONNECT_BASE_DELAY_MS;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let lastBlockTs = 0;
  let reqIdCounter = 0;
  let streamIdCounter = 0;

  /** 待处理请求回调 { [reqId]: { resolve, reject, timer } } */
  const pending = new Map();

  /** chatId → { reqId, isGroup }（用于 sendReply 透传和 fallback） */
  const chatReqIdMap = new Map();

  /** chatId → { streamId, timer }（block streaming 状态） */
  const blockStreams = new Map();

  // ── 帧工具 ──────────────────────────────────────────────

  function nextReqId() {
    return `wc_${Date.now()}_${++reqIdCounter}`;
  }

  function nextStreamId() {
    return `stream_${Date.now()}_${++streamIdCounter}`;
  }

  /** 发送 JSON 帧 */
  function sendFrame(frame) {
    if (ws?.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket not open (state=${ws?.readyState ?? 'null'})`);
    }
    const str = JSON.stringify(frame);
    debugLog()?.log("bridge", `[workwechat] → ${str.slice(0, 150)}`);
    ws.send(str);
  }

  /**
   * 发送命令并等待响应
   * @param {string} cmd     - 命令类型
   * @param {object} body   - 请求体
   * @param {object} [opts]
   * @param {string} [opts.reqId]     - 使用指定的 reqId（用于透传）
   * @param {boolean} [opts.waitResponse] - 是否等待响应（默认 true）
   * @param {number} [opts.timeoutMs]    - 超时毫秒
   */
  function sendCommand(cmd, body, opts = {}) {
    const reqId = opts.reqId || nextReqId();
    const frame = { cmd, headers: { req_id: reqId }, body };

    if (opts.waitResponse === false) {
      sendFrame(frame);
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`WeCom cmd ${cmd} timeout`));
      }, opts.timeoutMs || CMD_TIMEOUT_MS);

      pending.set(reqId, { resolve, reject, timer });
      sendFrame(frame);
    });
  }

  // ── WebSocket 连接管理 ─────────────────────────────────

  function connect() {
    if (!running) return;
    debugLog()?.log("bridge", `[workwechat] connecting to ${WS_URL}...`);
    onStatus?.("connecting");

    try {
      ws = new WebSocket(WS_URL);

      ws.on("open", () => {
        debugLog()?.log("bridge", `[workwechat] WS open, subscribing...`);
        doSubscribe();
      });

      ws.on("message", (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch (err) {
          debugLog()?.error("bridge", `[workwechat] invalid JSON: ${err.message}`);
          return;
        }
        handleFrame(msg);
      });

      ws.on("close", (code, reason) => {
        debugLog()?.log("bridge", `[workwechat] WS closed: ${code} ${reason || ""}`);
        subscribed = false;
        stopHeartbeat();
        if (running) scheduleReconnect();
      });

      ws.on("error", (err) => {
        debugLog()?.error("bridge", `[workwechat] WS error: ${err.message}`);
        onStatus?.("error", err.message);
      });

    } catch (err) {
      debugLog()?.error("bridge", `[workwechat] connect failed: ${err.message}`);
      if (running) scheduleReconnect();
    }
  }

  /** 发送订阅命令 */
  async function doSubscribe() {
    try {
      const res = await sendCommand("aibot_subscribe", { bot_id: botId, secret });
      if (res.errcode === 0) {
        subscribed = true;
        debugLog()?.log("bridge", `[workwechat] subscribed ok`);
        onStatus?.("connected");
        reconnectDelay = RECONNECT_BASE_DELAY_MS;
        startHeartbeat();
      } else {
        throw new Error(`errcode=${res.errcode} ${res.errmsg}`);
      }
    } catch (err) {
      debugLog()?.error("bridge", `[workwechat] subscribe failed: ${err.message}`);
      onStatus?.("error", err.message);
      try { ws?.close(); } catch {}
      if (running) scheduleReconnect();
    }
  }

  /** 处理服务端推送的帧 */
  function handleFrame(msg) {
    // 1. 匹配待处理请求的响应（通过 headers.req_id）
    const reqId = msg?.headers?.req_id;
    if (reqId && pending.has(reqId)) {
      const { resolve, reject, timer } = pending.get(reqId);
      clearTimeout(timer);
      pending.delete(reqId);
      if (msg.errcode != null && msg.errcode !== 0) {
        reject(new Error(`errcode=${msg.errcode} errmsg=${msg.errmsg || ""}`));
      } else {
        resolve(msg);
      }
      return;
    }

    // 2. 处理服务端主动推送（有 cmd 字段）
    const cmd = msg?.cmd;
    if (cmd === "aibot_msg_callback") {
      processMessage(msg);
    } else if (cmd === "aibot_event_callback") {
      processEvent(msg);
    } else if (reqId && !cmd) {
      // 有 req_id 但无 cmd：是 fire-and-forget 命令的响应（如 ping）
      // 也要 resolve pending，否则心跳会永远挂起直到超时
      if (pending.has(reqId)) {
        const { resolve, timer } = pending.get(reqId);
        clearTimeout(timer);
        pending.delete(reqId);
        resolve(msg);
      } else {
        debugLog()?.log("bridge", `[workwechat] stray response reqId=${reqId} errcode=${msg.errcode}`);
      }
    } else {
      debugLog()?.log("bridge", `[workwechat] unhandled frame cmd=${cmd} reqId=${reqId}`);
    }
  }

  // ── 心跳 ──────────────────────────────────────────────

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(async () => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      try {
        // ping 不需要等待响应，fire-and-forget
        await sendCommand("ping", undefined, { waitResponse: false });
      } catch (err) {
        debugLog()?.error("bridge", `[workwechat] ping failed, reconnecting: ${err.message}`);
        try { ws?.close(); } catch {}
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  // ── 重连 ──────────────────────────────────────────────

  function scheduleReconnect() {
    if (!running) return;
    onStatus?.("disconnected");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
      connect();
    }, reconnectDelay);
  }

  // ── 入站消息处理 ──────────────────────────────────────

  /** 处理 aibot_msg_callback */
  function processMessage(msg) {
    const body = msg.body || {};
    const reqId = msg.headers?.req_id;

    // 只处理文本消息
    if (body.msgtype !== "text") return;

    const fromUserId = body.from?.userid || "";
    const chatId = body.chatid || fromUserId;
    const isGroup = body.chattype === "group";
    let text = body.text?.content || "";

    if (!fromUserId || !text) return;
    if (text.length > MAX_MSG_SIZE) text = text.slice(0, MAX_MSG_SIZE);

    const sessionKey = isGroup
      ? `wc_group_${chatId}`
      : `wc_dm_${fromUserId}`;

    // 根据 userMap 查找用户昵称
    const senderName = userMap[fromUserId] || null;

    // 保存 reqId 和 isGroup 用于回复时透传
    chatReqIdMap.set(chatId, { reqId, isGroup });

    debugLog()?.log("bridge", `[workwechat] ← ${fromUserId}${senderName ? `(${senderName})` : ""}: ${text.slice(0, 60)}`);

    onMessage({
      platform: "workwechat",
      chatId,
      userId: fromUserId,
      sessionKey,
      text,
      senderName,
      avatarUrl: null,
      isGroup,
      _reqId: reqId,
    });
  }

  /** 处理 aibot_event_callback */
  function processEvent(msg) {
    const et = msg.body?.event?.eventtype;
    debugLog()?.log("bridge", `[workwechat] event: ${et}`);
    if (et === "disconnected_event") {
      debugLog()?.log("bridge", `[workwechat] kicked by new connection`);
    }
  }

  // ── 出站消息 ──────────────────────────────────────────

  /** 为助手回复添加名字前缀 */
  function withNamePrefix(text) {
    if (!agentName) return text;
    return `[${agentName}] ${text}`;
  }

  /**
   * 发送流式消息帧（aibot_respond_msg）
   * 必须透传原始消息的 req_id 到 headers
   */
  async function sendStreamFrame(chatId, text, reqId, streamId, finish) {
    debugLog()?.log("bridge", `[workwechat] sendStreamFrame finish=${finish} streamId=${streamId?.slice(0, 20)}... len=${text.length}`);
    await sendCommand("aibot_respond_msg", {
      msgtype: "stream",
      stream: {
        id: streamId,
        finish,
        content: text,
      },
    }, { reqId, waitResponse: false });
  }

  /** 主动推送消息（aibot_send_msg） */
  async function sendProactiveMessage(chatId, text, isGroup) {
    const prefixed = withNamePrefix(text);
    const MAX = 4096;
    for (let i = 0; i < prefixed.length; i += MAX) {
      await sendCommand("aibot_send_msg", {
        chatid: chatId,
        chat_type: isGroup ? 2 : 1, // 1=single, 2=group
        msgtype: "markdown",
        markdown: { content: prefixed.slice(i, i + MAX) },
      }, { waitResponse: false });
    }
  }

  // ── 启动 ──────────────────────────────────────────────

  connect();

  return {
    /**
     * 回复消息（非流式分块，发送单条 finish=true 的流式消息）
     * @param {string} chatId - 会话 ID
     * @param {string} text   - 消息文本
     * @param {object} [opts]
     * @param {string} [opts.reqId] - 透传的 req_id（来自 onMessage 的 _reqId）
     */
    async sendReply(chatId, text, opts = {}) {
      const entry = chatReqIdMap.get(chatId);
      const reqId = opts.reqId || opts._reqId || entry?.reqId;

      // 如果有未完成的 block stream，先结束它
      const bs = blockStreams.get(chatId);
      if (bs) {
        clearTimeout(bs.timer);
        blockStreams.delete(chatId);
        if (reqId) {
          debugLog()?.log("bridge", `[workwechat] sendReply finishing block stream chatId=${chatId}`);
          await sendStreamFrame(chatId, withNamePrefix(text), reqId, bs.streamId, true);
          return;
        }
      }

      if (!reqId) {
        debugLog()?.error("bridge", `[workwechat] sendReply: missing reqId for chatId=${chatId}, fallback to proactive`);
        await sendProactiveMessage(chatId, text, entry?.isGroup ?? false);
        return;
      }
      debugLog()?.log("bridge", `[workwechat] sendReply chatId=${chatId} reqId=${reqId?.slice(0, 20)}...`);
      const streamId = nextStreamId();
      await sendStreamFrame(chatId, withNamePrefix(text), reqId, streamId, true);
    },

    /**
     * block streaming：逐块刷新同一条流式消息
     * 使用相同的 stream.id 累积内容，3s 无新块自动 finish
     */
    async sendBlockReply(chatId, text, opts = {}) {
      const entry = chatReqIdMap.get(chatId);
      const reqId = opts.reqId || opts._reqId || entry?.reqId;

      // 人类延迟
      const now = Date.now();
      const elapsed = now - lastBlockTs;
      const delay = 800 + Math.random() * 1200;
      if (lastBlockTs && elapsed < delay) {
        await new Promise((r) => setTimeout(r, delay - elapsed));
      }

      if (!reqId) {
        debugLog()?.error("bridge", `[workwechat] sendBlockReply: missing reqId for chatId=${chatId}, fallback to proactive`);
        await sendProactiveMessage(chatId, text, entry?.isGroup ?? false);
        lastBlockTs = Date.now();
        return;
      }

      // 获取或创建 block stream
      let bs = blockStreams.get(chatId);
      if (!bs) {
        bs = { streamId: nextStreamId(), text: "", timer: null };
        blockStreams.set(chatId, bs);
      }
      bs.text += text;

      // 清除之前的 auto-finish timer
      if (bs.timer) clearTimeout(bs.timer);

      debugLog()?.log("bridge", `[workwechat] sendBlockReply chatId=${chatId} streamId=${bs.streamId?.slice(0, 20)}... len=${bs.text.length}`);
      await sendStreamFrame(chatId, withNamePrefix(bs.text), reqId, bs.streamId, false);

      // 3s 内无新块则自动 finish
      bs.timer = setTimeout(async () => {
        const current = blockStreams.get(chatId);
        if (current && current.streamId === bs.streamId) {
          try {
            await sendStreamFrame(chatId, withNamePrefix(current.text), reqId, current.streamId, true);
            debugLog()?.log("bridge", `[workwechat] block stream auto-finished chatId=${chatId}`);
          } catch (err) {
            debugLog()?.error("bridge", `[workwechat] block stream auto-finish failed: ${err.message}`);
          }
          blockStreams.delete(chatId);
        }
      }, 3000);

      lastBlockTs = Date.now();
    },

    /** 主动推送消息 */
    async sendProactive(chatId, text, isGroup = false) {
      await sendProactiveMessage(chatId, text, isGroup);
    },

    stop() {
      running = false;
      subscribed = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      stopHeartbeat();
      for (const [, { reject, timer }] of pending) {
        clearTimeout(timer);
        reject(new Error("adapter stopped"));
      }
      pending.clear();
      chatReqIdMap.clear();
      for (const [, bs] of blockStreams) {
        if (bs.timer) clearTimeout(bs.timer);
      }
      blockStreams.clear();
      if (ws) { try { ws.close(); } catch {} ws = null; }
    },
  };
}
