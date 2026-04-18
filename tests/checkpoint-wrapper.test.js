import { describe, it, expect, vi, beforeEach } from "vitest";
import { wrapWithCheckpoint } from "../lib/checkpoint-wrapper.js";

function makeTool(name, execute) {
  return { name, execute: execute || vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
}

function makeStore() {
  return { save: vi.fn(async () => "ckpt-001") };
}

describe("wrapWithCheckpoint", () => {
  let store;

  beforeEach(() => {
    store = makeStore();
  });

  it("wraps write tool — saves before execute", async () => {
    const writeTool = makeTool("write");
    const [wrapped] = wrapWithCheckpoint([writeTool], {
      store,
      maxFileSizeKb: 1024,
      cwd: "/project",
      getSessionPath: () => "sessions/test",
    });

    await wrapped.execute("t1", { path: "src/foo.js" });

    expect(store.save).toHaveBeenCalledWith({
      sessionPath: "sessions/test",
      tool: "write",
      filePath: "/project/src/foo.js",
      maxSizeKb: 1024,
    });
    expect(writeTool.execute).toHaveBeenCalled();
  });

  it("wraps edit tool — saves before execute", async () => {
    const editTool = makeTool("edit");
    const [wrapped] = wrapWithCheckpoint([editTool], {
      store,
      maxFileSizeKb: 1024,
      cwd: "/project",
      getSessionPath: () => null,
    });

    await wrapped.execute("t2", { path: "/absolute/bar.ts" });

    expect(store.save).toHaveBeenCalledWith({
      sessionPath: null,
      tool: "edit",
      filePath: "/absolute/bar.ts",
      maxSizeKb: 1024,
    });
  });

  it("wraps bash rm — detects rm and saves target", async () => {
    const bashTool = makeTool("bash");
    const [wrapped] = wrapWithCheckpoint([bashTool], {
      store,
      maxFileSizeKb: 1024,
      cwd: "/project",
      getSessionPath: () => null,
    });

    await wrapped.execute("t3", { command: "rm src/old.js" });

    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "bash:rm", filePath: "/project/src/old.js" }),
    );
  });

  it("wraps bash mv — saves destination if present", async () => {
    const bashTool = makeTool("bash");
    const [wrapped] = wrapWithCheckpoint([bashTool], {
      store,
      maxFileSizeKb: 1024,
      cwd: "/project",
      getSessionPath: () => null,
    });

    await wrapped.execute("t4", { command: "mv src/a.js src/b.js" });

    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "bash:mv", filePath: "/project/src/b.js" }),
    );
  });

  it("does not wrap unrelated tools", async () => {
    const grepTool = makeTool("grep");
    const [wrapped] = wrapWithCheckpoint([grepTool], {
      store,
      maxFileSizeKb: 1024,
      cwd: "/project",
      getSessionPath: () => null,
    });

    await wrapped.execute("t5", { pattern: "foo" });
    expect(store.save).not.toHaveBeenCalled();
  });

  it("still executes tool even if save fails", async () => {
    store.save = vi.fn(async () => { throw new Error("disk full"); });
    const writeTool = makeTool("write");
    const [wrapped] = wrapWithCheckpoint([writeTool], {
      store,
      maxFileSizeKb: 1024,
      cwd: "/project",
      getSessionPath: () => null,
    });

    const result = await wrapped.execute("t6", { path: "src/foo.js" });
    expect(writeTool.execute).toHaveBeenCalled();
  });
});
