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
import { createAgentSession, SessionManager, estimateTokens, findCutPoint, generateSummary, emitSessionShutdown, refreshSessionModelFromRegistry } from "../lib/pi-sdk/index.js";
import { createDefaultSettings } from "./session-defaults.js";
import { computeHardTruncation } from "./compaction-utils.js";
import { createModuleLogger } from "../lib/debug-log.js";
import { BrowserManager } from "../lib/browser/browser-manager.js";
import { t, getLocale } from "../server/i18n.js";
import { READ_ONLY_BUILTIN_TOOLS } from "./config-coordinator.js";
import { findModel } from "../shared/model-ref.js";
import { computeToolSnapshot, DEFAULT_DISABLED_TOOL_NAMES } from "../shared/tool-categories.js";

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
   * @param {(cwd: string) => Promise<void>} [deps.onBeforeSessionCreate]
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
    this._metaWriteQueue = Promise.resolve();
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
    const agent = this._d.getAgent();
    const effectiveCwd = cwd || this._d.getHomeCwd(agent.id) || process.cwd();
    const models = this._d.getModels();
    // restore 模式：不指定 model，让 PI SDK 从 JSONL 恢复（session model 单一数据源）
    const effectiveModel = restore ? null : (model || this._pendingModel || models.currentModel);
    this._pendingModel = null;
    log.log(`createSession cwd=${effectiveCwd} restore=${restore} (传入: ${cwd || "未指定"})`);

    await this._d.onBeforeSessionCreate?.(effectiveCwd);

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

          // 后台任务行为引导
          if (this._d.getDeferredResultStore?.()) {
            const isZh = String(this._d.getAgent()?.config?.locale || "").startsWith("zh");
            parts.push(isZh
              ? `## 后台任务

派出 subagent 或其他后台任务后：

1. 先继续做手头还没做完的工作，不要立刻停下来等
2. 手头工作做完后，调 check_pending_tasks 查看后台任务状态
3. 如果还有任务未完成，根据任务复杂度自行估算等待时间，调 wait 等待后再查。最多查 2 次，之后不再轮询，告知用户任务仍在后台运行，完成后会自动通知
4. 后台任务完成时系统也会以 <hana-background-result> 消息自动送达结果，届时处理并告知用户`
              : `## Background Tasks

After dispatching subagent or other background tasks:

1. Continue with any remaining work first — do not stop immediately to wait
2. Once your other work is done, call check_pending_tasks to check status
3. If tasks are still pending, estimate a reasonable wait time based on task complexity, then call wait and check again. Check at most 2 times — after that, stop polling and inform the user the task is still running and they will be notified when it completes
4. The system will also automatically deliver results via <hana-background-result> messages when tasks finish — process and relay them to the user`
            );
          }

          return parts;
        },
      },
    });

    const { tools: sessionTools, customTools: sessionCustomTools } = this._d.buildTools(effectiveCwd, agent.tools, { workspace: this._d.getHomeCwd(agent.id), agentDir: agent.agentDir });
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

    // ── Tool snapshot for session-tool-isolation (parallels session-model-isolation) ──
    // Three branches:
    //   A. restore=true + meta has toolNames  → replay the snapshot (applied below)
    //   B. restore=true + meta missing        → legacy session, keep all tools
    //   C. restore=false                       → fresh compute from agent config
    //
    // allToolNames must cover the COMPLETE active set: Pi SDK built-ins
    // (read/bash/edit/write/grep/find/ls) from sessionTools + OpenHanako
    // customs + plugin tools from sessionCustomTools. Using only agent.tools
    // would silently drop SDK built-ins and plugin tools when
    // setActiveToolsByName is applied.
    const allToolNames = [
      ...(sessionTools || []).map((t) => t.name).filter(Boolean),
      ...(sessionCustomTools || []).map((t) => t.name).filter(Boolean),
    ];
    let snapshotToolNames = null;  // null signals "do not call setActiveToolsByName"

    if (restore) {
      if (sessionPath) {
        const metaPathForRestore = path.join(agent.sessionDir, "session-meta.json");
        let metaEntry = null;
        let metaReadFailed = false;
        try {
          const raw = await fsp.readFile(metaPathForRestore, "utf-8");
          const meta = JSON.parse(raw);
          metaEntry = meta[path.basename(sessionPath)];
        } catch (err) {
          if (err.code !== "ENOENT") {
            metaReadFailed = true;
            log.warn(`session-meta read for tool-snapshot restore failed, recomputing from current agent config: ${err.message}`);
          }
        }
        if (metaEntry && Array.isArray(metaEntry.toolNames)) {
          snapshotToolNames = metaEntry.toolNames;  // Case A
        } else if (metaReadFailed) {
          // Fallback when meta file exists but is unreadable/corrupt: recompute
          // the snapshot from current agent config. Safer than silent Case B
          // (which would re-enable every disabled tool). Cannot perfectly
          // preserve the historical snapshot, but honors the user's current
          // disabled-tool intent.
          const disabled = agent.config?.tools?.disabled ?? DEFAULT_DISABLED_TOOL_NAMES;
          snapshotToolNames = computeToolSnapshot(allToolNames, disabled);
        }
        // else Case B (meta absent via ENOENT): snapshotToolNames stays null
      }
    } else {
      // Case C. Fresh agents (and agents upgrading from a pre-feature version)
      // have no tools.disabled field — apply DEFAULT_DISABLED_TOOL_NAMES so
      // update_settings and dm are off by default. Explicit `[]` means "all on"
      // and is preserved via nullish-coalescing rather than `||`.
      const disabled = agent.config?.tools?.disabled ?? DEFAULT_DISABLED_TOOL_NAMES;
      snapshotToolNames = computeToolSnapshot(allToolNames, disabled);
    }

    Object.assign(sessionEntry, {
      session,
      agentId: this._d.getActiveAgentId(),
      memoryEnabled,
      modelId: resolvedModel?.id || effectiveModel?.id || null,
      modelProvider: resolvedModel?.provider || effectiveModel?.provider || null,
      toolNames: snapshotToolNames,  // null for legacy sessions (Case B), array otherwise
      lastTouchedAt: Date.now(),
      unsub,
    });
    this._sessions.set(mapKey, sessionEntry);

    // Plan mode restricts to read-only SDK tools + custom tools. When a session
    // has a tool snapshot (Case A/C), intersect with it so user-disabled optional
    // tools stay disabled in plan mode too. Legacy sessions (Case B) fall back to
    // the full custom tool list since they have no snapshot to honor.
    if (initialPlanMode) {
      const customBase = snapshotToolNames !== null
        ? snapshotToolNames.filter((n) => !READ_ONLY_BUILTIN_TOOLS.includes(n))
        : (agent.tools || []).map((t) => t.name).filter(Boolean);
      session.setActiveToolsByName([...READ_ONLY_BUILTIN_TOOLS, ...customBase]);
    }

    // Apply tool snapshot (Case A / Case C). Plan mode already ran above and
    // intersected with the snapshot, so this branch is skipped in plan mode to
    // avoid clobbering plan mode's restricted list. Case B leaves
    // snapshotToolNames === null so this branch is a no-op and the session
    // keeps all tools.
    if (!initialPlanMode && snapshotToolNames !== null) {
      session.setActiveToolsByName(snapshotToolNames);
    }

    // Persist snapshot for Case C only. Case A already had it in meta; Case B
    // intentionally leaves meta untouched (adding a toolNames field to a legacy
    // session's meta would lock it into the current tool list, breaking
    // "upgrade is zero-noise"). writeSessionMeta is serialized and never
    // rejects; awaiting gives createSession a clean post-return state.
    if (!restore && snapshotToolNames !== null && sessionPath) {
      await this.writeSessionMeta(sessionPath, { toolNames: snapshotToolNames });
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
        agent?._memoryTicker?.notifySessionEnd(key).catch((err) =>
          log.warn(`LRU 淘汰 ${path.basename(key)}: notifySessionEnd failed: ${err.message}`),
        );
        await this._teardownSessionEntry(entry, key, "lru");
        this._d.getDeferredResultStore?.()?.clearBySession(key);
        this._sessions.delete(key);
        if (this._sessions.size <= MAX_CACHED_SESSIONS) break;
      }
    }

    return { session, sessionPath: sessionPath || mapKey, agentId: creatingAgentId };
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
          await oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch((err) =>
            log.warn(`switchSession ${path.basename(oldSp)}: notifySessionEnd failed: ${err.message}`),
          );
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
        await oldAgent?._memoryTicker?.notifySessionEnd(oldSp).catch((err) =>
          log.warn(`switchSession ${path.basename(oldSp)}: notifySessionEnd failed: ${err.message}`),
        );
      }
    }
    // 冷启动恢复：model 由 PI SDK 从 session JSONL 恢复（单一数据源），不从 session-meta.json 读
    const sessionMgr = SessionManager.open(sessionPath, this._d.getAgent().sessionDir);
    const cwd = sessionMgr.getCwd?.() || undefined;
    const result = await this.createSession(sessionMgr, cwd, memoryEnabled, null, { restore: true });
    return result.session;
  }

  async prompt(text, opts) {
    if (!this._session) throw new Error(t("error.noActiveSessionPrompt"));
    this._sessionStarted = true;
    const sp = this._session.sessionManager?.getSessionFile?.();
    if (sp) {
      const entry = this._sessions.get(sp);
      if (entry) entry.lastTouchedAt = Date.now();
    }
    // 非 vision 模型：静默剥离图片（vision 未知则放行，让 API 决定）
    if (opts?.images?.length && this._session.model?.vision === false) {
      opts = { ...opts, images: undefined };
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
    // 非 vision 模型：静默剥离图片（vision 未知则放行，让 API 决定）
    if (opts?.images?.length && entry.session.model?.vision === false) {
      opts = { ...opts, images: undefined };
    }
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

  // ── Mid-session model switch ──

  /**
   * 在已有 session 上切换模型（不创建新 session）。
   * 如果新模型的上下文窗口容不下当前对话，先压缩/截断。
   *
   * @param {string} sessionPath
   * @param {object} newModel - Pi SDK Model 对象
   * @returns {Promise<{ adaptations: string[] }>}
   */
  async switchSessionModel(sessionPath, newModel) {
    const entry = this._sessions.get(sessionPath);
    if (!entry) throw new Error(t("error.sessionNotInCache", { path: sessionPath }));

    const { session } = entry;

    // 并发 guard
    if (entry._switching) {
      throw new Error("Model switch already in progress for this session");
    }
    if (session.isCompacting) {
      throw new Error("Cannot switch model while compaction is in progress");
    }

    entry._switching = true;
    const adaptations = [];
    const oldModel = session.model;

    try {
      // 估算当前上下文 token 数
      const msgs = session.agent?.state?.messages || [];
      const usage = session.getContextUsage?.();
      let currentTokens = usage?.tokens;
      if (currentTokens == null) {
        // fallback: 逐消息估算
        currentTokens = msgs.reduce((sum, m) => sum + estimateTokens(m), 0);
      }

      const effectiveWindow = Math.floor(newModel.contextWindow * 0.9) - 4000;

      if (currentTokens > effectiveWindow) {
        // 预检：最后一轮对话是否本身就超窗口（此时 compact/truncate 都救不了）
        const lastUserIdx = msgs.findLastIndex(m => m.role === "user");
        if (lastUserIdx >= 0) {
          const lastTurnTokens = msgs.slice(lastUserIdx).reduce((s, m) => s + estimateTokens(m), 0);
          if (lastTurnTokens > effectiveWindow) {
            throw new Error("当前对话无法适配目标模型的上下文窗口");
          }
        }

        // 尝试压缩
        try {
          await this._compactWithModel(session, effectiveWindow, oldModel);
          adaptations.push("compacted");
        } catch (compactErr) {
          log.warn(`compactWithModel failed, falling back to hard truncate: ${compactErr.message}`);
          // 压缩失败，尝试硬截断
          try {
            await this._hardTruncate(session, effectiveWindow);
            adaptations.push("truncated");
          } catch (truncErr) {
            throw new Error(`Failed to fit context into new model window: ${truncErr.message}`);
          }
        }

        // 终极检查：压缩/截断后仍然超窗口则拒绝
        const postMsgs = session.agent.state.messages;
        const postTokens = postMsgs.reduce((sum, m) => sum + estimateTokens(m), 0);
        if (postTokens > effectiveWindow) {
          throw new Error(
            `Context still exceeds new model window after adaptation (${postTokens} > ${effectiveWindow})`
          );
        }
      }

      // 执行模型切换
      await session.setModel(newModel);
      entry.modelId = newModel.id;
      entry.modelProvider = newModel.provider;

      return { adaptations };
    } finally {
      entry._switching = false;
    }
  }

  /**
   * 用 LLM 生成摘要来压缩对话历史（为 model switch 准备窗口）。
   * @private
   */
  async _compactWithModel(session, effectiveWindow, model) {
    const sm = session.sessionManager;
    const pathEntries = sm.getBranch();

    // keepRecentTokens = effectiveWindow：保留尽可能多的近期上下文
    const keepRecentTokens = effectiveWindow;

    // 找到有 message 的 entry 的范围
    const messageEntries = pathEntries.filter(e => e.type === "message");
    if (messageEntries.length < 2) {
      throw new Error("Not enough messages to compact");
    }

    // findCutPoint 操作的是 JSONL path entries
    const startIndex = 0;
    const endIndex = pathEntries.length;
    const cutResult = findCutPoint(pathEntries, startIndex, endIndex, keepRecentTokens);

    const { firstKeptEntryIndex, turnStartIndex, isSplitTurn } = cutResult;

    // split-turn 时使用 turnStartIndex 避免 assistant 与 user prompt 分离
    const effectiveCutIndex = isSplitTurn ? turnStartIndex : firstKeptEntryIndex;

    if (effectiveCutIndex <= 0) {
      throw new Error("Cut point at beginning — nothing to compact");
    }

    // 收集要摘要的消息（从 pathEntries[i].message，非 agent.state.messages）
    const messagesToSummarize = [];
    for (let i = 0; i < effectiveCutIndex; i++) {
      if (pathEntries[i].type === "message" && pathEntries[i].message) {
        messagesToSummarize.push(pathEntries[i].message);
      }
    }

    if (messagesToSummarize.length === 0) {
      throw new Error("No messages to summarize before cut point");
    }

    // 链接之前的 compaction summary
    let previousSummary;
    for (const entry of pathEntries) {
      if (entry.type === "compaction" && entry.summary) {
        previousSummary = entry.summary;
      }
    }

    // 获取 API key
    const models = this._d.getModels();
    const auth = await models.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      throw new Error(`Auth failed for model ${model.id}: ${auth.error}`);
    }
    if (!auth.apiKey) {
      throw new Error(`No API key for provider ${model.provider}`);
    }

    // 计算压缩前 token 数
    const tokensBefore = messagesToSummarize.reduce((sum, m) => sum + estimateTokens(m), 0);

    // 保留 token 数给摘要本身
    const reserveTokens = 4000;

    // 生成摘要
    const summary = await generateSummary(
      messagesToSummarize,
      model,
      reserveTokens,
      auth.apiKey,
      auth.headers,
      undefined,        // signal
      undefined,        // customInstructions
      previousSummary,
    );

    // firstKeptEntryId 是要保留的第一个 entry 的 id
    const firstKeptEntryId = pathEntries[effectiveCutIndex].id;

    // 持久化
    sm.appendCompaction(summary, firstKeptEntryId, tokensBefore, {});

    // 重建上下文
    const ctx = sm.buildSessionContext();
    session.agent.replaceMessages(ctx.messages);
  }

  /**
   * 硬截断对话历史（无 API 调用，用固定文本作为摘要）。
   * @private
   */
  async _hardTruncate(session, effectiveWindow) {
    const sm = session.sessionManager;
    const pathEntries = sm.getBranch();

    const result = computeHardTruncation(pathEntries, effectiveWindow, {
      summary: "[由于模型切换，早期对话历史已被截断]",
      reason: "model-switch-truncation",
    });
    if (!result) {
      throw new Error("Cannot hard-truncate: not enough messages or cut at beginning");
    }

    sm.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details);

    const ctx = sm.buildSessionContext();
    session.agent.replaceMessages(ctx.messages);
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
    const allBuiltInNames = allBuiltInTools.map((t) => t.name);

    // Respect the session's tool snapshot so toggling plan mode preserves the
    // user's disabled-tool choice. Strip SDK built-in names from the snapshot
    // because we re-prepend either READ_ONLY_BUILTIN_TOOLS (plan ON) or the
    // full built-in list (plan OFF). Legacy sessions (Case B) have
    // toolNames = null and fall back to the unfiltered agent.tools list.
    const customBase = entry.toolNames != null
      ? entry.toolNames.filter((n) => !allBuiltInNames.includes(n))
      : (agent.tools || []).map((t) => t.name).filter(Boolean);

    if (entry.planMode) {
      entry.session.setActiveToolsByName([...READ_ONLY_BUILTIN_TOOLS, ...customBase]);
    } else {
      entry.session.setActiveToolsByName([...allBuiltInNames, ...customBase]);
    }

    this._d.emitEvent({ type: "plan_mode", enabled: entry.planMode }, sp);
    this._d.emitDevLog(`Plan Mode: ${entry.planMode ? "ON (只读)" : "OFF (正常)"}`, "info");
  }

  /**
   * 获取当前焦点 session 的完整模型引用 {id, provider}。
   *
   * 数据源：entry 的 modelId + modelProvider 字段（session 创建和 switchSessionModel
   * 时成对写入）。找不到 provider（意味着 session 未完整初始化）返回 null——
   * 禁止按单 id 降级。
   */
  getCurrentSessionModelRef() {
    const sp = this.currentSessionPath;
    if (!sp) return null;
    const entry = this._sessions.get(sp);
    if (!entry?.modelId || !entry?.modelProvider) return null;
    return { id: entry.modelId, provider: entry.modelProvider };
  }

  /** 中断所有正在 streaming 的 session */
  async abortAllStreaming() {
    const tasks = [];
    for (const [sp, entry] of this._sessions) {
      if (entry.session.isStreaming) {
        tasks.push(
          entry.session.abort().catch((err) =>
            log.warn(`abortAllStreaming ${path.basename(sp)}: abort failed: ${err.message}`),
          ),
        );
      }
    }
    await Promise.all(tasks);
    return tasks.length;
  }

  // ── Lifecycle teardown (统一入口) ──

  /**
   * 释放一个 sessionEntry 的所有资源。
   *
   * 三步契约:
   *   1. emit session_shutdown — 让 SDK 扩展清理 setInterval / store 订阅
   *   2. unsub — 取消 Hanako 层的 session 事件转发
   *   3. session.dispose — 让 SDK 释放 agent 订阅和 event listeners
   *
   * 任何一步失败都 log.warn 并继续下一步, 保证下游资源一定被释放。
   *
   * 契约背景: SDK 的 AgentSession.dispose() 本身不 emit session_shutdown,
   * 消费方必须显式 emit, 否则 deferred-result-ext 的 30 秒 setInterval
   * 永远不会被清理。
   *
   * @param {object} entry - sessionEntry (session, unsub, agentId, ...)
   * @param {string} sessionPath - 用于日志识别
   * @param {string} reason - teardown 原因 (lru / close / close_all / isolated)
   * @private
   */
  async _teardownSessionEntry(entry, sessionPath, reason) {
    if (!entry) return;
    const spShort = sessionPath ? path.basename(sessionPath) : "(anon)";

    // 1. emit session_shutdown
    try {
      if (entry.session) {
        await emitSessionShutdown(entry.session);
      }
    } catch (err) {
      log.warn(`teardown[${reason}] ${spShort}: emitSessionShutdown failed: ${err.message}`);
    }

    // 2. unsub
    try {
      entry.unsub?.();
    } catch (err) {
      log.warn(`teardown[${reason}] ${spShort}: unsub failed: ${err.message}`);
    }

    // 3. session.dispose
    try {
      entry.session?.dispose?.();
    } catch (err) {
      log.warn(`teardown[${reason}] ${spShort}: session.dispose failed: ${err.message}`);
    }
  }

  // ── Session 关闭 ──

  async closeSession(sessionPath) {
    const entry = this._sessions.get(sessionPath);
    if (entry) {
      const agent = this._d.getAgentById(entry.agentId) || this._d.getAgent();
      agent?._memoryTicker?.notifySessionEnd(sessionPath).catch((err) =>
        log.warn(`closeSession ${path.basename(sessionPath)}: notifySessionEnd failed: ${err.message}`),
      );
      if (entry.session.isStreaming) {
        try { await entry.session.abort(); }
        catch (err) { log.warn(`closeSession ${path.basename(sessionPath)}: abort failed: ${err.message}`); }
      }
      await this._teardownSessionEntry(entry, sessionPath, "close");
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
    // abort all streaming sessions + teardown（记忆收尾由 disposeAll 带超时处理）
    for (const [sessionPath, entry] of this._sessions) {
      if (entry.session.isStreaming) {
        try { await entry.session.abort(); }
        catch (err) { log.warn(`closeAllSessions ${path.basename(sessionPath)}: abort failed: ${err.message}`); }
      }
      await this._teardownSessionEntry(entry, sessionPath, "close_all");
      // sidecar cleanup: 与 closeSession 保持语义一致
      // pending confirmation 必须 abort, pending deferred task 必须 clear
      this._d.getConfirmStore?.()?.abortBySession(sessionPath);
      this._d.getDeferredResultStore?.()?.clearBySession(sessionPath);
    }
    this._sessions.clear();
    this._session = null;
  }

  async cleanupSession() {
    await this.closeAllSessions();
    log.log("sessions cleaned up");
  }

  /**
   * Provider 配置变更后，强制所有 active session 从 ModelRegistry 重新解析
   * 当前 model 对象。
   *
   * 必要性：Pi SDK 把 baseUrl 烤在 model 对象字段里，session 持的是创建时
   * 的对象引用。Hanako 这边 ModelRegistry.refresh() 之后会重建模型对象，
   * 但 session 还指向旧对象——下一个 turn 仍用旧 baseUrl 发请求。
   * 本方法由 engine.onProviderChanged() 触发。
   */
  refreshAllSessionsModels() {
    for (const entry of this._sessions.values()) {
      try {
        refreshSessionModelFromRegistry(entry.session);
      } catch (err) {
        log.warn(`refreshAllSessionsModels: ${err.message}`);
      }
    }
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
          // 读取新格式 model:{id,provider}；老格式（只有 modelId）视为无 provider，
          // 调用方必须接受 modelProvider 可能为 null。
          if (metaEntry?.model && typeof metaEntry.model === "object") {
            s.modelId = metaEntry.model.id || null;
            s.modelProvider = metaEntry.model.provider || null;
          } else {
            s.modelId = metaEntry?.modelId || null;
            s.modelProvider = null;
          }
        }
        return sessions;
      } catch (err) {
        // 显式日志：之前静默吞错会让用户看到「对话框列表为空」却没有任何线索 (#414)
        log.warn(`listSessions: agent="${agent.id}" sessionDir="${sessionDir}" failed: ${err?.message || err}`);
        return [];
      }
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
        modelProvider: currentEntry?.modelProvider || null,
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

  /**
   * Single entry point for all session-meta.json writes. Both the memory-toggle
   * path (persistSessionMeta) and the tool-snapshot path (createSession) go
   * through this method. Writes are serialized via a promise chain to prevent
   * RMW races where two concurrent writers would each read stale meta and
   * clobber the other's fields on write-back.
   *
   * @param {string} sessionPath - absolute path to the session .jsonl file
   * @param {object} partial - fields to merge into meta[basename(sessionPath)]
   * @returns {Promise<void>} Resolves after this write (and any writes queued
   *   before it) has been attempted. I/O failures are logged and swallowed
   *   internally — the returned promise never rejects.
   */
  writeSessionMeta(sessionPath, partial) {
    const next = () => this._doWriteSessionMeta(sessionPath, partial);
    // Chain on both success and failure branches so a failed write does not
    // poison the queue — the next write still runs.
    this._metaWriteQueue = this._metaWriteQueue.then(next, next);
    return this._metaWriteQueue;
  }

  async _doWriteSessionMeta(sessionPath, partial) {
    const agentId = this._d.agentIdFromSessionPath(sessionPath);
    const sessionDir = agentId
      ? path.join(this._d.agentsDir, agentId, "sessions")
      : this._d.getAgent().sessionDir;
    const metaPath = path.join(sessionDir, "session-meta.json");
    const sessKey = path.basename(sessionPath);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let meta = {};
        try {
          meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
        } catch {
          // file missing or parse error → start fresh
        }
        meta[sessKey] = {
          ...meta[sessKey],
          ...partial,
        };
        // model is owned by PI SDK via session JSONL — keep session-meta clean
        delete meta[sessKey].model;
        delete meta[sessKey].modelId;
        await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));
        this.invalidateMetaCache(metaPath);
        return;
      } catch (err) {
        if (attempt === 0) {
          try { await fsp.mkdir(path.dirname(metaPath), { recursive: true }); } catch {}
        } else {
          log.warn(`writeSessionMeta failed for ${sessKey}: ${err.message}`);
        }
      }
    }
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
        // migration #5 后 models.chat 必为 {id, provider}；半成品或字符串视为未配置
        const chatRef = agentConfig?.models?.chat;
        const ref = (typeof chatRef === "object" && chatRef?.id && chatRef?.provider) ? chatRef : null;
        if (!ref) {
          if (models.defaultModel) {
            log.log(`[resolveModel] agentConfig 未指定完整 models.chat，回退到默认模型 ${models.defaultModel.provider}/${models.defaultModel.id}`);
            return models.defaultModel;
          }
          log.error(`[resolveModel] agentConfig 未指定 models.chat，也没有默认模型`);
          throw new Error(t("error.resolveModelNoChatModel"));
        }
        const found = findModel(models.availableModels, ref.id, ref.provider);
        if (!found) {
          // 模型在可用列表中找不到，尝试回退到默认模型
          if (models.defaultModel) {
            log.log(`[resolveModel] 模型 "${ref.provider}/${ref.id}" 不在可用列表中，回退到默认模型 ${models.defaultModel.provider}/${models.defaultModel.id}`);
            return models.defaultModel;
          }
          const available = models.availableModels.map(m => `${m.provider}/${m.id}`).join(", ");
          log.error(`[resolveModel] 找不到模型 "${ref.provider}/${ref.id}"。availableModels=[${available}]`);
          throw new Error(t("error.resolveModelNotAvailable", { id: `${ref.provider}/${ref.id}` }));
        }
        return found;
      },
    };
  }

  promoteActivitySession(activitySessionFile, agentId) {
    const agent = agentId ? this._d.getAgentById(agentId) : this._d.getAgent();
    if (!agent) return null;
    const oldPath = path.join(agent.agentDir, "activity", activitySessionFile);
    if (!fs.existsSync(oldPath)) return null;

    const newPath = path.join(agent.sessionDir, activitySessionFile);
    try {
      fs.mkdirSync(agent.sessionDir, { recursive: true });
      fs.renameSync(oldPath, newPath);
      agent._memoryTicker?.notifyPromoted(newPath);
      log.log(`promoted activity session: ${activitySessionFile} (agent=${agent.id})`);
      return newPath;
    } catch (err) {
      log.error(`promoteActivitySession failed: ${err.message}`);
      return null;
    }
  }

  // ── Isolated Execution ──

  /**
   * 隔离执行：在独立 session 中执行 prompt（原子操作）。
   *
   * opts:
   *   agentId, cwd, model, persist (string 目录路径 | falsy),
   *   toolFilter, builtinFilter, withMemory, signal,
   *   emitEvents (true 时将 session 事件转发到 EventBus),
   *   onSessionReady (sessionPath => void) 回调，session 创建后、prompt 执行前触发
   */
  async executeIsolated(prompt, opts = {}) {
    const targetAgent = opts.agentId ? this._d.getAgentById(opts.agentId) : this._d.getAgent();
    if (!targetAgent) throw new Error(t("error.agentNotInitialized", { id: opts.agentId }));

    // abort signal：提前中止检查
    if (opts.signal?.aborted) {
      return { sessionPath: null, replyText: "", error: "aborted" };
    }

    const bm = BrowserManager.instance();
    const wasBrowserRunning = bm.hasAnyRunning;
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

      const execCwd = opts.cwd || this._d.getHomeCwd(targetAgent.id) || process.cwd();
      const models = this._d.getModels();
      // migration #5 之后 models.chat 必为 {id, provider}；旧裸字符串/缺 provider 对象视为未配置
      const agentPreferredRef = targetAgent.config?.models?.chat;
      const preferredRef = opts.model ? null
        : ((typeof agentPreferredRef === "object" && agentPreferredRef?.id && agentPreferredRef?.provider)
            ? agentPreferredRef : null);
      let resolvedModel = opts.model;
      if (!resolvedModel) {
        if (preferredRef) {
          resolvedModel = findModel(models.availableModels, preferredRef.id, preferredRef.provider);
        }
        if (!resolvedModel) {
          resolvedModel = models.defaultModel;
        }
        if (!resolvedModel) {
          log.error(`[executeIsolated] agent "${targetAgent.agentName}" 未指定完整 models.chat，也没有可用的默认模型`);
          throw new Error(t("error.executeIsolatedNoModel", { name: targetAgent.agentName }));
        }
        if (preferredRef && resolvedModel.id !== preferredRef.id) {
          log.log(`[executeIsolated] 模型 "${preferredRef.provider}/${preferredRef.id}" 不可用，fallback → ${resolvedModel.provider}/${resolvedModel.id}`);
        }
      }
      const execModel = models.resolveExecutionModel(resolvedModel);
      tempSessionMgr = SessionManager.create(execCwd, sessionDir);
      const { tools: allBuiltinTools, customTools: allCustomTools } = this._d.buildTools(
        execCwd, targetAgent.tools, { agentDir: targetAgent.agentDir, workspace: this._d.getHomeCwd(targetAgent.id) }
      );

      const patrolAllowed = opts.toolFilter
        || targetAgent.config?.desk?.patrol_tools
        || PATROL_TOOLS_DEFAULT;
      // heartbeat 巡检中屏蔽 cron 工具：agent 在巡检里 cron.create 一个 3 分钟任务
      // 会让该任务持续触发后续巡检/活动，看起来像「巡检间隔被破坏」(#398)
      const isHeartbeat = opts.activityType === "heartbeat";
      const heartbeatBlocked = new Set(isHeartbeat ? ["cron"] : []);
      const actCustomTools = patrolAllowed === "*"
        ? allCustomTools.filter(t => !heartbeatBlocked.has(t.name))
        : allCustomTools.filter(t => new Set(patrolAllowed).has(t.name) && !heartbeatBlocked.has(t.name));

      const actTools = opts.builtinFilter
        ? allBuiltinTools.filter(t => opts.builtinFilter.includes(t.name))
        : allBuiltinTools;

      const agent = this._d.getAgent();
      const skills = this._d.getSkills();
      const resourceLoader = this._d.getResourceLoader();
      let isolatedPrompt;
      if (opts.withMemory && !targetAgent.memoryEnabled) {
        const savedState = targetAgent.sessionMemoryEnabled;
        targetAgent.setMemoryEnabled(true);
        isolatedPrompt = targetAgent.systemPrompt;
        targetAgent.setMemoryEnabled(savedState);
      } else {
        isolatedPrompt = targetAgent.systemPrompt;
      }
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

      const childSessionPath = session.sessionManager?.getSessionFile?.() || null;

      // 通知调用方 session 已就绪（subagent 用它来后补 streamKey）
      try { opts.onSessionReady?.(childSessionPath); } catch {}

      let replyText = "";
      const unsub = session.subscribe((event) => {
        if (event.type === "message_update") {
          const sub = event.assistantMessageEvent;
          if (sub?.type === "text_delta") {
            replyText += sub.delta || "";
          }
        }
        if (opts.emitEvents && childSessionPath) {
          this._d.emitEvent({ ...event, isolated: true }, childSessionPath);
        }
      });

      // isolated 专用 teardown: 临时 session 不在 _sessions Map 中,
      // 但仍需 emit shutdown + dispose 以避免扩展资源泄漏。幂等:
      // AgentSession.dispose() 基于 _unsubscribeAgent 做重复调用保护。
      const teardownIsolatedSession = async (label) => {
        try { await emitSessionShutdown(session); }
        catch (err) { log.warn(`executeIsolated[${label}]: emitSessionShutdown failed: ${err.message}`); }
        try { unsub?.(); }
        catch (err) { log.warn(`executeIsolated[${label}]: unsub failed: ${err.message}`); }
        try { session?.dispose?.(); }
        catch (err) { log.warn(`executeIsolated[${label}]: session.dispose failed: ${err.message}`); }
      };

      const abortHandler = () => session.abort();
      opts.signal?.addEventListener("abort", abortHandler, { once: true });

      if (opts.signal?.aborted) {
        opts.signal.removeEventListener("abort", abortHandler);
        await teardownIsolatedSession("early_abort");
        cleanupTempSession();
        return { sessionPath: null, replyText: "", error: "aborted" };
      }

      try {
        await session.prompt(prompt);
      } finally {
        opts.signal?.removeEventListener("abort", abortHandler);
        await teardownIsolatedSession("finally");
      }

      const sessionPath = session.sessionManager?.getSessionFile?.() || null;

      if (!opts.persist && sessionPath) {
        try { fs.unlinkSync(sessionPath); } catch {}
        return { sessionPath: null, replyText, error: null };
      }

      return { sessionPath, replyText, error: null };
    } catch (err) {
      log.error(`isolated execution failed: ${err.message}`);
      if (!opts.persist && tempSessionMgr) {
        cleanupTempSession();
      }
      return { sessionPath: null, replyText: "", error: err.message };
    } finally {
      this._headlessOps.delete(opId);
      if (this._headlessOps.size === 0) bm.setHeadless(false);
      const browserNowRunning = bm.hasAnyRunning;
      if (browserNowRunning !== wasBrowserRunning) {
        this._d.emitEvent({ type: "browser_bg_status", running: browserNowRunning }, null);
      }
    }
  }

  /** 创建 session 专用 settings（控制 compaction + max_completion_tokens） */
  _createSettings(model) {
    return createDefaultSettings();
  }
}
