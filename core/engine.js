/**
 * HanaEngine — Hanako 的核心引擎（Thin Facade）
 *
 * 持有所有 Manager，对外暴露统一 API。
 * 具体逻辑委托给：
 *   - AgentManager       — agent CRUD / init / switch
 *   - SessionCoordinator — session 生命周期 / listing
 *   - ConfigCoordinator  — 配置读写 / 模型 / 搜索 / utility
 *   - ChannelManager     — 频道 CRUD / 成员管理
 *   - BridgeSessionManager — 外部平台 session
 *   - ModelManager        — 模型注册 / 发现
 *   - PreferencesManager  — 全局偏好
 *   - SkillManager        — 技能注册 / 同步
 */
import fs from "fs";
import os from "os";
import path from "path";
import { migrateConfigScope } from "../shared/migrate-config-scope.js";
import { migrateToProvidersYaml } from "./migrate-providers.js";
import { runMigrations } from "./migrations.js";
import { findModel } from "../shared/model-ref.js";
import { resolveWorkspaceSkillPaths } from "../shared/workspace-skill-paths.js";
import { PluginManager } from "./plugin-manager.js";
import { DefaultResourceLoader, codingTools, grepTool, findTool, lsTool } from "../lib/pi-sdk/index.js";

/** 已知的外部 AI 工具技能目录（相对 $HOME） */
const WELL_KNOWN_SKILL_PATHS = [
  { suffix: ".claude/skills",     label: "Claude Code" },
  { suffix: ".codex/skills",      label: "Codex" },
  { suffix: ".openclaw/skills",   label: "OpenClaw" },
  { suffix: ".pi/agent/skills",   label: "Pi" },
  { suffix: ".agents/skills",     label: "Agents" },
];

const allBuiltInTools = [...codingTools, grepTool, findTool, lsTool];

import { PreferencesManager } from "./preferences-manager.js";
import { ModelManager } from "./model-manager.js";
import { SkillManager } from "./skill-manager.js";
import { BridgeSessionManager } from "./bridge-session-manager.js";
import { AgentManager } from "./agent-manager.js";
import { SessionCoordinator } from "./session-coordinator.js";
import { ConfigCoordinator, SHARED_MODEL_KEYS } from "./config-coordinator.js";
import { ChannelManager } from "./channel-manager.js";
import {
  summarizeTitle as _summarizeTitle,
  translateSkillNames as _translateSkillNames,
  summarizeActivity as _summarizeActivity,
  summarizeActivityQuick as _summarizeActivityQuick,
} from "./llm-utils.js";
import { debugLog } from "../lib/debug-log.js";
import { createSandboxedTools } from "../lib/sandbox/index.js";
import { t } from "../server/i18n.js";
import { CheckpointStore } from "../lib/checkpoint-store.js";
import { assertAllToolsCategorized } from "../shared/tool-categories.js";
import { wrapWithCheckpoint } from "../lib/checkpoint-wrapper.js";
import { TaskRegistry } from "../lib/task-registry.js";

export class HanaEngine {
  /**
   * @param {object} dirs
   * @param {string} dirs.hanakoHome
   * @param {string} dirs.productDir
   * @param {string} [dirs.agentId]
   */
  constructor({ hanakoHome, productDir, agentId }) {
    this.hanakoHome = hanakoHome;
    this.productDir = productDir;
    this.agentsDir = path.join(hanakoHome, "agents");
    this.userDir = path.join(hanakoHome, "user");
    this.channelsDir = path.join(hanakoHome, "channels");
    fs.mkdirSync(this.channelsDir, { recursive: true });

    // ── Core managers ──
    this._prefs = new PreferencesManager({ userDir: this.userDir, agentsDir: this.agentsDir });
    this._models = new ModelManager({ hanakoHome });

    // 确定启动时焦点 agent
    const startId = agentId || this._prefs.getPrimaryAgent() || this._prefs.findFirstAgent();
    if (!startId) throw new Error(t("error.noAgentsFound"));

    // ── Channel Manager ──
    this._channels = new ChannelManager({
      channelsDir: this.channelsDir,
      agentsDir: this.agentsDir,
      userDir: this.userDir,
      getHub: () => this._hubCallbacks,
    });

    // ── Agent Manager ──
    this._agentMgr = new AgentManager({
      agentsDir: this.agentsDir,
      productDir: this.productDir,
      userDir: this.userDir,
      channelsDir: this.channelsDir,
      getPrefs: () => this._prefs,
      getModels: () => this._models,
      getHub: () => this._hubCallbacks,
      getSkills: () => this._skills,
      getSearchConfig: () => this.getSearchConfig(),
      resolveUtilityConfig: () => this.resolveUtilityConfig(),
      getSharedModels: () => this._configCoord.getSharedModels(),
      getChannelManager: () => this._channels,
      getSessionCoordinator: () => this._sessionCoord,
      getEngine: () => this,
      getResourceLoader: () => this._resourceLoader,
    });

    // ── Session Coordinator ──
    this._sessionCoord = new SessionCoordinator({
      agentsDir: this.agentsDir,
      getAgent: () => this.agent,
      getActiveAgentId: () => this.currentAgentId,
      getModels: () => this._models,
      getResourceLoader: () => this._resourceLoader,
      getSkills: () => this._skills,
      buildTools: (cwd, ct, opts) => this.buildTools(cwd, ct, opts),
      emitEvent: (e, sp) => this._emitEvent(e, sp),
      emitDevLog: (t, l) => this.emitDevLog(t, l),
      getHomeCwd: (agentId) => this.getHomeCwd(agentId),
      agentIdFromSessionPath: (p) => this.agentIdFromSessionPath(p),
      switchAgentOnly: (id) => this._agentMgr.switchAgentOnly(id),
      getConfig: () => this.config,
      getPrefs: () => this._prefs,
      getAgents: () => this._agentMgr.agents,
      getActivityStore: (id) => this.getActivityStore(id),
      getAgentById: (id) => this._agentMgr.getAgent(id),
      listAgents: () => this.listAgents(),
      getConfirmStore: () => this._confirmStore,
      getDeferredResultStore: () => this._deferredResultStore,
      getTaskRegistry: () => this._taskRegistry,
      onBeforeSessionCreate: async (cwd) => {
        await this.syncWorkspaceSkillPaths(cwd, { reload: true, emitEvent: false });
      },
    });

    // ── Config Coordinator ──
    this._configCoord = new ConfigCoordinator({
      hanakoHome,
      agentsDir: this.agentsDir,
      getAgent: () => this.agent,
      getAgentById: (id) => this._agentMgr.getAgent(id),
      getActiveAgentId: () => this._agentMgr.activeAgentId,
      getAgents: () => this._agentMgr.agents,
      getModels: () => this._models,
      getPrefs: () => this._prefs,
      getSkills: () => this._skills,
      getSession: () => this._sessionCoord.session,
      getSessionCoordinator: () => this._sessionCoord,
      getHub: () => this._hubCallbacks,
      emitEvent: (e, sp) => this._emitEvent(e, sp),
      emitDevLog: (t, l) => this.emitDevLog(t, l),
      getCurrentModel: () => this.currentModel?.name,
    });

    // ── Bridge Session Manager ──
    this._bridge = new BridgeSessionManager({
      getAgent: () => this.agent,
      getAgentById: (id) => this._agentMgr.getAgent(id),
      getModelManager: () => this._models,
      getResourceLoader: () => this._resourceLoader,
      getPreferences: () => this._readPreferences(),
      buildTools: (cwd, customTools, opts) => this.buildTools(cwd, customTools, opts),
      getHomeCwd: (agentId) => this.getHomeCwd(agentId),
    });

    // 任务注册表（外部 abort 用）
    this._taskRegistry = new TaskRegistry();

    // subagent AbortController 存储（engine 级别，跨 agent 共享）
    this._subagentControllers = new Map();
    this._taskRegistry.registerHandler("subagent", {
      abort: (taskId) => {
        const ctrl = this._subagentControllers.get(taskId);
        if (ctrl) ctrl.abort();
      },
    });

    // Checkpoint 备份存储
    this._checkpointStore = new CheckpointStore(
      path.join(this.hanakoHome, "checkpoints")
    );

    // ── Plugin Manager ──
    this._pluginManager = null;  // initialized async in initPlugins()

    // Pi SDK resources（init 时填充）
    this._resourceLoader = null;

    // Hub 回调（由 Hub 构造后通过 setHubCallbacks 注入，替代旧的 engine._hub 双向引用）
    this._hubCallbacks = null;

    // 事件系统
    this._listeners = new Set();
    this._eventBus = null;

    // DevTools 日志
    this._devLogs = [];
    this._devLogsMax = 200;

    // 设置起始 agentId
    this._agentMgr.activeAgentId = startId;
  }

  // ════════════════════════════
  //  Agent 代理（→ AgentManager）
  // ════════════════════════════

  /** @ui-focus-only 返回 UI 焦点 agent 实例，后端逻辑应通过 getAgent(agentId) 查询 */
  get agent() { return this._agentMgr.agent; }
  getAgent(agentId) { return this._agentMgr.getAgent(agentId); }
  /** @ui-focus-only 返回 UI 焦点 agent 的 ID */
  get currentAgentId() { return this._agentMgr.activeAgentId; }
  get confirmStore() { return this._confirmStore; }

  /** @deprecated 工具应通过 emitEvent(event, sessionPath) 传入显式 sessionPath */
  emitSessionEvent(event) {
    this._emitEvent(event, this.currentSessionPath);
  }

  setConfirmStore(store) {
    this._confirmStore = store;
    if (store) {
      store.onResolved = (confirmId, action) => {
        this._emitEvent({ type: "confirmation_resolved", confirmId, action }, null);
      };
    }
  }

  setDeferredResultStore(store) {
    this._deferredResultStore = store;
  }

  get deferredResults() {
    return this._deferredResultStore || null;
  }

  get taskRegistry() {
    return this._taskRegistry;
  }

  setSubagentController(taskId, controller) { this._subagentControllers.set(taskId, controller); }
  removeSubagentController(taskId) { this._subagentControllers.delete(taskId); }

  // 向后兼容 getter
  get agentDir() { return this.agent?.agentDir || path.join(this.agentsDir, this.currentAgentId); }
  get baseDir() { return this.agentDir; }
  get activityDir() { return path.join(this.agentDir, "activity"); }
  get activityStore() { return this.getActivityStore(this.currentAgentId); }
  getActivityStore(agentId) { return this._agentMgr.getActivityStore(agentId); }

  get agents() { return this._agentMgr.agents; }
  listAgents() { return this._agentMgr.listAgents(); }
  invalidateAgentListCache() { this._agentMgr.invalidateAgentListCache(); }
  async createAgent(opts) { return this._agentMgr.createAgent(opts); }
  async switchAgent(agentId) { return this._agentMgr.switchAgent(agentId); }
  async deleteAgent(agentId) { return this._agentMgr.deleteAgent(agentId); }
  setPrimaryAgent(agentId) { return this._agentMgr.setPrimaryAgent(agentId); }
  agentIdFromSessionPath(p) { return this._agentMgr.agentIdFromSessionPath(p); }
  async createSessionForAgent(agentId, cwd, mem) {
    return this._agentMgr.createSessionForAgent(agentId, cwd, mem);
  }

  // 向后兼容：agent 属性代理
  get agentName() { return this.agent.agentName; }
  set agentName(v) { this.agent.agentName = v; }
  get userName() { return this.agent.userName; }
  set userName(v) { this.agent.userName = v; }
  get configPath() { return this.agent.configPath; }
  get sessionDir() { return this.agent.sessionDir; }
  get factsDbPath() { return this.agent.factsDbPath; }
  get memoryMdPath() { return this.agent.memoryMdPath; }

  // ════════════════════════════
  //  Session 代理（→ SessionCoordinator）
  // ════════════════════════════

  get session() { return this._sessionCoord.session; }
  get messages() { return this._sessionCoord.session?.messages ?? []; }
  get isStreaming() { return this._sessionCoord.session?.isStreaming ?? false; }
  /** @ui-focus-only 返回 UI 焦点 session 的路径，后端逻辑不应依赖此值 */
  get currentSessionPath() { return this._sessionCoord.currentSessionPath; }
  get cwd() { return this._sessionCoord.session?.sessionManager?.getCwd?.() ?? process.cwd(); }
  get deskCwd() { return this._sessionCoord.session?.sessionManager?.getCwd?.() || this.homeCwd || null; }

  async createSession(mgr, cwd, mem, model) {
    return this._sessionCoord.createSession(mgr, cwd, mem, model);
  }
  async switchSession(p) {
    const result = await this._sessionCoord.switchSession(p);
    await this.syncWorkspaceSkillPaths(this.cwd, { reload: true, emitEvent: false });
    return result;
  }
  /** @deprecated Phase 2: 使用 promptSession(path, text, opts) */
  async prompt(text, opts) { return this._sessionCoord.prompt(text, opts); }
  /** @deprecated Phase 2: 使用 abortSession(path) */
  async abort() { return this._sessionCoord.abort(); }
  /** @deprecated Phase 2: 使用 steerSession(path, text) */
  steer(text) { return this._sessionCoord.steer(text); }

  // ── Path 感知 API（Phase 2） ──
  async promptSession(p, text, opts) { return this._sessionCoord.promptSession(p, text, opts); }
  steerSession(p, text) { return this._sessionCoord.steerSession(p, text); }
  async abortSession(p) { return this._sessionCoord.abortSession(p); }
  get focusSessionPath() { return this._sessionCoord.currentSessionPath; }
  getMessages(p) { return this._sessionCoord.getSessionByPath(p)?.messages ?? []; }

  async abortAllStreaming() { return this._sessionCoord.abortAllStreaming(); }
  isBridgeSessionStreaming(key) { return this._bridge?.isSessionStreaming(key) ?? false; }
  async abortBridgeSession(key) { return this._bridge?.abortSession(key) ?? false; }
  steerBridgeSession(key, text) { return this._bridge?.steerSession(key, text) ?? false; }
  async closeSession(p) { return this._sessionCoord.closeSession(p); }
  getSessionByPath(p) { return this._sessionCoord.getSessionByPath(p); }
  isSessionStreaming(p) { return this._sessionCoord.isSessionStreaming(p); }
  async abortSessionByPath(p) { return this._sessionCoord.abortSessionByPath(p); }
  async listSessions() { return this._sessionCoord.listSessions(); }
  async saveSessionTitle(p, t) { return this._sessionCoord.saveSessionTitle(p, t); }
  createSessionContext() { return this._sessionCoord.createSessionContext(); }
  promoteActivitySession(f, agentId) { return this._sessionCoord.promoteActivitySession(f, agentId); }
  async executeIsolated(prompt, opts) { return this._sessionCoord.executeIsolated(prompt, opts); }

  // ════════════════════════════
  //  Config 代理（→ ConfigCoordinator）
  // ════════════════════════════

  get config() { return this.agent.config; }
  get factStore() { return this.agent.factStore; }
  /** 下一次新对话将使用的模型（UI 选择器绑定此值） */
  get currentModel() {
    return this._sessionCoord.pendingModel
      ?? this._models.currentModel;
  }
  /** 当前活跃 session 实际使用的模型（已创建的对话不随选择器变） */
  get activeSessionModel() {
    return this._sessionCoord.session?.model ?? null;
  }
  get availableModels() { return this._models.availableModels; }
  get memoryEnabled() { return this.agent.memoryEnabled; }
  get memoryModelUnavailableReason() { return this.agent.memoryModelUnavailableReason; }
  get planMode() { return this._sessionCoord.getPlanMode(); }
  get homeCwd() { return this._configCoord.getHomeFolder(this._readPrimaryAgent()) || null; }

  getHomeCwd(agentId) {
    return this._configCoord.getHomeFolder(agentId) || null;
  }
  get authStorage() { return this._models.authStorage; }
  get modelRegistry() { return this._models.modelRegistry; }
  get providerRegistry() { return this._models.providerRegistry; }
  get preferences() { return this._prefs; }

  /** 刷新可用模型列表（含 OAuth 自定义模型注入） */
  async refreshModels() { return this._models.refreshAvailable(); }

  getHomeFolder(agentId) { return this._configCoord.getHomeFolder(agentId); }
  setHomeFolder(agentId, folder) { return this._configCoord.setHomeFolder(agentId, folder); }
  getHeartbeatMaster() { return this._configCoord.getHeartbeatMaster(); }
  setHeartbeatMaster(v) { return this._configCoord.setHeartbeatMaster(v); }
  getSharedModels() { return this._configCoord.getSharedModels(); }
  setSharedModels(p) { return this._configCoord.setSharedModels(p); }
  getSearchConfig() { return this._configCoord.getSearchConfig(); }
  setSearchConfig(p) { return this._configCoord.setSearchConfig(p); }
  getUtilityApi() { return this._configCoord.getUtilityApi(); }
  setUtilityApi(p) { return this._configCoord.setUtilityApi(p); }
  resolveUtilityConfig() { return this._configCoord.resolveUtilityConfig(); }
  readAgentOrder() { return this._configCoord.readAgentOrder(); }
  saveAgentOrder(o) { return this._configCoord.saveAgentOrder(o); }
  async syncModelsAndRefresh() { return this._configCoord.syncAndRefresh(); }
  setPendingModel(id, provider) { return this._configCoord.setPendingModel(id, provider); }
  async switchSessionModel(sessionPath, modelId, provider) {
    const model = findModel(this._models.availableModels, modelId, provider);
    if (!model) throw new Error(t("error.modelNotFound", { id: modelId }));
    return this._sessionCoord.switchSessionModel(sessionPath, model);
  }
  setDefaultModel(id, provider) { return this._configCoord.setDefaultModel(id, provider); }
  getThinkingLevel() { return this._configCoord.getThinkingLevel(); }
  setThinkingLevel(l) { return this._configCoord.setThinkingLevel(l); }
  getSandbox() { return this._prefs.getSandbox(); }
  setSandbox(v) { this._prefs.setSandbox(v); }
  getFileBackup() { return this._prefs.getFileBackup(); }
  setFileBackup(p) { this._prefs.setFileBackup(p); }
  listCheckpoints() { return this._checkpointStore.list(); }
  restoreCheckpoint(id) { return this._checkpointStore.restore(id); }
  removeCheckpoint(id) { return this._checkpointStore.remove(id); }
  cleanupCheckpoints() {
    const cfg = this._prefs.getFileBackup();
    return this._checkpointStore.cleanup(cfg.retention_days || 1);
  }
  getLearnSkills() { return this._prefs.getLearnSkills(); }
  setLearnSkills(p) { this._prefs.setLearnSkills(p); }
  getLocale() { return this._prefs.getLocale(); }
  setLocale(l) { this._prefs.setLocale(l); }
  getTimezone() { return this._prefs.getTimezone(); }
  setTimezone(tz) { this._prefs.setTimezone(tz); }
  getUpdateChannel() { return this._prefs.getUpdateChannel(); }
  setUpdateChannel(ch) { this._prefs.setUpdateChannel(ch); }
  setMemoryEnabled(v) { return this._configCoord.setMemoryEnabled(v); }
  setMemoryMasterEnabled(id, v) { return this._configCoord.setMemoryMasterEnabled(id, v); }
  persistSessionMeta() { return this._configCoord.persistSessionMeta(); }
  setPlanMode(enabled) { return this._sessionCoord.setPlanMode(enabled, allBuiltInTools); }
  async updateConfig(p, opts) { return this._configCoord.updateConfig(p, opts); }

  getPreferences() { return this._readPreferences(); }
  savePreferences(p) { return this._writePreferences(p); }

  // ════════════════════════════
  //  Channel 代理（→ ChannelManager）
  // ════════════════════════════

  deleteChannelByName(n) { return this._channels.deleteChannelByName(n); }
  async triggerChannelTriage(n, o) { return this._channels.triggerChannelTriage(n, o); }

  // ════════════════════════════
  //  Bridge 代理（→ BridgeSessionManager）
  // ════════════════════════════

  getBridgeIndex(agentId) {
    const agent = agentId ? this.getAgent(agentId) : undefined;
    return this._bridge.readIndex(agent);
  }
  saveBridgeIndex(i, agentId) {
    const agent = agentId ? this.getAgent(agentId) : undefined;
    return this._bridge.writeIndex(i, agent);
  }
  async executeExternalMessage(p, sk, m, o) { return this._bridge.executeExternalMessage(p, sk, m, o); }
  injectBridgeMessage(sk, t) { return this._bridge.injectMessage(sk, t); }

  // ════════════════════════════
  //  Skills（→ SkillManager）
  // ════════════════════════════

  _syncAgentSkills() { this._skills.syncAgentSkills(this.agent); }
  _syncAllAgentSkills() { for (const ag of this._agentMgr.agents.values()) this._skills.syncAgentSkills(ag); }
  getAllSkills(agentId) {
    // 不接受 fallback 到 this.agent — 调用方必须显式指定 agentId，
    // 否则前后端 agent 错位会导致 desk skill toggle 把错位列表写入当前 agent (#397)
    if (!agentId) throw new Error("getAllSkills requires explicit agentId");
    const ag = this._agentMgr.getAgent(agentId);
    if (!ag) throw new Error(`agent not found: ${agentId}`);
    return this._skills.getAllSkills(ag);
  }
  getRuntimeSkills(agentId) {
    if (!agentId) throw new Error("getRuntimeSkills requires explicit agentId");
    const ag = this._agentMgr.getAgent(agentId);
    if (!ag) throw new Error(`agent not found: ${agentId}`);
    return this._skills.getRuntimeSkillInfos(ag);
  }
  _getSkillsForAgent(ag) { return this._skills.getSkillsForAgent(ag); }
  get skillsDir() { return this._skills?.skillsDir; }
  get userSkillsDir() { return this._skills?.skillsDir; }
  get learnedSkillsDir() { return path.join(this.agent.agentDir, "learned-skills"); }
  get modelsJsonPath() { return this._models.modelsJsonPath; }
  get authJsonPath() { return this._models.authJsonPath; }

  async reloadSkills() {
    await this._skills.reload(this._resourceLoader, this._agentMgr.agents);
    this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
    this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);
    this._syncAllAgentSkills();
  }

  /** 获取外部技能路径配置（供 API 使用） */
  getExternalSkillPaths() {
    // 刷新 exists 状态，检测运行期间新增的目录
    let newDirAppeared = false;
    for (const d of this._discoveredExternalPaths || []) {
      const nowExists = fs.existsSync(d.dirPath);
      if (nowExists && !d.exists) newDirAppeared = true;
      d.exists = nowExists;
    }
    // 运行期间有新目录出现：重新集成到 SkillManager（watcher + 扫描）
    if (newDirAppeared) {
      this.syncWorkspaceSkillPaths(this.currentSessionPath ? this.cwd : null, {
        reload: true,
        emitEvent: true,
      }).catch(() => {});
    }
    return {
      configured: this._prefs.getExternalSkillPaths(),
      discovered: this._discoveredExternalPaths || [],
    };
  }

  /** 更新外部技能路径 + 同步 ResourceLoader + 重载 */
  async setExternalSkillPaths(paths) {
    this._prefs.setExternalSkillPaths(paths);
    await this.syncWorkspaceSkillPaths(this.currentSessionPath ? this.cwd : null, {
      reload: true,
      emitEvent: true,
    });
  }

  /** 合并自动发现 + 用户配置的外部路径（去重） */
  _mergeExternalPaths(userConfiguredPaths, extraPaths = []) {
    // 每次合并时重新检测目录是否存在（不依赖初始化快照）
    for (const d of this._discoveredExternalPaths || []) {
      d.exists = fs.existsSync(d.dirPath);
    }
    const discovered = (this._discoveredExternalPaths || [])
      .filter(d => d.exists)
      .map(d => ({ dirPath: d.dirPath, label: d.label }));
    const userParsed = (userConfiguredPaths || []).map(p => ({
      dirPath: path.resolve(p),
      label: path.basename(path.dirname(p)),
    }));
    const merged = [...discovered];
    const seen = new Set(merged.map(m => m.dirPath));
    for (const up of [...userParsed, ...extraPaths]) {
      if (seen.has(up.dirPath)) continue;
      merged.push(up);
      seen.add(up.dirPath);
    }
    return merged;
  }

  _getWorkspaceExternalSkillPaths(cwd) {
    return resolveWorkspaceSkillPaths(cwd);
  }

  _getResolvedExternalSkillPaths(cwd) {
    const pluginPaths = this._pluginManager?.getSkillPaths?.() || [];
    const workspacePaths = this._getWorkspaceExternalSkillPaths(cwd);
    return this._mergeExternalPaths(this._prefs.getExternalSkillPaths(), [
      ...pluginPaths,
      ...workspacePaths,
    ]);
  }

  _sameExternalSkillPaths(a = [], b = []) {
    if (a.length !== b.length) return false;
    return a.every((entry, index) => {
      const other = b[index];
      return entry?.dirPath === other?.dirPath
        && entry?.label === other?.label
        && (entry?.scope || "") === (other?.scope || "");
    });
  }

  async syncWorkspaceSkillPaths(cwd = null, { reload = true, emitEvent = false, force = false } = {}) {
    if (!this._skills) return false;
    const resolved = this._getResolvedExternalSkillPaths(cwd);
    const changed = !this._sameExternalSkillPaths(this._skills._externalPaths || [], resolved);
    if (!changed && !force) return false;

    this._skills.setExternalPaths(resolved);
    if (reload) await this.reloadSkills();
    if (emitEvent) this._emitEvent({ type: "skills-changed" }, null);
    return true;
  }

  // ════════════════════════════
  //  Model 代理
  // ════════════════════════════

  _resolveThinkingLevel(l) { return this._models.resolveThinkingLevel(l); }
  _resolveExecutionModel(r) { return this._models.resolveExecutionModel(r); }
  _resolveProviderCredentials(p) { return this._models.resolveProviderCredentials(p); }
  resolveProviderCredentials(p) { return this._resolveProviderCredentials(p); }
  resolveModelWithCredentials(ref) { return this._models.resolveModelWithCredentials(ref); }
  _inferModelProvider(id) { return this._models.inferModelProvider(id); }
  async refreshAvailableModels() { return this._models.refreshAvailable(); }
  /**
   * Provider 配置变更后的统一操作序列。
   * reload registry → sync models.json → refresh available → normalize utility prefs
   * → 通知 active session 重新解析 model 对象（baseUrl 等字段烤在对象上）
   */
  async onProviderChanged() {
    await this._models.reloadAndSync();
    this._configCoord.normalizeUtilityApiPreferences();
    this._sessionCoord.refreshAllSessionsModels();
  }
  getRegistryModelsForProvider(name) { return this._models.getRegistryModelsForProvider(name); }

  static SHARED_MODEL_KEYS = SHARED_MODEL_KEYS;

  // ════════════════════════════
  //  生命周期
  // ════════════════════════════

  async init(log = () => {}) {
    const startupTimer = Date.now();

    // 0. Config scope 迁移（全局字段从 agent config → preferences）
    migrateConfigScope({
      agentsDir: this.agentsDir,
      prefs: this._prefs,
      primaryAgentId: this._prefs.getPrimaryAgent(),
      log,
    });

    // 0b. Provider 迁移（旧数据 → added-models.yaml，只跑一次）
    migrateToProvidersYaml(this.hanakoHome, this.agentsDir, log);

    // 0c. Model overrides 迁移（config.models.overrides → added-models.yaml，只跑一次）
    this._models.providerRegistry.migrateOverridesToAddedModels(this.agentsDir, log);

    // 0d. 统一数据迁移（版本号驱动，新迁移统一加在 migrations.js）
    runMigrations({
      hanakoHome: this.hanakoHome,
      agentsDir: this.agentsDir,
      prefs: this._prefs,
      providerRegistry: this._models.providerRegistry,
      log,
    });

    // 1. Pi SDK + 模型基础设施（必须在 agent init 之前，agent 需要解析记忆模型）
    log(`[init] 1/5 Pi SDK 初始化...`);
    this._models.init();
    // 预填充 _availableModels，agent init 时需要解析 utility model
    await this._models.refreshAvailable();
    log(`[init] 1/5 AuthStorage + ModelRegistry + ${this._models.availableModels.length} 个模型就绪`);

    // 2. 初始化所有 agent
    log(`[init] 2/5 初始化所有 agent...`);
    await this._agentMgr.initAllAgents(log, this._agentMgr.activeAgentId);
    log(`[init] 2/5 ${this._agentMgr.agents.size} 个 agent 已就绪`);

    // 2b. 确保所有 agent 都有 channels.md（老用户升级兼容）
    for (const [id] of this._agentMgr.agents) {
      const channelsMd = path.join(this.agentsDir, id, 'channels.md');
      if (!fs.existsSync(channelsMd)) {
        this._channels.setupChannelsForNewAgent(id);
      }
    }

    // 3. ResourceLoader + Skills
    log(`[init] 3/5 ResourceLoader 初始化...`);
    const t_rl = Date.now();
    const skillsDir = path.join(this.hanakoHome, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    // 解析外部兼容技能路径
    const homeDir = os.homedir();
    this._discoveredExternalPaths = WELL_KNOWN_SKILL_PATHS.map(w => ({
      dirPath: path.join(homeDir, w.suffix),
      label: w.label,
      exists: fs.existsSync(path.join(homeDir, w.suffix)),
    }));
    const externalPaths = this._getResolvedExternalSkillPaths(null);

    this._skills = new SkillManager({ skillsDir, externalPaths });
    this._resourceLoader = new DefaultResourceLoader({
      systemPromptOverride: () => this.agent.systemPrompt,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: [skillsDir],
      extensionFactories: this._extensionFactories = [
        /** 兼容性修正：剥离第三方 anthropic-messages 供应商不支持的字段 */
        (pi) => {
          pi.on("before_provider_request", (event) => {
            const p = event.payload;
            if (!p) return p;
            // 剥离空 tools 数组 — dashscope / volcengine 不接受 tools: []
            if (Array.isArray(p.tools) && p.tools.length === 0) {
              delete p.tools;
            }
            // 剥离 thinking — minimax / kimi-coding 等 anthropic 兼容层不支持
            if (p.thinking) {
              const m = findModel(this._models.availableModels, p.model);
              if (m && m.provider !== "anthropic") delete p.thinking;
            }
            return p;
          });
        },
      ],
    });
    await this._resourceLoader.reload();

    const HIDDEN_SKILLS = new Set(["canvas-design", "skill-creator", "skills-translate-temp"]);
    this._skills.init(this._resourceLoader, this._agentMgr.agents, HIDDEN_SKILLS);
    const extCount = this._skills.allSkills.filter(s => s.source === "external").length;
    log(`[init] 3/5 ResourceLoader 完成 (${Date.now() - t_rl}ms, ${this._skills.allSkills.length} skills${extCount ? `, ${extCount} external` : ""})`);

    this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
    this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);

    // 4. 模型发现
    log(`[init] 4/5 发现可用模型...`);
    try { await this.syncModelsAndRefresh(); } catch {}
    await this._models.refreshAvailable();
    this._configCoord.normalizeUtilityApiPreferences(log);
    const availableModels = this._models.availableModels;
    log(`[init] 4/5 找到 ${availableModels.length} 个模型: ${availableModels.map(m => `${m.provider}/${m.id}`).join(", ")}`);
    if (availableModels.length === 0) {
      console.warn("[engine] ⚠ 未找到可用模型，请在设置中配置 API key");
      this._models.defaultModel = null;
    } else {
      const chatRef = this.agent.config.models?.chat;
      const preferredId = typeof chatRef === "object" ? chatRef?.id : chatRef;
      const preferredProvider = typeof chatRef === "object" ? chatRef?.provider : undefined;
      if (!preferredId) {
        console.warn("[engine] ⚠ 未配置 models.chat，defaultModel 为 null");
        this._models.defaultModel = null;
      } else {
        const model = findModel(availableModels, preferredId, preferredProvider);
        if (!model) {
          console.error(`[engine] ⚠ 配置的模型 "${preferredId}" 不在可用列表中，defaultModel 为 null`);
          this._models.defaultModel = null;
        } else {
          this._models.defaultModel = model;
          log(`✿ 使用模型: ${model.name} (${model.provider})`);
        }
      }
    }

    // 5. Sync skills + watch skillsDir
    this._syncAllAgentSkills();
    this._skills.watch(this._resourceLoader, this._agentMgr.agents, () => {
      this._resourceLoader.getSystemPrompt = () => this.agent.systemPrompt;
      this._resourceLoader.getSkills = () => this._getSkillsForAgent(this.agent);
      this._syncAllAgentSkills();
    });

    // 7. Bridge 孤儿清理
    try { this._bridge.reconcile(); } catch {}

    // 8. 沙盒日志
    const sandboxEnabled = this._readPreferences().sandbox !== false;
    log(`✿ 沙盒${sandboxEnabled ? "已启用" : "已关闭"}`);

    // 9. 清理过期的 .ephemeral session 文件（>7 天）
    this._cleanEphemeralSessions();

    const totalTime = ((Date.now() - startupTimer) / 1000).toFixed(1);
    log(`✿ 初始化完成（${totalTime}s）`);
  }

  /** 清理所有 agent 的 .ephemeral/ 目录中超过 7 天的文件 */
  _cleanEphemeralSessions() {
    const maxAge = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    try {
      if (!this.agentsDir || !fs.existsSync(this.agentsDir)) return;
      for (const entry of fs.readdirSync(this.agentsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const ephDir = path.join(this.agentsDir, entry.name, '.ephemeral');
        if (!fs.existsSync(ephDir)) continue;
        for (const file of fs.readdirSync(ephDir)) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = path.join(ephDir, file);
          try {
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > maxAge) fs.unlinkSync(filePath);
          } catch { /* best effort */ }
        }
      }
    } catch { /* best effort */ }
  }

  async dispose() {
    // 先卸载 plugins（它们可能依赖 engine 资源）
    if (this._pluginManager) {
      for (const p of this._pluginManager.listPlugins()) {
        if (p.status === "loaded") {
          await this._pluginManager.unloadPlugin(p.id);
        }
      }
    }
    this._skills?.unwatch();
    await this._agentMgr.disposeAll(this._sessionCoord);
    await this._sessionCoord.cleanupSession();
  }

  // ════════════════════════════
  //  插件系统
  // ════════════════════════════

  /**
   * Initialize plugin system. Called after Hub construction (EventBus available).
   * @param {import('../hub/event-bus.js').EventBus} bus
   */
  async initPlugins(bus) {
    const builtinPluginsDir = path.join(this.productDir, "..", "plugins");
    const userPluginsDir = path.join(this.hanakoHome, "plugins");
    const pluginDataDir = path.join(this.hanakoHome, "plugin-data");

    // Read app version for plugin compatibility check
    let appVersion = "0.0.0";
    try {
      const pkgPath = path.join(this.productDir, "..", "package.json");
      appVersion = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version || "0.0.0";
    } catch {}

    this._pluginManager = new PluginManager({
      pluginsDirs: [builtinPluginsDir, userPluginsDir],
      dataDir: pluginDataDir,
      bus,
      preferencesManager: this._prefs,
      appVersion,
      getSessionPath: () => this.currentSessionPath,
    });
    this._pluginManager.scan();
    await this._pluginManager.loadAll();

    if (this._skills) {
      await this.syncWorkspaceSkillPaths(this.currentSessionPath ? this.cwd : null, {
        reload: true,
        emitEvent: false,
      });
    }

    // Inject plugin extension factories into ResourceLoader (same array reference)
    this._syncExtensionFactories();
  }

  /**
   * 同步插件 extension factories 到 ResourceLoader 共享数组。
   * 原地 splice 保持数组引用不变（DefaultResourceLoader 持有同一引用）。
   * 在 initPlugins 以及任何插件热操作后调用。
   */
  _syncExtensionFactories() {
    if (!this._extensionFactories) return;
    const frameworkFactories = this._frameworkExtFactories || [];
    const pluginFactories = this._pluginManager?.getExtensionFactories() || [];
    this._extensionFactories.splice(1, Infinity, ...frameworkFactories, ...pluginFactories);
  }

  /**
   * Register a framework-level extension factory.
   * Tracked separately so _syncExtensionFactories preserves them across plugin hot-reloads.
   * Only affects sessions created after this call.
   */
  registerExtensionFactory(factory) {
    if (!this._extensionFactories) return;
    if (!this._frameworkExtFactories) this._frameworkExtFactories = [];
    this._frameworkExtFactories.push(factory);
    this._syncExtensionFactories();
  }

  get pluginManager() { return this._pluginManager; }

  /** 插件热操作后调用，同步 extension factories 到 ResourceLoader */
  syncPluginExtensions() { this._syncExtensionFactories(); }

  // ════════════════════════════
  //  工具构建
  // ════════════════════════════

  buildTools(cwd, customTools, opts = {}) {
    let ct = customTools;
    let agentId;
    if (!ct) {
      // 通过 opts.agentDir 反查 agent 实例，避免隐式依赖焦点 agent
      if (opts.agentDir) {
        const dirAgentId = path.basename(opts.agentDir);
        const dirAgent = this.getAgent(dirAgentId);
        ct = dirAgent?.tools || this.agent.tools;
        agentId = dirAgentId;
      } else {
        ct = this.agent.tools;
        agentId = this.agent?.id || "";
      }
    } else {
      agentId = opts.agentDir ? path.basename(opts.agentDir) : (this.agent?.id || "");
    }
    // Append plugin tools
    const pluginTools = this._pluginManager?.getAllTools() || [];
    const wrappedPluginTools = pluginTools.map(t => ({
      ...t,
      execute: (toolCallId, params, runtimeCtx) => t.execute(toolCallId, params, { ...runtimeCtx, agentId }),
    }));
    const allTools = [...ct, ...wrappedPluginTools];

    const effectiveAgentDir = opts.agentDir || this.agent.agentDir;
    const effectiveWorkspace = opts.workspace !== undefined ? opts.workspace : this.homeCwd;

    let result = createSandboxedTools(cwd, allTools, {
      agentDir: effectiveAgentDir,
      workspace: effectiveWorkspace,
      hanakoHome: this.hanakoHome,
      getSandboxEnabled: () => this._readPreferences().sandbox !== false,
    });

    // Checkpoint wrapper (outside sandbox layer)
    const backupCfg = this._prefs.getFileBackup();
    if (backupCfg.enabled) {
      const getSessionPath = opts.getSessionPath || (() => null);
      result = {
        ...result,
        tools: wrapWithCheckpoint(result.tools, {
          store: this._checkpointStore,
          maxFileSizeKb: backupCfg.max_file_size_kb,
          cwd,
          getSessionPath,
        }),
      };
    }

    // Startup assertion: every built-in tool must be categorized in
    // shared/tool-categories.js. All session-creation paths route through
    // this function, so a single check here catches the whole surface.
    assertAllToolsCategorized([
      ...result.tools.map((t) => t.name).filter(Boolean),
      ...ct
        .filter((t) => !t._pluginId)
        .map((t) => t.name)
        .filter(Boolean),
    ]);

    return result;
  }

  // ════════════════════════════
  //  事件系统
  // ════════════════════════════

  /**
   * Hub 构造后注入回调，替代旧的 engine._hub = this 双向引用。
   * Manager 通过 getHub() lazy getter 拿到这个对象。
   */
  setHubCallbacks(callbacks) {
    this._hubCallbacks = callbacks;
  }

  setEventBus(bus) {
    for (const fn of this._listeners) bus.subscribe(fn);
    this._listeners.clear();
    this._eventBus = bus;
  }

  subscribe(listener) {
    if (this._eventBus) return this._eventBus.subscribe(listener);
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emitEvent(event, sessionPath) {
    if (this._eventBus) {
      this._eventBus.emit(event, sessionPath);
    } else {
      for (const fn of this._listeners) {
        try { fn(event, sessionPath); } catch {}
      }
    }
  }

  emitEvent(event, sessionPath) { this._emitEvent(event, sessionPath); }

  emitDevLog(text, level = "info") {
    const entry = { text, level, ts: Date.now() };
    this._devLogs.push(entry);
    if (this._devLogs.length > this._devLogsMax) {
      this._devLogs.shift();
    }
    const dl = debugLog();
    if (dl) {
      if (level === "error") dl.error("engine", text);
      else dl.log("engine", text);
    }
    this._emitEvent({ type: "devlog", text, level }, null);
  }

  getDevLogs() {
    return this._devLogs;
  }

  // ════════════════════════════
  //  日记 / 工具调用
  // ════════════════════════════

  async writeDiary() {
    const currentPath = this.currentSessionPath;
    if (currentPath && this.agent.memoryTicker) {
      await this.agent.memoryTicker.flushSession(currentPath);
    }
    const { writeDiary } = await import("../lib/diary/diary-writer.js");
    const diaryModelId = this.agent.config.models?.chat || this.agent.memoryModel;
    const resolvedModel = this._models.resolveModelWithCredentials(diaryModelId);
    return writeDiary({
      summaryManager: this.agent.summaryManager,
      resolvedModel,
      agentPersonality: this.agent.personality,
      memory: (() => {
        try { return fs.readFileSync(this.agent.memoryMdPath, "utf-8"); } catch { return ""; }
      })(),
      userName: this.agent.userName,
      agentName: this.agent.agentName,
      cwd: this.homeCwd || process.cwd(),
      activityStore: this.activityStore,
      todayMdPath: this.agent.todayMdPath,
    });
  }

  async summarizeTitle(ut, at, opts) {
    return _summarizeTitle(this.resolveUtilityConfig(), ut, at, opts);
  }

  async translateSkillNames(names, lang) {
    return _translateSkillNames(this.resolveUtilityConfig(), names, lang);
  }

  async summarizeActivity(sp, preloaded) {
    return _summarizeActivity(this.resolveUtilityConfig(), sp, (msg) => this.emitDevLog(msg), preloaded);
  }

  async summarizeActivityQuick(activityId) {
    let entry = null, foundAgentId = null;
    for (const [agId] of this._agentMgr.agents) {
      const store = this.getActivityStore(agId);
      const e = store?.get(activityId);
      if (e) { entry = e; foundAgentId = agId; break; }
    }
    if (!entry?.sessionFile) return null;
    const sessionPath = path.join(this.agentsDir, foundAgentId, "activity", entry.sessionFile);
    return _summarizeActivityQuick(this.resolveUtilityConfig(), sessionPath);
  }

  // ════════════════════════════
  //  Desk 辅助
  // ════════════════════════════

  listDeskFiles() {
    try {
      const dir = this.homeCwd;
      if (!dir || !fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith("."))
        .map(e => {
          const fp = path.join(dir, e.name);
          let mtime = 0;
          try { mtime = fs.statSync(fp).mtimeMs; } catch {}
          return { name: e.name, isDir: e.isDirectory(), mtime };
        });
    } catch {
      return [];
    }
  }

  // ════════════════════════════
  //  Preferences 代理
  // ════════════════════════════

  _readPreferences() { return this._prefs.getPreferences(); }
  _writePreferences(prefs) { return this._prefs.savePreferences(prefs); }
  _readPrimaryAgent() { return this._prefs.getPrimaryAgent(); }
  _savePrimaryAgent(agentId) { return this._prefs.savePrimaryAgent(agentId); }

  // ════════════════════════════
  //  巡检工具白名单（向后兼容静态引用）
  // ════════════════════════════

  static PATROL_TOOLS_DEFAULT = "*";
}
