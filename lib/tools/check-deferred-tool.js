/**
 * check-deferred-tool.js — 查询当前 session 的异步任务状态
 *
 * 通用工具，覆盖所有通过 DeferredResultStore 注册的后台任务：
 * 图片/视频生成、subagent、后台终端等。
 * 按当前 sessionPath 隔离，不跨 session。
 */

import { Type } from "@sinclair/typebox";
import { getToolSessionPath } from "./tool-session.js";

/**
 * @param {{
 *   getDeferredStore: () => import("../deferred-result-store.js").DeferredResultStore | null,
 *   getSessionPath: () => string | null,
 * }} opts
 */
export function createCheckDeferredTool({ getDeferredStore, getSessionPath }) {
  return {
    name: "check_pending_tasks",
    description:
      "查询当前对话中所有后台异步任务的状态（图片/视频生成、subagent 等）。仅返回本次对话的任务。",
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({ description: "按状态过滤：pending / resolved / failed。不传则返回全部。" }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const store = getDeferredStore();
      if (!store) {
        return { content: [{ type: "text", text: "异步任务存储未初始化。" }] };
      }

      const sessionPath = getToolSessionPath(ctx);
      if (!sessionPath) {
        return { content: [{ type: "text", text: "当前无活跃 session。" }] };
      }

      const all = store.listBySession(sessionPath);
      const filtered = params.status
        ? all.filter((t) => t.status === params.status)
        : all;

      if (!filtered.length) {
        const qualifier = params.status ? `（状态: ${params.status}）` : "";
        return { content: [{ type: "text", text: `当前对话没有后台任务${qualifier}。` }] };
      }

      const summary = filtered.map((t) => ({
        taskId: t.taskId,
        status: t.status,
        type: t.meta?.type || "unknown",
        deferredAt: new Date(t.deferredAt).toISOString(),
        ...(t.result != null && { result: t.result }),
        ...(t.reason != null && { reason: t.reason }),
        ...(t.meta && Object.keys(t.meta).length > 1 && { meta: t.meta }),
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    },
  };
}
