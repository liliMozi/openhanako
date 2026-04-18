/**
 * todo.js — todo_write tool
 *
 * 对标 Claude Code 的 TodoWrite：替换式协议、三态状态机、content/activeForm 双文本。
 * 完全无状态：不持有闭包变量，每次调用从参数构建返回值。
 *
 * 历史状态重建由 lib/tools/todo-compat.js 的 extractLatestTodos 负责，
 * session_coordinator / sessions.js route 从 session entries 里读取。
 */

import { Type } from "@sinclair/typebox";
import { StringEnum } from "../pi-sdk/index.js";
import { t } from "../../server/i18n.js";
import { TODO_WRITE_TOOL_NAME } from "./todo-constants.js";

const TODO_STATUS_VALUES = ["pending", "in_progress", "completed"];

/**
 * 校验并构建文本摘要
 */
function buildSummary(todos) {
  if (todos.length === 0) return t("toolDef.todoWrite.summaryEmpty");
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const td of todos) counts[td.status] = (counts[td.status] || 0) + 1;
  return t("toolDef.todoWrite.summaryStats", {
    total: todos.length,
    completed: counts.completed,
    in_progress: counts.in_progress,
    pending: counts.pending,
  });
}

/**
 * 检测多 in_progress，返回 warning 字符串或 null
 */
function detectMultiInProgress(todos) {
  const count = todos.filter(td => td.status === "in_progress").length;
  if (count > 1) {
    return `multiple in_progress: ${count} (convention violated; showing all)`;
  }
  return null;
}

/**
 * 创建 todo_write 工具定义
 * @returns {import('../pi-sdk/index.js').ToolDefinition}
 */
export function createTodoTool() {
  return {
    name: TODO_WRITE_TOOL_NAME,
    label: t("toolDef.todoWrite.label"),
    description: t("toolDef.todoWrite.description"),
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String({
            minLength: 1,
            description: t("toolDef.todoWrite.contentDesc"),
          }),
          activeForm: Type.String({
            minLength: 1,
            description: t("toolDef.todoWrite.activeFormDesc"),
          }),
          status: StringEnum(TODO_STATUS_VALUES, {
            description: t("toolDef.todoWrite.statusDesc"),
          }),
        }),
        { description: t("toolDef.todoWrite.todosDesc") },
      ),
    }),

    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const todos = params.todos || [];
      const warning = detectMultiInProgress(todos);
      if (warning) {
        console.warn(`[todo_write] ${warning}`);
      }

      const summary = buildSummary(todos);
      const details = { todos };
      if (warning) details.warning = warning;

      return {
        content: [{ type: "text", text: summary }],
        details,
      };
    },
  };
}
