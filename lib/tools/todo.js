/**
 * todo.js — session 内的待办工具
 *
 * 给 agent 一个"工作草稿纸"，在执行多步骤任务时追踪进度。
 * 状态通过 tool result 的 details 持久化到 session 历史中，
 * 切换 session 时从历史中重建。
 *
 * 灵感来源：Pi SDK examples/extensions/todo.ts
 */

import { Type } from "@sinclair/typebox";

/**
 * 创建 todo 工具定义
 * @returns {import('@mariozechner/pi-coding-agent').ToolDefinition}
 */
export function createTodoTool() {
  // session 内状态
  let todos = [];
  let nextId = 1;
  let _reconstructedSessionId = null;

  /**
   * 从当前 session 分支中重建 todo 状态
   * 扫描所有 toolResult(todo) entries，按顺序重放
   */
  function reconstructFromSession(ctx) {
    todos = [];
    nextId = 1;

    try {
      const branch = ctx?.sessionManager?.getBranch?.();
      if (!branch) return;

      for (const entry of branch) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

        const details = msg.details;
        if (details?.todos) {
          todos = details.todos;
          nextId = details.nextId ?? (todos.length + 1);
        }
      }
    } catch (err) {
      console.error("[todo] state reconstruction failed:", err.message);
    }
  }

  /**
   * 确保状态与当前 session 同步
   * 如果 session 变了（session ID 不同），重新扫描历史
   */
  function ensureState(ctx) {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (sessionId && sessionId !== _reconstructedSessionId) {
      reconstructFromSession(ctx);
      _reconstructedSessionId = sessionId;
    }
  }

  /** 构建当前快照（写入 details 供未来重建） */
  function snapshot(action) {
    return { action, todos: [...todos], nextId };
  }

  return {
    name: "todo",
    label: "待办",
    description:
      "管理当前 session 内的待办清单。" +
      "在执行多步骤任务时，用这个工具追踪进度、拆分子任务。\n" +
      "操作：\n" +
      "- list：查看所有待办\n" +
      "- add(text)：添加一条待办\n" +
      "- toggle(id)：切换完成状态\n" +
      "- clear：清空所有待办",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("add"),
        Type.Literal("toggle"),
        Type.Literal("clear"),
      ], { description: "操作类型" }),
      text: Type.Optional(Type.String({ description: "待办内容（add 时必填）" })),
      id: Type.Optional(Type.Number({ description: "待办 ID（toggle 时必填）" })),
    }),

    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      // 确保状态与当前 session 同步
      ensureState(ctx);

      switch (params.action) {
        case "list": {
          const text = todos.length
            ? todos.map(t => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
            : "没有待办";
          return {
            content: [{ type: "text", text }],
            details: snapshot("list"),
          };
        }

        case "add": {
          if (!params.text) {
            return {
              content: [{ type: "text", text: "错误：add 需要提供 text 参数" }],
              details: { ...snapshot("add"), error: "text required" },
            };
          }
          const newTodo = { id: nextId++, text: params.text, done: false };
          todos.push(newTodo);
          return {
            content: [{ type: "text", text: `添加待办 #${newTodo.id}: ${newTodo.text}` }],
            details: snapshot("add"),
          };
        }

        case "toggle": {
          if (params.id === undefined) {
            return {
              content: [{ type: "text", text: "错误：toggle 需要提供 id 参数" }],
              details: { ...snapshot("toggle"), error: "id required" },
            };
          }
          const todo = todos.find(t => t.id === params.id);
          if (!todo) {
            return {
              content: [{ type: "text", text: `待办 #${params.id} 不存在` }],
              details: { ...snapshot("toggle"), error: `#${params.id} not found` },
            };
          }
          todo.done = !todo.done;
          return {
            content: [{ type: "text", text: `待办 #${todo.id} ${todo.done ? "✓ 完成" : "○ 未完成"}` }],
            details: snapshot("toggle"),
          };
        }

        case "clear": {
          const count = todos.length;
          todos = [];
          nextId = 1;
          return {
            content: [{ type: "text", text: `已清空 ${count} 条待办` }],
            details: snapshot("clear"),
          };
        }

        default:
          return {
            content: [{ type: "text", text: `未知操作: ${params.action}` }],
            details: snapshot("list"),
          };
      }
    },
  };
}
