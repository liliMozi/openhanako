/**
 * tool-session.js — 从 tool execute 的 ctx 中提取 sessionPath
 *
 * Pi SDK 调用 tool.execute(toolCallId, params, signal?, onUpdate?, ctx?) 时，
 * ctx.sessionManager.getSessionFile() 返回当前执行 session 的文件路径。
 * 所有工具应通过此函数获取 sessionPath，不再依赖焦点回调。
 */

/**
 * @param {object} [ctx] - Pi SDK tool execute 的第 5 个参数
 * @returns {string|null}
 */
export function getToolSessionPath(ctx) {
  return ctx?.sessionManager?.getSessionFile?.() ?? null;
}
