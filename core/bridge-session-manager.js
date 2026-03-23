/**
 * BridgeSessionManager — Bridge（外部平台）session 管理
 *
 * 负责 bridge session 索引读写、外部消息执行、消息注入。
 * 从 Engine 提取，Engine 通过 manager 访问 bridge 功能。
 */
import fs from "fs";
import path from "path";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { debugLog } from "../lib/debug-log.js";
import { READ_ONLY_BUILTIN_TOOLS } from "./config-coordinator.js";
import { t, getLocale } from "../server/i18n.js";
import { safeReadJSON } from "../shared/safe-fs.js";

function getSteerPrefix() {
  const isZh = getLocale().startsWith("zh");
  return isZh ? "（插话，无需 MOOD）\n" : "(Interjection, no MOOD needed)\n";
}

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

  /**
   * 执行外部平台消息：找到或创建持久 session，prompt 并捕获回复文本
   * @param {string} prompt - 格式化后的用户消息
   * @param {string} sessionKey - 会话标识（如 tg_dm_12345）
   * @param {object} [meta] - 元数据（name, avatarUrl, userId）
   * @param {object} [opts] - { guest: boolean, contextTag?: string, onDelta? }
   * @returns {Promise<string|null>} agent 的回复文本
   */
  async executeExternalMessage(prompt, sessionKey, meta, opts = {}) {
    // 优先用调用方传入的 agentId，避免 debounce 窗口内切 agent 导致路由到错误 agent
    const agent = (opts.agentId && this._deps.getAgentById?.(opts.agentId)) || this._deps.getAgent();
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
      if (existingPath) {
        try {
          mgr = SessionManager.open(existingPath, sessionDir);
        } catch {
          mgr = null;
        }
      }
      const homeCwd = this._deps.getHomeCwd() || process.cwd();
      if (!mgr) {
        mgr = SessionManager.create(homeCwd, sessionDir);
      }

      let sessionOpts;
      // MEDIA 协议指令（追加到 bridge 场景的系统提示）
      const mediaInstruction = "当你需要发送媒体文件（图片、视频、音频、文件）时，在回复中单独一行写 MEDIA:<url>，例如：\nMEDIA:https://example.com/photo.jpg\n不要把 MEDIA: 写在代码块里。一行一个。";

      if (opts.guest) {
        // guest 模式：yuan + public-ishiki + contextTag，主模型，无工具
        const yuanBase = agent.yuanPrompt;
        const pubIshiki = agent.publicIshiki;
        const parts = [yuanBase, pubIshiki, opts.contextTag, mediaInstruction].filter(Boolean);
        const guestPrompt = parts.join("\n\n");
        const tempResourceLoader = Object.create(this._deps.getResourceLoader());
        tempResourceLoader.getSystemPrompt = () => guestPrompt;
        tempResourceLoader.getSkills = () => ({ skills: [], diagnostics: [] });

        // 使用 agent 配置的模型，而非 defaultModel
        const chatModelId = agent.config?.models?.chat;
        if (!chatModelId) {
          throw new Error(t("error.bridgeAgentNoChatModel", { name: agent.agentName }));
        }
        const chatModel = mm.availableModels.find(m => m.id === chatModelId);
        if (!chatModel) {
          throw new Error(t("error.bridgeAgentModelNotAvailable", { name: agent.agentName, model: chatModelId }));
        }

        sessionOpts = {
          model: chatModel,
          thinkingLevel: "none",
          resourceLoader: tempResourceLoader,
          settingsManager: this._createSettings(chatModel),
        };
      } else {
        // owner 模式：完整 agent
        const prefs = this._deps.getPreferences();
        const bridgeReadOnly = !!prefs.bridge?.readOnly;
        const bridgeCwd = homeCwd;
        const { tools: baseTools, customTools: baseCustomTools } = this._deps.buildTools(bridgeCwd, null, { workspace: homeCwd });

        const bridgeTools = bridgeReadOnly
          ? baseTools.filter(t => READ_ONLY_BUILTIN_TOOLS.includes(t.name))
          : baseTools;
        const safeCustomNames = ["search_memory", "web_search", "web_fetch", "present_files"];
        const bridgeCustomTools = bridgeReadOnly
          ? (baseCustomTools || []).filter(t => safeCustomNames.includes(t.name))
          : baseCustomTools;

        // 使用 agent 配置的模型
        const ownerModelId = agent.config?.models?.chat;
        if (!ownerModelId) {
          throw new Error(t("error.bridgeAgentNoChatModel", { name: agent.agentName }));
        }
        const ownerModel = mm.availableModels.find(m => m.id === ownerModelId);
        if (!ownerModel) {
          throw new Error(t("error.bridgeAgentModelNotAvailable", { name: agent.agentName, model: ownerModelId }));
        }

        // 包装 resourceLoader 追加 MEDIA 协议指令
        const baseRL = this._deps.getResourceLoader();
        const ownerRL = Object.create(baseRL);
        const baseGetSP = baseRL.getSystemPrompt.bind(baseRL);
        ownerRL.getSystemPrompt = (...args) => {
          const sp = baseGetSP(...args);
          return sp + "\n\n" + mediaInstruction;
        };

        sessionOpts = {
          model: ownerModel,
          thinkingLevel: mm.resolveThinkingLevel(prefs?.thinking_level || "auto"),
          resourceLoader: ownerRL,
          tools: bridgeTools,
          customTools: bridgeCustomTools,
          settingsManager: this._createSettings(ownerModel),
        };
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
        }
      });

      try {
        const promptOpts = opts.images?.length ? { images: opts.images } : undefined;
        await session.prompt(prompt, promptOpts);
      } finally {
        unsub?.();
        this._activeSessions.delete(sessionKey);
      }

      // 更新索引 + 元数据
      const sessionPath = session.sessionManager?.getSessionFile?.();
      if (sessionPath) {
        const fileName = `${subDir}/${path.basename(sessionPath)}`;
        if (!existingFile) {
          index[sessionKey] = { file: fileName, ...(meta || {}) };
        } else if (meta) {
          const entry = typeof index[sessionKey] === "string"
            ? { file: index[sessionKey] }
            : index[sessionKey];
          Object.assign(entry, meta);
          index[sessionKey] = entry;
        }
        this.writeIndex(index, agent);
      }

      return capturedText.trim() || null;
    } catch (err) {
      console.error(`[bridge-session] external message failed (${sessionKey}):`, err.message);
      return null;
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
   * @returns {boolean}
   */
  injectMessage(sessionKey, text) {
    try {
      const index = this.readIndex();
      const raw = index[sessionKey];
      const existingFile = typeof raw === "string" ? raw : raw?.file || null;
      if (!existingFile) {
        console.warn(`[bridge-session] injectMessage: sessionKey "${sessionKey}" 不存在`);
        return false;
      }

      const bridgeDir = path.join(this._deps.getAgent().sessionDir, "bridge");
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

  /** 创建 bridge 专用 settings：100k token 触发压缩 */
  _createSettings(model) {
    // 用户手动设置的 context 覆盖优先
    const overrides = this._deps.getAgent?.()?.config?.models?.overrides;
    const ov = model?.id && overrides?.[model.id];
    const contextWindow = ov?.context || model?.contextWindow || 200_000;
    return SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: Math.max(contextWindow - 100_000, 16384),
        keepRecentTokens: 20_000,
      },
    });
  }
}
