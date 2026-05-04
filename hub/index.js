/**
 * Hub — 消息调度中枢
 *
 * 同进程模式：Hub 和 HanaEngine 跑在同一个 Node 进程里。
 * hub.send() 内部直接调 engine 方法，行为零变化。
 * EventBus 通过 engine.setEventBus() 注入，统一事件广播。
 *
 * 模块：
 *   EventBus      — 统一事件总线
 *   ChannelRouter  — 频道 triage + 调度
 *   GuestHandler   — Guest 留言机
 *   Scheduler      — Heartbeat + Cron
 */

import path from "path";
import fs from "fs";
import crypto from "crypto";
import { EventBus } from "./event-bus.js";
import { ChannelRouter } from "./channel-router.js";
import { GuestHandler } from "./guest-handler.js";
import { Scheduler } from "./scheduler.js";
import { DmRouter } from "./dm-router.js";
import {
  extractTextContent,
  loadSessionHistoryMessages,
  isValidSessionPath,
} from "../core/message-utils.js";
import { submitDesktopSessionMessage } from "../core/desktop-session-submit.js";

export class Hub {
  /**
   * @param {object} opts
   * @param {import('../core/engine.js').HanaEngine} opts.engine
   */
  constructor({ engine }) {
    this._engine = engine;
    this._eventBus = new EventBus();
    this._channelRouter = new ChannelRouter({ hub: this });
    this._guestHandler = new GuestHandler({ hub: this });
    this._scheduler = new Scheduler({ hub: this });
    this._dmRouter = new DmRouter({ hub: this });

    // 注入 Hub 回调到 Engine（单向：Hub → Engine，不再双向引用）
    engine.setHubCallbacks({
      hub: this,  // 用于 slash dispatcher setHub 注入；engine.setHubCallbacks 内部会调 dispatcher.setHub(hub)
      scheduler: this._scheduler,
      dmRouter: this._dmRouter,
      channelRouter: this._channelRouter,
      eventBus: this._eventBus,
      pauseForAgentSwitch: () => this.pauseForAgentSwitch(),
      resumeAfterAgentSwitch: () => this.resumeAfterAgentSwitch(),
      triggerChannelTriage: (name, opts) => this._channelRouter.triggerImmediate(name, opts),
    });

    // 注入 EventBus（替代旧的 proxy hack）
    engine.setEventBus(this._eventBus);

    this._sessionHandlerCleanups = [];
    this._setupSessionHandlers();
    this._setupDmHandler();
  }

  /** @returns {import('../core/engine.js').HanaEngine} */
  get engine() { return this._engine; }

  /** @returns {EventBus} */
  get eventBus() { return this._eventBus; }

  /** @returns {ChannelRouter} */
  get channelRouter() { return this._channelRouter; }

  /** @returns {Scheduler} */
  get scheduler() { return this._scheduler; }

  /** @returns {import('../lib/bridge/bridge-manager.js').BridgeManager|null} */
  get bridgeManager() { return this._bridgeManager || null; }
  set bridgeManager(bm) { this._bridgeManager = bm; }

  // ──────────── 订阅 ────────────

  /**
   * 订阅事件（替代 engine.subscribe）
   * @param {Function} callback  (event, sessionPath) => void
   * @param {object} [filter]    可选过滤器
   * @returns {Function} unsubscribe
   */
  subscribe(callback, filter) {
    return this._eventBus.subscribe(callback, filter);
  }

  // ──────────── 消息统一入口 ────────────

  /**
   * 统一消息入口
   *
   * @param {string} text  消息文本
   * @param {object} [opts]
   * @param {string}  [opts.sessionKey]  Bridge/频道的 session 标识
   * @param {string}  [opts.role]        "owner" | "agent" | "guest"（默认 "owner"）
   * @param {boolean} [opts.ephemeral]   true = 不持久化 session（cron/heartbeat/channel）
   * @param {object}  [opts.meta]        Bridge 元数据 { name, avatarUrl, userId }
   * @param {boolean} [opts.isGroup]     是否群聊（影响 guest 上下文标签）
   * @param {string}  [opts.cwd]         工作目录覆盖
   * @param {string}  [opts.model]       模型覆盖
   * @param {string}  [opts.persist]     持久化目录（activity session）
   * @returns {Promise<*>}
   */
  async send(text, opts = {}) {
    const {
      sessionKey,
      role = "owner",
      ephemeral = false,
      meta,
      isGroup = false,
      cwd,
      model,
      persist,
      from,
      to,
      onDelta,
      images,
      imageAttachmentPaths,
      sessionPath,
      agentId,
      uiContext,
      displayMessage,
    } = opts;
    const o = { sessionKey, role, ephemeral, meta, isGroup, cwd, model, persist, from, to, onDelta, images, imageAttachmentPaths, sessionPath, agentId, uiContext, displayMessage };

    // ── 图片预处理：持久化到磁盘 + 插入 [attached_image] 标记 ──
    // 在路由之前统一处理，所有消息路径（WS / Bridge DM / Bridge Group）共享
    if (o.images?.length && this._engine.hanakoHome) {
      const attachDir = path.join(this._engine.hanakoHome, "attachments");
      await fs.promises.mkdir(attachDir, { recursive: true });
      const savedPaths = [];
      for (const img of o.images) {
        const ext = (img.mimeType || "image/png").split("/")[1] || "png";
        const hash = crypto.createHash("md5").update((img.data || "").slice(0, 1024)).digest("hex").slice(0, 8);
        const filePath = path.join(attachDir, `upload-${Date.now()}-${hash}.${ext}`);
        try {
          await fs.promises.writeFile(filePath, Buffer.from(img.data, "base64"));
          savedPaths.push(filePath);
        } catch { /* best-effort; prompt still goes through */ }
      }
      if (savedPaths.length) {
        const pathNote = savedPaths.map(p => `[attached_image: ${p}]`).join("\n");
        text = `${pathNote}\n${text}`;
        o.imageAttachmentPaths = savedPaths;
      }
    }

    // 路由表：按顺序匹配，第一条命中即执行。
    // 优先级通过位置保证，新增路由在此处显式插入，不依赖散落在各处的 if 顺序。
    const routes = [
      { // 桌面端 owner
        match: o => !o.sessionKey && !o.ephemeral && o.role === "owner",
        handle: () => o.sessionPath
          ? submitDesktopSessionMessage(this._engine, {
            sessionPath: o.sessionPath,
            text,
            images: o.images,
            imageAttachmentPaths: o.imageAttachmentPaths,
            onDelta: o.onDelta,
            uiContext: o.uiContext,
            displayMessage: o.displayMessage,
          })
          : this._engine.prompt(text, { images: o.images }),
      },
      { // Bridge guest
        match: o => o.sessionKey && o.role === "guest",
        handle: () => this._guestHandler.handle(text, o.sessionKey, o.meta, { isGroup: o.isGroup, agentId: o.agentId, onDelta: o.onDelta, images: o.images, imageAttachmentPaths: o.imageAttachmentPaths }),
      },
      { // Bridge owner
        match: o => o.sessionKey && !o.ephemeral,
        handle: () => this._engine.executeExternalMessage(text, o.sessionKey, o.meta, { guest: false, agentId: o.agentId, onDelta: o.onDelta, images: o.images, imageAttachmentPaths: o.imageAttachmentPaths }),
      },
      { // 隔离执行（cron/heartbeat/channel）
        match: o => o.ephemeral,
        handle: () => this._engine.executeIsolated(text, { cwd: o.cwd, model: o.model, persist: o.persist }),
      },
    ];

    for (const route of routes) {
      if (route.match(o)) return route.handle();
    }
    throw new Error(`[Hub] unhandled route: role=${o.role}, sessionKey=${o.sessionKey}, ephemeral=${o.ephemeral}`);
  }

  /**
   * 中断生成（支持指定 session）
   */
  async abort(sessionPath) {
    return sessionPath
      ? this._engine.abortSession(sessionPath)
      : this._engine.abort();
  }

  // ──────────── 调度器管理 ────────────

  /**
   * 初始化所有调度器（Scheduler + ChannelRouter）
   * 在 engine.init() 完成后由 server/index.js 调用
   */
  initSchedulers() {
    const engine = this._engine;

    // Scheduler（heartbeat + cron）
    this._scheduler.start();

    // ChannelRouter：仅在频道总开关为开时启动
    if (engine.isChannelsEnabled?.()) {
      this._channelRouter.start();
      this._channelRouter.setupPostHandler();
    }
  }

  /**
   * Agent 切换前暂停：停所有 heartbeat（cron 全 agent 并发，不中断），ChannelRouter 持续跑
   */
  async pauseForAgentSwitch() {
    await this._scheduler.stopHeartbeat();
  }

  /**
   * Agent 切换完成后恢复：重启所有 agent 的 heartbeat（幂等），重新注入 handler
   */
  resumeAfterAgentSwitch() {
    this._scheduler.startHeartbeat();
    this._setupDmHandler();
    this._channelRouter.setupPostHandler();
  }

  /**
   * 停止所有调度器（dispose 用）
   */
  async stopSchedulers() {
    await this._scheduler.stop();
    await this._channelRouter.stop();
  }

  // ──────────── 频道代理方法 ────────────

  triggerChannelTriage(channelName, opts) {
    return this._channelRouter.triggerImmediate(channelName, opts);
  }

  async toggleChannels(enabled) {
    return this._channelRouter.toggle(enabled);
  }

  // ──────────── 生命周期 ────────────

  async dispose() {
    for (const cleanup of this._sessionHandlerCleanups) cleanup();
    this._sessionHandlerCleanups = [];
    await this.stopSchedulers();
    await this._engine.dispose();
    this._eventBus.clear();
  }

  // ──────────── 内部 ────────────

  /** @returns {DmRouter} */
  get dmRouter() { return this._dmRouter; }

  _setupSessionHandlers() {
    const bus = this._eventBus;
    const engine = this._engine;

    // ── session:send ──
    this._sessionHandlerCleanups.push(bus.handle("session:send", async ({ text, sessionPath, ...opts }) => {
      if (!text || typeof text !== "string" || !text.trim()) {
        throw new Error("text is required");
      }
      const sp = sessionPath;
      if (!sp) throw new Error("sessionPath is required for session:send");
      if (engine.isSessionStreaming(sp)) throw new Error("session_busy");
      await engine.ensureSessionLoaded(sp);
      engine.promptSession(sp, text, opts).catch(err => {
        console.error("[Hub] session:send promptSession error:", err.message);
        bus.emit({ type: "error", error: err.message, source: "session:send" }, sp);
      });
      return { sessionPath: sp, accepted: true };
    }));

    // ── session:abort ──
    this._sessionHandlerCleanups.push(bus.handle("session:abort", async ({ sessionPath } = {}) => {
      const sp = sessionPath;
      if (!sp) return { aborted: false };
      const result = await engine.abortSession(sp);
      return { aborted: !!result };
    }));

    // ── session:history ──
    this._sessionHandlerCleanups.push(bus.handle("session:history", async ({ sessionPath, limit: rawLimit } = {}) => {
      if (!sessionPath) throw new Error("sessionPath is required");
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        throw new Error("Invalid session path");
      }
      const limit = Math.min(Number(rawLimit) || 50, 200);
      const sourceMessages = await loadSessionHistoryMessages(engine, sessionPath);
      const messages = [];
      for (const m of sourceMessages) {
        if (m.role === "user") {
          const { text, images } = extractTextContent(m.content);
          if (text || images.length) {
            messages.push({ role: "user", content: text, images: images.length ? images : undefined });
          }
        } else if (m.role === "assistant") {
          const { text, thinking, toolUses } = extractTextContent(m.content, { stripThink: true });
          if (text || toolUses.length) {
            messages.push({
              role: "assistant",
              content: text,
              thinking: thinking || undefined,
              toolCalls: toolUses.length ? toolUses : undefined,
            });
          }
        }
        if (messages.length >= limit) break;
      }
      return { messages };
    }));

    // ── session:list ──
    this._sessionHandlerCleanups.push(bus.handle("session:list", async ({ agentId } = {}) => {
      const all = await engine.listSessions();
      const filtered = agentId ? all.filter(s => s.agentId === agentId) : all;
      const sessions = filtered.map(s => ({
        path: s.path,
        title: s.title,
        firstMessage: s.firstMessage,
        agentId: s.agentId,
        agentName: s.agentName,
        modelId: s.modelId,
        messageCount: s.messageCount,
        cwd: s.cwd,
        modified: s.modified,
      }));
      return { sessions };
    }));

    // ── agent:list ──
    this._sessionHandlerCleanups.push(bus.handle("agent:list", async () => {
      const all = engine.listAgents();
      const agents = all.map(a => ({
        id: a.id,
        name: a.name,
        isCurrent: a.isCurrent,
        isPrimary: a.isPrimary,
      }));
      return { agents };
    }));

    // ── provider & agent handlers ──

    this._sessionHandlerCleanups.push(bus.handle("provider:credentials", async ({ providerId }) => {
      const creds = engine.providerRegistry.getCredentials(providerId);
      if (!creds?.apiKey) return { error: "no_credentials" };
      return { apiKey: creds.apiKey, baseUrl: creds.baseUrl, api: creds.api };
    }));

    this._sessionHandlerCleanups.push(bus.handle("provider:models-by-type", async ({ type, providerId }) => {
      if (providerId) {
        return { models: engine.providerRegistry.getModelsByType(providerId, type) };
      }
      return { models: engine.providerRegistry.getAllModelsByType(type) };
    }));

    this._sessionHandlerCleanups.push(bus.handle("agent:config", async ({ agentId }) => {
      const agent = engine.agentManager.getAgent(agentId);
      if (!agent) return { error: "not_found" };
      return { config: agent.config };
    }));

    // ── groupchat:execute-agent ──
    // 插件通过 EventBus 触发：完整 Agent 能力（全工具 + 人格 + 记忆）
    this._sessionHandlerCleanups.push(bus.handle("groupchat:execute-agent", async ({ agentId, text, contextHistory }) => {
      if (!agentId || !text) throw new Error("agentId and text required");
      const agent = engine.getAgent(agentId);
      if (!agent) throw new Error("agent not found: " + agentId);

      const prompt = contextHistory
        ? `【群聊上下文】\n${contextHistory}\n---\n[主人]: ${text}`
        : text;

      const cwd = engine.getHomeCwd(agentId) || process.cwd();
      const persistDir = path.join(engine.agentsDir, agentId, "sessions", "group_sessions");
      fs.mkdirSync(persistDir, { recursive: true });

      console.log("[Hub] groupchat:execute-agent", agentId, "text:", text.substring(0, 40));

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 180_000);

      try {
        await engine.executeIsolated(prompt, {
          agentId,
          cwd,
          emitEvents: true,
          persist: persistDir,
          signal: controller.signal,
        });
      } catch (err) {
        if (err.name !== "AbortError") {
          console.error("[Hub] groupchat:execute-agent error:", err.message);
        }
      }

      return { agentId, done: true };
    }));
  }

  _setupDmHandler() {
    const engine = this._engine;
    // 给所有 agent 注入 DM 回调
    for (const [, agent] of engine.agents || []) {
      agent.setDmSentHandler((fromId, toId) =>
        this._dmRouter.handleNewDm(fromId, toId));
    }
  }

}
