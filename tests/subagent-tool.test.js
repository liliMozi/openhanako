import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSubagentTool } from "../lib/tools/subagent-tool.js";

// ---- helpers ----------------------------------------------------------------

/** Mock Pi SDK ctx with sessionManager */
const mockCtx = (sp = "/test/session.jsonl") => ({
  sessionManager: { getSessionFile: () => sp },
});

/**
 * Build a mock executeIsolated that:
 *  - calls opts.onSessionReady(sessionPath) synchronously if provided
 *  - resolves with the given result
 */
function makeExecuteIsolated(
  result = { replyText: "done", error: null, sessionPath: "/test/child.jsonl" },
) {
  return vi.fn().mockImplementation((_prompt, opts) => {
    if (typeof opts?.onSessionReady === "function") {
      opts.onSessionReady("/test/child.jsonl");
    }
    return Promise.resolve(result);
  });
}

function makeDeps(overrides = {}) {
  return {
    executeIsolated: makeExecuteIsolated(),
    resolveUtilityModel: () => "utility-model",
    getDeferredStore: () => ({
      defer: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
      query: vi.fn(() => ({ meta: {} })),
      _save: vi.fn(),
    }),
    getSessionPath: () => "/test/session.jsonl",
    listAgents: vi.fn(() => [
      { id: "hana", name: "Hana", model: "claude-3-5-sonnet", summary: "主 agent" },
      { id: "other-agent", name: "Other", model: "gpt-4", summary: "专家 agent" },
    ]),
    currentAgentId: "hana",
    agentDir: "/test/agents/hana",
    emitEvent: vi.fn(),
    ...overrides,
  };
}

// ---- tests ------------------------------------------------------------------

describe("subagent-tool (executeIsolated 原子模式)", () => {
  let mockStore;
  let deps;

  beforeEach(() => {
    mockStore = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn(), query: vi.fn(() => ({ meta: {} })), _save: vi.fn() };
    deps = makeDeps({ getDeferredStore: () => mockStore });
  });

  // 1. fire-and-forget: returns immediately with taskId / streamStatus / sessionPath
  it("dispatches task and returns immediately with running status", async () => {
    const tool = createSubagentTool(deps);
    const result = await tool.execute("call_1", { task: "查一下项目状态" }, null, null, mockCtx());

    // t() returns the key path when locale is not loaded in tests
    expect(result.content[0].text).toMatch(/task-id|subagentDispatched/);
    expect(result.details).toBeDefined();
    expect(result.details.taskId).toMatch(/^subagent-/);
    expect(result.details.streamStatus).toBe("running");
    expect(result.details.sessionPath).toBeNull();
    expect(result.details.task).toBe("查一下项目状态");

    // store.defer is called before returning
    expect(mockStore.defer).toHaveBeenCalledWith(
      expect.stringMatching(/^subagent-/),
      "/test/session.jsonl",
      expect.objectContaining({ type: "subagent" }),
    );
  });

  // 2. deferred store resolves on success
  it("resolves deferred store on success", async () => {
    const tool = createSubagentTool(deps);
    await tool.execute("call_1", { task: "成功的任务" }, null, null, mockCtx());

    await vi.waitFor(() => {
      expect(mockStore.resolve).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        "done",
      );
    });
    expect(mockStore.fail).not.toHaveBeenCalled();
  });

  // 3. deferred store fails when executeIsolated returns an error
  it("fails deferred store when result.error is set", async () => {
    const failingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return Promise.resolve({ replyText: null, error: "boom", sessionPath: null });
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: failingExecute,
      getDeferredStore: () => mockStore,
    }));

    await tool.execute("call_1", { task: "会失败的任务" }, null, null, mockCtx());

    await vi.waitFor(() => {
      expect(mockStore.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        "boom",
      );
    });
    expect(mockStore.resolve).not.toHaveBeenCalled();
  });

  // 4. emits block_update with streamStatus: done on success
  it("emits block_update with streamStatus done on success", async () => {
    const emitEvent = vi.fn();
    const tool = createSubagentTool(makeDeps({
      getDeferredStore: () => mockStore,
      emitEvent,
    }));

    const result = await tool.execute("call_1", { task: "完成的任务" }, null, null, mockCtx());
    const { taskId } = result.details;

    await vi.waitFor(() => {
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "block_update",
          taskId,
          patch: expect.objectContaining({ streamStatus: "done" }),
        }),
        "/test/session.jsonl",
      );
    });
  });

  // 5. emits block_update with streamStatus: failed on failure
  it("emits block_update with streamStatus failed on failure", async () => {
    const emitEvent = vi.fn();
    const errorExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return Promise.resolve({ replyText: null, error: "network error", sessionPath: null });
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: errorExecute,
      getDeferredStore: () => mockStore,
      emitEvent,
    }));

    const result = await tool.execute("call_1", { task: "失败的任务" }, null, null, mockCtx());
    const { taskId } = result.details;

    await vi.waitFor(() => {
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "block_update",
          taskId,
          patch: expect.objectContaining({ streamStatus: "failed" }),
        }),
        "/test/session.jsonl",
      );
    });
  });

  // 6. per-session concurrent limit: rejects 6th task on the same session
  it("rejects new work when the per-session limit (5) is reached", async () => {
    const pending = [];
    const blockingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((resolve) => pending.push(resolve));
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
    }));

    // Dispatch 5 tasks on the same session (fire-and-forget)
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await tool.execute(`call_${i}`, { task: `任务 ${i}` }, null, null, mockCtx()));
    }
    for (const r of results) {
      expect(r.details.streamStatus).toBe("running");
    }

    // 6th task on the same session must be rejected
    const blocked = await tool.execute("call_5", { task: "第六个任务" }, null, null, mockCtx());
    expect(blocked.content[0].text).toMatch(/5|subagentMaxConcurrent/);
    expect(blocked.details).toBeUndefined();

    // Cleanup
    for (const resolve of pending) {
      resolve({ replyText: "ok", error: null, sessionPath: null });
    }
  });

  // 6b. different sessions each get their own per-session quota
  it("allows different sessions to each run up to per-session limit", async () => {
    const pending = [];
    const blockingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((resolve) => pending.push(resolve));
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
    }));

    // Session A: dispatch 5 tasks
    for (let i = 0; i < 5; i++) {
      const r = await tool.execute(`call_a${i}`, { task: `任务 A${i}` }, null, null, mockCtx("/session/a.jsonl"));
      expect(r.details.streamStatus).toBe("running");
    }

    // Session B: should still be able to dispatch 5 tasks (independent quota)
    for (let i = 0; i < 5; i++) {
      const r = await tool.execute(`call_b${i}`, { task: `任务 B${i}` }, null, null, mockCtx("/session/b.jsonl"));
      expect(r.details.streamStatus).toBe("running");
    }

    // Session A: 6th task should be rejected
    const blockedA = await tool.execute("call_a5", { task: "第六个 A" }, null, null, mockCtx("/session/a.jsonl"));
    expect(blockedA.content[0].text).toMatch(/5|subagentMaxConcurrent/);
    expect(blockedA.details).toBeUndefined();

    // Session B: 4th task should also be rejected
    const blockedB = await tool.execute("call_b3", { task: "第四个 B" }, null, null, mockCtx("/session/b.jsonl"));
    expect(blockedB.content[0].text).toMatch(/3|subagentMaxConcurrent/);
    expect(blockedB.details).toBeUndefined();

    // Cleanup
    for (const resolve of pending) {
      resolve({ replyText: "ok", error: null, sessionPath: null });
    }
  });

  // 6c. global limit (15) rejects when total across all sessions exceeds it
  it("rejects when global limit (15) is reached across sessions", async () => {
    const pending = [];
    const blockingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((resolve) => pending.push(resolve));
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
    }));

    // Fill up 15 tasks across 3 sessions (5 + 5 + 5)
    for (let s = 0; s < 3; s++) {
      for (let i = 0; i < 5; i++) {
        const r = await tool.execute(`call_${s}_${i}`, { task: `任务` }, null, null, mockCtx(`/session/${s}.jsonl`));
        expect(r.details.streamStatus).toBe("running");
      }
    }

    // 16th task from a new session (per-session is fine, but global is full)
    const blocked = await tool.execute("call_3_0", { task: "第16个" }, null, null, mockCtx("/session/3.jsonl"));
    expect(blocked.content[0].text).toMatch(/15|subagentMaxConcurrent/);
    expect(blocked.details).toBeUndefined();

    // Cleanup
    for (const resolve of pending) {
      resolve({ replyText: "ok", error: null, sessionPath: null });
    }
  });

  // 7. discovery mode: agent="?" lists agents (excluding self)
  it("lists agents in discovery mode (agent=?)", async () => {
    const noopExecute = vi.fn();
    const tool = createSubagentTool(makeDeps({
      executeIsolated: noopExecute,
      listAgents: () => [
        { id: "hana", name: "Hana", model: "claude-3-5-sonnet", summary: "主 agent" },
        { id: "other-agent", name: "Other", model: "gpt-4", summary: "专家 agent" },
      ],
      currentAgentId: "hana",
    }));

    const result = await tool.execute("call_1", { task: "", agent: "?" });

    expect(result.content[0].text).toContain("other-agent");
    expect(result.content[0].text).toContain("Other");
    // self should be excluded
    expect(result.content[0].text).not.toContain("hana (");
    // executeIsolated must not be called in discovery mode
    expect(noopExecute).not.toHaveBeenCalled();
  });

  // 8. cross-agent delegation: agentId forwarded in opts
  it("passes agentId to executeIsolated when delegating to another agent", async () => {
    const captureExecute = makeExecuteIsolated({ replyText: "delegated", error: null, sessionPath: "/test/child.jsonl" });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: captureExecute,
      getDeferredStore: () => mockStore,
    }));

    const result = await tool.execute("call_1", { task: "专项任务", agent: "other-agent" }, null, null, mockCtx());

    expect(result.details.agentId).toBe("other-agent");
    expect(captureExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ agentId: "other-agent" }),
    );
  });

  // 9. unknown agent returns error without calling executeIsolated
  it("returns error when agent id is unknown", async () => {
    const noopExecute = vi.fn();
    const tool = createSubagentTool(makeDeps({ executeIsolated: noopExecute }));

    const result = await tool.execute("call_1", { task: "任务", agent: "nonexistent" });

    // t() falls back to the key when locale is not loaded
    expect(result.content[0].text).toMatch(/agentNotFound|not found|不存在/);
    expect(noopExecute).not.toHaveBeenCalled();
  });

  // 10. sync fallback when deferred store is unavailable
  it("falls back to sync execution when deferred store is unavailable", async () => {
    const syncExecute = makeExecuteIsolated({ replyText: "sync result", error: null, sessionPath: null });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: syncExecute,
      getDeferredStore: () => null,
      getSessionPath: () => null,
    }));

    const result = await tool.execute("call_1", { task: "同步任务" });

    // sync fallback returns the reply text directly (no details / streamStatus)
    expect(result.content[0].text).toBe("sync result");
    expect(result.details).toBeUndefined();
  });
});
