import { describe, it, expect, vi } from "vitest";
import { TaskRegistry } from "../lib/task-registry.js";

describe("TaskRegistry", () => {
  it("registerHandler validates abort method", () => {
    const reg = new TaskRegistry();
    expect(() => reg.registerHandler("test", {})).toThrow("must have an abort");
    expect(() => reg.registerHandler("test", { abort: "not a fn" })).toThrow("must have an abort");
  });

  it("register + query returns task info", () => {
    const reg = new TaskRegistry();
    reg.registerHandler("test", { abort: vi.fn() });
    reg.register("t1", { type: "test", parentSessionPath: "/p1" });
    const task = reg.query("t1");
    expect(task).toBeTruthy();
    expect(task.type).toBe("test");
    expect(task.parentSessionPath).toBe("/p1");
    expect(task.aborted).toBe(false);
  });

  it("abort dispatches to handler and returns 'aborted'", () => {
    const reg = new TaskRegistry();
    const abortFn = vi.fn();
    reg.registerHandler("test", { abort: abortFn });
    reg.register("t1", { type: "test", parentSessionPath: "/p1" });
    const result = reg.abort("t1");
    expect(result).toBe("aborted");
    expect(abortFn).toHaveBeenCalledWith("t1");
    expect(reg.query("t1").aborted).toBe(true);
  });

  it("abort with no handler returns 'no_handler'", () => {
    const reg = new TaskRegistry();
    // register task without registering handler first
    reg.register("t1", { type: "unknown", parentSessionPath: "/p1" });
    expect(reg.abort("t1")).toBe("no_handler");
  });

  it("abort on unknown taskId returns 'not_found'", () => {
    const reg = new TaskRegistry();
    expect(reg.abort("nope")).toBe("not_found");
  });

  it("double abort returns 'already_aborted'", () => {
    const reg = new TaskRegistry();
    reg.registerHandler("test", { abort: vi.fn() });
    reg.register("t1", { type: "test", parentSessionPath: "/p1" });
    reg.abort("t1");
    expect(reg.abort("t1")).toBe("already_aborted");
  });

  it("remove cleans up the task", () => {
    const reg = new TaskRegistry();
    reg.registerHandler("test", { abort: vi.fn() });
    reg.register("t1", { type: "test", parentSessionPath: "/p1" });
    reg.remove("t1");
    expect(reg.query("t1")).toBeNull();
  });

  it("unregisterHandler removes handler", () => {
    const reg = new TaskRegistry();
    reg.registerHandler("test", { abort: vi.fn() });
    reg.unregisterHandler("test");
    reg.register("t1", { type: "test", parentSessionPath: "/p1" });
    expect(reg.abort("t1")).toBe("no_handler");
  });

  it("listByType filters by type", () => {
    const reg = new TaskRegistry();
    reg.registerHandler("a", { abort: vi.fn() });
    reg.registerHandler("b", { abort: vi.fn() });
    reg.register("t1", { type: "a", parentSessionPath: "/p1" });
    reg.register("t2", { type: "b", parentSessionPath: "/p2" });
    reg.register("t3", { type: "a", parentSessionPath: "/p3" });
    const aList = reg.listByType("a");
    expect(aList).toHaveLength(2);
    expect(aList.map(t => t.taskId)).toEqual(["t1", "t3"]);
  });

  it("listAll returns all tasks", () => {
    const reg = new TaskRegistry();
    reg.registerHandler("a", { abort: vi.fn() });
    reg.register("t1", { type: "a", parentSessionPath: "/p1" });
    reg.register("t2", { type: "a", parentSessionPath: "/p2" });
    expect(reg.listAll()).toHaveLength(2);
  });
});
