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
import { EventBus } from "./event-bus.js";
import { ChannelRouter } from "./channel-router.js";
import { GuestHandler } from "./guest-handler.js";
import { Scheduler } from "./scheduler.js";
import { AgentMessenger } from "./agent-messenger.js";
import { DmRouter } from "./dm-router.js";

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
    this._agentMessenger = new AgentMessenger({ hub: this });
    this._dmRouter = new DmRouter({ hub: this });

    // 双向引用：engine 也能拿到 hub
    engine._hub = this;

    // 注入 EventBus（替代旧的 proxy hack）
    engine.setEventBus(this._eventBus);

    this._setupNotifyHandler();
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
      sessionPath,
    } = opts;
    const o = { sessionKey, role, ephemeral, meta, isGroup, cwd, model, persist, from, to, onDelta, images, sessionPath };

    // 路由表：按顺序匹配，第一条命中即执行。
    // 优先级通过位置保证，新增路由在此处显式插入，不依赖散落在各处的 if 顺序。
    const routes = [
      { // Agent → Agent 私聊（优先，防止被 owner 路由吞掉）
        match: o => o.from && o.to,
        handle: () => this._agentMessenger.send(text, o.from, o.to, opts),
      },
      { // 桌面端 owner
        match: o => !o.sessionKey && !o.ephemeral && o.role === "owner",
        handle: () => o.sessionPath
          ? this._engine.promptSession(o.sessionPath, text, { images: o.images })
          : this._engine.prompt(text, { images: o.images }),
      },
      { // Bridge guest
        match: o => o.sessionKey && o.role === "guest",
        handle: () => this._guestHandler.handle(text, o.sessionKey, o.meta, { isGroup: o.isGroup, agentId: o.agentId, onDelta: o.onDelta }),
      },
      { // Bridge owner
        match: o => o.sessionKey && !o.ephemeral,
        handle: () => this._engine.executeExternalMessage(text, o.sessionKey, o.meta, { guest: false, agentId: o.agentId, onDelta: o.onDelta }),
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

    // ChannelRouter
    const channelEnabled = engine.agent.config?.channels?.enabled !== false;
    if (channelEnabled) {
      this._channelRouter.start();
    }

    // 注入频道 post 回调
    this._channelRouter.setupPostHandler();
  }

  /**
   * Agent 切换前暂停：只停 heartbeat（cron 全 agent 并发，不中断），ChannelRouter 持续跑
   */
  async pauseForAgentSwitch() {
    await this._scheduler.stopHeartbeat();
  }

  /**
   * Agent 切换完成后恢复：重启新 agent 的 heartbeat，重新注入 handler
   */
  resumeAfterAgentSwitch() {
    this._scheduler.startHeartbeat();
    this._setupNotifyHandler();
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
    await this.stopSchedulers();
    await this._engine.dispose();
    this._eventBus.clear();
  }

  // ──────────── 内部 ────────────

  /** @returns {DmRouter} */
  get dmRouter() { return this._dmRouter; }

  _setupDmHandler() {
    const engine = this._engine;
    // 给所有 agent 注入 DM 回调
    for (const [, agent] of engine.agents || []) {
      agent._dmSentHandler = (fromId, toId) =>
        this._dmRouter.handleNewDm(fromId, toId);
    }
  }

  _setupNotifyHandler() {
    const agent = this._engine.agent;
    if (!agent) return;
    agent._notifyHandler = (title, body) => {
      this._eventBus.emit({ type: "notification", title, body }, null);
    };
  }

}
