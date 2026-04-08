import { describe, expect, it, vi } from "vitest";
import { createSubagentTool } from "../lib/tools/subagent-tool.js";

function makePrepareIsolatedSession(runResult) {
  return vi.fn().mockResolvedValue({
    sessionPath: "/test/child-session.jsonl",
    run: vi.fn().mockResolvedValue(runResult),
  });
}

function makeBaseDeps(overrides = {}) {
  return {
    prepareIsolatedSession: makePrepareIsolatedSession({ replyText: "done", error: null }),
    resolveUtilityModel: () => "utility-model",
    getDeferredStore: () => ({
      defer: vi.fn(),
      resolve: vi.fn(),
      fail: vi.fn(),
    }),
    getSessionPath: () => "/test/session.jsonl",
    listAgents: vi.fn(() => [
      { id: "hana", name: "Hana", model: "claude-3-5-sonnet", summary: "主 agent" },
      { id: "other-agent", name: "Other", model: "gpt-4", summary: "专家 agent" },
    ]),
    currentAgentId: "hana",
    emitEvent: vi.fn(),
    ...overrides,
  };
}

describe("subagent-tool (async deferred)", () => {
  it("dispatches task and returns immediately with details", async () => {
    const mockStore = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
    const deps = makeBaseDeps({ getDeferredStore: () => mockStore });
    const tool = createSubagentTool(deps);

    const result = await tool.execute("call_1", { task: "查一下项目状态" });

    // 立即返回 dispatched 消息
    expect(result.content[0].text).toContain("subagentDispatched");

    // details 字段存在且结构正确
    expect(result.details).toBeDefined();
    expect(result.details.taskId).toMatch(/^subagent-/);
    expect(result.details.streamStatus).toBe("running");
    expect(result.details.task).toBe("查一下项目状态");

    // store.defer 应该被调用
    expect(mockStore.defer).toHaveBeenCalledWith(
      expect.stringMatching(/^subagent-/),
      "/test/session.jsonl",
      expect.objectContaining({ type: "subagent" }),
    );

    // prepareIsolatedSession 应该被调用
    expect(deps.prepareIsolatedSession).toHaveBeenCalledWith(
      expect.objectContaining({ toolFilter: "*" }),
    );

    // 等 promise 链走完，验证 resolve 被调用
    await vi.waitFor(() => {
      expect(mockStore.resolve).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        "done",
      );
    });
  });

  it("resolves deferred store on success", async () => {
    const mockStore = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
    const deps = makeBaseDeps({ getDeferredStore: () => mockStore });
    const tool = createSubagentTool(deps);

    await tool.execute("call_1", { task: "成功的任务" });

    await vi.waitFor(() => {
      expect(mockStore.resolve).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        "done",
      );
    });
    expect(mockStore.fail).not.toHaveBeenCalled();
  });

  it("fails deferred store on error", async () => {
    const prepareIsolatedSession = vi.fn().mockResolvedValue({
      sessionPath: "/test/child-session.jsonl",
      run: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const mockStore = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
    const deps = makeBaseDeps({ prepareIsolatedSession, getDeferredStore: () => mockStore });
    const tool = createSubagentTool(deps);

    await tool.execute("call_1", { task: "会失败的任务" });

    await vi.waitFor(() => {
      expect(mockStore.fail).toHaveBeenCalledWith(
        expect.stringMatching(/^subagent-/),
        "boom",
      );
    });
    expect(mockStore.resolve).not.toHaveBeenCalled();
  });

  it("emits block_update on completion", async () => {
    const emitEvent = vi.fn();
    const mockStore = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
    const deps = makeBaseDeps({ getDeferredStore: () => mockStore, emitEvent });
    const tool = createSubagentTool(deps);

    const result = await tool.execute("call_1", { task: "完成的任务" });
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

  it("emits block_update on failure", async () => {
    const emitEvent = vi.fn();
    const prepareIsolatedSession = vi.fn().mockResolvedValue({
      sessionPath: "/test/child-session.jsonl",
      run: vi.fn().mockRejectedValue(new Error("network error")),
    });
    const mockStore = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
    const deps = makeBaseDeps({ prepareIsolatedSession, getDeferredStore: () => mockStore, emitEvent });
    const tool = createSubagentTool(deps);

    const result = await tool.execute("call_1", { task: "失败的任务" });
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

  it("rejects new work when the concurrency limit (5) is reached", async () => {
    const releases = [];
    const prepareIsolatedSession = vi.fn().mockImplementation(() => Promise.resolve({
      sessionPath: "/test/child-session.jsonl",
      run: () => new Promise((resolve) => { releases.push(resolve); }),
    }));
    const mockStore = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
    const deps = makeBaseDeps({ prepareIsolatedSession, getDeferredStore: () => mockStore });
    const tool = createSubagentTool(deps);

    // 启动 5 个（非阻塞，立即返回）
    const running = [];
    for (let i = 0; i < 5; i++) {
      running.push(tool.execute(`call_${i}`, { task: `任务 ${i}` }));
    }
    await Promise.all(running);

    // 第 6 个被拒
    const blocked = await tool.execute("call_5", { task: "任务 5" });
    expect(blocked.content[0].text).toContain("subagentMaxConcurrent");

    // 释放
    for (const release of releases) {
      release({ replyText: "ok", error: null });
    }
    expect(prepareIsolatedSession).toHaveBeenCalledTimes(5);
  });

  it("lists agents in discovery mode", async () => {
    const prepareIsolatedSession = vi.fn();
    const tool = createSubagentTool({
      prepareIsolatedSession,
      resolveUtilityModel: () => "utility-model",
      getDeferredStore: () => null,
      getSessionPath: () => null,
      listAgents: () => [
        { id: "agent-a", name: "Alpha", model: "gpt-4", summary: "数学专家" },
        { id: "agent-b", name: "Beta", model: "", summary: "" },
        { id: "self", name: "Self", model: "", summary: "" },
      ],
      currentAgentId: "self",
      emitEvent: vi.fn(),
    });

    const result = await tool.execute("call_1", { task: "", agent: "?" });
    expect(result.content[0].text).toContain("agent-a");
    expect(result.content[0].text).toContain("Alpha");
    expect(result.content[0].text).not.toContain("self");
    expect(prepareIsolatedSession).not.toHaveBeenCalled();
  });

  it("delegates to another agent via cross-agent delegation", async () => {
    const prepareIsolatedSession = makePrepareIsolatedSession({ replyText: "delegated result", error: null });
    const mockStore = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn() };
    const deps = makeBaseDeps({ prepareIsolatedSession, getDeferredStore: () => mockStore });
    const tool = createSubagentTool(deps);

    const result = await tool.execute("call_1", { task: "专项任务", agent: "other-agent" });

    expect(result.content[0].text).toContain("subagentDispatched");
    expect(result.details.agentId).toBe("other-agent");

    // prepareIsolatedSession 必须收到正确的 agentId
    expect(prepareIsolatedSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "other-agent" }),
    );
  });

  it("returns error when agent is unknown", async () => {
    const deps = makeBaseDeps();
    const tool = createSubagentTool(deps);

    const result = await tool.execute("call_1", { task: "任务", agent: "nonexistent" });

    // 应该返回错误，不应该调用 prepareIsolatedSession
    // i18n 在测试环境返回 key，key 包含 agentNotFound
    expect(result.content[0].text).toContain("agentNotFound");
    expect(deps.prepareIsolatedSession).not.toHaveBeenCalled();
  });

  it("falls back to sync execution when deferred store is unavailable", async () => {
    const prepareIsolatedSession = makePrepareIsolatedSession({ replyText: "sync result", error: null });
    const deps = makeBaseDeps({
      prepareIsolatedSession,
      getDeferredStore: () => null,
      getSessionPath: () => null,
    });
    const tool = createSubagentTool(deps);

    const result = await tool.execute("call_1", { task: "同步任务" });

    expect(result).toEqual({
      content: [{ type: "text", text: "sync result" }],
    });
  });
});
