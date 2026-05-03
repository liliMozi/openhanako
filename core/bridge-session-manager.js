/**
 * BridgeSessionManager — Bridge（外部平台）session 管理
 *
 * 负责 bridge session 索引读写、外部消息执行、消息注入。
 * 从 Engine 提取，Engine 通过 manager 访问 bridge 功能。
 */
import fs from "fs";
import path from "path";
import { createAgentSession, SessionManager } from "../lib/pi-sdk/index.js";
import { createDefaultSettings } from "./session-defaults.js";
import { debugLog } from "../lib/debug-log.js";
import { READ_ONLY_BUILTIN_TOOLS } from "./config-coordinator.js";
import { t, getLocale } from "../server/i18n.js";
import { safeReadJSON } from "../shared/safe-fs.js";
import { findModel } from "../shared/model-ref.js";
import { teardownSessionResources } from "./session-teardown.js";
import { requireVisionAuxiliaryEnabled } from "./vision-auxiliary-policy.js";
import { collectMediaItems } from "../lib/tools/media-details.js";
import { materializeBridgeInboundFiles } from "../lib/session-files/bridge-inbound-files.js";

function getSteerPrefix() {
  const isZh = getLocale().startsWith("zh");
  return isZh ? "（插话，无需 MOOD）\n" : "(Interjection, no MOOD needed)\n";
}

function withVisionExtension(resourceLoader, getBridge, getSessionPath, isEnabled, warn) {
  return Object.create(resourceLoader, {
    getExtensions: {
      value: () => {
        const base = resourceLoader.getExtensions?.() ?? { extensions: [], errors: [] };
        const extension = {
          path: "hana-vision-context-injection",
          tools: new Map(),
          handlers: new Map([
            [
              "context",
              [
                async (event) => {
                  try {
                    if (isEnabled?.() !== true) return undefined;
                    const bridge = getBridge?.();
                    if (!bridge) return undefined;
                    const { messages, injected } = bridge.injectNotes(event.messages, getSessionPath?.() || null);
                    if (!injected) return undefined;
                    return { messages };
                  } catch (err) {
                    warn?.(`vision context injection failed: ${err?.message || err}`);
                    return undefined;
                  }
                },
              ],
            ],
          ]),
          flags: new Map(),
          shortcuts: new Map(),
          commands: new Map(),
          messageRenderers: new Map(),
        };
        return { ...base, extensions: [...(base.extensions || []), extension] };
      },
    },
  });
}

/**
 * Bridge index entry（持久化到 bridge-sessions.json）。
 * 这个 typedef 只声明结构以便 IDE 和未来读者，运行时仍是 plain JSON object。
 *
 * @typedef {object} BridgeIndexEntry
 * @property {string} [file] - owner/xxx.jsonl 或 guests/xxx.jsonl（rotate 后会被移除保留 meta）
 * @property {string} [name]
 * @property {string} [avatarUrl]
 * @property {string} [userId]
 * @property {string} [linkedSessionPath]
 *   - 预留字段：当该 bridge session 由某个桌面 session "推送"产生时，
 *     记录源桌面 session 的绝对路径。一期不写入（/push 命令在后续 phase 落地），
 *     现有读写路径对未知字段透明保留（readIndex → writeIndex roundtrip 不丢）。
 *     这是"桌面 session 推送到社交平台"长期能力的数据模型钩子。
 */

export class BridgeSessionManager {
  /**
   * @param {object} deps - 注入依赖（不持有 engine 引用）
   * @param {() => object} deps.getAgent - 返回当前 agent（需 sessionDir, yuanPrompt）
   * @param {(id: string) => object|null} deps.getAgentById - 按 ID 获取 agent
   * @param {() => Map<string, object>|object[]|undefined} [deps.getAgents] - 返回所有 agent（reconcile 用）
   * @param {() => import('./model-manager.js').ModelManager} deps.getModelManager
   * @param {() => object} deps.getResourceLoader
   * @param {() => object} deps.getPreferences
   * @param {(cwd: string, customTools?, opts?) => {tools: any[], customTools: any[]}} deps.buildTools
   * @param {() => string} deps.getHomeCwd
   * @param {() => boolean} [deps.isVisionAuxiliaryEnabled]
   */
  constructor(deps) {
    this._deps = deps;
    this._activeSessions = new Map();
  }

  /** 活跃 bridge sessions（供 bridge-manager abort 用） */
  get activeSessions() { return this._activeSessions; }

  /** 指定 bridge session 是否正在 streaming */
  isSessionStreaming(sessionKey) {
    return this._activeSessions.get(sessionKey)?.isStreaming ?? false;
  }

  /** abort 指定 bridge session（如果正在 streaming） */
  async abortSession(sessionKey) {
    const session = this._activeSessions.get(sessionKey);
    if (!session?.isStreaming) return false;
    this._activeSessions.delete(sessionKey);
    try {
      const abortPromise = session.abort?.();
      Promise.resolve(abortPromise).catch((err) =>
        console.warn(`[bridge-session] abortSession[${sessionKey}]: abort failed: ${err.message}`),
      );
    } catch (err) {
      console.warn(`[bridge-session] abortSession[${sessionKey}]: abort failed: ${err.message}`);
    }
    try {
      session.dispose?.();
    } catch (err) {
      console.warn(`[bridge-session] abortSession[${sessionKey}]: session.dispose failed: ${err.message}`);
    }
    return true;
  }

  /** bridge 索引文件路径 */
  _indexPath(agent) {
    const a = agent || this._deps.getAgent();
    return path.join(a.sessionDir, "bridge", "bridge-sessions.json");
  }

  _resolveAgent(opts = {}, operation = "operation") {
    if (opts.agentId) {
      const agent = this._deps.getAgentById?.(opts.agentId) || null;
      if (!agent) throw new Error(`bridge ${operation}: agent "${opts.agentId}" not found`);
      return agent;
    }
    const agent = this._deps.getAgent?.() || null;
    if (!agent) throw new Error(`bridge ${operation}: focus agent not available`);
    return agent;
  }

  _listAgentsForReconcile() {
    const all = this._deps.getAgents?.();
    if (all instanceof Map) return [...all.values()].filter(Boolean);
    if (Array.isArray(all)) return all.filter(Boolean);
    const focus = this._deps.getAgent?.();
    return focus ? [focus] : [];
  }

  /**
   * 启动时 sanity check：扫描 bridge-index，清理孤儿条目
   * （有 file 引用但 JSONL 文件已不存在的）
   */
  reconcile() {
    let totalCleaned = 0;

    for (const agent of this._listAgentsForReconcile()) {
      const index = this.readIndex(agent);
      const bridgeDir = path.join(agent.sessionDir, "bridge");
      let cleaned = 0;

      for (const [sessionKey, raw] of Object.entries(index)) {
        const entry = typeof raw === "string" ? { file: raw } : raw;
        if (!entry.file) continue;
        const fp = path.join(bridgeDir, entry.file);
        if (!fs.existsSync(fp)) {
          // 保留元数据（name/avatarUrl/userId），只删 file 引用
          delete entry.file;
          index[sessionKey] = entry;
          cleaned++;
        }
      }

      if (cleaned > 0) {
        this.writeIndex(index, agent);
        totalCleaned += cleaned;
        debugLog()?.log("bridge", `reconcile: cleaned ${cleaned} orphan session refs for ${agent.id || "unknown"}`);
      }
    }

    if (totalCleaned > 0) {
      console.log(`[bridge-session] reconcile: 清理 ${totalCleaned} 个孤儿 session 引用`);
    }
  }

  /** 读取 bridge session 索引 */
  readIndex(agent) {
    return safeReadJSON(this._indexPath(agent), {});
  }

  /** 写入 bridge session 索引 */
  writeIndex(index, agent) {
    const dir = path.dirname(this._indexPath(agent));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this._indexPath(agent), JSON.stringify(index, null, 2) + "\n", "utf-8");
  }

  _normalizeIndexEntry(raw) {
    if (!raw) return {};
    return typeof raw === "string" ? { file: raw } : { ...raw };
  }

  _serializeIndexEntry(previousRaw, entry) {
    if (typeof previousRaw === "string" && Object.keys(entry).length === 1 && typeof entry.file === "string") {
      return entry.file;
    }
    return entry;
  }

  _relativeBridgeFile(bridgeDir, sessionPath) {
    const relative = path.relative(bridgeDir, sessionPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`bridge session path escapes bridge dir: ${sessionPath}`);
    }
    return relative.split(path.sep).join("/");
  }

  _syncIndexEntry(index, sessionKey, previousRaw, { bridgeDir, sessionPath, meta }) {
    const entry = this._normalizeIndexEntry(previousRaw);
    entry.file = this._relativeBridgeFile(bridgeDir, sessionPath);
    if (meta) Object.assign(entry, meta);
    const nextValue = this._serializeIndexEntry(previousRaw, entry);
    if (JSON.stringify(previousRaw ?? null) === JSON.stringify(nextValue)) return { changed: false, file: entry.file };
    index[sessionKey] = nextValue;
    return { changed: true, file: entry.file };
  }

  /**
   * 执行外部平台消息：找到或创建持久 session，prompt 并捕获回复文本
   * @param {string} prompt - 格式化后的用户消息
   * @param {string} sessionKey - 会话标识（如 tg_dm_12345）
   * @param {object} [meta] - 元数据（name, avatarUrl, userId）
   * @param {object} [opts] - { guest: boolean, contextTag?: string, onDelta? }
   * @returns {Promise<string|null>} agent 的回复文本
   */
  async executeExternalMessage(prompt, sessionKey, meta, opts = {}) {
    try {
      let promptText = prompt;
      const agent = this._resolveAgent(opts, "executeExternalMessage");
      const mm = this._deps.getModelManager();
      const bridgeDir = path.join(agent.sessionDir, "bridge");
      const subDir = opts.guest ? "guests" : "owner";
      const sessionDir = path.join(bridgeDir, subDir);
      fs.mkdirSync(sessionDir, { recursive: true });

      // 查找已有 session（兼容旧格式字符串和新格式对象）
      const index = this.readIndex(agent);
      const raw = index[sessionKey];
      const existingFile = typeof raw === "string" ? raw : raw?.file || null;
      const existingPath = existingFile ? path.join(bridgeDir, existingFile) : null;

      let mgr;
      let reopenError = null;
      if (existingPath) {
        try {
          mgr = SessionManager.open(existingPath, sessionDir);
        } catch (err) {
          reopenError = err;
          mgr = null;
          console.warn(`[bridge-session] existing session open failed (${sessionKey}): ${err.message}; creating a new session and rebinding index`);
          debugLog()?.log("bridge-session", `open failed for ${sessionKey}: ${err.message}`);
        }
      }
      const homeCwd = this._deps.getHomeCwd(agent.id) || process.cwd();
      if (!mgr) {
        mgr = SessionManager.create(homeCwd, sessionDir);
      }

      let sessionOpts;
      const sessionPathRef = { current: null };
      // 工具 details.media 收集器（被动提取 tool_execution_end 事件）
      let toolMediaUrls = [];

      if (opts.guest) {
        // guest 模式：yuan + public-ishiki + contextTag，主模型，无工具
        const yuanBase = agent.yuanPrompt;
        const pubIshiki = agent.publicIshiki;
        const parts = [yuanBase, pubIshiki, opts.contextTag].filter(Boolean);
        const guestPrompt = parts.join("\n\n");
        const tempResourceLoader = Object.create(this._deps.getResourceLoader());
        tempResourceLoader.getSystemPrompt = () => guestPrompt;
        tempResourceLoader.getSkills = () => ({ skills: [], diagnostics: [] });
        const guestResourceLoader = withVisionExtension(
          tempResourceLoader,
          () => this._deps.getVisionBridge?.(),
          () => sessionPathRef.current,
          () => this._deps.isVisionAuxiliaryEnabled?.() === true,
          (msg) => console.warn(`[bridge-session] ${msg}`),
        );

        // 使用 agent 配置的模型，而非 defaultModel。
        // migration #5 之后 models.chat 必为 {id, provider} 对象；缺 provider 视为未配置。
        const chatRef = agent.config?.models?.chat;
        const ref = (typeof chatRef === "object" && chatRef?.id && chatRef?.provider) ? chatRef : null;
        if (!ref) {
          throw new Error(t("error.bridgeAgentNoChatModel", { name: agent.agentName }));
        }
        const chatModel = findModel(mm.availableModels, ref.id, ref.provider);
        if (!chatModel) {
          throw new Error(t("error.bridgeAgentModelNotAvailable", { name: agent.agentName, model: `${ref.provider}/${ref.id}` }));
        }

        sessionOpts = {
          model: chatModel,
          thinkingLevel: "none",
          resourceLoader: guestResourceLoader,
          tools: [],
          customTools: [],
          settingsManager: this._createSettings(chatModel),
        };
      } else {
        // owner 模式：完整 agent。抽出 _buildOwnerSessionOpts 后，compactSession 也能复用同一构造逻辑
        sessionOpts = this._buildOwnerSessionOpts(agent, mm, homeCwd, sessionPathRef);
      }

      const { session } = await createAgentSession({
        cwd: homeCwd,
        sessionManager: mgr,
        authStorage: mm.authStorage,
        modelRegistry: mm.modelRegistry,
        ...sessionOpts,
      });

      const activeSessionPath = session.sessionManager?.getSessionFile?.() || null;
      sessionPathRef.current = activeSessionPath;
      this._activeSessions.set(sessionKey, session);

      if (opts.inboundFiles?.length && !activeSessionPath) {
        throw new Error("bridge inbound files require a resolved sessionPath");
      }
      if (opts.inboundFiles?.length && activeSessionPath) {
        const materialized = await materializeBridgeInboundFiles({
          hanakoHome: this._deps.getHanakoHome?.(),
          sessionPath: activeSessionPath,
          files: opts.inboundFiles,
          registerSessionFile: this._deps.registerSessionFile,
        });
        if (materialized.imageAttachmentPaths.length) {
          promptText = addAttachedImageMarkers(promptText, materialized.imageAttachmentPaths);
          opts = {
            ...opts,
            imageAttachmentPaths: [
              ...(opts.imageAttachmentPaths || []),
              ...materialized.imageAttachmentPaths,
            ],
          };
        }
      }

      // 捕获文本输出
      let capturedText = "";
      const unsub = session.subscribe((event) => {
        if (event.type === "message_update") {
          const sub = event.assistantMessageEvent;
          if (sub?.type === "text_delta") {
            const delta = sub.delta || "";
            capturedText += delta;
            try { opts.onDelta?.(delta, capturedText); } catch {}
          }
        } else if (event.type === "tool_execution_end" && !event.isError) {
          toolMediaUrls.push(...collectMediaItems(event.result?.details?.media));
          const card = event.result?.details?.card;
          if (card?.description) {
            capturedText += (capturedText ? "\n\n" : "") + card.description;
          }
        }
      });

      try {
        // 非 image 模型：用视觉桥生成隐藏纸条，历史由 context extension 注入
        const bridgeInput = session.model?.input;
        if (opts.images?.length && Array.isArray(bridgeInput) && !bridgeInput.includes("image")) {
          requireVisionAuxiliaryEnabled({
            isVisionAuxiliaryEnabled: this._deps.isVisionAuxiliaryEnabled,
          });
          const visionBridge = this._deps.getVisionBridge?.();
          if (!visionBridge) {
            throw new Error("vision auxiliary model is required for image input with the current text-only model");
          }
          const prepared = await visionBridge.prepare({
            sessionPath: activeSessionPath,
            targetModel: session.model,
            text: promptText,
            images: opts.images,
            imageAttachmentPaths: opts.imageAttachmentPaths,
          });
          promptText = prepared.text;
          opts = { ...opts, images: prepared.images };
        }
        const promptOpts = opts.images?.length
          ? { images: opts.images, ...(opts.imageAttachmentPaths?.length ? { imageAttachmentPaths: opts.imageAttachmentPaths } : {}) }
          : undefined;
        await session.prompt(promptText, promptOpts);
      } finally {
        await teardownSessionResources({
          session,
          unsub,
          label: `bridge.executeExternalMessage[${sessionKey}]`,
          warn: (msg) => console.warn(`[bridge-session] ${msg}`),
        });
        this._activeSessions.delete(sessionKey);
      }

      // 更新索引 + 元数据
      const sessionPath = activeSessionPath || session.sessionManager?.getSessionFile?.();
      if (sessionPath) {
        const { changed, file } = this._syncIndexEntry(index, sessionKey, raw, {
          bridgeDir,
          sessionPath,
          meta,
        });
        if (changed) {
          if (existingFile && existingFile !== file) {
            debugLog()?.log("bridge-session", `rebound ${sessionKey}: ${existingFile} -> ${file}`);
            if (reopenError) {
              console.log(`[bridge-session] ${sessionKey} 已自愈：${existingFile} -> ${file}`);
            }
          }
          this.writeIndex(index, agent);
        }
      }

      const text = capturedText.trim() || null;
      if (toolMediaUrls.length) {
        debugLog()?.log("bridge-session", `tool media → ${toolMediaUrls.length} url(s) via details.media`);
        return { text, toolMedia: toolMediaUrls };
      }
      return text;
    } catch (err) {
      console.error(`[bridge-session] external message failed (${sessionKey}):`, err.message);
      return { __bridgeError: true, message: err.message };
    }
  }

  /**
   * 向正在 streaming 的 bridge session 注入 steer 消息
   * @param {string} sessionKey
   * @param {string} text
   * @returns {boolean} 是否成功注入
   */
  steerSession(sessionKey, text) {
    const session = this._activeSessions.get(sessionKey);
    if (!session?.isStreaming) return false;
    session.steer(getSteerPrefix() + text);
    return true;
  }

  /**
   * 往指定 bridge session 追加一条 assistant 消息（不触发 LLM）
   * @param {string} sessionKey - bridge session 标识
   * @param {string} text - 要追加的 assistant 消息文本
   * @param {object} [opts] - { agentId?: string }
   * @returns {boolean}
   */
  injectMessage(sessionKey, text, opts = {}) {
    const agent = this._resolveAgent(opts, "injectMessage");
    try {
      const index = this.readIndex(agent);
      const raw = index[sessionKey];
      const existingFile = typeof raw === "string" ? raw : raw?.file || null;
      if (!existingFile) {
        console.warn(`[bridge-session] injectMessage: sessionKey "${sessionKey}" 不存在`);
        return false;
      }

      const bridgeDir = path.join(agent.sessionDir, "bridge");
      const sessionPath = path.join(bridgeDir, existingFile);
      if (!fs.existsSync(sessionPath)) {
        console.warn(`[bridge-session] injectMessage: session 文件不存在: ${sessionPath}`);
        return false;
      }

      const mgr = SessionManager.open(sessionPath, path.dirname(sessionPath));
      mgr.appendMessage({
        role: "assistant",
        content: [{ type: "text", text }],
      });

      debugLog()?.log("bridge-session", `injected message to ${sessionKey} (${text.length} chars)`);
      return true;
    } catch (err) {
      console.error(`[bridge-session] injectMessage failed: ${err.message}`);
      return false;
    }
  }

  /**
   * 构造 owner 模式 bridge session 的 createAgentSession opts。
   * 从 executeExternalMessage 的 owner 分支抽出，以便 compactSession 复用同一配置。
   *
   * 纯函数（相对于 this._deps）：不写 _activeSessions，不落盘索引。
   *
   * @param {object} agent
   * @param {import('./model-manager.js').ModelManager} mm
   * @param {string} homeCwd
   * @returns {object} sessionOpts for createAgentSession
   */
  _buildOwnerSessionOpts(agent, mm, homeCwd, sessionPathRef = { current: null }) {
    const prefs = this._deps.getPreferences();
    const bridgeReadOnly = prefs?.bridge?.readOnly === true;
    const agentToolsSnapshot = typeof agent.getToolsSnapshot === "function"
      ? agent.getToolsSnapshot({
        forceMemoryEnabled: agent.memoryMasterEnabled !== false,
        ...(typeof agent.experienceEnabled === "boolean"
          ? { forceExperienceEnabled: agent.experienceEnabled === true }
          : {}),
      })
      : agent.tools;
    const { tools: baseTools, customTools: baseCustomTools } = this._deps.buildTools(
      homeCwd, agentToolsSnapshot,
      { workspace: homeCwd, agentDir: agent.agentDir },
    );

    const bridgeTools = bridgeReadOnly
      ? baseTools.filter(t => READ_ONLY_BUILTIN_TOOLS.includes(t.name))
      : baseTools;
    const safeCustomNames = ["search_memory", "web_search", "web_fetch", "stage_files"];
    const bridgeCustomTools = bridgeReadOnly
      ? (baseCustomTools || []).filter(t => safeCustomNames.includes(t.name))
      : baseCustomTools;

    // 使用 agent 配置的模型（必须是带 provider 的复合键对象）
    const ownerRef = agent.config?.models?.chat;
    const ref = (typeof ownerRef === "object" && ownerRef?.id && ownerRef?.provider) ? ownerRef : null;
    if (!ref) {
      throw new Error(t("error.bridgeAgentNoChatModel", { name: agent.agentName }));
    }
    const ownerModel = findModel(mm.availableModels, ref.id, ref.provider);
    if (!ownerModel) {
      throw new Error(t("error.bridgeAgentModelNotAvailable", { name: agent.agentName, model: `${ref.provider}/${ref.id}` }));
    }

    // 快照 prompt，隔离于其他 session 的 prompt 变更（与 SessionCoordinator.createSession 一致）。
    // 显式按 master 开关构建：bridge owner 是独立链路，不应受桌面端某个 session
    // 的 per-session 开关污染。用户在桌面关掉某个 session 的记忆，不影响这里。
    const ownerPromptSnapshot = agent.buildSystemPrompt({
      cwdOverride: homeCwd,
      forceMemoryEnabled: agent.memoryMasterEnabled,
      ...(typeof agent.experienceEnabled === "boolean"
        ? { forceExperienceEnabled: agent.experienceEnabled === true }
        : {}),
    });
    const ownerResourceLoader = Object.create(this._deps.getResourceLoader(), {
      getSystemPrompt: { value: () => ownerPromptSnapshot },
    });
    const visionResourceLoader = withVisionExtension(
      ownerResourceLoader,
      () => this._deps.getVisionBridge?.(),
      () => sessionPathRef.current,
      () => this._deps.isVisionAuxiliaryEnabled?.() === true,
      (msg) => console.warn(`[bridge-session] ${msg}`),
    );

    return {
      model: ownerModel,
      thinkingLevel: mm.resolveThinkingLevel(prefs?.thinking_level || "auto"),
      resourceLoader: visionResourceLoader,
      tools: bridgeTools,
      customTools: bridgeCustomTools,
      settingsManager: this._createSettings(ownerModel),
    };
  }

  /**
   * 对指定 bridge session 执行真正的上下文压缩。
   *
   * 流程：
   *   1. 从 index 定位 jsonl 文件
   *   2. 若当前正 streaming → 抛错（禁止并发压缩+生成）
   *   3. SessionManager.open + createAgentSession 组装临时 owner session
   *   4. 读取压缩前 token 占用 → session.compact() → 读取压缩后
   *   5. 不把临时 session 写入 _activeSessions（它不承担 LLM 生成，isStreaming 语义无关）
   *
   * 返回值为结构化对象，上层 /compact handler 负责消息文案。
   *
   * @param {string} sessionKey
   * @param {{ agentId?: string }} opts
   * @returns {Promise<{ tokensBefore: number|null, tokensAfter: number|null, contextWindow: number|null }>}
   */
  async compactSession(sessionKey, opts = {}) {
    // 1. 定位 agent
    const agent = this._resolveAgent(opts, "compactSession");

    // 2. 并发保护：正在生成回复时禁止压缩（SDK 内部冲突）
    const active = this._activeSessions.get(sessionKey);
    if (active?.isStreaming) {
      throw new Error("bridge compact: session is streaming, try again after the reply completes");
    }

    // 3. 读索引 → 拿到 jsonl 绝对路径
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const index = this.readIndex(agent);
    const raw = index[sessionKey];
    const existingFile = typeof raw === "string" ? raw : raw?.file || null;
    if (!existingFile) {
      throw new Error(`bridge compact: session "${sessionKey}" not found or has no history`);
    }
    const sessionFilePath = path.join(bridgeDir, existingFile);
    if (!fs.existsSync(sessionFilePath)) {
      throw new Error(`bridge compact: session file missing on disk: ${sessionFilePath}`);
    }

    // 4. 打开 SessionManager + 组装 owner 模式 createAgentSession opts
    const mm = this._deps.getModelManager();
    const homeCwd = this._deps.getHomeCwd(agent.id) || process.cwd();
    const sessionDir = path.dirname(sessionFilePath);
    const mgr = SessionManager.open(sessionFilePath, sessionDir);
    const sessionOpts = this._buildOwnerSessionOpts(agent, mm, homeCwd);

    const { session } = await createAgentSession({
      cwd: homeCwd,
      sessionManager: mgr,
      authStorage: mm.authStorage,
      modelRegistry: mm.modelRegistry,
      ...sessionOpts,
    });

    try {
      // 5. 读 usage → compact → 读 usage
      const before = session.getContextUsage?.() ?? null;
      if (session.isCompacting) {
        throw new Error("bridge compact: already compacting");
      }
      await session.compact();
      const after = session.getContextUsage?.() ?? null;

      return {
        tokensBefore: before?.tokens ?? null,
        tokensAfter: after?.tokens ?? null,
        contextWindow: after?.contextWindow ?? before?.contextWindow ?? null,
      };
    } finally {
      await teardownSessionResources({
        session,
        label: `bridge.compactSession[${sessionKey}]`,
        warn: (msg) => console.warn(`[bridge-session] ${msg}`),
      });
    }
  }

  /** 创建 bridge 专用 settings：compaction 由 SDK 默认触发（contextWindow - 16384） */
  _createSettings(model) {
    return createDefaultSettings();
  }
}

function addAttachedImageMarkers(text, imageAttachmentPaths) {
  let promptText = text || "";
  const missing = Array.from(new Set(imageAttachmentPaths || []))
    .filter((filePath) => filePath && !promptText.includes(`[attached_image: ${filePath}]`));
  if (!missing.length) return promptText;
  const markerText = missing.map((filePath) => `[attached_image: ${filePath}]`).join("\n");
  return promptText ? `${markerText}\n${promptText}` : markerText;
}
