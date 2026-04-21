/**
 * todo.js todo_write tool unit tests
 *
 * Covers:
 * - Replacement-style semantics: input todos → output details.todos
 * - Empty array handling (clear semantics)
 * - Schema validation: missing content / activeForm / invalid status
 * - Multi-in_progress: warning in details + console.warn call (soft, not hard)
 * - Idempotency: same input produces same output (no hidden state)
 * - Tool metadata: name === "todo_write"
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { loadLocale } from "../server/i18n.js";
import { createTodoTool } from "../lib/tools/todo.js";
import { TODO_WRITE_TOOL_NAME } from "../lib/tools/todo-constants.js";

beforeEach(() => {
  loadLocale("en");
});

describe("todo_write tool", () => {
  it("has name 'todo_write'", () => {
    const tool = createTodoTool();
    expect(tool.name).toBe(TODO_WRITE_TOOL_NAME);
  });

  it("returns todos unchanged in details (replacement semantics)", async () => {
    const tool = createTodoTool();
    const input = {
      todos: [
        { content: "read spec", activeForm: "reading spec", status: "completed" },
        { content: "analyze arch", activeForm: "analyzing arch", status: "in_progress" },
        { content: "write code", activeForm: "writing code", status: "pending" },
      ],
    };
    const result = await tool.execute("tc-1", input, null, null, {});
    expect(result.details.todos).toEqual(input.todos);
  });

  it("handles empty todos array (clear semantics)", async () => {
    const tool = createTodoTool();
    const result = await tool.execute("tc-1", { todos: [] }, null, null, {});
    expect(result.details.todos).toEqual([]);
    // Matches "Cleared todos" (en) / "清空待办" (zh) / similar / or literal i18n key
    expect(result.content[0].text).toMatch(/cleared|empty|clear|清空|summaryEmpty/i);
  });

  it("schema rejects empty content string", () => {
    const tool = createTodoTool();
    const invalid = {
      todos: [{ content: "", activeForm: "doing", status: "pending" }],
    };
    expect(Value.Check(tool.parameters, invalid)).toBe(false);
  });

  it("schema rejects empty activeForm string", () => {
    const tool = createTodoTool();
    const invalid = {
      todos: [{ content: "x", activeForm: "", status: "pending" }],
    };
    expect(Value.Check(tool.parameters, invalid)).toBe(false);
  });

  it("schema exposes the expected shape for todo items", () => {
    const tool = createTodoTool();
    const todoItemSchema = tool.parameters.properties.todos.items.properties;
    // content and activeForm must be strings with minLength 1
    expect(todoItemSchema.content.type).toBe("string");
    expect(todoItemSchema.content.minLength).toBe(1);
    expect(todoItemSchema.activeForm.type).toBe("string");
    expect(todoItemSchema.activeForm.minLength).toBe(1);
    // status must be a string enum with exactly the three allowed values
    expect(todoItemSchema.status.type).toBe("string");
    expect(todoItemSchema.status.enum).toEqual(["pending", "in_progress", "completed"]);
    expect(todoItemSchema.status.enum).not.toContain("bogus");
  });

  it("is idempotent: two instances with same input produce same output", async () => {
    const input = {
      todos: [
        { content: "a", activeForm: "doing a", status: "pending" },
      ],
    };
    const tool1 = createTodoTool();
    const tool2 = createTodoTool();
    const r1 = await tool1.execute("tc-1", input, null, null, {});
    const r2 = await tool2.execute("tc-2", input, null, null, {});
    expect(r1.details.todos).toEqual(r2.details.todos);
  });

  it("has no hidden state across calls", async () => {
    const tool = createTodoTool();
    await tool.execute("tc-1", {
      todos: [{ content: "a", activeForm: "doing a", status: "pending" }],
    }, null, null, {});
    const result = await tool.execute("tc-2", {
      todos: [{ content: "b", activeForm: "doing b", status: "completed" }],
    }, null, null, {});
    expect(result.details.todos).toHaveLength(1);
    expect(result.details.todos[0].content).toBe("b");
  });

  it("warns on multiple in_progress but does not reject", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tool = createTodoTool();
    const input = {
      todos: [
        { content: "a", activeForm: "doing a", status: "in_progress" },
        { content: "b", activeForm: "doing b", status: "in_progress" },
      ],
    };
    const result = await tool.execute("tc-1", input, null, null, {});

    expect(result.details.todos).toHaveLength(2);
    expect(result.details.warning).toMatch(/in_progress/i);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not warn on zero or one in_progress", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tool = createTodoTool();

    await tool.execute("tc-1", {
      todos: [{ content: "a", activeForm: "doing a", status: "pending" }],
    }, null, null, {});
    await tool.execute("tc-2", {
      todos: [{ content: "b", activeForm: "doing b", status: "in_progress" }],
    }, null, null, {});

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
