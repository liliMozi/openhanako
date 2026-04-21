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
    persistSubagentSessionMeta: vi.fn(async () => {}),
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
    const task = "任务：查一下项目状态\n\n请阅读当前仓库的未提交改动，并总结风险。";
    const result = await tool.execute("call_1", { task }, null, null, mockCtx());

    // t() returns the key path when locale is not loaded in tests
    expect(result.content[0].text).toMatch(/task-id|subagentDispatched/);
    expect(result.details).toBeDefined();
    expect(result.details.taskId).toMatch(/^subagent-/);
    expect(result.details.streamStatus).toBe("running");
    expect(result.details.sessionPath).toBeNull();
    expect(result.details.task).toBe(task);
    expect(result.details.taskTitle).toBe("任务：查一下项目状态");
    expect(result.details.agentId).toBe("hana");
    expect(result.details.agentName).toBe("Hana");
    expect(result.details.requestedAgentId).toBe("hana");
    expect(result.details.requestedAgentNameSnapshot).toBe("Hana");
    expect(result.details.executorAgentId).toBe("hana");
    expect(result.details.executorAgentNameSnapshot).toBe("Hana");
    expect(result.details.executorMetaVersion).toBe(1);

    // store.defer is called before returning
    expect(mockStore.defer).toHaveBeenCalledWith(
      expect.stringMatching(/^subagent-/),
      "/test/session.jsonl",
      expect.objectContaining({ type: "subagent", summary: "任务：查一下项目状态" }),
    );
  });

  it("self-dispatch emits actual agent identity with session-ready patch", async () => {
    const emitEvent = vi.fn();
    const persistSubagentSessionMeta = vi.fn(async () => {});
    const tool = createSubagentTool(makeDeps({
      getDeferredStore: () => mockStore,
      emitEvent,
      persistSubagentSessionMeta,
    }));

    const result = await tool.execute("call_1", { task: "当前 agent 自己执行" }, null, null, mockCtx());
    const { taskId } = result.details;

    await vi.waitFor(() => {
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "block_update",
          taskId,
          patch: expect.objectContaining({
            streamKey: "/test/child.jsonl",
            agentId: "hana",
            agentName: "Hana",
            requestedAgentId: "hana",
            requestedAgentNameSnapshot: "Hana",
            executorAgentId: "hana",
            executorAgentNameSnapshot: "Hana",
          }),
        }),
        "/test/session.jsonl",
      );
    });

    await vi.waitFor(() => {
      expect(persistSubagentSessionMeta).toHaveBeenCalledWith(
        "/test/child.jsonl",
        expect.objectContaining({
          executorAgentId: "hana",
          executorAgentNameSnapshot: "Hana",
          executorMetaVersion: 1,
        }),
      );
    });
  });

  it("uses the original first line as taskTitle and dispatches task unchanged", async () => {
    const executeIsolated = makeExecuteIsolated();
    const tool = createSubagentTool(makeDeps({
      executeIsolated,
      getDeferredStore: () => mockStore,
    }));

    const task = "你是一个生活规划助手。请为用户制定一份**一周生活规律建议**，涵盖以下五个方面：\n\n1. 作息\n2. 运动";
    const result = await tool.execute("call_1", { task }, null, null, mockCtx());

    expect(result.details.taskTitle).toBe("你是一个生活规划助手。请为用户制定一份**一周生活规律建议**，涵盖以下五个方面：");
    expect(executeIsolated).toHaveBeenCalledWith(
      task,
      expect.any(Object),
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

  it("does not silently fallback to current agent when delegated execution fails", async () => {
    const executeIsolated = vi.fn().mockRejectedValue(new Error("delegated boom"));
    const emitEvent = vi.fn();
    const tool = createSubagentTool(makeDeps({
      executeIsolated,
      getDeferredStore: () => mockStore,
      emitEvent,
      listAgents: vi.fn(() => [
        { id: "hana", name: "Hana" },
        { id: "butter", name: "butter" },
      ]),
    }));

    const result = await tool.execute("call_1", { task: "委派任务", agent: "butter" }, null, null, mockCtx());

    expect(result.details.requestedAgentId).toBe("butter");
    expect(result.details.executorAgentId).toBe("butter");
    await vi.waitFor(() => {
      expect(mockStore.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        "delegated boom",
      );
    });
    expect(executeIsolated).toHaveBeenCalledTimes(1);
    expect(executeIsolated).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ agentId: "butter" }),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "block_update",
        patch: expect.objectContaining({ streamStatus: "failed", summary: "delegated boom" }),
      }),
      "/test/session.jsonl",
    );
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

  // 6. per-session concurrent limit: rejects 9th task on the same session
  it("rejects new work when the per-session limit (8) is reached", async () => {
    const pending = [];
    const blockingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((resolve) => pending.push(resolve));
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
    }));

    // Dispatch 8 tasks on the same session (fire-and-forget)
    const results = [];
    for (let i = 0; i < 8; i++) {
      results.push(await tool.execute(`call_${i}`, { task: `任务 ${i}` }, null, null, mockCtx()));
    }
    for (const r of results) {
      expect(r.details.streamStatus).toBe("running");
    }

    // 9th task on the same session must be rejected
    const blocked = await tool.execute("call_8", { task: "第九个任务" }, null, null, mockCtx());
    expect(blocked.content[0].text).toMatch(/8|subagentMaxConcurrent/);
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

    // Session A: dispatch 8 tasks
    for (let i = 0; i < 8; i++) {
      const r = await tool.execute(`call_a${i}`, { task: `任务 A${i}` }, null, null, mockCtx("/session/a.jsonl"));
      expect(r.details.streamStatus).toBe("running");
    }

    // Session B: should still be able to dispatch 8 tasks (independent quota)
    for (let i = 0; i < 8; i++) {
      const r = await tool.execute(`call_b${i}`, { task: `任务 B${i}` }, null, null, mockCtx("/session/b.jsonl"));
      expect(r.details.streamStatus).toBe("running");
    }

    // Session A: 9th task should be rejected
    const blockedA = await tool.execute("call_a8", { task: "第九个 A" }, null, null, mockCtx("/session/a.jsonl"));
    expect(blockedA.content[0].text).toMatch(/8|subagentMaxConcurrent/);
    expect(blockedA.details).toBeUndefined();

    // Session B: 9th task should also be rejected
    const blockedB = await tool.execute("call_b8", { task: "第九个 B" }, null, null, mockCtx("/session/b.jsonl"));
    expect(blockedB.content[0].text).toMatch(/8|subagentMaxConcurrent/);
    expect(blockedB.details).toBeUndefined();

    // Cleanup
    for (const resolve of pending) {
      resolve({ replyText: "ok", error: null, sessionPath: null });
    }
  });

  // 6c. global limit (20) rejects when total across all sessions exceeds it
  it("rejects when global limit (20) is reached across sessions", async () => {
    const pending = [];
    const blockingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((resolve) => pending.push(resolve));
    });
    const tool = createSubagentTool(makeDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
    }));

    // Fill up 20 tasks across 4 sessions (5 each, under per-session limit of 8)
    for (let s = 0; s < 4; s++) {
      for (let i = 0; i < 5; i++) {
        const r = await tool.execute(`call_${s}_${i}`, { task: `任务` }, null, null, mockCtx(`/session/${s}.jsonl`));
        expect(r.details.streamStatus).toBe("running");
      }
    }

    // 21st task from a new session (per-session is fine, but global is full)
    const blocked = await tool.execute("call_4_0", { task: "第21个" }, null, null, mockCtx("/session/4.jsonl"));
    expect(blocked.content[0].text).toMatch(/20|subagentMaxConcurrent/);
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
