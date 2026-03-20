/**
 * AgentExecutor — Agent 会话执行器
 *
 * 使用 Engine 中的长驻 Agent 实例（不再创建临时 Agent），
 * 创建临时 session 执行多轮 prompt，捕获标记了 capture: true 的轮次输出。
 *
 * ChannelRouter 和 AgentMessenger 共用这个执行器。
 */

import fs from "fs";
import path from "path";
import { createAgentSession, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { debugLog } from "../lib/debug-log.js";

/**
 * 以指定 agentId 的身份跑一次临时会话。
 *
 * @param {string} agentId
 * @param {Array<{text: string, capture?: boolean}>} rounds  按序执行的 prompts
 * @param {object} opts
 * @param {import('../core/engine.js').HanaEngine} opts.engine
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.sessionSuffix="temp"]
 * @param {string} [opts.systemAppend] - 追加到 system prompt 末尾
 * @param {boolean} [opts.keepSession=false] - 是否保留 session 文件
 * @param {boolean} [opts.noMemory=false] - 不注入记忆，只用 personality
 * @param {boolean} [opts.noTools=false] - 不注入工具
 * @param {boolean} [opts.readOnly=false] - 只读模式（只保留读取类工具，排除写/编辑/ask_agent/dm 等）
 * @returns {Promise<string>}  capture 轮的输出（已去掉 MOOD 块）
 */
export async function runAgentSession(agentId, rounds, { engine, signal, sessionSuffix = "temp", systemAppend, keepSession = false, noMemory = false, noTools = false, readOnly = false } = {}) {
  // 1. 从长驻 Map 获取 Agent 实例
  const agent = engine.getAgent(agentId);
  if (!agent) {
    throw new Error(`agent "${agentId}" 不存在或未初始化`);
  }
  const agentDir = agent.agentDir;

  // 2. 临时 ResourceLoader
  const ctx = engine.createSessionContext();
  const tempResourceLoader = Object.create(ctx.resourceLoader);

  // noMemory 模式：只用 personality（identity + yuan + ishiki），不注入记忆/用户档案等
  const basePrompt = noMemory ? agent.personality : agent.systemPrompt;
  tempResourceLoader.getSystemPrompt = () =>
    systemAppend ? `${basePrompt}\n\n${systemAppend}` : basePrompt;
  tempResourceLoader.getSkills = () => ctx.getSkillsForAgent(agent);

  // 3. 临时 session
  const cwd = engine.homeCwd || process.cwd();
  const sessionDir = path.join(agentDir, "sessions", sessionSuffix);
  fs.mkdirSync(sessionDir, { recursive: true });
  const tempSessionMgr = SessionManager.create(cwd, sessionDir);

  // 工具模式：noTools = 无工具，readOnly = 只读工具，默认 = 全部
  let tools, customTools;
  if (noTools) {
    tools = [];
    customTools = [];
  } else {
    const built = ctx.buildTools(cwd, agent.tools, { agentDir, workspace: engine.homeCwd });
    if (readOnly) {
      const READ_ONLY_BUILTIN = ["read", "grep", "find", "ls"];
      const READ_ONLY_CUSTOM = ["search_memory", "recall_experience", "web_search", "web_fetch"];
      tools = built.tools.filter(t => READ_ONLY_BUILTIN.includes(t.name));
      customTools = (built.customTools || []).filter(t => READ_ONLY_CUSTOM.includes(t.name));
    } else {
      tools = built.tools;
      customTools = built.customTools;
    }
  }
  const model = ctx.resolveModel(agent.config);
  const contextWindow = model?.contextWindow || 200_000;
  const { session } = await createAgentSession({
    cwd,
    sessionManager: tempSessionMgr,
    settingsManager: SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: Math.max(contextWindow - 100_000, 16384),
        keepRecentTokens: 20_000,
      },
    }),
    authStorage: ctx.authStorage,
    modelRegistry: ctx.modelRegistry,
    model,
    thinkingLevel: "medium",
    resourceLoader: tempResourceLoader,
    tools,
    customTools,
  });

  // 4. AbortSignal 连接
  let onAbort;
  if (signal) {
    onAbort = () => { try { session.abort(); } catch {} };
    signal.addEventListener("abort", onAbort, { once: true });
  }

  // 5. 文本捕获
  let capturedText = "";
  let isCapturing = false;
  const unsub = session.subscribe((event) => {
    if (!isCapturing) return;
    if (event.type === "message_update") {
      const sub = event.assistantMessageEvent;
      if (sub?.type === "text_delta") capturedText += sub.delta || "";
    }
  });

  debugLog()?.log("agent-executor", `${agentId} session started (${rounds.length} rounds)`);

  try {
    for (const round of rounds) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      isCapturing = !!round.capture;
      if (round.capture) capturedText = "";
      await session.prompt(round.text);
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    unsub?.();
  }

  // 6. 清理临时 session 文件（keepSession=true 时保留，供 DM 等场景存档）
  if (!keepSession) {
    const sessionPath = session.sessionManager?.getSessionFile?.();
    if (sessionPath) {
      try { fs.unlinkSync(sessionPath); } catch {}
    }
  }

  // 7. 去掉 MOOD 块（backtick 和 XML 两种格式，一次过）
  const text = capturedText
    .replace(/```(?:mood|pulse|reflect)[\s\S]*?```\n*|<(?:mood|pulse|reflect)>[\s\S]*?<\/(?:mood|pulse|reflect)>\n*/gi, "")
    .trim();

  debugLog()?.log("agent-executor", `${agentId} done, ${text.length} chars captured`);
  return text;
}
