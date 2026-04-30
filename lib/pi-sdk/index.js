/**
 * PI SDK Adapter — 所有 PI SDK 导入的唯一入口
 *
 * 稳定 API 直接 re-export，不稳定 API 通过适配函数封装。
 * 消费方不应直接 import "@mariozechner/..."，全部从这里导入。
 *
 * 纪律：
 *   - 不接受 engine / agent / config 参数
 *   - 不拼 session options（compaction、thinkingLevel 等）
 *   - 不做工具过滤 / plan mode 逻辑
 *   - 不持有任何状态
 */

import {
  createAgentSession as rawCreateAgentSession,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import {
  normalizeCreateAgentSessionOptions,
  PI_BUILTIN_TOOL_NAMES,
} from "./session-options.js";

// ── Session 管理 ──
export { SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";

/**
 * Hana 侧保持稳定的 Tool[] 调用契约，适配层负责转换 Pi SDK 版本差异。
 *
 * Pi SDK 0.68+ 将 `tools` 改成 string[] allowlist；Hana 的沙盒工具仍然
 * 是 session 级对象，必须先注册为同名 customTools，再用名字启用。
 *
 * @param {object} options
 */
export async function createAgentSession(options) {
  const resourceLoaderAgentDir = options?.resourceLoader?.agentDir;
  const sessionOptions = !options?.agentDir && typeof resourceLoaderAgentDir === "string" && resourceLoaderAgentDir
    ? { ...options, agentDir: resourceLoaderAgentDir }
    : options;
  return rawCreateAgentSession(normalizeCreateAgentSessionOptions(sessionOptions));
}

// ── 内置工具名常量 ──
export { PI_BUILTIN_TOOL_NAMES };

// ── 工具工厂（沙盒用）──
export {
  createReadTool, createWriteTool, createEditTool, createBashTool,
  createGrepTool, createFindTool, createLsTool,
} from "@mariozechner/pi-coding-agent";

// ── 资源加载 ──
export { DefaultResourceLoader } from "@mariozechner/pi-coding-agent";

// ── Utilities ──
export { formatSkillsForPrompt, getLastAssistantUsage } from "@mariozechner/pi-coding-agent";
export { AuthStorage } from "@mariozechner/pi-coding-agent";

// ── Compaction primitives（model switch 用）──
export {
  estimateTokens, findCutPoint, generateSummary,
  serializeConversation, shouldCompact,
  parseSessionEntries, buildSessionContext,
} from "@mariozechner/pi-coding-agent";

// ── pi-ai（直接依赖，需保持与 pi-coding-agent 内部依赖同版本，避免双实例）──
export { StringEnum } from "@mariozechner/pi-ai";
export { registerOAuthProvider } from "@mariozechner/pi-ai/oauth";

// ── Schema 构造（typebox 的 Type 透过 adapter，避免工具直接依赖第三方包名）──
export { Type } from "typebox";

// ── 类型 re-export（供 JSDoc 引用）──
/** @typedef {import('@mariozechner/pi-coding-agent').ToolDefinition} ToolDefinition */

// ── Lifecycle helpers ──

/**
 * Emit `session_shutdown` event to the session's extension runner.
 *
 * 为什么在 adapter 层实现而不从 SDK 导出:
 *   SDK 的 emitSessionShutdownEvent 辅助函数只在 core/extensions/runner.js
 *   内部暴露, 顶级 index.js 未 re-export。直接 import 深层路径会违反
 *   adapter 纪律。实现本身仅 7 行, 自己实现更干净。
 *
 * 契约: AgentSession.dispose() 本身不 emit shutdown, 调用方必须在
 *   dispose 前显式 emit, 否则监听 session_shutdown 的扩展(如
 *   deferred-result-ext) 无法清理自身的 setInterval 和 store 订阅,
 *   导致长期运行进程的内存泄漏。
 *
 * @param {object} session - AgentSession 实例
 * @returns {Promise<boolean>} 事件是否被 emit (false = 无 handler)
 */
export async function emitSessionShutdown(session) {
  const runner = session?.extensionRunner;
  if (runner?.hasHandlers?.("session_shutdown")) {
    await runner.emit({ type: "session_shutdown" });
    return true;
  }
  return false;
}

// ── 不稳定 API 适配 ──

/**
 * ModelRegistry 工厂。
 * 0.64.0 将构造函数私有化，必须用静态方法。
 * 下次 SDK 改工厂签名，只改这里。
 * @param {import('@mariozechner/pi-coding-agent').AuthStorage} authStorage
 * @param {string} [modelsJsonPath]
 * @returns {import('@mariozechner/pi-coding-agent').ModelRegistry}
 */
export function createModelRegistry(authStorage, modelsJsonPath) {
  return ModelRegistry.create(authStorage, modelsJsonPath);
}

/**
 * 强制 session 从 ModelRegistry 重新解析当前 model 对象。
 *
 * 为什么需要：Pi SDK 的 model 对象把 baseUrl 烤在字段里
 * （openai-completions.js 等 provider 直接读 model.baseUrl 构造 client），
 * session 持有的是创建时的对象引用。当 ModelRegistry.refresh() 重建模型
 * 表后，session 仍指向旧对象，导致改完 base_url / api 等字段后 active
 * session 用旧值发请求，必须重启或切换 session 才生效。
 *
 * SDK 内部有 _refreshCurrentModelFromRegistry()，但只在 extension
 * registerProvider/unregisterProvider 时被调用，没有公开包装。
 * 这里走 adapter 纪律统一桥接，下次 SDK 升级改名只改这里。
 *
 * @param {object} session - AgentSession 实例
 */
export function refreshSessionModelFromRegistry(session) {
  session?._refreshCurrentModelFromRegistry?.();
}
