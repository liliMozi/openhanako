/**
 * bridge-manager.js — 外部平台接入管理器
 *
 * 统一管理 Telegram / 飞书等外部消息平台的生命周期。
 * 每个平台一个 adapter，共享 engine 的 _executeExternalMessage()。
 */

import fs from "fs";
import os from "os";
import path from "path";
import { debugLog } from "../debug-log.js";
import { createTelegramAdapter } from "./telegram-adapter.js";
import { createFeishuAdapter } from "./feishu-adapter.js";
import { createQQAdapter } from "./qq-adapter.js";
import { createWechatAdapter } from "./wechat-adapter.js";
import { downloadMedia, bufferToBase64, detectMime, splitMediaFromOutput, formatSize, setMediaLocalRoots } from "./media-utils.js";
import { mediaItemKey, normalizeMediaItems } from "./media-item-normalizer.js";
import { MediaDeliveryService } from "./media-delivery-service.js";
import { MediaPublisher } from "./media-publisher.js";
import { AppError } from "../../shared/errors.js";
import { errorBus } from "../../shared/error-bus.js";
import { handleRcPendingInput } from "../../core/slash-commands/rc-pending-handler.js";
import { collectMediaItems } from "../tools/media-details.js";

// ── Adapter Registry ─────────────────────────────────────
// 每个平台注册：create 工厂、凭证提取、owner sessionKey 构造。
// 新增平台只需在此注册 + 提供 adapter 文件。
const ADAPTER_REGISTRY = {
  telegram: {
    create: (creds, onMessage, hooks, agentId) => createTelegramAdapter({ token: creds.token, agentId, onMessage, onStatus: hooks?.onStatus }),
    getCredentials: (cfg) => cfg?.enabled && cfg?.token ? { token: cfg.token } : null,
    ownerSessionKey: (userId, agentId) => `tg_dm_${userId}@${agentId}`,
  },
  feishu: {
    create: (creds, onMessage, hooks, agentId) => createFeishuAdapter({ appId: creds.appId, appSecret: creds.appSecret, agentId, onMessage, onStatus: hooks?.onStatus }),
    getCredentials: (cfg) => cfg?.enabled && cfg?.appId && cfg?.appSecret ? { appId: cfg.appId, appSecret: cfg.appSecret } : null,
    ownerSessionKey: (userId, agentId) => `fs_dm_${userId}@${agentId}`,
    connectsAsync: true,
  },
  qq: {
    create: (creds, onMessage, hooks, agentId) => createQQAdapter({
      appID: creds.appID, appSecret: creds.appSecret, agentId, onMessage,
      dmGuildMap: creds.dmGuildMap,
      onDmGuildDiscovered: hooks?.onQqDmGuild,
      onStatus: hooks?.onStatus,
    }),
    getCredentials: (cfg) => {
      const secret = cfg?.appSecret || cfg?.token; // 兼容旧版 token 字段
      return cfg?.enabled && cfg?.appID && secret
        ? { appID: cfg.appID, appSecret: secret, dmGuildMap: cfg.dmGuildMap }
        : null;
    },
    ownerSessionKey: (userId, agentId) => `qq_dm_${userId}@${agentId}`,
  },
  wechat: {
    create: (creds, onMessage, hooks, agentId) => createWechatAdapter({
      botToken: creds.botToken,
      hanaHome: creds.hanaHome,
      agentId,
      onMessage,
      onStatus: hooks?.onStatus,
    }),
    getCredentials: (cfg) => cfg?.enabled && cfg?.botToken ? { botToken: cfg.botToken, hanaHome: cfg._hanaHome || "" } : null,
    ownerSessionKey: (userId, agentId) => `wx_dm_${userId}@${agentId}`,
    connectsAsync: true,
  },
};

const MAX_INBOUND_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/* ── StreamCleaner ─────────────────────────────────────────
 * 增量剥离内部标签（mood/pulse/reflect/tool_code/think/thinking）。
 * 两态状态机（NORMAL / IN_TAG），支持标签跨 delta。
 */
const STRIP_TAGS = ["mood", "pulse", "reflect", "tool_code", "think", "thinking"];

class StreamCleaner {
  constructor() {
    this._buf = "";
    this._inTag = false;
    this._tagName = null;
    this.cleaned = "";
    /** 流式过程中提取到的媒体 URL */
    this.extractedMedia = [];
    this._inCodeFence = false;
    /** 媒体拦截的行缓冲（处理 delta 分片边界） */
    this._lineBuf = "";
  }

  /** 喂入 delta，返回可发送的干净文本增量（可能为空） */
  feed(delta) {
    this._buf += delta;
    let out = "";

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this._inTag) {
        const close = `</${this._tagName}>`;
        const ci = this._buf.toLowerCase().indexOf(close);
        if (ci === -1) break; // 等待更多数据
        this._buf = this._buf.slice(ci + close.length).replace(/^\s*/, "");
        this._inTag = false;
        this._tagName = null;
      } else {
        // 寻找最近的开标签（case-insensitive）
        let best = null;
        let bestIdx = Infinity;
        const lower = this._buf.toLowerCase();
        for (const tag of STRIP_TAGS) {
          const open = `<${tag}>`;
          const idx = lower.indexOf(open);
          if (idx !== -1 && idx < bestIdx) { bestIdx = idx; best = tag; }
        }

        if (best) {
          out += this._buf.slice(0, bestIdx);
          this._buf = this._buf.slice(bestIdx + `<${best}>`.length);
          this._inTag = true;
          this._tagName = best;
        } else {
          // 保留可能的不完整开标签（如 "<Moo"）
          let hold = 0;
          const lower = this._buf.toLowerCase();
          for (const tag of STRIP_TAGS) {
            const open = `<${tag}>`;
            for (let len = 1; len < open.length; len++) {
              if (lower.endsWith(open.slice(0, len)) && len > hold) hold = len;
            }
          }
          out += this._buf.slice(0, this._buf.length - hold);
          this._buf = this._buf.slice(this._buf.length - hold);
          break;
        }
      }
    }

    // ── 媒体拦截：从 out 中剥离 MEDIA: 和 ![](url) ──
    out = this._interceptMedia(out);

    this.cleaned += out;
    return out;
  }

  /**
   * 从文本增量中拦截媒体标记，返回剥离后的干净文本。
   * 使用行缓冲处理 delta 分片边界（如 "MED" + "IA:https://..."）。
   * 只有遇到换行时才处理完整行，未完成的行 hold 在 _lineBuf 中。
   */
  _interceptMedia(text) {
    if (!text) return text;

    // 把新文本追加到行缓冲
    this._lineBuf += text;

    // 按换行拆分：最后一段如果没有换行，留在 _lineBuf 等下一个 delta
    const parts = this._lineBuf.split("\n");
    this._lineBuf = parts.pop(); // 最后一段（可能不完整）留着

    const cleaned = [];
    for (const line of parts) {
      const processed = this._processLine(line);
      if (processed !== null) cleaned.push(processed);
    }

    return cleaned.length ? cleaned.join("\n") + "\n" : "";
  }

  /** 处理一行完整文本，返回 null 表示该行被媒体拦截移除 */
  _processLine(line) {
    const trimmed = line.trim();
    // 追踪 code fence 状态
    if (trimmed.startsWith("```")) {
      this._inCodeFence = !this._inCodeFence;
      return line;
    }
    if (this._inCodeFence) return line;

    // MEDIA:<source> 指令行（支持 URL 和本地路径，路径可含空格）
    const mediaMatch = /^MEDIA:\s*<?(.+?)>?\s*$/.exec(trimmed);
    if (mediaMatch) {
      const source = mediaMatch[1].trim();
      // 接受 http(s) URL、file:// URI、绝对路径
      const isHttp = source.startsWith("http://") || source.startsWith("https://");
      const isFile = source.startsWith("file://") || path.isAbsolute(source);
      if (isHttp || isFile) {
        this.extractedMedia.push(source);
      }
      return null; // 无论是否有效都从输出中移除（不泄漏路径）
    }

    // ![alt](url) — 整行是图片标记时拦截
    const imgMatch = /^!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)\s*$/.exec(trimmed);
    if (imgMatch) {
      this.extractedMedia.push(imgMatch[1]);
      return null;
    }

    return line;
  }

  /** 流结束时 flush 行缓冲中剩余的不完整行 */
  flushLineBuf() {
    if (!this._lineBuf) return "";
    const line = this._lineBuf;
    this._lineBuf = "";
    const processed = this._processLine(line);
    return processed !== null ? processed : "";
  }
}

/* ── BlockChunker ─────────────────────────────────────────
 * 将流式文本按行拆成多条消息（block streaming）。
 *
 * 规则：换行即分块，但 markdown 结构内不拆。
 *   普通行 + \n → flush 为一条气泡
 *   列表 / 代码围栏 / 表格 / 引用 → 积累为一整块
 *   标题（# ）→ 开启「节模式」，节内所有内容攒成一个气泡，
 *              下一个标题触发 flush 并开启新节
 *   结构块结束后恢复逐行发送
 */
class BlockChunker {
  /**
   * @param {object} opts
   * @param {(text: string) => Promise<void>} opts.onFlush  发送一条消息
   * @param {number} [opts.maxChars=2000]  安全上限：无换行时强制 flush
   */
  constructor({ onFlush, maxChars = 2000 }) {
    this._onFlush = onFlush;
    this._maxChars = maxChars;
    this._buf = "";
    this._flushing = Promise.resolve();
    this._inCodeFence = false;
    this._structured = false;
    this._inSection = false;
    this._currentLine = "";
  }

  /** 喂入清理后的文本增量 */
  feed(text) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      this._buf += ch;
      this._currentLine += ch;
      if (ch === '\n') {
        this._onLineEnd(this._currentLine);
        this._currentLine = "";
      }
    }
    // 安全：无换行的超长文本强制 flush
    if (this._buf.length >= this._maxChars && !this._inCodeFence) {
      this._flushBuf();
    }
  }

  /** 流结束：flush 剩余 buffer */
  async finish() {
    await this._flushing;
    const rest = this._buf.trim();
    if (rest) {
      await this._onFlush(rest);
      this._buf = "";
    }
    this._currentLine = "";
  }

  _onLineEnd(line) {
    const stripped = line.replace(/\n$/, '');
    const trimmed = stripped.trim();
    const isEmpty = trimmed === '';

    // ── 代码围栏 ──
    if (trimmed.startsWith('```')) {
      if (this._inCodeFence) {
        // 关闭围栏：flush 整个代码块（含 ``` 行）
        this._inCodeFence = false;
        this._flushBuf();
      } else {
        // 打开围栏：先 flush 围栏前的内容
        this._inCodeFence = true;
        const cutAt = this._buf.length - line.length;
        if (cutAt > 0) this._flushAt(cutAt);
      }
      return;
    }
    if (this._inCodeFence) return;

    // ── 标题：开启/切换节 ──
    const isHeading = /^#{1,6} /.test(trimmed);
    if (isHeading) {
      // flush 标题前的内容（上一节 / 普通行 / 结构块）
      const cutAt = this._buf.length - line.length;
      if (cutAt > 0) this._flushAt(cutAt);
      this._inSection = true;
      this._sectionHasContent = false;
      this._structured = false;
      return;
    }

    // ── 节内：积累，有内容后遇段落空行才 flush ──
    if (this._inSection) {
      if (!isEmpty) this._sectionHasContent = true;
      if (isEmpty && this._sectionHasContent && this._buf.slice(0, -1).endsWith('\n')) {
        this._flushBuf();
        this._inSection = false;
      }
      return;
    }

    // ── 结构化内容（列表 / 表格 / 引用）──
    const isList = /^[ \t]*[-*+] /.test(stripped) || /^[ \t]*\d+[.)]\s/.test(stripped);
    const isTable = /^[ \t]*\|.*\|/.test(stripped);
    const isBlockquote = /^[ \t]*>/.test(stripped);
    const isStructured = isList || isTable || isBlockquote;

    if (isStructured) {
      this._structured = true;
      return;
    }
    if (this._structured && isEmpty) return; // 结构块内空行

    if (this._structured) {
      // 结构块结束：flush 结构内容，当前行留在 buf
      this._structured = false;
      const cutAt = this._buf.length - line.length;
      if (cutAt > 0) this._flushAt(cutAt);
      // fall through：当前行按普通行处理
    }

    // ── 普通行：非空则 flush ──
    if (!isEmpty && this._buf.trim()) {
      this._flushBuf();
    }
  }

  /** flush 整个 buf */
  _flushBuf() {
    const content = this._buf.trim();
    this._buf = "";
    if (content) {
      this._flushing = this._flushing.then(() => this._onFlush(content)).catch((err) => {
        console.error("[BlockChunker] flush error:", err.message);
      });
    }
  }

  /** flush buf 前 cutAt 个字符，保留剩余 */
  _flushAt(cutAt) {
    const content = this._buf.slice(0, cutAt).trim();
    this._buf = this._buf.slice(cutAt);
    if (content) {
      this._flushing = this._flushing.then(() => this._onFlush(content)).catch((err) => {
        console.error("[BlockChunker] flush error:", err.message);
      });
    }
  }
}

/** 生成紧凑时间标记：<t>MM-DD HH:mm</t> */
function timeTag(ts = Date.now()) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `<t>${mm}-${dd} ${hh}:${mi}</t>`;
}

export class BridgeManager {
  /**
   * @param {object} opts
   * @param {import('../../core/engine.js').HanaEngine} opts.engine
   * @param {import('../../hub/index.js').Hub} opts.hub
   */
  constructor({ engine, hub }) {
    this.engine = engine;
    this._hub = hub;
    /** @type {Map<string, { adapter, status: string, error?: string }>} */
    this._platforms = new Map();
    /** per-sessionKey 消息缓冲（debounce + abort） */
    this._pending = new Map();
    /** per-sessionKey 处理锁（防止 debounce 触发和 abort 重发并发） */
    this._processing = new Set();
    /** 最近消息环形缓冲 per-agent（每个 agent 最多 200 条） */
    // 初始化媒体本地路径白名单
    // owner 模式下 agent 可能回复 MEDIA: 指向用户 home 下任意文件
    const roots = [engine.hanakoHome, os.homedir()];
    const deskHome = engine.agent?.deskManager?.homePath;
    if (deskHome) roots.push(deskHome);
    roots.push(os.tmpdir());
    setMediaLocalRoots(roots);
    this._messageLogs = new Map();
    this._messageLogMax = 200;
    this.mediaPublisher = new MediaPublisher({
      baseUrl: engine.getBridgeMediaPublicBaseUrl?.() || process.env.HANA_BRIDGE_PUBLIC_BASE_URL || "",
      allowedRoots: roots,
    });
    this._mediaDelivery = new MediaDeliveryService({ engine, mediaPublisher: this.mediaPublisher });
    /** legacy block streaming 开关，仅在 adapter 显式声明 block 能力时生效 */
    this.blockStreaming = true;
    this._draftCounter = 0;
    this._rcMirrorStreams = new Map();
    this._rcMirrorUnsubscribe = typeof hub?.subscribe === "function"
      ? hub.subscribe((event, sessionPath) => {
        this._handleRcMirrorEvent(event, sessionPath).catch((err) => {
          debugLog()?.warn("bridge", `rc mirror event failed: ${err.message}`);
        });
      })
      : null;
  }

  /** 生成平台 Map key（支持 per-agent 多实例） */
  _getPlatformKey(platform, agentId) {
    return agentId ? `${platform}:${agentId}` : platform;
  }

  /** 按平台名+agentId 查找 entry */
  _findPlatformEntry(platform, agentId) {
    if (agentId) {
      return this._platforms.get(this._getPlatformKey(platform, agentId)) || null;
    }
    // No agentId: return first matching platform entry (legacy compat)
    for (const [, entry] of this._platforms) {
      if (entry.platform === platform) return entry;
    }
    return null;
  }

  _clearPending(sessionKey) {
    const pending = this._pending.get(sessionKey);
    if (pending?.timer) clearTimeout(pending.timer);
    this._pending.delete(sessionKey);
  }

  _appendPendingAttachments(entry, target, attachments) {
    if (!attachments?.length) return;
    for (const att of attachments) {
      // 图片附件立即预下载（CDN 链接可能短时间过期，不能等 flush 再下载）
      if (att.type === "image" && !att.url && att.platformRef && entry?.adapter?.downloadImage) {
        entry.adapter.downloadImage(att.platformRef, att._messageId)
          .then(buf => { att._prefetched = buf; })
          .catch(err => debugLog()?.warn("bridge", `图片预下载失败: ${err.message}`));
      }
      target.push(att);
    }
  }

  _triggerPendingFlush(sessionKey) {
    void this._flushPending(sessionKey).catch((err) => {
      console.error(`[bridge] pending flush failed (${sessionKey}):`, err.message);
      debugLog()?.error("bridge", `pending flush failed (${sessionKey}): ${err.message}`);
      this._processing.delete(sessionKey);
    });
  }

  _schedulePendingFlush(sessionKey, delayMs) {
    const pending = this._pending.get(sessionKey);
    if (!pending) return;
    if (delayMs <= 0) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = null;
      this._triggerPendingFlush(sessionKey);
      return;
    }
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this._triggerPendingFlush(sessionKey), delayMs);
  }

  _takePendingBatch(sessionKey) {
    const pending = this._pending.get(sessionKey);
    if (!pending) return null;

    if (pending.kind === "group-queue") {
      const batch = pending.batches.shift() || null;
      if (!pending.batches.length) this._pending.delete(sessionKey);
      return batch;
    }

    if (!pending.lines?.length) return null;
    if (pending.timer) clearTimeout(pending.timer);
    const batch = {
      lines: pending.lines.splice(0),
      attachments: pending.attachments?.splice(0) || [],
      platform: pending.platform,
      chatId: pending.chatId,
      senderName: pending.senderName,
      avatarUrl: pending.avatarUrl,
      userId: pending.userId,
      isGroup: pending.isGroup,
      isOwner: pending.isOwner,
      agentId: pending.agentId,
      messageThreadId: pending.messageThreadId,
    };
    this._pending.delete(sessionKey);
    return batch;
  }

  /** 遍历所有 agent 的 config.bridge，自动启动已启用的平台 */
  autoStart(agents) {
    if (!agents) return;
    for (const [agentId, agent] of agents) {
      const bridgeCfg = agent.config?.bridge;
      if (!bridgeCfg) continue;
      for (const [platform, spec] of Object.entries(ADAPTER_REGISTRY)) {
        const cfg = { ...(bridgeCfg[platform] || {}) };
        if (platform === "wechat") cfg._hanaHome = this.engine.hanakoHome;
        const creds = spec.getCredentials(cfg);
        if (creds) this.startPlatform(platform, creds, agentId);
      }
    }
  }

  /**
   * 从配置启动平台（route 层用，不需要知道凭证结构）
   * @param {string} platform
   * @param {object} cfg - agent.config.bridge[platform] 的完整配置
   * @param {string} agentId - 绑定的 agent ID
   */
  startPlatformFromConfig(platform, cfg, agentId) {
    const spec = ADAPTER_REGISTRY[platform];
    if (!spec) return;
    if (platform === "wechat") cfg._hanaHome = this.engine.hanakoHome;
    const creds = spec.getCredentials(cfg);
    if (creds) this.startPlatform(platform, creds, agentId);
  }

  /**
   * 启动指定平台
   * @param {string} platform
   * @param {object} credentials
   * @param {string} [agentId] - 绑定的 agent ID（消息路由用）
   */
  startPlatform(platform, credentials, agentId) {
    const key = this._getPlatformKey(platform, agentId);
    this.stopPlatform(platform, agentId);

    const spec = ADAPTER_REGISTRY[platform];
    if (!spec) throw new Error(`Unknown platform: ${platform}`);

    try {
      const onMessage = (msg) => this._handleMessage(platform, msg);
      const hooks = {
        onEvent: (evt) => this._hub.eventBus.emit(evt, null),
        onQqDmGuild: (userId, guildId) => this._persistQqDmGuild(userId, guildId, agentId),
        onStatus: (status, error) => {
          const entry = this._platforms.get(key);
          if (entry) { entry.status = status; entry.error = error || null; }
          this._emitStatus(platform, status, error, agentId);
        },
      };
      const adapter = spec.create(credentials, onMessage, hooks, agentId);

      // 异步握手的平台先进入 connecting，直到 adapter 明确上报 connected/error。
      const initialStatus = spec.connectsAsync ? "connecting" : "connected";

      this._platforms.set(key, { adapter, status: initialStatus, agentId: agentId || null, platform });
      console.log(`[bridge] ${platform} 已启动`);
      debugLog()?.log("bridge", `${platform} started`);

      this._emitStatus(platform, initialStatus, null, agentId);
    } catch (err) {
      console.error(`[bridge] ${platform} 启动失败:`, err.message);
      debugLog()?.error("bridge", `${platform} start failed: ${err.message}`);
      this._platforms.set(key, { adapter: null, status: "error", error: err.message, agentId: agentId || null, platform });
      this._emitStatus(platform, "error", err.message, agentId);
    }
  }

  /** 持久化 QQ userId→guildId 映射到 agent config */
  _persistQqDmGuild(userId, guildId, agentId) {
    try {
      const agent = agentId ? this.engine.getAgent(agentId) : null;
      if (!agent) return;
      const existing = agent.config?.bridge?.qq?.dmGuildMap || {};
      if (existing[userId] === guildId) return;
      agent.updateConfig({ bridge: { qq: { dmGuildMap: { ...existing, [userId]: guildId } } } });
    } catch (err) {
      console.error("[bridge] persist QQ dmGuildMap failed:", err.message);
      errorBus.report(new AppError('BRIDGE_SEND_FAILED', { cause: err, context: { platform: 'qq', operation: 'flush dmGuildMap' } }));
    }
  }

  /** 停止指定平台 */
  stopPlatform(platform, agentId) {
    const key = this._getPlatformKey(platform, agentId);
    const entry = this._platforms.get(key);
    if (!entry) return;

    try {
      entry.adapter?.stop();
    } catch {}
    this._platforms.delete(key);
    console.log(`[bridge] ${platform} 已停止`);
    debugLog()?.log("bridge", `${platform} stopped`);
    this._emitStatus(platform, "disconnected", null, agentId);
  }

  /** 停止所有平台 */
  stopAll() {
    try { this._rcMirrorUnsubscribe?.(); } catch {}
    this._rcMirrorUnsubscribe = null;
    this._rcMirrorStreams.clear();
    for (const [key, entry] of this._platforms) {
      try { entry.adapter?.stop(); } catch {}
      const name = entry.platform || key;
      console.log(`[bridge] ${name} 已停止`);
      debugLog()?.log("bridge", `${name} stopped`);
      this._emitStatus(name, "disconnected", null, entry.agentId);
    }
    this._platforms.clear();
  }

  /** 获取平台状态（可按 agentId 过滤） */
  getStatus(agentId) {
    const result = {};
    for (const [, entry] of this._platforms) {
      if (agentId && entry.agentId !== agentId) continue;
      const name = entry.platform || "unknown";
      result[name] = { status: entry.status, error: entry.error || null };
    }
    return result;
  }

  _sendLlmWaitingReceipt(platform, chatId, agentId) {
    if (this.engine.getBridgeReceiptEnabled?.() === false) return;

    const entry = this._platforms.get(this._getPlatformKey(platform, agentId));
    const adapter = entry?.adapter;
    if (!adapter) return;

    const agentObj = this.engine.getAgent?.(agentId);
    const agentName = agentObj?.agentName || this.engine.agentName || "";
    if (agentName && adapter.sendReply) {
      adapter.sendReply(chatId, `（${agentName}正在输入...）`).catch(() => {});
    } else if (adapter.sendTypingIndicator) {
      adapter.sendTypingIndicator(chatId).catch(() => {});
    }
  }

  /**
   * 核心：收到外部消息
   *
   * 群聊：立即入队，不 debounce 不 abort，但同一 sessionKey 串行
   * 私聊：debounce 聚合 → 如正在处理则 abort → 合并发送
   */
  async _handleMessage(platform, msg) {
    const { sessionKey, text, senderName, avatarUrl, userId, isGroup, chatId, attachments, agentId: msgAgentId, messageThreadId } = msg;
    // agentId 优先从消息取，fallback 到 platform entry 的绑定
    const entry = this._platforms.get(this._getPlatformKey(platform, msgAgentId));
    const agentId = msgAgentId || entry?.agentId || null;
    if (!agentId) {
      console.error(`[bridge] ${platform} 消息缺少 agentId 且 adapter 未绑定，已丢弃。请在 bridge 配置中设置 agentId。`);
      return;
    }
    if (!entry?.adapter) return;

    const hasAttachments = attachments?.length > 0;
    debugLog()?.log("bridge", `← ${platform} ${isGroup ? "group" : "dm"} (${text.length} chars${hasAttachments ? `, ${attachments.length} attachment(s)` : ""})`);

    // 广播收到的消息
    this._pushMessage({
      platform, direction: "in", sessionKey, agentId,
      sender: senderName || "用户", text: text || (hasAttachments ? `[${attachments.length} 个附件]` : ""),
      isGroup, ts: Date.now(),
    });

    const isOwner = this._isOwner(platform, userId, agentId);

    // ── Slash 命令拦截（统一走 dispatcher）──
    // 纪律：
    //   1) 斜杠命令必须始终优先（任何 pending/attached 状态都不能夺走斜杠通道）
    //   2) 但仅 owner 能触发斜杠——guest 发的 /foo 跳过整个 dispatcher，
    //      让消息当普通文本进 LLM。
    //      原因：所有 bridge 命令都是 owner-only；guest 打 /stop 若被 dispatcher
    //      "静默拒绝"，消息会被 bridge-manager 清掉 pending + return，
    //      群里其他成员甚至 agent 都看不到这条发言，像消息被吞了。
    //      让 guest 的 slash 文本直接进 LLM，agent 可以正常回应，体验更符合直觉。
    const dispatcher = this.engine.slashDispatcher;
    if (dispatcher && text && text.trim().startsWith("/") && isOwner) {
      const sendReply = (t) => entry.adapter.sendReply(chatId, t).catch(() => {});
      const dispatchResult = await dispatcher.tryDispatch(text.trim(), {
        sessionRef: { kind: "bridge", agentId, sessionKey },
        source: platform,
        senderId: userId,
        senderName,
        isOwner,
        isGroup,
        chatId,
        reply: sendReply,
      });
      if (dispatchResult.handled) {
        this._clearPending(sessionKey);
        debugLog()?.log("bridge", `slash dispatched: ${text.trim().slice(0, 40)}`);
        return;
      }
    }

    // ── RC pending-selection 拦截（Phase 2-B） ──
    // 仅在非斜杠消息时介入：用户在 /rc 后回复编号（如 "2"），不是斜杠命令，
    // 正常会被喂给 LLM，但此时应当走 rc 选择流程。
    // pending-selection 按 sessionKey keying，guest 模式天然隔离（guest sessionKey 不同）。
    const rcState = this.engine.rcState;
    if (rcState && !isGroup && rcState.isPending(sessionKey) && text && isOwner) {
      const sendReply = (t) => entry.adapter.sendReply(chatId, t).catch(() => {});
      const r = await handleRcPendingInput({
        engine: this.engine,
        agentId,
        chatId,
        messageThreadId,
        sessionKey,
        text: text.trim(),
        isGroup,
        reply: async (t) => sendReply(t),
      });
      if (r?.handled) {
        // 吞掉同 sessionKey 的 debounce buffer，避免这条消息再被 flush 送进 LLM
        this._clearPending(sessionKey);
        debugLog()?.log("bridge", `rc pending handled: ${text.trim().slice(0, 20)}`);
        return;
      }
    }

    // ── 群聊：立即排队，但同一 sessionKey 串行处理 ──
    if (isGroup) {
      const line = senderName ? `${senderName}: ${text}` : text;
      let pending = this._pending.get(sessionKey);
      if (!pending) {
        pending = { kind: "group-queue", batches: [] };
        this._pending.set(sessionKey, pending);
      }
      const batch = {
        lines: [line],
        attachments: [],
        platform,
        chatId,
        senderName,
        avatarUrl,
        userId,
        isGroup: true,
        isOwner,
        agentId,
      };
      this._appendPendingAttachments(entry, batch.attachments, attachments);
      pending.batches.push(batch);
      if (!this._processing.has(sessionKey) && pending.batches.length === 1) {
        this._triggerPendingFlush(sessionKey);
      }
      return;
    }

    // ── 私聊：debounce + abort ──
    const line = !isOwner && senderName
      ? `${senderName}: ${text}` : text;

    let pending = this._pending.get(sessionKey);
    if (!pending) {
      pending = { kind: "dm-buffer", lines: [], attachments: [], platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner, agentId, messageThreadId };
      this._pending.set(sessionKey, pending);
    }
    pending.lines.push(line);
    this._appendPendingAttachments(entry, pending.attachments, attachments);
    Object.assign(pending, { platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner, messageThreadId });

    const isActive = this.engine.isBridgeSessionStreaming(sessionKey);

    this._schedulePendingFlush(sessionKey, isActive ? 1000 : 2000);
  }

  /**
   * 下载附件 Buffer（通用：优先 URL 直接下载，否则走 adapter 平台 API）
   */
  async _downloadAttachment(adapter, att) {
    if (att.url) return downloadMedia(att.url);
    if (att.platformRef && adapter?.downloadFileByRef) {
      return adapter.downloadFileByRef(att.platformRef);
    }
    if (att.platformRef && att._messageId && adapter?.downloadFile) {
      return adapter.downloadFile(att._messageId, att.platformRef);
    }
    return null;
  }

  async _resolveAttachments(platform, attachments, agentId) {
    const images = [];
    const notes = [];
    const inboundFiles = [];
    if (!attachments?.length) return { images, textNotes: "", inboundFiles };

    const entry = this._findPlatformEntry(platform, agentId);
    const adapter = entry?.adapter;

    for (const att of attachments) {
      try {
        if (att.size && att.size > MAX_INBOUND_ATTACHMENT_BYTES) {
          throw new Error(`attachment too large: ${att.filename || att.type || "file"}`);
        }
        if (att.type === "image") {
          let buffer = att._prefetched || null;
          if (!buffer && att.url) {
            buffer = await downloadMedia(att.url);
          } else if (!buffer && att.platformRef && adapter?.downloadImage) {
            buffer = await adapter.downloadImage(att.platformRef, att._messageId);
          }
          if (buffer) {
            const mime = detectMime(buffer, att.mimeType || "image/jpeg");
            this._assertInboundAttachmentSize(buffer, att);
            images.push({ type: "image", data: bufferToBase64(buffer), mimeType: mime });
            inboundFiles.push(this._inboundFileFromAttachment(att, buffer, mime, "image"));
          }
        } else if (att.type === "audio") {
          const buffer = await this._downloadAttachment(adapter, att);
          if (buffer) {
            this._assertInboundAttachmentSize(buffer, att);
            const mime = detectMime(buffer, att.mimeType || "application/octet-stream", att.filename || "voice.ogg");
            inboundFiles.push(this._inboundFileFromAttachment(att, buffer, mime, "audio"));
          }
          const dur = att.duration ? ` ${Math.round(att.duration)}秒` : "";
          notes.push(`[收到语音${dur}]`);
        } else if (att.type === "video") {
          const buffer = await this._downloadAttachment(adapter, att);
          if (buffer) {
            this._assertInboundAttachmentSize(buffer, att);
            const mime = detectMime(buffer, att.mimeType || "application/octet-stream", att.filename || "video.mp4");
            inboundFiles.push(this._inboundFileFromAttachment(att, buffer, mime, "video"));
          }
          notes.push(`[收到视频: ${att.filename || "video"}]`);
        } else {
          // file 类型：文本文件下载内容，二进制文件保留占位符
          const filename = att.filename || "file";
          const size = att.size ? ` (${formatSize(att.size)})` : "";
          const buffer = await this._downloadAttachment(adapter, att);
          if (buffer) {
            this._assertInboundAttachmentSize(buffer, att);
            const mime = detectMime(buffer, att.mimeType || "application/octet-stream", filename);
            inboundFiles.push(this._inboundFileFromAttachment(att, buffer, mime, "file"));
          }
          const textContent = buffer ? this._tryReadTextBuffer(att, buffer) : null;
          if (textContent !== null) {
            notes.push(`[文件: ${filename}${size}]\n\`\`\`\n${textContent}\n\`\`\``);
          } else {
            notes.push(`[收到文件: ${filename}${size}]`);
          }
        }
      } catch (err) {
        debugLog()?.warn("bridge", `附件解析失败: ${err.message}`);
        notes.push(`[附件加载失败: ${att.filename || att.type}]`);
      }
    }
    return { images, textNotes: notes.join("\n"), inboundFiles };
  }

  _assertInboundAttachmentSize(buffer, att) {
    const size = buffer?.length || 0;
    if (size > MAX_INBOUND_ATTACHMENT_BYTES) {
      throw new Error(`attachment too large: ${att?.filename || att?.type || "file"}`);
    }
  }

  _inboundFileFromAttachment(att, buffer, mimeType, fallbackType) {
    return {
      type: att.type || fallbackType,
      filename: att.filename || this._defaultAttachmentFilename(att.type || fallbackType, mimeType),
      mimeType,
      buffer,
    };
  }

  _defaultAttachmentFilename(type, mimeType) {
    const ext = (() => {
      if (mimeType === "image/png") return "png";
      if (mimeType === "image/gif") return "gif";
      if (mimeType === "image/webp") return "webp";
      if (mimeType?.startsWith("image/")) return "jpg";
      if (mimeType === "video/mp4" || type === "video") return "mp4";
      if (mimeType === "audio/mpeg") return "mp3";
      if (mimeType?.startsWith("audio/") || type === "audio") return "ogg";
      return "bin";
    })();
    return `${type || "file"}.${ext}`;
  }

  /**
   * 尝试将文件附件作为文本读取。
   * 仅对文本类扩展名且大小 ≤ 1MB 的文件生效，返回 string 或 null。
   */
  _tryReadTextBuffer(att, buffer) {
    const TEXT_EXTENSIONS = new Set([
      "txt", "md", "markdown", "json", "csv", "tsv", "xml", "yaml", "yml",
      "toml", "ini", "cfg", "conf", "log", "sql", "sh", "bash", "zsh",
      "py", "js", "ts", "jsx", "tsx", "mjs", "cjs",
      "java", "kt", "go", "rs", "rb", "php", "c", "h", "cpp", "hpp",
      "cs", "swift", "r", "lua", "pl", "html", "htm", "css", "scss",
      "less", "svg", "env", "gitignore", "dockerignore", "makefile",
      "dockerfile", "rst", "tex", "bib",
    ]);
    const MAX_TEXT_FILE_SIZE = 1024 * 1024; // 1MB

    const filename = (att.filename || "").toLowerCase();
    const ext = filename.split(".").pop() || "";
    if (!TEXT_EXTENSIONS.has(ext)) return null;

    // 已知大小超限则跳过
    if (att.size && att.size > MAX_TEXT_FILE_SIZE) return null;

    try {
      if (!buffer) return null;
      if (buffer.length > MAX_TEXT_FILE_SIZE) return null;

      // 简单的二进制检测：前 8KB 内出现 NUL 字节则视为二进制
      const sample = buffer.slice(0, 8192);
      if (sample.includes(0x00)) return null;

      return buffer.toString("utf-8");
    } catch (err) {
      debugLog()?.warn("bridge", `文件文本读取失败: ${err.message}`);
      return null;
    }
  }

  _createStreamDelivery({ adapter, chatId, isGroup, platform, messageThreadId }) {
    const capability = this._resolveStreamingCapability(adapter, isGroup);
    const mode = capability?.mode || "batch";
    const context = { platform, messageThreadId };

    if (mode === "draft") {
      return this._createDraftStreamDelivery({ adapter, chatId, capability, context });
    }
    if (mode === "edit_message") {
      return this._createEditMessageStreamDelivery({ adapter, chatId, capability, context });
    }
    if (mode === "block") {
      return this._createBlockStreamDelivery({ adapter, chatId });
    }
    return this._createBatchDelivery({ adapter, chatId });
  }

  _resolveStreamingCapability(adapter, isGroup) {
    const capability = adapter?.streamingCapabilities;
    if (!capability || isGroup) return null;
    if (capability.scopes?.length && !capability.scopes.includes("dm")) return null;
    if (capability.mode === "draft" && adapter?.sendDraft && adapter?.sendReply) return capability;
    if (
      capability.mode === "edit_message" &&
      adapter?.startStreamReply &&
      adapter?.updateStreamReply &&
      adapter?.finishStreamReply
    ) return capability;
    if (capability.mode === "block" && this.blockStreaming && adapter?.sendBlockReply) return capability;
    return null;
  }

  _createBatchDelivery({ adapter, chatId }) {
    return {
      mode: "batch",
      onDelta: undefined,
      finish: async (cleaned) => {
        const { text: textOnly, mediaUrls } = splitMediaFromOutput(cleaned);
        if (textOnly.trim()) await adapter.sendReply(chatId, textOnly.trim());
        return mediaUrls;
      },
    };
  }

  _createBlockStreamDelivery({ adapter, chatId }) {
    const cleaner = new StreamCleaner();
    let blockSentAny = false;
    const chunker = new BlockChunker({
      onFlush: async (text) => {
        blockSentAny = true;
        await adapter.sendBlockReply(chatId, text);
      },
    });

    return {
      mode: "block",
      onDelta: (delta) => {
        const inc = cleaner.feed(delta);
        if (inc) chunker.feed(inc);
      },
      finish: async (cleaned) => {
        const tail = cleaner.flushLineBuf();
        if (tail) {
          cleaner.cleaned += tail;
          chunker.feed(tail);
        }
        await chunker.finish();
        if (!blockSentAny) {
          const textOnly = (cleaner.cleaned || cleaned).trim();
          if (textOnly) await adapter.sendReply(chatId, textOnly);
        }
        const snapshot = this._cleanStreamSnapshot(cleaned);
        return [...cleaner.extractedMedia, ...snapshot.mediaUrls];
      },
    };
  }

  _createDraftStreamDelivery({ adapter, chatId, capability, context }) {
    const draftId = this._nextDraftId();
    const minIntervalMs = Number.isFinite(capability.minIntervalMs) ? capability.minIntervalMs : 500;
    const maxChars = Number.isFinite(capability.maxChars) ? capability.maxChars : 4096;
    let lastSentText = "";
    let lastDraftTs = 0;
    let failed = false;

    const sendSnapshot = (accumulated, force = false) => {
      if (failed) return;
      const { text } = this._cleanStreamSnapshot(accumulated);
      const next = this._truncateStreamText(text.trim(), maxChars);
      if (!next || next === lastSentText) return;
      const now = Date.now();
      if (!force && lastDraftTs && now - lastDraftTs < minIntervalMs) return;
      lastDraftTs = now;
      lastSentText = next;
      adapter.sendDraft(chatId, next, {
        draftId,
        messageThreadId: context.messageThreadId,
      }).catch(() => { failed = true; });
    };

    return {
      mode: "draft",
      onDelta: (_delta, accumulated) => sendSnapshot(accumulated || _delta),
      finish: async (cleaned) => {
        const { text, mediaUrls } = this._cleanStreamSnapshot(cleaned);
        const textOnly = text.trim();
        if (textOnly) {
          const finalText = this._truncateStreamText(textOnly, maxChars);
          if (!failed) {
            try {
              await adapter.sendDraft(chatId, finalText, {
                draftId,
                messageThreadId: context.messageThreadId,
              });
            } catch {
              failed = true;
            }
          }
          await adapter.sendReply(chatId, textOnly);
        }
        return mediaUrls;
      },
    };
  }

  _createEditMessageStreamDelivery({ adapter, chatId, capability, context }) {
    const minIntervalMs = Number.isFinite(capability.minIntervalMs) ? capability.minIntervalMs : 500;
    const maxChars = Number.isFinite(capability.maxChars) ? capability.maxChars : 150_000;
    let streamState = null;
    let lastSentText = "";
    let lastUpdateTs = 0;
    let failed = false;
    let chain = Promise.resolve();

    const enqueueSnapshot = (accumulated, force = false) => {
      if (failed) return;
      const { text } = this._cleanStreamSnapshot(accumulated);
      const next = this._truncateStreamText(text.trim(), maxChars);
      if (!next || next === lastSentText) return;
      const now = Date.now();
      if (!force && lastUpdateTs && now - lastUpdateTs < minIntervalMs) return;
      lastUpdateTs = now;
      lastSentText = next;
      chain = chain.then(async () => {
        if (!streamState) {
          streamState = await adapter.startStreamReply(chatId, next, context);
        } else {
          await adapter.updateStreamReply(chatId, streamState, next, context);
        }
      }).catch(() => { failed = true; });
    };

    return {
      mode: "edit_message",
      onDelta: (_delta, accumulated) => enqueueSnapshot(accumulated || _delta),
      finish: async (cleaned) => {
        const { text, mediaUrls } = this._cleanStreamSnapshot(cleaned);
        const textOnly = text.trim();
        await chain;
        if (!textOnly) return mediaUrls;
        const finalText = this._truncateStreamText(textOnly, maxChars);
        if (!failed) {
          try {
            if (!streamState) {
              streamState = await adapter.startStreamReply(chatId, finalText, context);
            } else {
              await adapter.finishStreamReply(chatId, streamState, finalText, context);
            }
            return mediaUrls;
          } catch {
            failed = true;
          }
        }
        await adapter.sendReply(chatId, textOnly);
        return mediaUrls;
      },
    };
  }

  _cleanStreamSnapshot(text) {
    let cleaned = this._cleanReplyForPlatform(text || "");
    for (const tag of STRIP_TAGS) {
      const open = new RegExp(`<${tag}>[\\s\\S]*$`, "i");
      cleaned = cleaned.replace(open, "");
    }
    cleaned = cleaned.replace(/<[^>\s]*$/g, "");
    const { text: textOnly, mediaUrls } = splitMediaFromOutput(cleaned);
    return { text: textOnly, mediaUrls };
  }

  _truncateStreamText(text, maxChars) {
    if (!Number.isFinite(maxChars) || maxChars <= 0) return text;
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }

  _nextDraftId() {
    this._draftCounter = (this._draftCounter + 1) % 1_000_000;
    return (Date.now() % 1_000_000_000) * 1000 + this._draftCounter;
  }

  /**
   * flush 已排队消息并发送给 LLM
   * - group: 单条入队，按 sessionKey 串行 drain
   * - dm: debounce 聚合后 flush
   */
  async _flushPending(sessionKey) {
    // 防止并发触发
    if (this._processing.has(sessionKey)) return;
    const batch = this._takePendingBatch(sessionKey);
    if (!batch || batch.lines.length === 0) return;
    this._processing.add(sessionKey);

    // 取出所有缓冲消息和附件
    const { lines, attachments: pendingAttachments = [], platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner, agentId, messageThreadId } = batch;

    try {
      // 解析附件
      const { images, textNotes, inboundFiles } = await this._resolveAttachments(platform, pendingAttachments, agentId);
      const prompt = textNotes ? `${lines.join("\n")}\n${textNotes}` : lines.join("\n");
      const merged = `${timeTag()} ${prompt}`;
      const meta = { name: senderName, avatarUrl, userId };

      // ── RC 接管态路由（Phase 2-C） ──
      // attachment 存在 → 消息进桌面 session 而非 bridge session
      // attachment 仅对 owner 生效（/rc 是 owner-only，guest 不会有 attachment，但 isOwner 防御检查一道）
      const rcState = this.engine.rcState;
      const rcAttachment = !isGroup && isOwner ? rcState?.getAttachment(sessionKey) : null;
      if (rcAttachment) {
        if (!(await this._desktopSessionStillExists(rcAttachment.desktopSessionPath))) {
          rcState?.detach(sessionKey);
          try {
            this.engine.emitEvent?.({
              type: "bridge_rc_detached",
              sessionKey,
              sessionPath: rcAttachment.desktopSessionPath,
            }, rcAttachment.desktopSessionPath);
          } catch {}
          const staleEntry = this._platforms.get(this._getPlatformKey(platform, agentId));
          try {
            await staleEntry?.adapter?.sendReply(chatId, "接管已失效：目标桌面会话不存在，已自动退出 /rc");
          } catch {}
          return;
        }
        await this._flushAttachedDesktopSession({
          sessionKey,
          desktopSessionPath: rcAttachment.desktopSessionPath,
          platform,
          chatId,
          agentId,
          text: prompt || (images.length ? "请查看图片" : ""),
          images,
          inboundFiles,
          messageThreadId,
          alreadyLocked: true,
        });
        return;
      }

      this._sendLlmWaitingReceipt(platform, chatId, agentId);

      // 如果 agent 正在 streaming，用 steer 注入而不是新建 prompt
      // 但如果有图片附件，不走 steer（Pi SDK 不支持往 streaming 中追加图片），等当前回复结束后正常处理
      if (!isGroup && !images.length && this.engine.steerBridgeSession(sessionKey, merged)) {
        debugLog()?.log("bridge", `steer ${platform} dm (${lines.length} msg(s))`);
        return;
      }

      debugLog()?.log("bridge", `flush ${platform} ${isGroup ? "group" : "dm"} (${lines.length} msg(s), ${merged.length} chars${images.length ? `, ${images.length} image(s)` : ""})`);

      const platformKey = this._getPlatformKey(platform, agentId);
      const entry = this._platforms.get(platformKey);
      const adapter = entry?.adapter;
      const delivery = this._createStreamDelivery({
        adapter,
        chatId,
        isGroup,
        platform,
        messageThreadId,
      });

      let reply = await this._hub.send(merged, {
        sessionKey,
        agentId,
        role: isGroup ? "guest" : isOwner ? "owner" : "guest",
        meta,
        isGroup,
        onDelta: delivery.onDelta,
        images: images.length ? images : undefined,
        inboundFiles: inboundFiles.length ? inboundFiles : undefined,
      });

      // bridge-session 返回 error 标记时，发送简短错误提示给用户
      if (reply && typeof reply === "object" && reply.__bridgeError) {
        if (adapter) {
          const errMsg = `[Error] ${reply.message || "Unable to process message"}`;
          try { await adapter.sendReply(chatId, errMsg); } catch {}
        }
        reply = null;
      }

      // 提取结构化返回中的 toolMedia（来自 details.media 合约）
      let toolMedia = [];
      if (reply && typeof reply === "object" && !reply.__bridgeError) {
        toolMedia = Array.isArray(reply.toolMedia) ? reply.toolMedia : [];
        reply = reply.text;
      }

      if (reply && adapter) {
        const cleaned = this._cleanReplyForPlatform(reply);
        let allMediaUrls = await delivery.finish(cleaned);

        // 合入工具 details.media 产出的媒体，并归一化去重
        if (toolMedia.length) {
          this._appendMediaItems(allMediaUrls, toolMedia);
        }
        allMediaUrls = normalizeMediaItems(allMediaUrls);

        // 统一发送所有提取到的媒体
        for (const item of allMediaUrls) {
          try { await this._sendMediaItem(adapter, chatId, item, { platform }); }
          catch (err) {
            debugLog()?.warn("bridge", `media send failed: ${err.message} (${this._describeMediaSource(item)})`);
            await this._mediaDelivery.sendFailureNotice(adapter, chatId, err);
          }
        }

        debugLog()?.log("bridge", `→ ${platform} reply (${cleaned.length} chars, mode: ${delivery.mode}${allMediaUrls.length ? `, ${allMediaUrls.length} media` : ""})`);
        const agentObj = this.engine.getAgent?.(agentId);
        const sender = agentObj?.agentName || this.engine.agentName;
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender, text: cleaned,
          isGroup, ts: Date.now(),
        });
      }
    } catch (err) {
      if (!err.message?.includes("aborted")) {
        console.error(`[bridge] ${platform} 消息处理失败:`, err.message);
        debugLog()?.error("bridge", `${platform} message handling failed: ${err.message}`);
      }
    } finally {
      this._processing.delete(sessionKey);
    }

    // 处理期间可能又有新消息进来了，检查并重新 flush
    const newPending = this._pending.get(sessionKey);
    if (newPending && ((newPending.kind === "group-queue" && newPending.batches.length > 0) || (newPending.kind !== "group-queue" && newPending.lines.length > 0))) {
      this._schedulePendingFlush(sessionKey, newPending.kind === "group-queue" ? 0 : 500);
    }
  }

  async _desktopSessionStillExists(sessionPath) {
    let hadAuthoritativeCheck = false;

    if (typeof this.engine?.listSessions === "function") {
      hadAuthoritativeCheck = true;
      const sessions = await this.engine.listSessions();
      if (sessions.some(session => session?.path === sessionPath)) return true;
    }

    if (typeof this.engine?.getSessionByPath === "function") {
      hadAuthoritativeCheck = true;
      if (this.engine.getSessionByPath(sessionPath)) return true;
    }

    if (typeof this.engine?.ensureSessionLoaded === "function") {
      hadAuthoritativeCheck = true;
      try {
        if (await this.engine.ensureSessionLoaded(sessionPath)) return true;
      } catch {
        return false;
      }
    }

    try {
      return fs.existsSync(sessionPath);
    } catch {
      return !hadAuthoritativeCheck;
    }
  }

  /**
   * RC 接管态下，把 bridge 消息 prompt 到桌面 session，并把生成流式送回 bridge 平台。
   *
   * 区别于 _flushPending：
   *   - 目标不是 bridge session（owner/xxx.jsonl），是桌面 session
   *   - 走与桌面输入框相同的桌面 session 提交通道（hub.send + sessionPath）
   *   - 桌面 UI 通过同一套 session_user_message / session_status / message_update 协议显示
   *   - bridge 侧仍复用 adapter reply / media 发送
   *
   * @private
   */
  async _flushAttachedDesktopSession({ sessionKey, desktopSessionPath, platform, chatId, agentId, text, images, inboundFiles, messageThreadId, alreadyLocked = false }) {
    if (!alreadyLocked) {
      if (this._processing.has(sessionKey)) return;
      this._processing.add(sessionKey);
    }

    const entry = this._platforms.get(this._getPlatformKey(platform, agentId));
    const adapter = entry?.adapter;
    this._sendLlmWaitingReceipt(platform, chatId, agentId);
    const delivery = this._createStreamDelivery({
      adapter,
      chatId,
      isGroup: false,
      platform,
      messageThreadId,
    });

    debugLog()?.log("bridge", `rc-attached flush ${platform} (${text.length} chars → ${desktopSessionPath})`);

    try {
      const displayMessage = {
        text,
        source: "bridge_rc",
        bridgeSessionKey: sessionKey,
        attachments: inboundFiles?.length
          ? undefined
          : images?.length
          ? images.map((img, idx) => ({
            path: `bridge-image-${idx}`,
            name: `bridge-image-${idx}.${(img.mimeType || "image/png").split("/")[1] || "png"}`,
            isDir: false,
            base64Data: img.data,
            mimeType: img.mimeType,
          }))
          : undefined,
      };
      const { text: replyText, toolMedia } = await this._hub.send(text, {
        sessionPath: desktopSessionPath,
        images: images?.length ? images : undefined,
        inboundFiles: inboundFiles?.length ? inboundFiles : undefined,
        displayMessage,
        uiContext: null,
        onDelta: delivery.onDelta,
      });

      if (replyText && adapter) {
        const cleaned = this._cleanReplyForPlatform(replyText);
        const mediaUrls = await delivery.finish(cleaned);
        const allMediaUrls = [...mediaUrls];
        this._appendMediaItems(allMediaUrls, toolMedia);
        const allMediaItems = normalizeMediaItems(allMediaUrls);

        for (const item of allMediaItems) {
          try { await this._sendMediaItem(adapter, chatId, item, { platform }); }
          catch (err) {
            debugLog()?.warn("bridge", `rc-attached media send failed: ${err.message}`);
            await this._mediaDelivery.sendFailureNotice(adapter, chatId, err);
          }
        }

        debugLog()?.log("bridge", `→ ${platform} rc-attached reply (${cleaned.length} chars)`);
        const agentObj = this.engine.getAgent?.(agentId);
        const sender = agentObj?.agentName || this.engine.agentName;
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender, text: cleaned,
          isGroup: false, ts: Date.now(),
        });
      }
    } catch (err) {
      if (!err.message?.includes("aborted")) {
        const errMsg = err.message === "session_busy"
          ? "当前桌面会话仍在回复中，请稍后再发"
          : err.message;
        console.error(`[bridge] rc-attached prompt failed (${platform}, ${desktopSessionPath}):`, errMsg);
        debugLog()?.error("bridge", `rc-attached failed: ${errMsg}`);
        if (adapter) {
          try { await adapter.sendReply(chatId, `[Error] ${errMsg}`); } catch {}
        }
      }
    } finally {
      if (!alreadyLocked) this._processing.delete(sessionKey);
    }

    // 处理期间又来新消息（debounce 吃了一部分），看是否还需要再 flush
    const newPending = this._pending.get(sessionKey);
    if (!alreadyLocked && newPending && ((newPending.kind === "group-queue" && newPending.batches.length > 0) || (newPending.kind !== "group-queue" && newPending.lines.length > 0))) {
      this._schedulePendingFlush(sessionKey, newPending.kind === "group-queue" ? 0 : 500);
    }
  }

  async _handleRcMirrorEvent(event, sessionPath) {
    if (!event || !sessionPath) return;

    if (event.type === "session_user_message") {
      const source = event.message?.source || "desktop";
      if (source === "bridge_rc") return;
      const target = this._resolveRcMirrorTarget(sessionPath);
      if (!target) return;

      const text = String(event.message?.text || "").trim();
      const attachments = Array.isArray(event.message?.attachments) ? event.message.attachments : [];
      const userLine = text ? `电脑端用户：${text}` : "电脑端用户发送了文件";
      await target.adapter.sendReply(target.chatId, userLine);
      this._pushMessage({
        platform: target.platform,
        direction: "out",
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        sender: target.sender,
        text: userLine,
        isGroup: false,
        ts: Date.now(),
      });

      for (const item of this._mediaItemsFromDesktopAttachments(attachments, sessionPath)) {
        try { await this._sendMediaItem(target.adapter, target.chatId, item, { platform: target.platform }); }
        catch (err) {
          debugLog()?.warn("bridge", `rc mirror media send failed: ${err.message}`);
          await this._mediaDelivery.sendFailureNotice(target.adapter, target.chatId, err);
        }
      }

      const delivery = this._createStreamDelivery({
        adapter: target.adapter,
        chatId: target.chatId,
        isGroup: false,
        platform: target.platform,
        messageThreadId: target.messageThreadId,
      });
      this._rcMirrorStreams.set(sessionPath, {
        ...target,
        delivery,
        text: "",
        toolMedia: [],
      });
      return;
    }

    const state = this._rcMirrorStreams.get(sessionPath);
    if (!state) return;

    if (event.type === "message_update") {
      const sub = event.assistantMessageEvent;
      if (sub?.type === "text_delta") {
        const delta = sub.delta || "";
        state.text += delta;
        try { state.delivery.onDelta?.(delta, state.text); } catch {}
      }
      return;
    }

    if (event.type === "tool_execution_end" && !event.isError) {
      state.toolMedia.push(...collectMediaItems(event.result?.details?.media));
      const card = event.result?.details?.card;
      if (card?.description) {
        state.text += (state.text ? "\n\n" : "") + card.description;
      }
      return;
    }

    if (event.type === "session_status" && event.isStreaming === false) {
      this._rcMirrorStreams.delete(sessionPath);
      const cleaned = this._cleanReplyForPlatform(state.text || "");
      if (!cleaned) return;

      let allMediaItems = await state.delivery.finish(cleaned);
      if (state.toolMedia.length) this._appendMediaItems(allMediaItems, state.toolMedia);
      allMediaItems = normalizeMediaItems(allMediaItems);

      for (const item of allMediaItems) {
        try { await this._sendMediaItem(state.adapter, state.chatId, item, { platform: state.platform }); }
        catch (err) {
          debugLog()?.warn("bridge", `rc mirror assistant media send failed: ${err.message}`);
          await this._mediaDelivery.sendFailureNotice(state.adapter, state.chatId, err);
        }
      }

      this._pushMessage({
        platform: state.platform,
        direction: "out",
        sessionKey: state.sessionKey,
        agentId: state.agentId,
        sender: state.sender,
        text: cleaned,
        isGroup: false,
        ts: Date.now(),
      });
    }
  }

  _resolveRcMirrorTarget(sessionPath) {
    const rcState = this.engine?.rcState;
    const sessionKey = rcState?.getAttachedBridgeSessionKey?.(sessionPath);
    if (!sessionKey) return null;
    const attachment = rcState.getAttachment?.(sessionKey) || {};
    const platform = attachment.platform || this._platformFromSessionKey(sessionKey);
    const agentId = attachment.agentId || this._extractAgentIdFromSessionKey(sessionKey);
    const entry = this._platforms.get(this._getPlatformKey(platform, agentId));
    const adapter = entry?.adapter;
    if (!adapter) return null;
    const chatId = attachment.chatId || this._chatIdFromBridgeSessionKey(sessionKey);
    if (!chatId) return null;
    const agentObj = this.engine.getAgent?.(agentId);
    return {
      sessionKey,
      platform,
      agentId,
      chatId,
      adapter,
      messageThreadId: attachment.messageThreadId || null,
      sender: agentObj?.agentName || this.engine.agentName,
    };
  }

  _mediaItemsFromDesktopAttachments(attachments, sessionPath) {
    return (attachments || []).map((attachment) => {
      if (attachment?.fileId) {
        return {
          type: "session_file",
          fileId: attachment.fileId,
          sessionPath,
          filePath: attachment.path,
          filename: attachment.name || (attachment.path ? path.basename(attachment.path) : undefined),
          label: attachment.name,
          mime: attachment.mimeType,
          kind: attachment.kind,
        };
      }
      if (attachment?.path && path.isAbsolute(attachment.path)) {
        return { type: "legacy_local_path", filePath: attachment.path };
      }
      return null;
    }).filter(Boolean);
  }

  _platformFromSessionKey(sessionKey) {
    const match = /^([a-z]+)_/i.exec(sessionKey || "");
    return match ? match[1] : "bridge";
  }

  _chatIdFromBridgeSessionKey(sessionKey) {
    const withoutAgent = String(sessionKey || "").split("@")[0] || "";
    const match = /^[a-z]+_(?:dm|group)_(.+)$/i.exec(withoutAgent);
    return match ? match[1] : null;
  }

  /**
   * 发送单个媒体项到平台。
   * structured session_file 先解析身份，再由消费端能力决定发送方式。
   */
  async _sendMediaItem(adapter, chatId, source, context = {}) {
    return this._mediaDelivery.send({
      adapter,
      chatId,
      platform: context.platform,
      mediaItem: source,
    });
  }

  _appendMediaItems(target, items) {
    const merged = normalizeMediaItems([...(target || []), ...(items || [])]);
    target.splice(0, target.length, ...merged);
  }

  _mediaDedupeKey(item) {
    return mediaItemKey(item);
  }

  _describeMediaSource(item) {
    return this._mediaDelivery.describe(item);
  }

  /** 判断消息发送者是否为 owner（per-agent） */
  _isOwner(platform, userId, agentId) {
    if (!userId) return false;
    // 微信 iLink 是私人协议，所有 DM 消息都来自 owner
    if (platform === "wechat") return true;
    const agent = agentId ? this.engine.getAgent(agentId) : null;
    const owner = agent?.config?.bridge?.[platform]?.owner;
    return owner && owner === userId;
  }

  /**
   * 清理发给外部平台的回复（batch 模式兜底，流式由 StreamCleaner 处理）：
   * - 去除 mood/pulse/reflect 区块（backtick 和 XML 两种格式）
   * - 去除 <think>/<thinking> 标签
   * - 去除 <tool_code> 标签
   */
  _cleanReplyForPlatform(text) {
    let cleaned = text;
    // 内省标签：backtick 和 XML 两种格式
    cleaned = cleaned.replace(/```(?:mood|pulse|reflect)[\s\S]*?```\n*/gi, "");
    cleaned = cleaned.replace(/<(?:mood|pulse|reflect)>[\s\S]*?<\/(?:mood|pulse|reflect)>\s*/gi, "");
    // thinking 标签
    cleaned = cleaned.replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>\s*/gi, "");
    // <tool_code> 标签
    cleaned = cleaned.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/gi, "");
    return cleaned.trim();
  }


  /**
   * 主动发送消息给 owner（不需要用户先发消息）
   * 用于心跳/cron 升级到 IM 的场景。
   *
   * @param {string} text - 要发送的文本（会自动 clean mood/pulse 标签）
   * @returns {{ platform: string, chatId: string } | null} 发送成功返回平台信息，失败返回 null
   */
  async sendProactive(text, targetAgentId) {
    const cleaned = this._cleanReplyForPlatform(text);
    if (!cleaned) return null;

    for (const [, entry] of this._platforms) {
      if (entry.status !== "connected" || !entry.adapter) continue;
      const platform = entry.platform;
      if (!platform) continue;
      if (targetAgentId && entry.agentId && entry.agentId !== targetAgentId) continue;

      const entryAgentId = entry.agentId;
      const agent = entryAgentId ? this.engine.getAgent(entryAgentId) : null;
      const ownerId = agent?.config?.bridge?.[platform]?.owner;
      if (!ownerId) continue;

      const chatId = entry.adapter.resolveOwnerChatId?.(ownerId) || ownerId;

      if (entry.adapter.capabilities?.proactive === false && !entry.adapter.canReply?.(chatId)) {
        debugLog()?.log("bridge", `→ ${platform} skipped proactive (no reply context for ${chatId})`);
        continue;
      }

      const spec = ADAPTER_REGISTRY[platform];
      try {
        await entry.adapter.sendReply(chatId, cleaned);
        debugLog()?.log("bridge", `→ ${platform} proactive to owner (${cleaned.length} chars)`);

        if (!entryAgentId) {
          throw new Error(`[bridge] proactive message to "${platform}" requires agentId`);
        }
        const sessionKey = spec?.ownerSessionKey?.(ownerId, entryAgentId) || `${platform}_dm_${ownerId}@${entryAgentId}`;
        const sender = agent?.agentName || this.engine.agentName;
        this._pushMessage({
          platform, direction: "out", sessionKey, agentId: entryAgentId,
          sender, text: cleaned,
          isGroup: false, ts: Date.now(),
        });

        return { platform, chatId, sessionKey };
      } catch (err) {
        console.error(`[bridge] proactive send failed (${platform}): ${err.message}`);
        debugLog()?.error("bridge", `proactive send failed (${platform}): ${err.message}`);
      }
    }

    return null;
  }

  /**
   * 从桌面端发送本地文件到 bridge 平台
   * @param {string} platform
   * @param {string} chatId
   * @param {string} filePath - 已校验过安全性的本地文件路径
   */
  async sendMediaFile(platform, chatId, filePath, agentId) {
    return this.sendMediaItem(platform, chatId, { type: "legacy_local_path", filePath }, agentId);
  }

  /**
   * 主动发送一个已归一化的媒体项到 bridge 平台。
   */
  async sendMediaItem(platform, chatId, mediaItem, agentId) {
    const entry = this._findPlatformEntry(platform, agentId);
    if (!entry?.adapter) throw new Error(`platform ${platform} not connected`);

    // 不支持主动推送的平台需要检查是否有回复窗口
    if (entry.adapter.capabilities?.proactive === false && !entry.adapter.canReply?.(chatId)) {
      throw new Error(`${platform}: 需要对方最近发过消息才能发送文件`);
    }

    await this._sendMediaItem(entry.adapter, chatId, mediaItem, { platform });
  }

  /** 广播状态到前端（通过 Hub EventBus） */
  _emitStatus(platform, status, error, agentId) {
    this._hub.eventBus.emit(
      { type: "bridge_status", platform, status, error: error || null, agentId: agentId || null },
      null,
    );
  }

  /** 记录消息并广播到前端（per-agent buffer） */
  _pushMessage(entry) {
    // Determine agentId from the entry or from the sessionKey @suffix
    const agentId = entry.agentId || this._extractAgentIdFromSessionKey(entry.sessionKey) || '_global';
    if (!this._messageLogs.has(agentId)) this._messageLogs.set(agentId, []);
    const log = this._messageLogs.get(agentId);
    log.push(entry);
    if (log.length > this._messageLogMax) log.shift();
    this._hub.eventBus.emit(
      { type: "bridge_message", message: { ...entry, agentId } },
      null,
    );
  }

  /** Extract agentId from sessionKey "@suffix" (e.g., "tg_dm_123@agent-1" → "agent-1") */
  _extractAgentIdFromSessionKey(sessionKey) {
    if (!sessionKey) return null;
    const atIdx = sessionKey.lastIndexOf('@');
    return atIdx !== -1 ? sessionKey.slice(atIdx + 1) : null;
  }

  /** 获取最近消息日志（供 REST API 使用，支持 per-agent 过滤） */
  getMessages(limit = 50, agentId = null) {
    if (agentId) {
      const log = this._messageLogs.get(agentId) || [];
      return log.slice(-limit);
    }
    // No filter: merge all logs (backward compat)
    const all = [];
    for (const log of this._messageLogs.values()) all.push(...log);
    all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return all.slice(-limit);
  }
}
