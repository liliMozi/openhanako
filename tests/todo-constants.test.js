/**
 * todo-constants.js — shared constants smoke test
 *
 * Verifies that the shared constants module exports the expected
 * names and that "todo" (legacy) and "todo_write" (new) are both present.
 */
import { describe, it, expect } from "vitest";
import { TODO_TOOL_NAMES, TODO_WRITE_TOOL_NAME } from "../lib/tools/todo-constants.js";

describe("todo-constants", () => {
  it("exports TODO_TOOL_NAMES containing both legacy and new names", () => {
    expect(Array.isArray(TODO_TOOL_NAMES)).toBe(true);
    expect(TODO_TOOL_NAMES).toContain("todo");
    expect(TODO_TOOL_NAMES).toContain("todo_write");
    expect(TODO_TOOL_NAMES.length).toBe(2);
  });

  it("exports TODO_WRITE_TOOL_NAME as 'todo_write'", () => {
    expect(TODO_WRITE_TOOL_NAME).toBe("todo_write");
  });

  it("TODO_TOOL_NAMES is frozen (immutable)", () => {
    expect(Object.isFrozen(TODO_TOOL_NAMES)).toBe(true);
  });
});
