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
import { AppError } from "../../shared/errors.js";
import { errorBus } from "../../shared/error-bus.js";

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
  },
};

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
    /** 最近消息环形缓冲（最多 200 条） */
    this._messageLog = [];
    this._messageLogMax = 200;

    // 初始化媒体本地路径白名单
    // owner 模式下 agent 可能回复 MEDIA: 指向用户 home 下任意文件
    const roots = [engine.hanakoHome, os.homedir()];
    const deskHome = engine.agent?.deskManager?.homePath;
    if (deskHome) roots.push(deskHome);
    roots.push(os.tmpdir());
    setMediaLocalRoots(roots);
    /** block streaming 模式（默认开，多气泡发送） */
    this.blockStreaming = true;
  }

  /** 生成平台 Map key（支持 per-agent 多实例） */
  _getPlatformKey(platform, agentId) {
    return agentId ? `${platform}:${agentId}` : platform;
  }

  /** 按裸平台名查找 entry（兼容 composite key） */
  _findPlatformEntry(platform) {
    const direct = this._platforms.get(platform);
    if (direct) return direct;
    for (const [, entry] of this._platforms) {
      if (entry.platform === platform) return entry;
    }
    return null;
  }

  /** 读取 preferences 中的 bridge 配置，自动启动已启用的平台 */
  autoStart() {
    const prefs = this.engine.getPreferences();
    const bridge = prefs.bridge || {};

    for (const [platform, spec] of Object.entries(ADAPTER_REGISTRY)) {
      const cfg = bridge[platform] || {};
      if (platform === "wechat") cfg._hanaHome = this.engine.hanakoHome;
      const creds = spec.getCredentials(cfg);
      // 仅在配置中显式指定 agentId 时传入，否则走 focus agent fallback
      const agentId = cfg.agentId || null;
      if (creds) this.startPlatform(platform, creds, agentId);
    }
  }

  /**
   * 从 preferences 配置启动平台（route 层用，不需要知道凭证结构）
   * @param {string} platform
   * @param {object} cfg - prefs.bridge[platform] 的完整配置
   */
  startPlatformFromConfig(platform, cfg) {
    const spec = ADAPTER_REGISTRY[platform];
    if (!spec) return;
    if (platform === "wechat") cfg._hanaHome = this.engine.hanakoHome;
    const creds = spec.getCredentials(cfg);
    const agentId = cfg.agentId || null;
    if (creds) this.startPlatform(platform, creds, agentId);
  }

  /**
   * 启动指定平台
   * @param {string} platform
   * @param {object} credentials
   * @param {string} [agentId] - 绑定的 agent ID（消息路由用，不传则 fallback 到 focus agent）
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
        onQqDmGuild: (userId, guildId) => this._persistQqDmGuild(userId, guildId),
        onStatus: (status, error) => {
          const entry = this._platforms.get(key);
          if (entry) { entry.status = status; entry.error = error || null; }
          this._emitStatus(platform, status, error);
        },
      };
      const adapter = spec.create(credentials, onMessage, hooks, agentId);

      // Platforms with async connections (e.g. feishu WSClient) start as "connecting";
      // their onStatus callback will promote to "connected" or "error".
      const isAsync = platform === "feishu";
      const initialStatus = isAsync ? "connecting" : "connected";

      this._platforms.set(key, { adapter, status: initialStatus, agentId: agentId || null, platform });
      console.log(`[bridge] ${platform} 已启动`);
      debugLog()?.log("bridge", `${platform} started`);

      this._emitStatus(platform, initialStatus);
    } catch (err) {
      console.error(`[bridge] ${platform} 启动失败:`, err.message);
      debugLog()?.error("bridge", `${platform} start failed: ${err.message}`);
      this._platforms.set(key, { adapter: null, status: "error", error: err.message, agentId: agentId || null, platform });
      this._emitStatus(platform, "error", err.message);
    }
  }

  /** 持久化 QQ userId→guildId 映射到 preferences */
  _persistQqDmGuild(userId, guildId) {
    try {
      const prefs = this.engine.getPreferences();
      const qq = prefs.bridge?.qq || {};
      const map = qq.dmGuildMap || {};
      if (map[userId] === guildId) return;
      map[userId] = guildId;
      qq.dmGuildMap = map;
      if (!prefs.bridge) prefs.bridge = {};
      prefs.bridge.qq = qq;

      // 立即写入（PreferencesManager 内存缓存保证高效）。
      // 旧实现 debounce flush 时重新 getPreferences() 导致丢失累积修改。
      this.engine.savePreferences(prefs);
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
    this._emitStatus(platform, "disconnected");
  }

  /** 停止所有平台 */
  stopAll() {
    for (const [key, entry] of this._platforms) {
      try { entry.adapter?.stop(); } catch {}
      const name = entry.platform || key;
      console.log(`[bridge] ${name} 已停止`);
      debugLog()?.log("bridge", `${name} stopped`);
      this._emitStatus(name, "disconnected");
    }
    this._platforms.clear();
  }

  /** 获取所有平台状态 */
  getStatus() {
    const result = {};
    for (const [, entry] of this._platforms) {
      const name = entry.platform || "unknown";
      result[name] = { status: entry.status, error: entry.error || null };
    }
    return result;
  }

  /**
   * 核心：收到外部消息
   *
   * 群聊：直接发送，不 debounce 不 abort（轻量 guest 快速回复）
   * 私聊：debounce 聚合 → 如正在处理则 abort → 合并发送
   */
  async _handleMessage(platform, msg) {
    const { sessionKey, text, senderName, avatarUrl, userId, isGroup, chatId, attachments, agentId: msgAgentId } = msg;
    // 优先使用 adapter 绑定的 agentId，fallback 到 focus agent
    const agentId = msgAgentId || this.engine.currentAgentId;
    if (!msgAgentId) {
      console.warn(`[bridge] ${platform} 消息缺少 agentId，fallback 到焦点 agent "${agentId}"`);
    }
    const entry = this._platforms.get(platform) || this._platforms.get(this._getPlatformKey(platform, agentId));
    if (!entry?.adapter) return;

    const hasAttachments = attachments?.length > 0;
    debugLog()?.log("bridge", `← ${platform} ${isGroup ? "group" : "dm"} (${text.length} chars${hasAttachments ? `, ${attachments.length} attachment(s)` : ""})`);

    // 立刻发送"正在输入"，减少体感延迟
    const agentObj = this.engine.getAgent?.(agentId);
    const agentName = agentObj?.agentName || this.engine.agentName || "";
    if (agentName && entry?.adapter?.sendReply) {
      entry.adapter.sendReply(chatId, `（${agentName}正在输入...）`).catch(() => {});
    } else if (entry?.adapter?.sendTypingIndicator) {
      entry.adapter.sendTypingIndicator(chatId).catch(() => {});
    }

    // 广播收到的消息
    this._pushMessage({
      platform, direction: "in", sessionKey,
      sender: senderName || "用户", text: text || (hasAttachments ? `[${attachments.length} 个附件]` : ""),
      isGroup, ts: Date.now(),
    });

    const isOwner = this._isOwner(platform, userId);

    // ── /stop 命令：abort 当前生成，不触发新回复 ──
    if (isOwner && /^\/(stop|abort)$/i.test(text.trim())) {
      this.engine.abortBridgeSession(sessionKey).catch(() => {});
      debugLog()?.log("bridge", `abort ${platform} active session: /stop command`);
      const pending = this._pending.get(sessionKey);
      if (pending?.timer) clearTimeout(pending.timer);
      this._pending.delete(sessionKey);
      return;
    }

    // ── 群聊：快速路径，不 debounce 不 abort ──
    if (isGroup) {
      const line = senderName ? `${senderName}: ${text}` : text;
      const meta = { name: senderName, avatarUrl, userId };
      this._flushGroupMessage(platform, chatId, sessionKey, line, meta, attachments, agentId);
      return;
    }

    // ── 私聊：debounce + abort ──
    const line = !isOwner && senderName
      ? `${senderName}: ${text}` : text;

    let pending = this._pending.get(sessionKey);
    if (!pending) {
      pending = { lines: [], attachments: [], platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner, agentId };
      this._pending.set(sessionKey, pending);
    }
    pending.lines.push(line);
    if (hasAttachments) {
      for (const att of attachments) {
        // 图片附件立即预下载（CDN 链接可能短时间过期，不能等 debounce 完再下载）
        if (att.type === "image" && !att.url && att.platformRef && entry.adapter?.downloadImage) {
          entry.adapter.downloadImage(att.platformRef)
            .then(buf => { att._prefetched = buf; })
            .catch(err => debugLog()?.warn("bridge", `图片预下载失败: ${err.message}`));
        }
        pending.attachments.push(att);
      }
    }
    Object.assign(pending, { platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner });

    const isActive = this.engine.isBridgeSessionStreaming(sessionKey);

    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this._flushPending(sessionKey), isActive ? 1000 : 2000);
  }

  /**
   * 下载附件 Buffer（通用：优先 URL 直接下载，否则走 adapter 平台 API）
   */
  async _downloadAttachment(adapter, att) {
    if (att.url) return downloadMedia(att.url);
    if (att.platformRef && att._messageId && adapter?.downloadFile) {
      return adapter.downloadFile(att._messageId, att.platformRef);
    }
    return null;
  }

  async _resolveAttachments(platform, attachments) {
    const images = [];
    const notes = [];
    if (!attachments?.length) return { images, textNotes: "" };

    const entry = this._findPlatformEntry(platform);
    const adapter = entry?.adapter;

    for (const att of attachments) {
      try {
        if (att.type === "image") {
          let buffer = att._prefetched || null;
          if (!buffer && att.url) {
            buffer = await downloadMedia(att.url);
          } else if (!buffer && att.platformRef && adapter?.downloadImage) {
            buffer = await adapter.downloadImage(att.platformRef);
          }
          if (buffer) {
            const mime = detectMime(buffer, att.mimeType || "image/jpeg");
            images.push({ type: "image", data: bufferToBase64(buffer), mimeType: mime });
          }
        } else if (att.type === "audio") {
          const dur = att.duration ? ` ${Math.round(att.duration)}秒` : "";
          notes.push(`[收到语音${dur}]`);
        } else if (att.type === "video") {
          notes.push(`[收到视频: ${att.filename || "video"}]`);
        } else {
          // file 类型：文本文件下载内容，二进制文件保留占位符
          const filename = att.filename || "file";
          const size = att.size ? ` (${formatSize(att.size)})` : "";
          const textContent = await this._tryReadTextFile(adapter, att);
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
    return { images, textNotes: notes.join("\n") };
  }

  /**
   * 尝试将文件附件作为文本读取。
   * 仅对文本类扩展名且大小 ≤ 1MB 的文件生效，返回 string 或 null。
   */
  async _tryReadTextFile(adapter, att) {
    const TEXT_EXTENSIONS = new Set([
      "txt", "md", "markdown", "json", "csv", "tsv", "xml", "yaml", "yml",
      "toml", "ini", "cfg", "conf", "log", "sql", "sh", "bash", "zsh",
      "py", "js", "ts", "jsx", "tsx", "mjs", "cjs",
      "java", "kt", "go", "rs", "rb", "php", "c", "h", "cpp", "hpp",
      "cs", "swift", "r", "lua", "pl", "html", "htm", "css", "scss",
      "less", "svg", "env", "gitignore", "dockerignore", "makefile",
      "dockerfile", "rst", "tex", "bib",
    ]);
    const DOCX_EXTS = new Set(["docx"]);
    const MAX_TEXT_FILE_SIZE = 1024 * 1024; // 1MB

    const filename = (att.filename || "").toLowerCase();
    const ext = filename.split(".").pop() || "";
    
    // 处理 docx 文件
    if (DOCX_EXTS.has(ext)) {
      try {
        const buffer = await this._downloadAttachment(adapter, att);
        if (!buffer) return null;
        if (buffer.length > MAX_TEXT_FILE_SIZE) return null;
        
        // 保存临时文件
        const tempPath = `/tmp/${Date.now()}.docx`;
        require('fs').writeFileSync(tempPath, buffer);
        
        // 使用 mammoth 提取文本
        const mammoth = (await import("mammoth")).default;
        const result = await mammoth.extractRawText({ path: tempPath });
        
        // 清理临时文件
        require('fs').unlinkSync(tempPath);
        
        return result.value;
      } catch (err) {
        debugLog()?.warn("bridge", `docx 解析失败: ${err.message}`);
        return null;
      }
    }
    
    if (!TEXT_EXTENSIONS.has(ext)) return null;

    // 已知大小超限则跳过
    if (att.size && att.size > MAX_TEXT_FILE_SIZE) return null;

    try {
      const buffer = await this._downloadAttachment(adapter, att);
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

  async _flushGroupMessage(platform, chatId, sessionKey, line, meta, attachments, agentId) {
    const key = this._getPlatformKey(platform, agentId);
    const entry = this._platforms.get(key) || this._platforms.get(platform);
    if (!entry?.adapter) return;

    debugLog()?.log("bridge", `flush ${platform} group message (${line.length} chars)`);

    // typing indicator
    if (entry.adapter?.sendTypingIndicator) {
      entry.adapter.sendTypingIndicator(chatId).catch(() => {});
    }

    // 解析附件
    const { images, textNotes } = await this._resolveAttachments(platform, attachments);
    const prompt = textNotes ? `${line}\n${textNotes}` : line;

    const tagged = `${timeTag()} ${prompt}`;
    try {
      let reply = await this._hub.send(tagged, {
        sessionKey,
        agentId,
        role: "guest",
        meta,
        isGroup: true,
        images: images.length ? images : undefined,
      });

      // __bridgeError 守卫（群聊路径之前缺失此检查）
      if (typeof reply === "object" && reply.__bridgeError) {
        if (entry?.adapter) {
          const errMsg = `[Error] ${reply.message || "Unable to process message"}`;
          try { await entry.adapter.sendReply(chatId, errMsg); } catch {}
        }
        return;
      }
      // 提取结构化返回中的 toolMedia
      let toolMedia = [];
      if (typeof reply === "object") {
        toolMedia = Array.isArray(reply.toolMedia) ? reply.toolMedia : [];
        reply = reply.text;
      }

      if (reply && entry?.adapter) {
        const cleaned = this._cleanReplyForPlatform(reply);
        // batch 模式：提取媒体
        const { text: textOnly, mediaUrls } = splitMediaFromOutput(cleaned);
        if (toolMedia.length) {
          const seen = new Set(mediaUrls);
          for (const url of toolMedia) {
            if (!seen.has(url)) mediaUrls.push(url);
          }
        }
        if (textOnly.trim()) await entry.adapter.sendReply(chatId, textOnly);
        for (const url of mediaUrls) {
          try { await this._sendMediaItem(entry.adapter, chatId, url); }
          catch (err) { debugLog()?.warn("bridge", `media send failed: ${err.message} (${url.slice(0, 60)})`); }
        }
        debugLog()?.log("bridge", `→ ${platform} group reply (${cleaned.length} chars)`);
        const agentObj = this.engine.getAgent?.(agentId);
        const sender = agentObj?.agentName || this.engine.agentName;
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender, text: cleaned,
          isGroup: true, ts: Date.now(),
        });
      }
    } catch (err) {
      if (!err.message?.includes("aborted")) {
        console.error(`[bridge] ${platform} 群聊消息处理失败:`, err.message);
        debugLog()?.error("bridge", `${platform} group message failed: ${err.message}`);
      }
    }
  }

  /**
   * debounce 到期：合并缓冲消息并发送给 LLM
   */
  async _flushPending(sessionKey) {
    const pending = this._pending.get(sessionKey);
    if (!pending || pending.lines.length === 0) return;

    // 防止并发触发
    if (this._processing.has(sessionKey)) return;

    // 取出所有缓冲消息和附件
    const lines = pending.lines.splice(0);
    const pendingAttachments = pending.attachments?.splice(0) || [];
    const { platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner, agentId } = pending;
    this._pending.delete(sessionKey);

    // 解析附件
    const { images, textNotes } = await this._resolveAttachments(platform, pendingAttachments);
    const prompt = textNotes ? `${lines.join("\n")}\n${textNotes}` : lines.join("\n");
    const merged = `${timeTag()} ${prompt}`;
    const meta = { name: senderName, avatarUrl, userId };

    // 如果 agent 正在 streaming，用 steer 注入而不是新建 prompt
    // 但如果有图片附件，不走 steer（Pi SDK 不支持往 streaming 中追加图片），等当前回复结束后正常处理
    if (!images.length && this.engine.steerBridgeSession(sessionKey, merged)) {
      debugLog()?.log("bridge", `steer ${platform} dm (${lines.length} msg(s))`);
      return;
    }

    this._processing.add(sessionKey);

    // typing indicator（Telegram 原生支持，其他平台忽略）
    {
      const _key = this._getPlatformKey(platform, agentId);
      const _adapter = (this._platforms.get(_key) || this._platforms.get(platform))?.adapter;
      if (_adapter?.sendTypingIndicator) _adapter.sendTypingIndicator(chatId).catch(() => {});
    }

    debugLog()?.log("bridge", `flush ${platform} dm (${lines.length} msg(s), ${merged.length} chars${images.length ? `, ${images.length} image(s)` : ""})`);

    const platformKey = this._getPlatformKey(platform, agentId);
    const entry = this._platforms.get(platformKey) || this._platforms.get(platform);
    const adapter = entry?.adapter;

    // ── 流式输出（adapter 支持 sendBlockReply 即可流式）──
    const canStream = !!adapter?.sendBlockReply && !isGroup;
    const useBlockStream = canStream && this.blockStreaming;
    const useDraft = canStream && !this.blockStreaming && !!adapter?.sendDraft;

    let cleaner = null;
    let chunker = null;
    let blockSentAny = false;
    let lastDraftTs = 0;
    let draftFailed = false;
    const THROTTLE = 500;

    // block streaming: 多气泡发送
    if (useBlockStream) {
      cleaner = new StreamCleaner();
      chunker = new BlockChunker({
        onFlush: async (text) => {
          blockSentAny = true;
          await adapter.sendBlockReply(chatId, text);
        },
      });
    }

    const onDelta = canStream ? (_delta) => {
      if (useBlockStream) {
        const inc = cleaner.feed(_delta);
        if (inc) chunker.feed(inc);
      } else if (useDraft) {
        if (draftFailed) return;
        if (!cleaner) cleaner = new StreamCleaner();
        cleaner.feed(_delta);
        const now = Date.now();
        if (now - lastDraftTs < THROTTLE) return;
        if (!cleaner.cleaned.trim()) return;
        lastDraftTs = now;
        adapter.sendDraft(chatId, cleaner.cleaned).catch(() => { draftFailed = true; });
      }
    } : undefined;

    try {
      let reply = await this._hub.send(merged, {
        sessionKey,
        agentId,
        role: isOwner ? "owner" : "guest",
        meta,
        isGroup: false,
        onDelta,
        images: images.length ? images : undefined,
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
        let allMediaUrls = [];

        // flush StreamCleaner 行缓冲中剩余的不完整行
        if (cleaner) {
          const tail = cleaner.flushLineBuf();
          if (tail) {
            cleaner.cleaned += tail;
            if (chunker) chunker.feed(tail);
          }
        }

        if (useBlockStream && chunker) {
          await chunker.finish();
          allMediaUrls = cleaner?.extractedMedia || [];
          if (!blockSentAny) {
            const textOnly = (cleaner?.cleaned || cleaned).trim();
            if (textOnly) await adapter.sendReply(chatId, textOnly);
          }
        } else if (useDraft && cleaner) {
          // draft 模式：用 cleaner.cleaned（已剥离媒体标记）发送最终文本
          allMediaUrls = cleaner.extractedMedia || [];
          const textOnly = cleaner.cleaned.trim();
          if (textOnly) {
            try { await adapter.sendDraft(chatId, textOnly); }
            catch { await adapter.sendReply(chatId, textOnly); }
          }
        } else {
          // batch 模式：提取媒体
          const { text: textOnly, mediaUrls } = splitMediaFromOutput(cleaned);
          allMediaUrls = mediaUrls;
          if (textOnly.trim()) await adapter.sendReply(chatId, textOnly);
        }

        // 合入工具 details.media 产出的媒体，并去重
        if (toolMedia.length) {
          const seen = new Set(allMediaUrls);
          for (const url of toolMedia) {
            if (!seen.has(url)) allMediaUrls.push(url);
          }
        }

        // 统一发送所有提取到的媒体
        for (const url of allMediaUrls) {
          try { await this._sendMediaItem(adapter, chatId, url); }
          catch (err) { debugLog()?.warn("bridge", `media send failed: ${err.message} (${url.slice(0, 60)})`); }
        }

        debugLog()?.log("bridge", `→ ${platform} reply (${cleaned.length} chars, mode: ${useBlockStream ? "block" : useDraft ? "draft" : "batch"}${allMediaUrls.length ? `, ${allMediaUrls.length} media` : ""})`);
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
      // 确保 chunker 的异步 flush 链完成，即使 hub.send 中途抛错
      if (chunker) {
        try { await chunker.finish(); } catch {}
      }
      this._processing.delete(sessionKey);
    }

    // 处理期间可能又有新消息进来了，检查并重新 flush
    const newPending = this._pending.get(sessionKey);
    if (newPending && newPending.lines.length > 0) {
      if (newPending.timer) clearTimeout(newPending.timer);
      newPending.timer = setTimeout(() => this._flushPending(sessionKey), 500);
    }
  }

  /**
   * 发送单个媒体项（URL 或本地路径）到平台
   * 本地路径走 sendMediaBuffer，URL 走 sendMedia
   */
  async _sendMediaItem(adapter, chatId, source) {
    const isLocal = path.isAbsolute(source) || source.startsWith("file://");
    if (isLocal && adapter.sendMediaBuffer) {
      const buffer = await downloadMedia(source); // downloadMedia 已有路径安全校验
      const filename = path.basename(source.startsWith("file://") ? source.replace(/^file:\/\//, "") : source);
      const mime = detectMime(buffer, "application/octet-stream", filename);
      await adapter.sendMediaBuffer(chatId, buffer, { mime, filename });
    } else if (adapter.sendMedia) {
      await adapter.sendMedia(chatId, source);
    } else {
      await adapter.sendReply(chatId, source);
    }
  }

  /** 判断消息发送者是否为 owner */
  _isOwner(platform, userId) {
    if (!userId) return false;
    // 微信 iLink 是私人协议，所有 DM 消息都来自 owner
    if (platform === "wechat") return true;
    const prefs = this.engine.getPreferences();
    const ownerId = prefs.bridge?.owner?.[platform];
    return ownerId && ownerId === userId;
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
  async sendProactive(text) {
    const prefs = this.engine.getPreferences();
    const ownerIds = prefs.bridge?.owner || {};
    const cleaned = this._cleanReplyForPlatform(text);
    if (!cleaned) return null;

    // 按优先级尝试已连接的平台
    for (const [, entry] of this._platforms) {
      if (entry.status !== "connected" || !entry.adapter) continue;
      const platform = entry.platform;
      if (!platform) continue;
      const ownerId = ownerIds[platform];
      if (!ownerId) continue;

      // QQ 私信需要 guild_id 而非 userId，通过 adapter 解析
      const chatId = entry.adapter.resolveOwnerChatId?.(ownerId) || ownerId;

      // 跳过不支持主动推送的平台（如微信 iLink，需要对方先发消息才能回复）
      if (entry.adapter.capabilities?.proactive === false && !entry.adapter.canReply?.(chatId)) {
        debugLog()?.log("bridge", `→ ${platform} skipped proactive (no reply context for ${chatId})`);
        continue;
      }

      const spec = ADAPTER_REGISTRY[platform];
      try {
        await entry.adapter.sendReply(chatId, cleaned);
        debugLog()?.log("bridge", `→ ${platform} proactive to owner (${cleaned.length} chars)`);

        const entryAgentId = entry.agentId || this.engine.currentAgentId;
        const sessionKey = spec?.ownerSessionKey?.(ownerId, entryAgentId) || `${platform}_dm_${ownerId}@${entryAgentId}`;
        const agentObj = entry.agentId && this.engine.getAgent?.(entry.agentId);
        const sender = agentObj?.agentName || this.engine.agentName;
        this._pushMessage({
          platform, direction: "out", sessionKey,
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
  async sendMediaFile(platform, chatId, filePath) {
    const entry = this._findPlatformEntry(platform);
    if (!entry?.adapter) throw new Error(`platform ${platform} not connected`);

    // 不支持主动推送的平台需要检查是否有回复窗口
    if (entry.adapter.capabilities?.proactive === false && !entry.adapter.canReply?.(chatId)) {
      throw new Error(`${platform}: 需要对方最近发过消息才能发送文件`);
    }

    const buffer = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const mime = detectMime(buffer, "application/octet-stream", filename);

    // 优先 sendMediaBuffer（直传 Buffer），fallback 到 sendMedia（data URL）
    if (entry.adapter.sendMediaBuffer) {
      await entry.adapter.sendMediaBuffer(chatId, buffer, { mime, filename });
    } else if (entry.adapter.sendMedia) {
      const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
      await entry.adapter.sendMedia(chatId, dataUrl);
    } else {
      await entry.adapter.sendReply(chatId, `[文件: ${filename}]`);
    }
  }

  /** 广播状态到前端（通过 Hub EventBus） */
  _emitStatus(platform, status, error) {
    this._hub.eventBus.emit(
      { type: "bridge_status", platform, status, error: error || null },
      null,
    );
  }

  /** 记录消息并广播到前端 */
  _pushMessage(entry) {
    this._messageLog.push(entry);
    if (this._messageLog.length > this._messageLogMax) {
      this._messageLog.shift();
    }
    this._hub.eventBus.emit(
      { type: "bridge_message", message: entry },
      null,
    );
  }

  /** 获取最近消息日志（供 REST API 使用） */
  getMessages(limit = 50) {
    return this._messageLog.slice(-limit);
  }
}
