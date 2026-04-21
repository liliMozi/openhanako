/**
 * todo-compat.js — 旧格式 → 新格式转换的纯函数
 *
 * 无状态、无副作用。前端镜像：desktop/src/react/utils/todo-compat.ts，
 * 必须保持同步。
 *
 * 旧格式（Pi SDK example 移植版）：
 *   { action, todos: [{id, text, done}], nextId }
 *
 * 新格式（对标 Claude Code TodoWrite）：
 *   { todos: [{content, activeForm, status}], warning? }
 *
 * 健壮性约定：
 * - 损坏 item（既不是 legacy 也不是 new）直接丢弃，不再 sanitize 成空串
 *   item。空字符串 item 渲染会导致空白行，污染 UI。
 * - extractLatestTodos 遇到缺失 / 非数组 details.todos 的 tool_result 视为
 *   "坏快照"，继续向前扫描。只有 details.todos 是数组（空数组也算）时才
 *   视为合法快照并返回。这样显式清空（todos: []）和坏数据能区分开。
 */

import fs from "fs/promises";
import { parseSessionEntries, buildSessionContext } from "@mariozechner/pi-coding-agent";
import { TODO_TOOL_NAMES } from "./todo-constants.js";

const VALID_STATUSES = new Set(["pending", "in_progress", "completed"]);

function isLegacyTodoItem(item) {
  return item && typeof item === "object" && typeof item.done === "boolean";
}

function isNewTodoItem(item) {
  return (
    item &&
    typeof item === "object" &&
    typeof item.content === "string" &&
    typeof item.activeForm === "string" &&
    VALID_STATUSES.has(item.status)
  );
}

function migrateLegacyItem(old) {
  return {
    content: old.text ?? "",
    activeForm: old.text ?? "",  // decision 3: fallback 到 content
    status: old.done ? "completed" : "pending",
  };
}

/**
 * 把 details.todos 数组转成新格式数组。
 * 损坏 item 直接丢弃（记录 error），不回填。
 */
export function migrateLegacyTodos(details) {
  if (!details || typeof details !== "object") return [];
  const todos = details.todos;
  if (!Array.isArray(todos)) return [];
  const result = [];
  for (const item of todos) {
    if (isLegacyTodoItem(item)) {
      result.push(migrateLegacyItem(item));
      continue;
    }
    if (isNewTodoItem(item)) {
      result.push(item);
      continue;
    }
    console.error("[todo-compat] 丢弃损坏的 todo item:", item);
  }
  return result;
}

/**
 * 判定一个 tool_result 的 details 是否是合法的 todo 快照。
 * 合法 = details.todos 存在且是数组。空数组算合法（显式清空）。
 */
function isValidTodoSnapshot(details) {
  return !!details
    && typeof details === "object"
    && Array.isArray(details.todos);
}

/**
 * 在一个线性消息数组中从后往前找最后一个合法 todo 快照。
 * 坏快照（details.todos 缺失或非数组）跳过继续向前。
 */
export function extractLatestTodos(sourceMessages) {
  if (!Array.isArray(sourceMessages)) return null;
  for (let i = sourceMessages.length - 1; i >= 0; i--) {
    const m = sourceMessages[i];
    if (!m || m.role !== "toolResult") continue;
    if (!TODO_TOOL_NAMES.includes(m.toolName)) continue;
    if (!isValidTodoSnapshot(m.details)) {
      console.error("[todo-compat] 跳过坏 todo 快照，继续向前扫描:", {
        toolName: m.toolName,
        details: m.details,
      });
      continue;
    }
    return migrateLegacyTodos(m.details);
  }
  return null;
}

/**
 * Branch-aware：从 session entries 沿当前 leaf 回溯到 root，
 * 只在当前分支路径上扫描最新 todo 快照。
 *
 * Pi SDK session 是 parent/child 树，file 物理顺序可能包含被抛弃的分支，
 * 直接按 file 顺序扫会取到错误分支的状态。必须先用 buildSessionContext
 * 走 leaf-to-root 路径。
 */
export function extractLatestTodosFromEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const header = entries[0];
  if (!header || header.type !== "session") return null;
  const { messages } = buildSessionContext(entries);
  return extractLatestTodos(messages);
}

/**
 * 从一个 session 文件读取 entries 并提取 branch-aware 的最新 todos。
 * 文件读取失败或无有效 header 返回 null。
 */
export async function loadLatestTodosFromSessionFile(sessionPath) {
  if (!sessionPath) return null;
  try {
    const raw = await fs.readFile(sessionPath, "utf-8");
    const entries = parseSessionEntries(raw);
    return extractLatestTodosFromEntries(entries);
  } catch {
    return null;
  }
}
