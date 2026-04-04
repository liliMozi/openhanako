/**
 * SessionCoordinator — Session 生命周期管理
 *
 * 从 Engine 提取，负责 session 的创建/切换/关闭/列表、
 * isolated 执行、session 标题、activity session 提升。
 * 不持有 engine 引用，通过构造器注入依赖。
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { createAgentSession, SessionManager } from "../lib/pi-sdk/index.js";
import { createDefaultSettings } from "./session-defaults.js";
import { createModuleLogger } from "../lib/debug-log.js";
import { BrowserManager } from "../lib/browser/browser-manager.js";
import { t, getLocale } from "../server/i18n.js";
import { READ_ONLY_BUILTIN_TOOLS } from "./config-coordinator.js";
import { findModel } from "../shared/model-ref.js";

const log = createModuleLogger("session");

/** 巡检/定时任务默认工具白名单（"*" = 与 chat 一致，全部放行） */
export const PATROL_TOOLS_DEFAULT = "*";

function getSteerPrefix() {
  const isZh = getLocale().startsWith("zh");
  return isZh ? "（插话，无需 MOOD）\n" : "(Interjection, no MOOD needed)\n";
}
const MAX_CACHED_SESSIONS = 20;

export class SessionCoordinator {
  /**
   * @param {object} deps
   * @param {string} deps.agentsDir
   * @param {() => object} deps.getAgent - 当前焦点 agent
   * @param {() => string} deps.getActiveAgentId
   * @param {() => import('./model-manager.js').ModelManager} deps.getModels
   * @param {() => object} deps.getResourceLoader
   * @param {() => import('./skill-manager.js').SkillManager} deps.getSkills
   * @param {(cwd, customTools?, opts?) => object} deps.buildTools
   * @param {(event, sp) => void} deps.emitEvent
   * @param {() => string|null} deps.getHomeCwd
   * @param {(path) => string|null} deps.agentIdFromSessionPath
   * @param {(id) => Promise} deps.switchAgentOnly - 仅切换 agent 指针
   * @param {() => object} deps.getConfig
   * @param {() => Map} deps.getAgents
   * @param {(agentId) => object} deps.getActivityStore
   * @param {(agentId) => object|null} deps.getAgentById
   * @param {() => object} deps.listAgents - 列出所有 agent
   */
  constructor(deps) {
    this._d = deps;
    this._pendingModel = null;
    this._session = null;
    this._sessionStarted = false;
    this._sessions = new Map();
    this._headlessOps = new Set();
    this._titlesCache = new Map(); // sessionDir → { titles, ts }
    this._metaCache = new Map();   // metaPath → { data, ts }
    this._pendingPlanMode = false;
  }

  static _TITLES_TTL = 60_000; // 60 秒

  get session() { return this._session; }
  get sessionStarted() { return this._sessionStarted; }
  get sessions() { return this._sessions; }

  setPendingModel(model) { this._pendingModel = model; }
  get pendingModel() { return this._pendingModel; }

  get currentSessionPath() {
    return this._session?.sessionManager?.getSessionFile?.() ?? null;
  }

  // ── Session 创建 / 切换 ──

  async createSession(sessionMgr, cwd, memoryEnabled = true, model = null, { restore = false } = {}) {
    const t0 = Date.now();
    const effectiveCwd = cwd || this._d.getHomeCwd() || process.cwd();
    const agent = this._d.getAgent();
    const models = this._d.getModels();
    // restore 模式：不指定 model，让 PI SDK 从 JSONL 恢复（session model 单一数据源）
    const effectiveModel = restore ? null : (model || this._pendingModel || models.currentModel);
    this._pendingModel = null;
    log.log(`createSession cwd=${effectiveCwd} restore=${restore} (传入: ${cwd || "未指定"})`);

    if (!restore && !effectiveModel) {
      throw new Error(t("error.noAvailableModel"));
    }

    if (!sessionMgr) {
      sessionMgr = SessionManager.create(effectiveCwd, agent.sessionDir);
    }

    // 切换 session 级记忆状态后立即快照 prompt（下方 promptSnapshot）。
    const creatingAgent = agent;
    creatingAgent.setMemoryEnabled(memoryEnabled);

    const baseResourceLoader = this._d.getResourceLoader();
    const initialPlanMode = this._pendingPlanMode;
    this._pendingPlanMode = false;
    const sessionEntry = { planMode: initialPlanMode }; // pre-populated for resourceLoader proxy

    // 快照当前 system prompt，per-session 隔离。
    // 后续记忆编译、技能变更只影响新对话，已有对话的 prompt 不变（保护 prefix cache）。
    const promptSnapshot = agent.buildSystemPrompt();

    // Wrap resourceLoader: per-session prompt snapshot + plan mode injection
    const resourceLoader = Object.create(baseResourceLoader, {
      getSystemPrompt: {
        value: () => promptSnapshot,
      },
      getAppendSystemPrompt: {
        value: () => {
          const base = baseResourceLoader.getAppendSystemPrompt();
          const parts = [...base];

          // Plan mode prompt (existing logic, preserved verbatim)
          if (sessionEntry.planMode) {
            const isZh = String(this._d.getAgent().config?.locale || "").startsWith("zh");
            const planModePrompt = isZh
              ? "【系统通知】当前处于「只读模式」，用户在设置中关闭了「操作电脑」权限。你只能使用只读工具（read、grep、find、ls）和自定义工具。不能执行写入、编辑、删除等操作。如果用户要求你做这些操作，请告知当前处于只读模式，需要先在输入框旁的按钮开启「操作电脑」权限。"
              : "[System Notice] Currently in READ-ONLY MODE. The user has disabled 'Computer Access' in settings. You can only use read-only tools (read, grep, find, ls) and custom tools. You cannot write, edit, or delete. If the user asks for these operations, inform them that read-only mode is active and they need to enable 'Computer Access' via the button next to the input area.";
            parts.push(planModePrompt);
          }

          // Deferred result prompt (new)
          if (this._d.getDeferredResultStore?.()) {
            const isZh = String(this._d.getAgent()?.config?.locale || "").startsWith("zh");
            parts.push(isZh
              ? "收到 <hana-background-result> 标签中的内容时，这是后台任务完成的系统通知，不是用户发送的消息。请根据通知内容自然地告知用户任务结果。如果通知中包含文件路径，使用 stage_files 工具呈现给用户。"
              : "When you receive content inside <hana-background-result> tags, this is a system notification about a completed background task, NOT a user message. Respond naturally to inform the user about the task result. If file paths are included, use stage_files to present them to the user."
            );
          }

          return parts;
        },
      },
    });

    const { tools: sessionTools, customTools: sessionCustomTools } = this._d.buildTools(effectiveCwd, null, { workspace: this._d.getHomeCwd() });
    const sessionOpts = {
      cwd: effectiveCwd,
      sessionManager: sessionMgr,
      settingsManager: this._createSettings(effectiveModel),
      authStorage: models.authStorage,
      modelRegistry: models.modelRegistry,
      thinkingLevel: models.resolveThinkingLevel(this._d.getPrefs().getThinkingLevel()),
      resourceLoader,
      tools: sessionTools,
      customTools: sessionCustomTools,
    };
    // 新建 session 传 model；恢复 session 不传，让 PI SDK 从 JSONL 读取（单一数据源）
    if (effectiveModel) sessionOpts.model = effectiveModel;
    const { session, modelFallbackMessage } = await createAgentSession(sessionOpts);
    if (modelFallbackMessage) {
      log.warn(`session model fallback: ${modelFallbackMessage}`);
    }
    const resolvedModel = session.model;
    const elapsed = Date.now() - t0;
    log.log(`session created (${elapsed}ms), model=${resolvedModel?.name || effectiveModel?.name || "?"}`);
    this._session = session;
    this._sessionStarted = false;

    // 事件转发（附带 agentId，供订阅者按 agent 过滤）
    const sessionPath = session.sessionManager?.getSessionFile?.();
    const creatingAgentId = this._d.getActiveAgentId();
    const unsub = session.subscribe((event) => {
      this._d.emitEvent(
        event.agentId ? event : { ...event, agentId: creatingAgentId },
        sessionPath,
      );
    });

    // 存入 map（SessionEntry）— sessionEntry is the same object the resourceLoader proxy references
    const mapKey = sessionPath || `_anon_${Date.now()}`;
    const old = this._sessions.get(mapKey);
    if (old) old.unsub();

    Object.assign(sessionEntry, {
      session,
      agentId: this._d.getActiveAgentId(),
      memoryEnabled,
      modelId: resolvedModel?.id || effectiveModel?.id || null,
      modelProvider: resolvedModel?.provider || effectiveModel?.provider || null,
      lastTouchedAt: Date.now(),
      unsub,
    });
    this._sessions.set(mapKey, sessionEntry);

    // If plan mode was pending, apply tool restriction now
    if (initialPlanMode) {
      const agent = this._d.getAgent();
      const customNames = (agent.tools || []).map(t => t.name);
      session.setActiveToolsByName([...READ_ONLY_BUILTIN_TOOLS, ...customNames]);
    }

    // LRU 淘汰：按 lastTouchedAt 排序，跳过 streaming 和焦点 session
    if (this._sessions.size > MAX_CACHED_SESSIONS) {
      const focusPath = this.currentSessionPath;
      const candidates = [...this._sessions.entries()]
        .filter(([key, e]) => key !== mapKey && key !== focusPath && !e.session.isStreaming)
        .sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt);
      for (const [key, entry] of candidates) {
        // 记忆收尾（fire-and-forget，淘汰场景不阻塞）
        const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
        agent?._memoryTicker?.notifySessionEnd(key).catch(() => {});
        entry.unsub();
        this._d.getDeferredResultStore?.()?.clearBySession(key);
        this._sessions.delete(key);
        if (this._sessions.size <= MAX_CACHED_SESSIONS) break;
      }
    }

    return session;
  }

  async switchSession(sessionPath) {
    // 切到已有 session 时清空 pendingModel（用户的临时选择不应跟到别的 session）
    this._pendingModel = null;

    const targetAgentId = this._d.agentIdFromSessionPath(sessionPath);
    if (targetAgentId && targetAgentId !== this._d.getActiveAgentId()) {
      // Phase 1: 跨 agent 切换只切指针，不清旧 session
      await this._d.switchAgentOnly(targetAgentId);
    }

    // 从 session-meta.json 恢复记忆开关（model 由 PI SDK 从 JSONL 恢复，不在此处读取）
    let memoryEnabled = true;
    try {
      const metaPath = path.join(this._d.getAgent().sessionDir, "session-meta.json");
      const meta = await this._readMetaCached(metaPath);
      const sessKey = path.basename(sessionPath);
      const metaEntry = meta[sessKey];
      if (metaEntry?.memoryEnabled === false) memoryEnabled = false;
    } catch (err) {
      if (err.code !== "ENOENT") {
        log.warn(`session-meta.json 读取失败: ${err.message}`);
      }
    }

    // 如果已在 map 中，切指针
    const existing = this._sessions.get(sessionPath);
    if (existing) {
      if (this._session && this._session !== existing.session) {
        const oldSp = this._session.sessionManager?.getSessionFile?.();
        if (oldSp) {
          const oldEntry = this._sessions.get(oldSp);
          const oldAgent = oldEntry ? this._d.getAgentById(oldEntry.agentId) : this._d.getAgent();
          await oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch(() => {});
        }
      }
      this._session = existing.session;
      existing.lastTouchedAt = Date.now();
      const targetAgent = this._d.getAgentById(existing.agentId) || this._d.getAgent();
      targetAgent.setMemoryEnabled(memoryEnabled);
      return existing.session;
    }

    // 不在 map 中，先 flush 当前再新建
    if (this._session) {
      const oldSp = this._session.sessionManager?.getSessionFile?.();
      if (oldSp) {
        const oldEntry = this._sessions.get(oldSp);
        const oldAgent = oldEntry ? this._d.getAgentById(oldEntry.agentId) : this._d.getAgent();
        await oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch(() => {});
      }
    }
    // 冷启动恢复：model 由 PI SDK 从 session JSONL 恢复（单一数据源），不从 session-meta.json 读
    const sessionMgr = SessionManager.open(sessionPath, this._d.getAgent().sessionDir);
    const cwd = sessionMgr.getCwd?.() || undefined;
    return this.createSession(sessionMgr, cwd, memoryEnabled, null, { restore: true });
  }

  async prompt(text, opts) {
    if (!this._session) throw new Error(t("error.noActiveSessionPrompt"));
    this._sessionStarted = true;
    const sp = this._session.sessionManager?.getSessionFile?.();
    if (sp) {
      const entry = this._sessions.get(sp);
      if (entry) entry.lastTouchedAt = Date.now();
    }
    const promptOpts = opts?.images?.length ? { images: opts.images } : undefined;
    await this._session.prompt(text, promptOpts);
    if (sp) {
      const entry = this._sessions.get(sp);
      const agent = entry ? this._d.getAgentById(entry.agentId) : this._d.getAgent();
      agent?._memoryTicker?.notifyTurn(sp);
    }
  }

  async abort() {
    if (this._session?.isStreaming) {
      await this._session.abort();
    }
  }

  steer(text) {
    if (!this._session?.isStreaming) return false;
    const sp = this._session.sessionManager?.getSessionFile?.();
    if (sp) {
      const entry = this._sessions.get(sp);
      if (entry) entry.lastTouchedAt = Date.now();
    }
    this._session.steer(getSteerPrefix() + text);
    return true;
  }

  // ── Path 感知 API（Phase 2） ──

  async promptSession(sessionPath, text, opts) {
    const entry = this._sessions.get(sessionPath);
    if (!entry) throw new Error(t("error.sessionNotInCache", { path: sessionPath }));
    entry.lastTouchedAt = Date.now();
    if (sessionPath === this.currentSessionPath) this._sessionStarted = true;
    const promptOpts = opts?.images?.length ? { images: opts.images } : undefined;
    await entry.session.prompt(text, promptOpts);
    const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
    agent?._memoryTicker?.notifyTurn(sessionPath);
  }

  steerSession(sessionPath, text) {
    const entry = this._sessions.get(sessionPath);
    if (!entry?.session.isStreaming) return false;
    entry.lastTouchedAt = Date.now();
    entry.session.steer(getSteerPrefix() + text);
    return true;
  }

  async abortSession(sessionPath) {
    const entry = this._sessions.get(sessionPath);
    if (!entry?.session.isStreaming) return false;
    await entry.session.abort();
    return true;
  }

  /** Get plan mode for the current (focused) session */
  getPlanMode() {
    const sp = this.currentSessionPath;
    if (!sp) return this._pendingPlanMode;
    return this._sessions.get(sp)?.planMode ?? false;
  }

  /** Set plan mode for the current (focused) session */
  setPlanMode(enabled, allBuiltInTools) {
    const sp = this.currentSessionPath;

    // No session yet (welcome page) — store for when session is created
    if (!sp) {
      this._pendingPlanMode = !!enabled;
      this._d.emitEvent({ type: "plan_mode", enabled: this._pendingPlanMode }, null);
      this._d.emitDevLog(`Plan Mode: ${this._pendingPlanMode ? "ON (只读)" : "OFF (正常)"}`, "info");
      return;
    }

    const entry = this._sessions.get(sp);
    if (!entry) return;

    entry.planMode = !!enabled;
    const agent = this._d.getAgent();
    const customNames = (agent.tools || []).map(t => t.name);

    if (entry.planMode) {
      entry.session.setActiveToolsByName([...READ_ONLY_BUILTIN_TOOLS, ...customNames]);
    } else {
      const allNames = allBuiltInTools.map(t => t.name);
      entry.session.setActiveToolsByName([...allNames, ...customNames]);
    }

    this._d.emitEvent({ type: "plan_mode", enabled: entry.planMode }, sp);
    this._d.emitDevLog(`Plan Mode: ${entry.planMode ? "ON (只读)" : "OFF (正常)"}`, "info");
  }

  /** 获取当前焦点 session 的 modelId 快照 */
  getCurrentSessionModelId() {
    const sp = this.currentSessionPath;
    if (!sp) return null;
    return this._sessions.get(sp)?.modelId || null;
  }

  /** 获取当前焦点 session 的完整模型引用 {id, provider} */
  getCurrentSessionModelRef() {
    const sp = this.currentSessionPath;
    if (!sp) return null;
    const entry = this._sessions.get(sp);
    if (!entry) return null;
    // 从活跃 session 的实际模型对象获取
    if (this._session?.model) {
      return { id: this._session.model.id, provider: this._session.model.provider };
    }
    // fallback: 从 entry 的 modelId 字段（旧格式，无 provider）
    return entry.modelId ? { id: entry.modelId, provider: "" } : null;
  }

  /** 中断所有正在 streaming 的 session */
  async abortAllStreaming() {
    const tasks = [];
    for (const [sp, entry] of this._sessions) {
      if (entry.session.isStreaming) {
        tasks.push(entry.session.abort().catch(() => {}));
      }
    }
    await Promise.all(tasks);
    return tasks.length;
  }

  // ── Session 关闭 ──

  async closeSession(sessionPath) {
    const entry = this._sessions.get(sessionPath);
    if (entry) {
      const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
      agent?._memoryTicker?.notifySessionEnd(sessionPath).catch(() => {});
      if (entry.session.isStreaming) {
        try { await entry.session.abort(); } catch {}
      }
      entry.unsub();
      this._sessions.delete(sessionPath);

      // 清理该 session 的 pending confirmation
      this._d.getConfirmStore?.()?.abortBySession(sessionPath);
      this._d.getDeferredResultStore?.()?.clearBySession(sessionPath);
    }
    if (sessionPath === this.currentSessionPath) {
      this._session = null;
    }
  }

  async closeAllSessions() {
    // abort all streaming sessions + unsub（记忆收尾由 disposeAll 带超时处理）
    for (const [, entry] of this._sessions) {
      if (entry.session.isStreaming) {
        try { await entry.session.abort(); } catch {}
      }
      entry.unsub();
    }
    this._sessions.clear();
    this._session = null;
  }

  async cleanupSession() {
    await this.closeAllSessions();
    log.log("sessions cleaned up");
  }

  // ── Session 查询 ──

  getSessionByPath(sessionPath) {
    return this._sessions.get(sessionPath)?.session ?? null;
  }

  isSessionStreaming(sessionPath) {
    return !!this.getSessionByPath(sessionPath)?.isStreaming;
  }

  async abortSessionByPath(sessionPath) {
    const session = this.getSessionByPath(sessionPath);
    if (!session?.isStreaming) return false;
    await session.abort();
    return true;
  }

  async listSessions() {
    const agents = this._d.listAgents();

    // 并行处理每个 agent，避免串行同步 I/O 阻塞事件循环
    const perAgent = await Promise.all(agents.map(async (agent) => {
      const sessionDir = path.join(this._d.agentsDir, agent.id, "sessions");
      try { await fsp.access(sessionDir); } catch { return []; }
      try {
        const [sessions, titles, meta] = await Promise.all([
          SessionManager.list(process.cwd(), sessionDir),
          this._loadSessionTitlesFor(sessionDir),
          this._readMetaCached(path.join(sessionDir, "..", "session-meta.json")),
        ]);
        for (const s of sessions) {
          if (titles[s.path]) s.title = titles[s.path];
          s.agentId = agent.id;
          s.agentName = agent.name;
          const sessKey = path.basename(s.path);
          const metaEntry = meta[sessKey];
          // 读取新格式 model:{id,provider} 或旧格式 modelId
          if (metaEntry?.model && typeof metaEntry.model === "object") {
            s.modelId = metaEntry.model.id || null;
          } else {
            s.modelId = metaEntry?.modelId || null;
          }
        }
        return sessions;
      } catch { return []; }
    }));
    const allSessions = perAgent.flat();

    const currentPath = this.currentSessionPath;
    const activeAgentId = this._d.getActiveAgentId();
    if (currentPath && this._sessionStarted && !allSessions.find(s => s.path === currentPath)) {
      const currentEntry = this._sessions.get(currentPath);
      allSessions.unshift({
        path: currentPath,
        title: null,
        firstMessage: "",
        modified: new Date(),
        messageCount: 0,
        cwd: this._session?.sessionManager?.getCwd?.() || "",
        agentId: activeAgentId,
        agentName: this._d.getAgent().agentName,
        modelId: currentEntry?.modelId || null,
      });
    }

    allSessions.sort((a, b) => b.modified - a.modified);
    return allSessions;
  }

  async saveSessionTitle(sessionPath, title) {
    const agentId = this._d.agentIdFromSessionPath(sessionPath);
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : this._d.getAgent().sessionDir;
    const titlePath = path.join(sessionDir, "session-titles.json");
    const titles = await this._loadSessionTitlesFor(sessionDir);
    titles[sessionPath] = title;
    await fsp.writeFile(titlePath, JSON.stringify(titles, null, 2), "utf-8");
    // 更新缓存
    this._titlesCache.set(sessionDir, { titles: { ...titles }, ts: Date.now() });
  }

  async getTitlesForPaths(paths) {
    const titles = {};
    for (const p of paths) titles[p] = null;

    const byDir = new Map();
    for (const p of paths) {
      const dir = path.dirname(p);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(p);
    }

    for (const [dir, sessionPaths] of byDir) {
      try {
        const dirTitles = await this._loadSessionTitlesFor(dir);
        for (const sp of sessionPaths) {
          if (dirTitles[sp]) titles[sp] = dirTitles[sp];
        }
      } catch { /* ignore */ }
    }

    return titles;
  }

  async _loadSessionTitlesFor(sessionDir) {
    const cached = this._titlesCache.get(sessionDir);
    if (cached && Date.now() - cached.ts < SessionCoordinator._TITLES_TTL) {
      return { ...cached.titles };
    }
    try {
      const raw = await fsp.readFile(path.join(sessionDir, "session-titles.json"), "utf-8");
      const titles = JSON.parse(raw);
      this._titlesCache.set(sessionDir, { titles, ts: Date.now() });
      return { ...titles };
    } catch {
      this._titlesCache.set(sessionDir, { titles: {}, ts: Date.now() });
      return {};
    }
  }

  /** 异步读取 session-meta.json，带 TTL 缓存 */
  async _readMetaCached(metaPath) {
    const cached = this._metaCache.get(metaPath);
    if (cached && Date.now() - cached.ts < SessionCoordinator._TITLES_TTL) {
      return cached.data;
    }
    try {
      const raw = await fsp.readFile(metaPath, "utf-8");
      const data = JSON.parse(raw);
      this._metaCache.set(metaPath, { data, ts: Date.now() });
      return data;
    } catch {
      return {};
    }
  }

  /** session-meta 写入后清除对应缓存 */
  invalidateMetaCache(metaPath) {
    this._metaCache.delete(metaPath);
  }

  // ── Session Context ──

  createSessionContext() {
    const models = this._d.getModels();
    const skills = this._d.getSkills();
    return {
      authStorage:    models.authStorage,
      modelRegistry:  models.modelRegistry,
      resourceLoader: this._d.getResourceLoader(),
      allSkills:      skills.allSkills,
      getSkillsForAgent: (ag) => skills.getSkillsForAgent(ag),
      buildTools:     (cwd, customTools, opts) => this._d.buildTools(cwd, customTools, opts),
      resolveModel:   (agentConfig) => {
        const chatRef = agentConfig?.models?.chat;
        const id = typeof chatRef === "object" ? chatRef?.id : chatRef;
        const provider = typeof chatRef === "object" ? chatRef?.provider : undefined;
        // 非 active agent 可能没有配 models.chat（模板默认为空），回退到全局默认模型
        if (!id) {
          if (models.defaultModel) {
            log.log(`[resolveModel] agentConfig 未指定 models.chat，回退到默认模型 ${models.defaultModel.id}`);
            return models.defaultModel;
          }
          log.error(`[resolveModel] agentConfig 未指定 models.chat，也没有默认模型`);
          throw new Error(t("error.resolveModelNoChatModel"));
        }
        const found = findModel(models.availableModels, id, provider);
        if (!found) {
          // 模型 ID 在可用列表中找不到，尝试回退到默认模型
          if (models.defaultModel) {
            log.log(`[resolveModel] 模型 "${id}" 不在可用列表中，回退到默认模型 ${models.defaultModel.id}`);
            return models.defaultModel;
          }
          const available = models.availableModels.map(m => `${m.provider}/${m.id}`).join(", ");
          const hasAuth = models.modelRegistry
            ? `hasAuth("${models.inferModelProvider?.(id) || "?"}")=unknown`
            : "no registry";
          log.error(`[resolveModel] 找不到模型 "${id}"。availableModels=[${available}]。${hasAuth}`);
          throw new Error(t("error.resolveModelNotAvailable", { id }));
        }
        return found;
      },
    };
  }

  promoteActivitySession(activitySessionFile) {
    const agent = this._d.getAgent();
    const oldPath = path.join(agent.agentDir, "activity", activitySessionFile);
    if (!fs.existsSync(oldPath)) return null;

    const newPath = path.join(agent.sessionDir, activitySessionFile);
    try {
      fs.renameSync(oldPath, newPath);
      agent._memoryTicker?.notifyPromoted(newPath);
      log.log(`promoted activity session: ${activitySessionFile}`);
      return newPath;
    } catch (err) {
      log.error(`promoteActivitySession failed: ${err.message}`);
      return null;
    }
  }

  // ── Isolated Execution ──

  async executeIsolated(prompt, opts = {}) {
    const targetAgent = opts.agentId ? this._d.getAgentById(opts.agentId) : this._d.getAgent();
    if (!targetAgent) throw new Error(t("error.agentNotInitialized", { id: opts.agentId }));

    // abort signal：提前中止检查
    if (opts.signal?.aborted) {
      return { sessionPath: null, replyText: "", error: "aborted" };
    }

    const bm = BrowserManager.instance();
    const wasBrowserRunning = bm.isRunning;
    const opId = `iso_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this._headlessOps.add(opId);
    if (this._headlessOps.size === 1) bm.setHeadless(true);
    let tempSessionMgr;
    const cleanupTempSession = () => {
      const sp = tempSessionMgr?.getSessionFile?.();
      if (sp) {
        try { fs.unlinkSync(sp); } catch {}
      }
    };
    try {
      const sessionDir = opts.persist || path.join(targetAgent.agentDir, '.ephemeral');
      fs.mkdirSync(sessionDir, { recursive: true });

      const execCwd = opts.cwd || this._d.getHomeCwd() || process.cwd();
      const models = this._d.getModels();
      const agentPreferredRef = targetAgent.config?.models?.chat;
      const modelId = opts.model ? null
        : (typeof agentPreferredRef === "object" ? agentPreferredRef?.id : agentPreferredRef);
      const modelProvider = opts.model ? undefined
        : (typeof agentPreferredRef === "object" ? agentPreferredRef?.provider : undefined);
      let resolvedModel = opts.model;
      if (!resolvedModel) {
        if (modelId) {
          resolvedModel = findModel(models.availableModels, modelId, modelProvider);
        }
        if (!resolvedModel) {
          // agent 未配 models.chat 或配置的模型不在可用列表：fallback 到当前默认模型
          resolvedModel = models.defaultModel;
        }
        if (!resolvedModel) {
          log.error(`[executeIsolated] agent "${targetAgent.agentName}" 未指定 models.chat，也没有可用的默认模型`);
          throw new Error(t("error.executeIsolatedNoModel", { name: targetAgent.agentName }));
        }
        if (modelId && resolvedModel.id !== modelId) {
          log.log(`[executeIsolated] 模型 "${modelId}" 不可用，fallback → ${resolvedModel.id}`);
        }
      }
      const execModel = models.resolveExecutionModel(resolvedModel);
      tempSessionMgr = SessionManager.create(execCwd, sessionDir);
      const { tools: allBuiltinTools, customTools: allCustomTools } = this._d.buildTools(
        execCwd, targetAgent.tools, { agentDir: targetAgent.agentDir, workspace: this._d.getHomeCwd() }
      );

      const patrolAllowed = opts.toolFilter
        || targetAgent.config?.desk?.patrol_tools
        || PATROL_TOOLS_DEFAULT;
      // "*" = allow all custom tools (subagent needs plugin query tools)
      const actCustomTools = patrolAllowed === "*"
        ? allCustomTools
        : allCustomTools.filter(t => new Set(patrolAllowed).has(t.name));

      // builtin tools 过滤：传入 builtinFilter 时只保留白名单内的 builtin 工具
      const actTools = opts.builtinFilter
        ? allBuiltinTools.filter(t => opts.builtinFilter.includes(t.name))
        : allBuiltinTools;

      const agent = this._d.getAgent();
      const skills = this._d.getSkills();
      const resourceLoader = this._d.getResourceLoader();
      // 快照 prompt，隔离于其他 session 的 prompt 变更
      const isolatedPrompt = targetAgent.systemPrompt;
      const execResourceLoader = (targetAgent === agent)
        ? Object.create(resourceLoader, {
            getSystemPrompt: { value: () => isolatedPrompt },
          })
        : Object.create(resourceLoader, {
            getSystemPrompt: { value: () => isolatedPrompt },
            getSkills: { value: () => skills.getSkillsForAgent(targetAgent) },
          });

      const { session } = await createAgentSession({
        cwd: execCwd,
        sessionManager: tempSessionMgr,
        settingsManager: this._createSettings(execModel),
        authStorage: models.authStorage,
        modelRegistry: models.modelRegistry,
        model: execModel,
        thinkingLevel: models.resolveThinkingLevel(this._d.getPrefs().getThinkingLevel()),
        resourceLoader: execResourceLoader,
        tools: actTools,
        customTools: actCustomTools,
      });

      let replyText = "";
      const unsub = session.subscribe((event) => {
        if (event.type === "message_update") {
          const sub = event.assistantMessageEvent;
          if (sub?.type === "text_delta") {
            replyText += sub.delta || "";
          }
        }
      });

      // abort signal：监听中止，转发到子 session
      const abortHandler = () => session.abort();
      opts.signal?.addEventListener("abort", abortHandler, { once: true });

      // 二次检查：覆盖初始化期间 signal 已变 aborted 的竞争窗口
      if (opts.signal?.aborted) {
        opts.signal.removeEventListener("abort", abortHandler);
        unsub?.();
        cleanupTempSession();
        return { sessionPath: null, replyText: "", error: "aborted" };
      }

      try {
        await session.prompt(prompt);
      } finally {
        opts.signal?.removeEventListener("abort", abortHandler);
        unsub?.();
      }

      const sessionPath = session.sessionManager?.getSessionFile?.() || null;

      if (!opts.persist && sessionPath) {
        try { fs.unlinkSync(sessionPath); } catch {}
        return { sessionPath: null, replyText, error: null };
      }

      return { sessionPath, replyText, error: null };
    } catch (err) {
      log.error(`isolated execution failed: ${err.message}`);
      // 清理失败的临时 session 文件
      if (!opts.persist && tempSessionMgr) {
        cleanupTempSession();
      }
      return { sessionPath: null, replyText: "", error: err.message };
    } finally {
      this._headlessOps.delete(opId);
      if (this._headlessOps.size === 0) bm.setHeadless(false);
      const browserNowRunning = bm.isRunning;
      if (browserNowRunning !== wasBrowserRunning) {
        this._d.emitEvent({ type: "browser_bg_status", running: browserNowRunning, url: bm.currentUrl }, null);
      }
    }
  }

  /** 创建 session 专用 settings（控制 compaction + max_completion_tokens） */
  _createSettings(model) {
    return createDefaultSettings();
  }
}
