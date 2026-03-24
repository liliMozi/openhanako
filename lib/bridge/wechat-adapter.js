/**
 * wechat-adapter.js — 微信 ClawBot 长轮询适配器
 *
 * 通过微信 ClawBot 的 ilink HTTP JSON API 接收和发送消息。
 * 协议：getUpdates 长轮询上行，sendMessage 下行。
 * 认证：扫码登录获取 bot_token，通过 Bearer token 鉴权。
 *
 * 凭证存储在 preferences.bridge.wechat 中（token + baseUrl）。
 * 登录流程由 server/routes/bridge.js 的 /api/bridge/wechat-login-* 端点驱动。
 */

import crypto from "node:crypto";
import QRCode from "qrcode";
import { debugLog } from "../debug-log.js";

// ── 常量 ──────────────────────────────────────────────────
const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_PAUSE_MS = 60 * 60 * 1000; // 1 hour

// ── 工具函数 ──────────────────────────────────────────────

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

/** X-WECHAT-UIN header: random uint32 -> decimal -> base64 */
function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token, bodyStr) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(bodyStr, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

/** POST JSON 到微信 API */
async function apiFetch({ baseUrl, endpoint, body, token, timeoutMs, label }) {
  const base = ensureTrailingSlash(baseUrl);
  const url = new URL(endpoint, base).toString();
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const headers = buildHeaders(token, bodyStr);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`${label} ${res.status}: ${rawText}`);
    }
    return JSON.parse(rawText);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── 扫码登录 API ─────────────────────────────────────────

const DEFAULT_BOT_TYPE = "3";
const QR_POLL_TIMEOUT_MS = 35_000;

/**
 * 发起扫码登录 — 获取二维码
 * @param {{ baseUrl?: string }} opts
 * @returns {Promise<{ qrcodeUrl?: string, qrcode?: string, message: string }>}
 */
export async function startWechatLogin(opts = {}) {
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
  const base = ensureTrailingSlash(baseUrl);
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${DEFAULT_BOT_TYPE}`, base).toString();

  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    const data = await res.json();

    // 用 qrcode_img_content URL 作为扫码内容，在服务端本地生成二维码 data URI
    // 这样前端直接用 data: 协议加载，不受 CSP 限制
    const scanUrl = data.qrcode_img_content || null;
    let qrcodeDataUri = null;
    if (scanUrl) {
      try {
        qrcodeDataUri = await QRCode.toDataURL(scanUrl, {
          width: 280,
          margin: 2,
          color: { dark: "#000000", light: "#ffffff" },
        });
      } catch (qrErr) {
        debugLog()?.error("bridge", `[wechat] 生成二维码失败: ${qrErr.message}`);
      }
    }

    return {
      qrcodeUrl: qrcodeDataUri,
      qrcode: data.qrcode || null,
      message: "使用微信扫描以下二维码，以完成连接。",
    };
  } catch (err) {
    return { qrcodeUrl: null, qrcode: null, message: `获取二维码失败: ${err.message}` };
  }
}

/**
 * 轮询扫码结果
 * @param {{ qrcode: string, baseUrl?: string, timeoutMs?: number }} opts
 * @returns {Promise<{ connected: boolean, botToken?: string, accountId?: string, baseUrl?: string, userId?: string, message: string }>}
 */
export async function pollWechatLogin(opts) {
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
  const base = ensureTrailingSlash(baseUrl);
  const timeoutMs = opts.timeoutMs || 480_000;
  const deadline = Date.now() + timeoutMs;
  let maxRefresh = 3;
  let qrcode = opts.qrcode;

  while (Date.now() < deadline) {
    const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base).toString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QR_POLL_TIMEOUT_MS);
    let status;
    try {
      const headers = { "iLink-App-ClientVersion": "1" };
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
      status = JSON.parse(text);
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        // 长轮询超时正常，继续
        continue;
      }
      return { connected: false, message: `轮询失败: ${err.message}` };
    }

    switch (status.status) {
      case "wait":
        break;
      case "scaned":
        break;
      case "expired":
        maxRefresh--;
        if (maxRefresh <= 0) {
          return { connected: false, message: "二维码多次过期，请重新开始。" };
        }
        // 刷新二维码
        try {
          const refreshUrl = new URL(`ilink/bot/get_bot_qrcode?bot_type=${DEFAULT_BOT_TYPE}`, base).toString();
          const refreshRes = await fetch(refreshUrl);
          const refreshData = await refreshRes.json();
          qrcode = refreshData.qrcode;
        } catch (refreshErr) {
          return { connected: false, message: `刷新二维码失败: ${refreshErr.message}` };
        }
        break;
      case "confirmed":
        if (!status.ilink_bot_id) {
          return { connected: false, message: "登录失败: 服务器未返回 bot ID" };
        }
        return {
          connected: true,
          botToken: status.bot_token,
          accountId: status.ilink_bot_id,
          baseUrl: status.baseurl || baseUrl,
          userId: status.ilink_user_id,
          message: "✅ 与微信连接成功！",
        };
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  return { connected: false, message: "登录超时，请重试。" };
}

// ── 适配器工厂 ────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.token    - bot_token（扫码登录后获取）
 * @param {string} [opts.baseUrl] - API 基础 URL，默认微信官方
 * @param {(msg: BridgeMessage) => void} opts.onMessage
 * @param {(status: string, error?: string) => void} [opts.onStatus]
 * @returns {{ sendReply, sendBlockReply, stop }}
 */
export function createWechatAdapter({ token, baseUrl, onMessage, onStatus }) {
  const apiBase = baseUrl || DEFAULT_BASE_URL;
  let running = true;
  let getUpdatesBuf = "";
  /** 每个 userId 的 contextToken 缓存 */
  const contextTokens = new Map();
  /** session 暂停到（时间戳），遇到 -14 错误码暂停 1h */
  let pauseUntil = 0;

  // 长轮询循环
  let consecutiveFailures = 0;
  let nextTimeout = DEFAULT_LONG_POLL_TIMEOUT_MS;

  const pollLoop = async () => {
    debugLog()?.log("bridge", `[wechat] poll loop started (${apiBase})`);
    onStatus?.("connected");

    while (running) {
      // session 暂停检查
      if (pauseUntil > Date.now()) {
        const remain = Math.ceil((pauseUntil - Date.now()) / 60_000);
        debugLog()?.log("bridge", `[wechat] session paused, ${remain} min remaining`);
        await sleep(Math.min(pauseUntil - Date.now(), 60_000));
        continue;
      }

      try {
        const resp = await apiFetch({
          baseUrl: apiBase,
          endpoint: "ilink/bot/getupdates",
          body: { get_updates_buf: getUpdatesBuf, base_info: {} },
          token,
          timeoutMs: nextTimeout,
          label: "getUpdates",
        });

        if (resp.longpolling_timeout_ms > 0) {
          nextTimeout = resp.longpolling_timeout_ms;
        }

        // API 错误检查
        const isError = (resp.ret !== undefined && resp.ret !== 0) ||
                        (resp.errcode !== undefined && resp.errcode !== 0);
        if (isError) {
          // session 过期
          if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
            pauseUntil = Date.now() + SESSION_PAUSE_MS;
            debugLog()?.error("bridge", `[wechat] session expired, pausing 1h`);
            onStatus?.("error", "session expired, pausing 1h");
            consecutiveFailures = 0;
            continue;
          }

          consecutiveFailures++;
          debugLog()?.error("bridge", `[wechat] getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            consecutiveFailures = 0;
            await sleep(BACKOFF_DELAY_MS);
          } else {
            await sleep(RETRY_DELAY_MS);
          }
          continue;
        }

        consecutiveFailures = 0;

        // 更新同步游标
        if (resp.get_updates_buf) {
          getUpdatesBuf = resp.get_updates_buf;
        }

        // 处理消息
        const msgs = resp.msgs || [];
        for (const msg of msgs) {
          processInbound(msg);
        }
      } catch (err) {
        if (!running) break;
        // 长轮询超时正常
        if (err.name === "AbortError") continue;

        consecutiveFailures++;
        debugLog()?.error("bridge", `[wechat] getUpdates error: ${err.message} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS);
        } else {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    debugLog()?.log("bridge", `[wechat] poll loop ended`);
  };

  /** 处理一条入站消息 */
  function processInbound(msg) {
    // 只处理用户发的消息（message_type=1），忽略 bot 自身消息
    if (msg.message_type !== 1) return;
    // 只处理新消息（state=0）和已完成消息（state=2），忽略 generating（state=1）
    if (msg.message_state === 1) return;

    const fromUserId = msg.from_user_id || "";
    if (!fromUserId) return;

    // 缓存 contextToken（发送回复时需要）
    if (msg.context_token) {
      contextTokens.set(fromUserId, msg.context_token);
    }

    // 提取文本内容
    const items = msg.item_list || [];
    let text = "";
    for (const item of items) {
      if (item.type === 1 && item.text_item?.text) {
        // 文本消息
        text = item.text_item.text;
        break;
      }
      if (item.type === 3 && item.voice_item?.text) {
        // 语音转文字
        text = item.voice_item.text;
        break;
      }
    }

    if (!text) return;

    const MAX_MSG_SIZE = 100_000;
    if (text.length > MAX_MSG_SIZE) {
      text = text.slice(0, MAX_MSG_SIZE);
    }

    // 处理引用消息
    for (const item of items) {
      if (item.ref_msg?.title) {
        text = `[引用: ${item.ref_msg.title}]\n${text}`;
        break;
      }
    }

    // sessionKey：微信只支持私聊（direct），目前无群聊
    const sessionKey = `wx_dm_${fromUserId}`;

    debugLog()?.log("bridge", `[wechat] ← ${fromUserId}: ${text.slice(0, 50)}...`);

    onMessage({
      platform: "wechat",
      chatId: fromUserId,
      userId: fromUserId,
      sessionKey,
      text,
      senderName: null,
      avatarUrl: null,
      isGroup: false,
    });
  }

  /** 上次 block streaming 发送时间 */
  let lastBlockTs = 0;

  /** 生成唯一 clientId */
  function generateClientId() {
    return `hanako-wx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** 构造发送消息的请求体 */
  function buildSendReq(toUserId, text) {
    const contextToken = contextTokens.get(toUserId);
    return {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: generateClientId(),
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: text ? [{ type: 1, text_item: { text } }] : undefined,
        context_token: contextToken || undefined,
      },
    };
  }

  // 启动长轮询
  pollLoop().catch(err => {
    debugLog()?.error("bridge", `[wechat] pollLoop fatal: ${err.message}`);
    onStatus?.("error", err.message);
  });

  return {
    async sendReply(chatId, text) {
      const req = buildSendReq(chatId, text);
      await apiFetch({
        baseUrl: apiBase,
        endpoint: "ilink/bot/sendmessage",
        body: { ...req, base_info: {} },
        token,
        timeoutMs: DEFAULT_API_TIMEOUT_MS,
        label: "sendMessage",
      });
    },

    /** block streaming 专用：发一条气泡，两条之间加 humanDelay */
    async sendBlockReply(chatId, text) {
      const now = Date.now();
      const elapsed = now - lastBlockTs;
      const delay = 800 + Math.random() * 1200;
      if (lastBlockTs && elapsed < delay) {
        await new Promise(r => setTimeout(r, delay - elapsed));
      }
      await this.sendReply(chatId, text);
      lastBlockTs = Date.now();
    },

    stop() {
      running = false;
    },
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
