/**
 * bridge-manager.js — 外部平台接入管理器
 *
 * 统一管理 Telegram / 飞书等外部消息平台的生命周期。
 * 每个平台一个 adapter，共享 engine 的 _executeExternalMessage()。
 */

import path from "path";
import { debugLog } from "../debug-log.js";
import { createTelegramAdapter } from "./telegram-adapter.js";
import { createFeishuAdapter } from "./feishu-adapter.js";
import { createQQAdapter } from "./qq-adapter.js";

// ── Adapter Registry ─────────────────────────────────────
// 每个平台注册：create 工厂、凭证提取、owner sessionKey 构造。
// 新增平台只需在此注册 + 提供 adapter 文件。
const ADAPTER_REGISTRY = {
  telegram: {
    create: (creds, onMessage, hooks) => createTelegramAdapter({ token: creds.token, onMessage, onStatus: hooks?.onStatus }),
    getCredentials: (cfg) => cfg?.enabled && cfg?.token ? { token: cfg.token } : null,
    ownerSessionKey: (userId) => `tg_dm_${userId}`,
  },
  feishu: {
    create: (creds, onMessage, hooks) => createFeishuAdapter({ appId: creds.appId, appSecret: creds.appSecret, onMessage, onStatus: hooks?.onStatus }),
    getCredentials: (cfg) => cfg?.enabled && cfg?.appId && cfg?.appSecret ? { appId: cfg.appId, appSecret: cfg.appSecret } : null,
    ownerSessionKey: (userId) => `fs_dm_${userId}`,
  },
  qq: {
    create: (creds, onMessage, hooks) => createQQAdapter({
      appID: creds.appID, appSecret: creds.appSecret, onMessage,
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
    ownerSessionKey: (userId) => `qq_dm_${userId}`,
  },
};

/* ── StreamCleaner ─────────────────────────────────────────
 * 增量剥离 <mood>, <pulse>, <reflect>, <tool_code> 标签。
 * 两态状态机（NORMAL / IN_TAG），支持标签跨 delta。
 */
const STRIP_TAGS = ["mood", "pulse", "reflect", "tool_code"];

class StreamCleaner {
  constructor() {
    this._buf = "";
    this._inTag = false;
    this._tagName = null;
    this.cleaned = "";
  }

  /** 喂入 delta，返回可发送的干净文本增量（可能为空） */
  feed(delta) {
    this._buf += delta;
    let out = "";

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this._inTag) {
        const close = `</${this._tagName}>`;
        const ci = this._buf.indexOf(close);
        if (ci === -1) break; // 等待更多数据
        this._buf = this._buf.slice(ci + close.length).replace(/^\s*/, "");
        this._inTag = false;
        this._tagName = null;
      } else {
        // 寻找最近的开标签
        let best = null;
        let bestIdx = Infinity;
        for (const tag of STRIP_TAGS) {
          const open = `<${tag}>`;
          const idx = this._buf.indexOf(open);
          if (idx !== -1 && idx < bestIdx) { bestIdx = idx; best = tag; }
        }

        if (best) {
          out += this._buf.slice(0, bestIdx);
          this._buf = this._buf.slice(bestIdx + `<${best}>`.length);
          this._inTag = true;
          this._tagName = best;
        } else {
          // 保留可能的不完整开标签（如 "<moo"）
          let hold = 0;
          for (const tag of STRIP_TAGS) {
            const open = `<${tag}>`;
            for (let len = 1; len < open.length; len++) {
              if (this._buf.endsWith(open.slice(0, len)) && len > hold) hold = len;
            }
          }
          out += this._buf.slice(0, this._buf.length - hold);
          this._buf = this._buf.slice(this._buf.length - hold);
          break;
        }
      }
    }

    this.cleaned += out;
    return out;
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
      this._flushing = this._flushing.then(() => this._onFlush(content));
    }
  }

  /** flush buf 前 cutAt 个字符，保留剩余 */
  _flushAt(cutAt) {
    const content = this._buf.slice(0, cutAt).trim();
    this._buf = this._buf.slice(cutAt);
    if (content) {
      this._flushing = this._flushing.then(() => this._onFlush(content));
    }
  }
}

/** 生成紧凑时间标记：[MM-DD HH:mm] */
function timeTag(ts = Date.now()) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `[${mm}-${dd} ${hh}:${mi}]`;
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
    /** block streaming 模式（默认开，多气泡发送） */
    this.blockStreaming = true;
  }

  /** 读取 preferences 中的 bridge 配置，自动启动已启用的平台 */
  autoStart() {
    const prefs = this.engine.getPreferences();
    const bridge = prefs.bridge || {};

    for (const [platform, spec] of Object.entries(ADAPTER_REGISTRY)) {
      const creds = spec.getCredentials(bridge[platform]);
      if (creds) this.startPlatform(platform, creds);
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
    const creds = spec.getCredentials(cfg);
    if (creds) this.startPlatform(platform, creds);
  }

  /**
   * 启动指定平台
   * @param {string} platform
   * @param {object} credentials
   */
  startPlatform(platform, credentials) {
    this.stopPlatform(platform);

    const spec = ADAPTER_REGISTRY[platform];
    if (!spec) throw new Error(`未知平台: ${platform}`);

    try {
      const onMessage = (msg) => this._handleMessage(platform, msg);
      const hooks = {
        onEvent: (evt) => this._hub.eventBus.emit(evt, null),
        onQqDmGuild: (userId, guildId) => this._persistQqDmGuild(userId, guildId),
        onStatus: (status, error) => {
          const entry = this._platforms.get(platform);
          if (entry) { entry.status = status; entry.error = error || null; }
          this._emitStatus(platform, status, error);
        },
      };
      const adapter = spec.create(credentials, onMessage, hooks);

      this._platforms.set(platform, { adapter, status: "connected" });
      console.log(`[bridge] ${platform} 已启动`);
      debugLog()?.log("bridge", `${platform} started`);

      this._emitStatus(platform, "connected");
    } catch (err) {
      console.error(`[bridge] ${platform} 启动失败:`, err.message);
      debugLog()?.error("bridge", `${platform} start failed: ${err.message}`);
      this._platforms.set(platform, { adapter: null, status: "error", error: err.message });
      this._emitStatus(platform, "error", err.message);
    }
  }

  /** 持久化 QQ userId→guildId 映射到 preferences（debounced） */
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
      // debounce: 合并短时间内的多次映射发现，避免每条私信都同步写盘
      if (!this._qqDmGuildFlushTimer) {
        this._qqDmGuildFlushTimer = setTimeout(() => {
          this._qqDmGuildFlushTimer = null;
          try { this.engine.savePreferences(this.engine.getPreferences()); }
          catch (e) { console.error("[bridge] flush QQ dmGuildMap failed:", e.message); }
        }, 5_000);
      }
    } catch (err) {
      console.error("[bridge] persist QQ dmGuildMap failed:", err.message);
    }
  }

  /** 停止指定平台 */
  stopPlatform(platform) {
    const entry = this._platforms.get(platform);
    if (!entry) return;

    try {
      entry.adapter?.stop();
    } catch {}
    this._platforms.delete(platform);
    console.log(`[bridge] ${platform} 已停止`);
    debugLog()?.log("bridge", `${platform} stopped`);
    this._emitStatus(platform, "disconnected");
  }

  /** 停止所有平台 */
  stopAll() {
    const platforms = [...this._platforms.keys()];
    for (const platform of platforms) {
      this.stopPlatform(platform);
    }
    if (this._qqDmGuildFlushTimer) {
      clearTimeout(this._qqDmGuildFlushTimer);
      this._qqDmGuildFlushTimer = null;
      try { this.engine.savePreferences(this.engine.getPreferences()); }
      catch {}
    }
  }

  /** 获取所有平台状态 */
  getStatus() {
    const result = {};
    for (const [platform, entry] of this._platforms) {
      result[platform] = { status: entry.status, error: entry.error || null };
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
    const { sessionKey, text, senderName, avatarUrl, userId, isGroup, chatId } = msg;
    const entry = this._platforms.get(platform);
    if (!entry?.adapter) return;

    debugLog()?.log("bridge", `← ${platform} ${isGroup ? "group" : "dm"} (${text.length} chars)`);

    // 广播收到的消息
    this._pushMessage({
      platform, direction: "in", sessionKey,
      sender: senderName || "用户", text,
      isGroup, ts: Date.now(),
    });

    const isOwner = this._isOwner(platform, userId);

    // ── /stop 命令：abort 当前生成，不触发新回复 ──
    if (isOwner && /^\/(stop|abort)$/i.test(text.trim())) {
      this.engine.abortBridgeSession(sessionKey).catch(() => {});
      debugLog()?.log("bridge", `abort ${platform} active session: /stop command`);
      // 清空 pending 缓冲，防止之前积攒的消息被重发
      const pending = this._pending.get(sessionKey);
      if (pending?.timer) clearTimeout(pending.timer);
      this._pending.delete(sessionKey);
      return;
    }

    // ── 群聊：快速路径，不 debounce 不 abort ──
    if (isGroup) {
      const line = senderName ? `${senderName}: ${text}` : text;
      const meta = { name: senderName, avatarUrl, userId };
      this._flushGroupMessage(platform, chatId, sessionKey, line, meta);
      return;
    }

    // ── 私聊：debounce + abort ──
    const line = !isOwner && senderName
      ? `${senderName}: ${text}` : text;

    // 入缓冲（首次创建时捕获当前 agentId，后续消息不覆盖）
    let pending = this._pending.get(sessionKey);
    if (!pending) {
      pending = { lines: [], platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner, agentId: this.engine.currentAgentId };
      this._pending.set(sessionKey, pending);
    }
    pending.lines.push(line);
    // 更新最新的 meta（多条消息可能来自不同人，取最后一条），agentId 保持首次捕获值
    Object.assign(pending, { platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner });

    // 如果 LLM 正在处理，准备 steer（不 abort，debounce 到期后注入）
    const isActive = this.engine.isBridgeSessionStreaming(sessionKey);

    // 重置 debounce 定时器（streaming 时缩短到 1s）
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this._flushPending(sessionKey), isActive ? 1000 : 2000);
  }

  /**
   * 群聊快速路径：不缓冲、不 abort，直接发送
   * 全部走 guest 通道（yuan only，零隐私）
   */
  async _flushGroupMessage(platform, chatId, sessionKey, line, meta) {
    const entry = this._platforms.get(platform);
    if (!entry?.adapter) return;

    debugLog()?.log("bridge", `flush ${platform} group message (${line.length} chars)`);

    const tagged = `${timeTag()} ${line}`;
    try {
      const reply = await this._hub.send(tagged, {
        sessionKey,
        agentId: this.engine.currentAgentId,
        role: "guest",
        meta,
        isGroup: true,
      });

      if (reply && entry?.adapter) {
        const cleaned = this._cleanReplyForPlatform(reply);
        await entry.adapter.sendReply(chatId, cleaned);
        debugLog()?.log("bridge", `→ ${platform} group reply (${cleaned.length} chars)`);
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender: this.engine.agentName, text: cleaned,
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

    // 取出所有缓冲消息
    const lines = pending.lines.splice(0);
    const { platform, chatId, senderName, avatarUrl, userId, isGroup, isOwner, agentId } = pending;
    this._pending.delete(sessionKey);

    const merged = `${timeTag()} ${lines.join("\n")}`;
    const meta = { name: senderName, avatarUrl, userId };

    // 如果 agent 正在 streaming，用 steer 注入而不是新建 prompt
    if (this.engine.steerBridgeSession(sessionKey, merged)) {
      debugLog()?.log("bridge", `steer ${platform} dm (${lines.length} msg(s))`);
      return;
    }

    this._processing.add(sessionKey);

    debugLog()?.log("bridge", `flush ${platform} dm (${lines.length} msg(s), ${merged.length} chars)`);

    const entry = this._platforms.get(platform);
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
        // fallback: edit-in-place draft
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
      const reply = await this._hub.send(merged, {
        sessionKey,
        agentId,
        role: isOwner ? "owner" : "guest",
        meta,
        isGroup: false,
        onDelta,
      });

      if (reply && adapter) {
        const cleaned = this._cleanReplyForPlatform(reply);

        if (useBlockStream && chunker) {
          // flush 剩余 buffer
          await chunker.finish();
          // 如果 chunker 一条都没发（回复太短），发完整回复
          if (!blockSentAny) {
            await adapter.sendReply(chatId, cleaned);
          }
        } else if (useDraft && !draftFailed && cleaner) {
          try { await adapter.sendDraft(chatId, cleaned); }
          catch { await adapter.sendReply(chatId, cleaned); }
        } else {
          await adapter.sendReply(chatId, cleaned);
        }

        debugLog()?.log("bridge", `→ ${platform} reply (${cleaned.length} chars, mode: ${useBlockStream ? "block" : useDraft ? "draft" : "batch"})`);
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender: this.engine.agentName, text: cleaned,
          isGroup, ts: Date.now(),
        });
      }
    } catch (err) {
      // abort 导致的错误不算失败
      if (!err.message?.includes("aborted")) {
        console.error(`[bridge] ${platform} 消息处理失败:`, err.message);
        debugLog()?.error("bridge", `${platform} message handling failed: ${err.message}`);
      }
    } finally {
      this._processing.delete(sessionKey);
    }

    // 处理期间可能又有新消息进来了，检查并重新 flush
    const newPending = this._pending.get(sessionKey);
    if (newPending && newPending.lines.length > 0) {
      if (newPending.timer) clearTimeout(newPending.timer);
      newPending.timer = setTimeout(() => this._flushPending(sessionKey), 500);
    }
  }

  /** 判断消息发送者是否为 owner */
  _isOwner(platform, userId) {
    if (!userId) return false;
    const prefs = this.engine.getPreferences();
    const ownerId = prefs.bridge?.owner?.[platform];
    return ownerId && ownerId === userId;
  }

  /**
   * 清理发给外部平台的回复：
   * - 去除 MOOD 代码块
   * - 去除 <tool_code> 标签
   * - 去除 pulse / reflect 区块
   */
  _cleanReplyForPlatform(text) {
    let cleaned = text;
    // 内省标签：backtick 和 XML 两种格式
    cleaned = cleaned.replace(/```(?:mood|pulse|reflect)[\s\S]*?```\n*/gi, "");
    cleaned = cleaned.replace(/<(?:mood|pulse|reflect)>[\s\S]*?<\/(?:mood|pulse|reflect)>\s*/g, "");
    // <tool_code> 标签
    cleaned = cleaned.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, "");
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
    for (const [platform, entry] of this._platforms) {
      if (entry.status !== "connected" || !entry.adapter) continue;
      const ownerId = ownerIds[platform];
      if (!ownerId) continue;

      // QQ 私信需要 guild_id 而非 userId，通过 adapter 解析
      const chatId = entry.adapter.resolveOwnerChatId?.(ownerId) || ownerId;
      const spec = ADAPTER_REGISTRY[platform];
      try {
        await entry.adapter.sendReply(chatId, cleaned);
        debugLog()?.log("bridge", `→ ${platform} proactive to owner (${cleaned.length} chars)`);

        const sessionKey = spec?.ownerSessionKey?.(ownerId) || `${platform}_dm_${ownerId}`;
        this._pushMessage({
          platform, direction: "out", sessionKey,
          sender: this.engine.agentName, text: cleaned,
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
