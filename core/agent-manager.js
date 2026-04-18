/**
 * AgentManager — 多 Agent 生命周期管理
 *
 * 从 Engine 提取，负责 agent 的扫描/初始化/创建/切换/删除。
 * 不持有 engine 引用，通过构造器注入依赖。
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import YAML from "js-yaml";
import { Agent } from "./agent.js";
import { safeReadYAMLSync } from "../shared/safe-fs.js";
import { createModuleLogger } from "../lib/debug-log.js";
import { clearConfigCache } from "../lib/memory/config-loader.js";
import { t } from "../server/i18n.js";
import { ActivityStore } from "../lib/desk/activity-store.js";
import { createHash } from "crypto";
import {
  generateAgentId as _generateAgentId,
  generateDescription,
} from "./llm-utils.js";
import { findModel } from "../shared/model-ref.js";

const log = createModuleLogger("agent-mgr");

export class AgentManager {
  /**
   * @param {object} deps
   * @param {string} deps.agentsDir
   * @param {string} deps.productDir
   * @param {string} deps.userDir
   * @param {string} deps.channelsDir
   * @param {() => import('./preferences-manager.js').PreferencesManager} deps.getPrefs
   * @param {() => import('./model-manager.js').ModelManager} deps.getModels
   * @param {() => object|null} deps.getHub
   * @param {() => import('./skill-manager.js').SkillManager} deps.getSkills
   * @param {() => object} deps.getSearchConfig
   * @param {() => object} deps.resolveUtilityConfig
   * @param {() => object} deps.getSharedModels
   * @param {() => import('./channel-manager.js').ChannelManager} deps.getChannelManager
   * @param {() => import('./session-coordinator.js').SessionCoordinator} deps.getSessionCoordinator
   */
  constructor(deps) {
    this._d = deps;
    this._agents = new Map();
    this._activeAgentId = null;
    this._switchQueue = Promise.resolve();
    this._activityStores = new Map();
    this._agentListCache = null;       // { raw: [{id,name,yuan,identity}], ts: number }
    this._descRefreshPending = false;
  }

  /** 清除 listAgents 缓存（agent 增删改时调用） */
  invalidateAgentListCache() { this._agentListCache = null; }

  get agents() { return this._agents; }
  get activeAgentId() { return this._activeAgentId; }
  set activeAgentId(id) { this._activeAgentId = id; }
  get switching() { return this._switchQueue !== Promise.resolve(); }

  /** 当前焦点 agent */
  get agent() { return this._agents.get(this._activeAgentId); }

  /** 按 ID 获取 agent */
  getAgent(agentId) { return this._agents.get(agentId) || null; }

  // ── Activity Store（per-agent 懒缓存） ──

  get activityStores() { return this._activityStores; }

  getActivityStore(agentId) {
    let store = this._activityStores.get(agentId);
    if (!store) {
      const agDir = path.join(this._d.agentsDir, agentId);
      store = new ActivityStore(
        path.join(agDir, "desk", "activities.json"),
        path.join(agDir, "activity"),
      );
      this._activityStores.set(agentId, store);
    }
    return store;
  }

  // ── Init ──

  async initAllAgents(log, startId) {
    this._activeAgentId = startId;

    const sharedModels = this._d.getSharedModels();
    const resolveModel = (bareId) =>
      this._d.getModels().resolveModelWithCredentials(bareId);

    const entries = this._scanAgentDirs();
    const initOne = async (agentId) => {
      const agentDir = path.join(this._d.agentsDir, agentId);
      const ag = this._createAgentInstance(agentDir, () => ({}));
      ag.setGetOwnerIds(this._makeOwnerIdsFn(ag));
      await ag.init(
        agentId === this._activeAgentId ? log : () => {},
        sharedModels,
        resolveModel,
      );
      this._agents.set(agentId, ag);
    };

    // 焦点 agent 先初始化 — 失败不阻塞启动，让用户能进应用修配置
    try {
      await initOne(this._activeAgentId);
    } catch (err) {
      console.error(`[agent-manager] 焦点 agent "${this._activeAgentId}" init 失败: ${err.message}`);
      if (err.stack) console.error(err.stack);
      // 仍然创建实例放入 map，让应用能启动。
      // 关键：必须至少把 config 加载进来，否则 agent.config.models.chat 读不到，
      // 下游会误判为"没配模型"，触发 session 创建跳过 / 记忆系统未启动等连锁崩溃（#414）。
      if (!this._agents.has(this._activeAgentId)) {
        const agentDir = path.join(this._d.agentsDir, this._activeAgentId);
        const ag = this._createAgentInstance(agentDir, () => ({}));
        ag.setGetOwnerIds(this._makeOwnerIdsFn(ag));
        try {
          ag.loadConfigOnly();
        } catch (cfgErr) {
          console.error(`[agent-manager] fallback loadConfigOnly 也失败: ${cfgErr.message}`);
          if (cfgErr.stack) console.error(cfgErr.stack);
        }
        this._agents.set(this._activeAgentId, ag);
      }
    }

    // 其余并行
    const others = entries.map(e => e.name).filter(id => id !== this._activeAgentId);
    if (others.length) {
      const results = await Promise.allSettled(others.map(id => initOne(id)));
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "rejected") {
          console.error(`[agent-manager] agent "${others[i]}" init 失败: ${results[i].reason?.message}`);
        }
      }
    }
    log(`[init] ${this._agents.size} 个 agent 初始化完成`);
  }

  // ── List ──

  static AGENT_LIST_TTL = 30_000; // 30 秒

  listAgents() {
    const now = Date.now();
    if (!this._agentListCache || now - this._agentListCache.ts > AgentManager.AGENT_LIST_TTL) {
      this._agentListCache = { raw: this._scanAgentList(), ts: now };
    }

    const prefs = this._d.getPrefs();
    const primaryId = prefs.getPrimaryAgent();
    const order = prefs.getPreferences()?.agentOrder || [];

    const agents = this._agentListCache.raw.map(a => ({
      ...a,
      isPrimary: a.id === primaryId,
      isCurrent: a.id === this._activeAgentId,
    }));

    if (order.length) {
      agents.sort((a, b) => {
        const ia = order.indexOf(a.id);
        const ib = order.indexOf(b.id);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      });
    }

    // lazy refresh：在返回列表后，异步刷新缺少 description 的 agent（每次最多 1 个）
    if (!this._descRefreshPending) {
      const needsRefresh = agents.find(a => !this._hasDescription(a.id));
      if (needsRefresh) {
        this._descRefreshPending = true;
        this._refreshDescription(needsRefresh.id)
          .catch(() => {})
          .finally(() => { this._descRefreshPending = false; });
      }
    }

    return agents;
  }

  /** 扫盘读取所有 agent 元数据（I/O 密集，由缓存保护） */
  _scanAgentList() {
    const entries = fs.readdirSync(this._d.agentsDir, { withFileTypes: true });
    const agents = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const configPath = path.join(this._d.agentsDir, entry.name, "config.yaml");
      if (!fs.existsSync(configPath)) continue;
      try {
        const cfg = safeReadYAMLSync(configPath, {}, YAML);
        let identity = "";
        try {
          const idMd = fs.readFileSync(path.join(this._d.agentsDir, entry.name, "identity.md"), "utf-8");
          const lines = idMd.split("\n").filter(l => l.trim() && !l.startsWith("#"));
          identity = lines[0]?.trim() || "";
        } catch {}
        const avatarDir = path.join(this._d.agentsDir, entry.name, "avatars");
        let hasAvatar = false;
        try {
          const avatarFiles = fs.readdirSync(avatarDir);
          hasAvatar = avatarFiles.some(f => /\.(png|jpe?g|gif|webp)$/i.test(f));
        } catch {}
        const chatRef = cfg.models?.chat;
        const chatModel = typeof chatRef === "object"
          ? { id: chatRef.id, provider: chatRef.provider }
          : (chatRef ? { id: chatRef } : null);
        agents.push({
          id: entry.name,
          name: cfg.agent?.name || entry.name,
          yuan: cfg.agent?.yuan || "hanako",
          identity,
          hasAvatar,
          chatModel,
        });
      } catch {}
    }
    return agents;
  }

  /** 检查 description.md 是否存在 */
  _hasDescription(agentId) {
    try {
      fs.accessSync(path.join(this._d.agentsDir, agentId, "description.md"));
      return true;
    } catch { return false; }
  }

  /**
   * 异步刷新 agent 的 description.md
   * 通过 hash 比对 personality + yuan 类型，变化时调用 LLM 重新生成。
   */
  async _refreshDescription(agentId) {
    try {
      const ag = this._agents.get(agentId);
      if (!ag) return;

      const personality = ag.personality;
      const yuan = ag.config?.agent?.yuan || "hanako";
      const hash = createHash("sha256").update(personality + "\n" + yuan).digest("hex");

      const descPath = path.join(this._d.agentsDir, agentId, "description.md");

      // 读取已有 hash
      try {
        const firstLine = fs.readFileSync(descPath, "utf-8").split("\n")[0].trim();
        const match = firstLine.match(/^<!--\s*sourceHash:\s*(\S+)\s*-->$/);
        if (match?.[1] === hash) return; // 没变化，跳过
      } catch {} // 文件不存在，继续生成

      const utilConfig = this._d.resolveUtilityConfig();
      const locale = ag.config?.locale || "zh";
      const desc = await generateDescription(utilConfig, personality, locale);
      if (!desc) {
        log.log(`[description] ${agentId}: 生成跳过（LLM 不可用或返回空）`);
        return;
      }

      fs.writeFileSync(descPath, `<!-- sourceHash: ${hash} -->\n${desc}`, "utf-8");
      log.log(`[description] ${agentId}: 已更新`);
    } catch (err) {
      console.warn(`[agent-mgr] _refreshDescription(${agentId}) failed:`, err.message);
    }
  }

  // ── Create ──

  /**
   * Best-effort rollback of createAgent's partial state.
   * Called when any step between fs.mkdirSync and this._agents.set fails.
   * All cleanup is wrapped in try/catch so a cleanup failure doesn't mask
   * the original error.
   */
  _rollbackAgentCreation(agentDir, agentId) {
    try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch {}
    try { this._d.getChannelManager().cleanupAgentFromChannels(agentId); } catch {}
  }

  async createAgent({ name, id, yuan }) {
    if (!name?.trim()) throw new Error(t("error.agentNameEmpty"));

    const agentId = id?.trim() || await this._generateAgentId(name);
    if (/[\/\\]|\.\./.test(agentId)) throw new Error(t("error.agentIdInvalid"));
    const agentDir = path.join(this._d.agentsDir, agentId);

    if (fs.existsSync(agentDir)) {
      throw new Error(t("error.agentAlreadyExists", { id: agentId }));
    }

    // 创建目录结构
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "avatars"), { recursive: true });

    // 从模板复制 config.yaml
    const templateConfig = fs.readFileSync(path.join(this._d.productDir, "config.example.yaml"), "utf-8");
    const currentAgent = this.agent;
    const userName = currentAgent?.userName || "";
    const safeName = name.trim().replace(/"/g, '\\"');
    const VALID_YUAN = ["hanako", "butter", "ming", "kong"];
    const yuanType = VALID_YUAN.includes(yuan) ? yuan : "hanako";
    let config = templateConfig.replace(/name: Hanako/, `name: "${safeName}"`);
    config = config.replace(/yuan: hanako/, `yuan: ${yuanType}`);
    if (userName) {
      config = config.replace(/user:\s*\n\s+name:\s*""/, `user:\n  name: "${userName}"`);
    }
    // 继承主 agent 的模型配置
    const chatRef = currentAgent?.config?.models?.chat;
    const primaryChat = (typeof chatRef === "object" ? chatRef?.id : chatRef) || this._d.getModels().defaultModel?.id || "";
    if (primaryChat) {
      config = config.replace(/chat: ""/, `chat: "${primaryChat}"`);
    }
    fs.writeFileSync(path.join(agentDir, "config.yaml"), config, "utf-8");

    // identity.md
    const identityTemplate = path.join(this._d.productDir, "identity.example.md");
    if (fs.existsSync(identityTemplate)) {
      const tmpl = fs.readFileSync(identityTemplate, "utf-8");
      const filled = tmpl
        .replace(/\{\{agentName\}\}/g, name.trim())
        .replace(/\{\{userName\}\}/g, currentAgent?.userName || t("error.fallbackUserName"));
      fs.writeFileSync(path.join(agentDir, "identity.md"), filled, "utf-8");
    }

    // ishiki.md
    const ishikiSrc = path.join(this._d.productDir, "ishiki.example.md");
    if (fs.existsSync(ishikiSrc)) {
      fs.copyFileSync(ishikiSrc, path.join(agentDir, "ishiki.md"));
    }

    // public-ishiki.md（对外意识模板）
    const publicIshikiSrc = path.join(this._d.productDir, "public-ishiki-templates", `${yuanType}.md`);
    if (fs.existsSync(publicIshikiSrc)) {
      fs.copyFileSync(publicIshikiSrc, path.join(agentDir, "public-ishiki.md"));
    }

    // 可选文件：确保存在（即使为空），避免运行时 ENOENT
    const touchIfMissing = (p) => { if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf-8'); };
    touchIfMissing(path.join(agentDir, 'pinned.md'));

    // 频道系统
    this._d.getChannelManager().setupChannelsForNewAgent(agentId);

    // 初始化并加入长驻 Map
    const ag = this._createAgentInstance(agentDir, () => ({}));
    ag.setGetOwnerIds(this._makeOwnerIdsFn(ag));
    const resolveModel = (bareId) =>
      this._d.getModels().resolveModelWithCredentials(bareId);
    try {
      await ag.init(() => {}, this._d.getSharedModels(), resolveModel);
    } catch (err) {
      // init 失败：回滚已创建的目录和频道状态，防止孤儿残留
      this._rollbackAgentCreation(agentDir, agentId);
      throw err;
    }
    // #419: 新建 agent 继承当前已装 user/SDK skill 快照;空快照时保留 template 默认
    const defaultEnabled = this._d.getSkills().computeDefaultEnabledForNewAgent();
    if (defaultEnabled.length > 0) {
      try {
        ag.updateConfig({ skills: { enabled: defaultEnabled } });
        this._d.getSkills().syncAgentSkills(ag);
      } catch (err) {
        this._rollbackAgentCreation(agentDir, agentId);
        throw err;
      }
    }
    this._agents.set(agentId, ag);

    // 启动 cron + heartbeat
    const hub = this._d.getHub();
    hub?.scheduler?.startAgentCron(agentId);
    const newAgent = this._agents.get(agentId);
    if (newAgent) {
      hub?.scheduler?.startAgentHeartbeat?.(agentId, newAgent);
    }

    // 注入 DM 回调
    const dmRouter = hub?.dmRouter;
    if (dmRouter) {
      ag.setDmSentHandler((fromId, toId) => dmRouter.handleNewDm(fromId, toId));
    }

    this.invalidateAgentListCache();
    log.log(`创建助手: ${name} (${agentId})`);
    return { id: agentId, name: name.trim() };
  }

  // ── Switch ──

  /**
   * 仅切换 agent 指针（不创建 session）。排队执行，不会并发。
   * SessionCoordinator.switchSession 跨 agent 时调用此方法。
   */
  async switchAgentOnly(agentId) {
    return this._enqueueSwitch(() => this._doSwitchAgentOnly(agentId));
  }

  /**
   * 完整切换：切 agent 指针 + 恢复调度 + 同步 skills + 创建 session。
   * 排队执行，快速连续切换会按序落到最终目标。
   */
  async switchAgent(agentId) {
    return this._enqueueSwitch(() => this._doSwitchAgent(agentId));
  }

  /** Promise 链互斥：所有切换操作排队执行，前一个失败不阻塞后续 */
  _enqueueSwitch(fn) {
    const queued = this._switchQueue.catch(() => {}).then(fn);
    this._switchQueue = queued;
    return queued;
  }

  async _doSwitchAgentOnly(agentId) {
    if (!this._agents.has(agentId)) {
      throw new Error(t("error.agentNotFound", { id: agentId }));
    }
    const prevAgentId = this._activeAgentId;
    log.log(`switching agent to ${agentId}`);
    try {
      const hub = this._d.getHub();
      await hub?.pauseForAgentSwitch();
      clearConfigCache();
      this._activeAgentId = agentId;

      const chatRef = this.agent.config.models?.chat;
      const preferredId = typeof chatRef === "object" ? chatRef?.id : chatRef;
      const preferredProvider = typeof chatRef === "object" ? chatRef?.provider : undefined;
      const models = this._d.getModels();
      if (preferredId) {
        const model = findModel(models.availableModels, preferredId, preferredProvider);
        if (!model) {
          throw new Error(t("error.agentModelNotAvailable", { id: agentId, model: preferredId }));
        }
        models.defaultModel = model;
      }
      const effectiveModel = preferredId || models.defaultModel?.id || "inherited";
      log.log(`agent switched to ${this.agent.agentName} (${agentId}), model=${effectiveModel}`);
    } catch (err) {
      this._activeAgentId = prevAgentId;
      try { this._d.getHub()?.resumeAfterAgentSwitch(); } catch {}
      throw err;
    }
  }

  async _doSwitchAgent(agentId) {
    await this._doSwitchAgentOnly(agentId);
    const hub = this._d.getHub();
    hub?.resumeAfterAgentSwitch();
    this._d.getSkills().syncAgentSkills(this.agent);
    this._d.getPrefs().savePrimaryAgent(agentId);
    await this._d.getSessionCoordinator().createSession();
    log.log(`已切换到助手: ${this.agent.agentName} (${agentId})`);
  }

  async createSessionForAgent(agentId, cwd, memoryEnabled = true) {
    if (agentId && agentId !== this._activeAgentId) {
      await this.switchAgentOnly(agentId);
    }
    return this._d.getSessionCoordinator().createSession(null, cwd, memoryEnabled);
  }

  // ── Delete ──

  async deleteAgent(agentId) {
    if (agentId === this._activeAgentId) {
      throw new Error(t("error.agentDeleteActive"));
    }

    const agentDir = path.join(this._d.agentsDir, agentId);
    if (!fs.existsSync(agentDir)) {
      throw new Error(t("error.agentNotExists", { id: agentId }));
    }

    const ag = this._agents.get(agentId);
    if (ag) {
      this._agents.delete(agentId);
      this._activityStores.delete(agentId);
      await this._d.getHub()?.scheduler?.removeAgentCron(agentId);
      await this._d.getHub()?.scheduler?.stopHeartbeat(agentId);
      await ag.dispose();
    }

    // 频道清理
    try {
      this._d.getChannelManager().cleanupAgentFromChannels(agentId);
    } catch (err) {
      log.error(`频道清理失败 (${agentId}): ${err.message}`);
    }

    await fsp.rm(agentDir, { recursive: true, force: true });

    const prefs = this._d.getPrefs();
    const primaryId = prefs.getPrimaryAgent();
    if (primaryId === agentId) {
      prefs.savePrimaryAgent(this._activeAgentId);
    }

    const order = prefs.getPreferences()?.agentOrder || [];
    const newOrder = order.filter(id => id !== agentId);
    if (newOrder.length !== order.length) {
      const p = prefs.getPreferences();
      p.agentOrder = newOrder;
      prefs.savePreferences(p);
    }

    this.invalidateAgentListCache();
    log.log(`已删除助手: ${agentId}`);
  }

  // ── Utility ──

  setPrimaryAgent(agentId) {
    const agentDir = path.join(this._d.agentsDir, agentId);
    if (!fs.existsSync(path.join(agentDir, "config.yaml"))) {
      throw new Error(t("error.agentNotExists", { id: agentId }));
    }
    this._d.getPrefs().savePrimaryAgent(agentId);
  }

  agentIdFromSessionPath(sessionPath) {
    const rel = path.relative(this._d.agentsDir, sessionPath);
    if (rel.startsWith("..")) return null;
    return rel.split(path.sep)[0] || null;
  }

  // ── Dispose ──

  async disposeAll(sessionCoord) {
    // 对所有缓存 session 做 final 滚动摘要（带超时保护）
    const entries = sessionCoord ? [...sessionCoord._sessions.entries()] : [];
    if (entries.length > 0) {
      const summaryPromises = entries.map(([sp, entry]) => {
        const agent = this._agents.get(entry.agentId) || this.agent;
        return Promise.race([
          agent?._memoryTicker?.notifySessionEnd(sp) ?? Promise.resolve(),
          new Promise(r => setTimeout(r, 4000)),
        ]);
      });
      await Promise.allSettled(summaryPromises);
    }
    await Promise.allSettled(
      [...this._agents.values()].map(ag => ag.dispose()),
    );
    this._agents.clear();
  }

  // ── Internal ──

  _scanAgentDirs() {
    try {
      return fs.readdirSync(this._d.agentsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && fs.existsSync(path.join(this._d.agentsDir, e.name, "config.yaml")));
    } catch { return []; }
  }

  /** 构造 per-agent getOwnerIds 闭包：从 agent 自身的 config.bridge 读取 */
  _makeOwnerIdsFn(ag) {
    return () => {
      const bridgeCfg = ag.config?.bridge || {};
      const ids = {};
      for (const [plat, cfg] of Object.entries(bridgeCfg)) {
        if (plat === 'readOnly') continue;
        if (typeof cfg === 'object' && cfg?.owner) ids[plat] = cfg.owner;
      }
      return ids;
    };
  }

  _createAgentInstance(agentDir, getOwnerIds) {
    const ag = new Agent({
      agentDir,
      productDir: this._d.productDir,
      userDir: this._d.userDir,
      channelsDir: this._d.channelsDir,
      agentsDir: this._d.agentsDir,
      searchConfigResolver: () => this._d.getSearchConfig(),
    });
    ag.setGetOwnerIds(getOwnerIds);
    // 回调注入：Agent 通过 _cb 访问 Engine 能力，不直接持有 Engine 引用
    const getEngine = () => this._d.getEngine?.();
    ag.setCallbacks({
      emitDevLog:           (text, level) => getEngine()?.emitDevLog?.(text, level),
      getConfirmStore:      () => getEngine()?.confirmStore ?? null,
      getCurrentSessionPath:() => getEngine()?.currentSessionPath ?? null,
      emitEvent:            (event, sp) => getEngine()?._emitEvent?.(event, sp),
      emitSessionEvent:     (event) => getEngine()?.emitSessionEvent?.(event),
      getDeferredResults:   () => getEngine()?.deferredResults ?? null,
      getTaskRegistry:      () => getEngine()?.taskRegistry ?? null,
      setSubagentController: (id, ctrl) => getEngine()?.setSubagentController(id, ctrl),
      removeSubagentController: (id) => getEngine()?.removeSubagentController(id),
      executeIsolated:      (prompt, opts) => getEngine()?.executeIsolated(prompt, opts),
      getCurrentModelId:    () => getEngine()?.currentModel?.id ?? null,
      getSkillsDir:         () => getEngine()?.skillsDir ?? null,
      getLearnSkills:       () => getEngine()?.getLearnSkills?.() ?? {},
      resolveUtilityConfig: () => getEngine()?.resolveUtilityConfig?.(),
      getCwd:               () => getEngine()?.cwd ?? "",
      getTimezone:          () => getEngine()?.getTimezone?.() ?? "",
      getEngine,  // update-settings-tool 仍需要完整 engine
    });
    ag.setOnInstallCallback(async (skillName) => {
      const skills = this._d.getSkills();
      await skills.reload(this._d.getResourceLoader?.(), this._agents);
      const enabled = new Set(ag.config?.skills?.enabled || []);
      enabled.add(skillName);
      ag.updateConfig({ skills: { enabled: [...enabled] } });
      skills.syncAgentSkills(ag);
    });
    ag.setNotifyHandler((title, body) => {
      this._d.getHub()?.eventBus?.emit({ type: "notification", title, body }, null);
    });
    ag.setDescriptionRefreshHandler(() => {
      this._refreshDescription(path.basename(ag.agentDir)).catch(() => {});
    });
    return ag;
  }

  async _generateAgentId(name) {
    let utilConfig;
    try {
      utilConfig = this._d.resolveUtilityConfig();
    } catch {
      // utility 模型未配置（新用户常见），直接走兜底 ID
      return `agent-${Date.now().toString(36)}`;
    }
    return _generateAgentId(utilConfig, name, this._d.agentsDir);
  }
}
