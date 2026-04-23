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

function getSteerPrefix() {
  const isZh = getLocale().startsWith("zh");
  return isZh ? "（插话，无需 MOOD）\n" : "(Interjection, no MOOD needed)\n";
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
   * @param {() => import('./model-manager.js').ModelManager} deps.getModelManager
   * @param {() => object} deps.getResourceLoader
   * @param {() => object} deps.getPreferences
   * @param {(cwd: string, customTools?, opts?) => {tools: any[], customTools: any[]}} deps.buildTools
   * @param {() => string} deps.getHomeCwd
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
    await session.abort();
    return true;
  }

  /** bridge 索引文件路径 */
  _indexPath(agent) {
    const a = agent || this._deps.getAgent();
    return path.join(a.sessionDir, "bridge", "bridge-sessions.json");
  }

  /**
   * 启动时 sanity check：扫描 bridge-index，清理孤儿条目
   * （有 file 引用但 JSONL 文件已不存在的）
   *
   * 注意：当前仅 reconcile focus agent 的 bridge 目录。
   * 多 agent 场景下应遍历所有 agent，但这属于更大范围的重构，暂留此限制。
   */
  reconcile() {
    const index = this.readIndex();
    const bridgeDir = path.join(this._deps.getAgent().sessionDir, "bridge");
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
      this.writeIndex(index);
      console.log(`[bridge-session] reconcile: 清理 ${cleaned} 个孤儿 session 引用`);
      debugLog()?.log("bridge", `reconcile: cleaned ${cleaned} orphan session refs`);
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
    // 优先用调用方传入的 agentId；fallback 到 focus agent 仅作最后保底
    let agent = opts.agentId ? this._deps.getAgentById?.(opts.agentId) : null;
    if (!agent) {
      if (opts.agentId) console.warn(`[bridge-session] executeExternalMessage: agentId "${opts.agentId}" not found, falling back to focus agent`);
      agent = this._deps.getAgent();
    }
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

    try {
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
          resourceLoader: tempResourceLoader,
          tools: [],
          customTools: [],
          settingsManager: this._createSettings(chatModel),
        };
      } else {
        // owner 模式：完整 agent。抽出 _buildOwnerSessionOpts 后，compactSession 也能复用同一构造逻辑
        sessionOpts = this._buildOwnerSessionOpts(agent, mm, homeCwd);
      }

      const { session } = await createAgentSession({
        cwd: homeCwd,
        sessionManager: mgr,
        authStorage: mm.authStorage,
        modelRegistry: mm.modelRegistry,
        ...sessionOpts,
      });

      this._activeSessions.set(sessionKey, session);

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
          const media = event.result?.details?.media;
          if (media?.mediaUrls?.length) {
            toolMediaUrls.push(...media.mediaUrls);
          }
          const card = event.result?.details?.card;
          if (card?.description) {
            capturedText += (capturedText ? "\n\n" : "") + card.description;
          }
        }
      });

      try {
        // 非 image 模型：剥离新贴的图片（历史由 engine context handler 净化）
        const bridgeInput = session.model?.input;
        if (opts.images?.length && Array.isArray(bridgeInput) && !bridgeInput.includes("image")) {
          opts.images = undefined;
        }
        const promptOpts = opts.images?.length ? { images: opts.images } : undefined;
        await session.prompt(prompt, promptOpts);
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
      const sessionPath = session.sessionManager?.getSessionFile?.();
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
    try {
      // 优先用指定 agentId；fallback 到 focus agent 仅作最后保底
      let agent = opts.agentId ? this._deps.getAgentById?.(opts.agentId) : null;
      if (!agent) {
        if (opts.agentId) console.warn(`[bridge-session] injectMessage: agentId "${opts.agentId}" not found, falling back to focus agent`);
        agent = this._deps.getAgent();
      }
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
  _buildOwnerSessionOpts(agent, mm, homeCwd) {
    const prefs = this._deps.getPreferences();
    const bridgeReadOnly = !!agent.config?.bridge?.readOnly;
    const { tools: baseTools, customTools: baseCustomTools } = this._deps.buildTools(
      homeCwd, agent.tools,
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

    // 快照 prompt，隔离于其他 session 的 prompt 变更（与 SessionCoordinator.createSession 一致）
    const ownerPromptSnapshot = agent.buildSystemPrompt();
    const ownerResourceLoader = Object.create(this._deps.getResourceLoader(), {
      getSystemPrompt: { value: () => ownerPromptSnapshot },
    });

    return {
      model: ownerModel,
      thinkingLevel: mm.resolveThinkingLevel(prefs?.thinking_level || "auto"),
      resourceLoader: ownerResourceLoader,
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
    let agent = opts.agentId ? this._deps.getAgentById?.(opts.agentId) : null;
    if (!agent) {
      if (opts.agentId) console.warn(`[bridge-session] compactSession: agentId "${opts.agentId}" not found, falling back to focus agent`);
      agent = this._deps.getAgent();
    }
    if (!agent) throw new Error("bridge compact: agent not found");

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
