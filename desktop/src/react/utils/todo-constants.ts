/**
 * todo-constants.ts — 前端镜像
 *
 * 后端真实来源：project-hana/lib/tools/todo-constants.js
 * 这两个文件必须保持同步。任何改动都要改两处。
 *
 * 命名不对称说明：tool 名用 snake_case（todo_write），对齐 SDK built-in
 * wire format；i18n key 用 camelCase (toolDef.todoWrite)，对齐 JS 属性命名
 * 惯例。跨领域的不对称是故意的。
 */

/** 新 tool 正式名（对标 Claude Code TodoWrite） */
export const TODO_WRITE_TOOL_NAME = "todo_write" as const;

/** 所有被识别为 todo 相关的 tool 名字 */
export const TODO_TOOL_NAMES = ["todo", TODO_WRITE_TOOL_NAME] as const;

export type TodoToolName = typeof TODO_TOOL_NAMES[number];
