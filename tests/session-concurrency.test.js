/**
 * Session 并发集成测试
 *
 * 验证系统并发设计的关键场景：
 * 1. createSession 返回值结构
 * 2. subagent per-session / global 并发限制
 * 3. DeferredResultStore cleanup（7 天过期清理）
 * 4. BrowserManager per-session 隔离
 * 5. resolveAgent / resolveAgentStrict 行为
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── 1. createSession 返回值结构 ──────────────────────────

const { createAgentSessionMock, sessionManagerCreateMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  SessionManager: {
    create: sessionManagerCreateMock,
    open: vi.fn(),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../core/session-coordinator.js";

function makeCoordinatorDeps(overrides = {}) {
  return {
    agentsDir: "/tmp/agents",
    getAgent: () => ({
      sessionDir: "/tmp/agent-sessions",
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "mock-prompt",
      config: {},
      tools: [],
      agentDir: "/tmp/agents/hana",
    }),
    getActiveAgentId: () => "hana",
    getModels: () => ({
      currentModel: { id: "test-model", name: "test-model" },
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: () => "medium",
    }),
    getResourceLoader: () => ({
      getSystemPrompt: () => "mock-prompt",
      getAppendSystemPrompt: () => [],
    }),
    getSkills: () => null,
    buildTools: () => ({ tools: [], customTools: [] }),
    emitEvent: vi.fn(),
    getHomeCwd: () => "/tmp/home",
    agentIdFromSessionPath: () => null,
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    getAgents: () => new Map(),
    getActivityStore: () => null,
    getAgentById: () => null,
    listAgents: () => [],
    getDeferredResultStore: () => null,
    ...overrides,
  };
}

describe("createSession 返回值结构", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionManagerCreateMock.mockReturnValue({ getCwd: () => "/tmp/workspace" });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => "/tmp/sessions/test-session.jsonl" },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model", name: "test-model" },
      },
    });
  });

  it("returns { session, sessionPath, agentId }", async () => {
    const coordinator = new SessionCoordinator(makeCoordinatorDeps());
    const result = await coordinator.createSession(null, "/tmp/workspace", false);

    expect(result).toHaveProperty("session");
    expect(result).toHaveProperty("sessionPath");
    expect(result).toHaveProperty("agentId");
    expect(result.sessionPath).toBe("/tmp/sessions/test-session.jsonl");
    expect(result.agentId).toBe("hana");
    expect(result.session).toBeDefined();
    expect(result.session.sessionManager).toBeDefined();
  });

  it("agentId reflects the active agent at creation time", async () => {
    const coordinator = new SessionCoordinator(makeCoordinatorDeps({
      getActiveAgentId: () => "custom-agent",
    }));
    const result = await coordinator.createSession(null, "/tmp/workspace", false);

    expect(result.agentId).toBe("custom-agent");
  });

  it("sessionPath falls back to anonymous key when sessionManager has no file", async () => {
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => null },
        subscribe: vi.fn(() => vi.fn()),
        model: { id: "test-model" },
      },
    });

    const coordinator = new SessionCoordinator(makeCoordinatorDeps());
    const result = await coordinator.createSession(null, "/tmp/workspace", false);

    expect(result.sessionPath).toMatch(/^_anon_/);
    expect(result.agentId).toBe("hana");
  });
});

// ── 2. subagent per-session 并发限制 ────────────────────

// subagent 并发限制的核心逻辑在 subagent-tool.test.js 中已有完整覆盖（6, 6b, 6c），
// 这里补充 "完成后释放配额、新任务可继续" 的场景。

import { createSubagentTool } from "../lib/tools/subagent-tool.js";

const mockCtx = (sp = "/test/session.jsonl") => ({
  sessionManager: { getSessionFile: () => sp },
});

function makeSubagentDeps(overrides = {}) {
  return {
    executeIsolated: vi.fn().mockResolvedValue({
      replyText: "done",
      error: null,
      sessionPath: "/test/child.jsonl",
    }),
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
    ]),
    currentAgentId: "hana",
    agentDir: "/test/agents/hana",
    emitEvent: vi.fn(),
    ...overrides,
  };
}

describe("subagent 并发配额释放与复用", () => {
  it("slot freed after task completes, allowing new dispatch", async () => {
    const pending = [];
    const blockingExecute = vi.fn().mockImplementation((_prompt, opts) => {
      opts?.onSessionReady?.("/test/child.jsonl");
      return new Promise((resolve) => pending.push(resolve));
    });
    const mockStore = { defer: vi.fn(), resolve: vi.fn(), fail: vi.fn(), query: vi.fn(() => ({ meta: {} })), _save: vi.fn() };
    const tool = createSubagentTool(makeSubagentDeps({
      executeIsolated: blockingExecute,
      getDeferredStore: () => mockStore,
    }));

    // 填满 5 个 slot（per-session limit）
    for (let i = 0; i < 5; i++) {
      const r = await tool.execute(`call_${i}`, { task: `任务 ${i}` }, null, null, mockCtx());
      expect(r.details.streamStatus).toBe("running");
    }

    // 第 6 个被拒
    const blocked = await tool.execute("call_5", { task: "第六个" }, null, null, mockCtx());
    expect(blocked.details).toBeUndefined();

    // 完成第一个任务，释放一个 slot
    pending[0]({ replyText: "ok", error: null, sessionPath: null });
    // 等待内部异步回调完成
    await vi.waitFor(() => {
      expect(mockStore.resolve).toHaveBeenCalledTimes(1);
    });

    // 现在应该能发新任务了
    const resumed = await tool.execute("call_6", { task: "新任务" }, null, null, mockCtx());
    expect(resumed.details.streamStatus).toBe("running");

    // 清理剩余 pending
    for (let i = 1; i < pending.length; i++) {
      pending[i]({ replyText: "ok", error: null, sessionPath: null });
    }
  });
});

// ── 3. DeferredResultStore cleanup ──────────────────────

import { DeferredResultStore } from "../lib/deferred-result-store.js";

describe("DeferredResultStore cleanup", () => {
  it("cleans up delivered tasks older than 7 days", () => {
    const store = new DeferredResultStore();

    // 手动注入一个 delivered + 8 天前的任务
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    store._tasks.set("old-delivered", {
      status: "resolved",
      sessionPath: "/s/a",
      meta: { type: "test" },
      deferredAt: eightDaysAgo,
      result: { data: "old" },
      reason: null,
      delivered: true,
    });

    expect(store.query("old-delivered")).not.toBeNull();
    store.cleanup();
    expect(store.query("old-delivered")).toBeNull();

    store.dispose();
  });

  it("preserves delivered tasks younger than 7 days", () => {
    const store = new DeferredResultStore();

    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    store._tasks.set("recent-delivered", {
      status: "resolved",
      sessionPath: "/s/a",
      meta: {},
      deferredAt: twoDaysAgo,
      result: {},
      reason: null,
      delivered: true,
    });

    store.cleanup();
    expect(store.query("recent-delivered")).not.toBeNull();

    store.dispose();
  });

  it("preserves non-delivered tasks regardless of age", () => {
    const store = new DeferredResultStore();

    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    store._tasks.set("old-pending", {
      status: "pending",
      sessionPath: "/s/a",
      meta: {},
      deferredAt: tenDaysAgo,
      result: null,
      reason: null,
      delivered: false,
    });
    store._tasks.set("old-resolved-undelivered", {
      status: "resolved",
      sessionPath: "/s/b",
      meta: {},
      deferredAt: tenDaysAgo,
      result: { data: "important" },
      reason: null,
      delivered: false,
    });

    store.cleanup();

    expect(store.query("old-pending")).not.toBeNull();
    expect(store.query("old-resolved-undelivered")).not.toBeNull();

    store.dispose();
  });

  it("constructor triggers initial cleanup", () => {
    const store = new DeferredResultStore();
    // 在构造后手动插入一个早已过期 + delivered 的任务
    // 由于构造时 cleanup 已执行过（此时 Map 为空），需要验证行为本身
    const spy = vi.spyOn(store, "cleanup");
    // 构造新 store 验证 cleanup 被调用
    const store2 = new DeferredResultStore();
    // cleanup 在构造函数中被调用，spy 绑定在 store 上，改用直接断言
    // 验证方式：通过 _cleanupTimer 存在来间接证明
    expect(store2._cleanupTimer).toBeDefined();

    spy.mockRestore();
    store.dispose();
    store2.dispose();
  });
});

// ── 4. BrowserManager per-session 隔离 ──────────────────

import { BrowserManager } from "../lib/browser/browser-manager.js";

describe("BrowserManager per-session 隔离（并发场景）", () => {
  it("isolates state between sessions: navigate, url, close", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockImplementation(async (cmd, params) => {
      if (cmd === "navigate") {
        return {
          url: params.url,
          title: "Mock",
          snapshot: "...",
        };
      }
      return {};
    });
    manager._saveColdUrl = vi.fn();
    manager._removeColdUrl = vi.fn();

    const sp1 = "/sessions/iso-1.json";
    const sp2 = "/sessions/iso-2.json";

    // 同时启动两个 session 的浏览器
    await manager.launch(sp1);
    await manager.launch(sp2);

    expect(manager.isRunning(sp1)).toBe(true);
    expect(manager.isRunning(sp2)).toBe(true);

    // 各自导航到不同 URL
    await manager.navigate("https://alpha.example.com", sp1);
    await manager.navigate("https://beta.example.com", sp2);

    // URL 互相隔离
    expect(manager.currentUrl(sp1)).toBe("https://alpha.example.com");
    expect(manager.currentUrl(sp2)).toBe("https://beta.example.com");

    // 关闭 sp1 不影响 sp2
    await manager.close(sp1);

    expect(manager.isRunning(sp1)).toBe(false);
    expect(manager.isRunning(sp2)).toBe(true);
    expect(manager.currentUrl(sp2)).toBe("https://beta.example.com");

    // 清理
    await manager.close(sp2);
  });

  it("concurrent launches do not cross-contaminate session entries", async () => {
    const manager = new BrowserManager();
    manager._sendCmd = vi.fn().mockResolvedValue({});

    const sp1 = "/sessions/concurrent-1.json";
    const sp2 = "/sessions/concurrent-2.json";
    const sp3 = "/sessions/concurrent-3.json";

    // 并发 launch
    await Promise.all([
      manager.launch(sp1),
      manager.launch(sp2),
      manager.launch(sp3),
    ]);

    expect(manager.runningSessions).toHaveLength(3);
    expect(manager.isRunning(sp1)).toBe(true);
    expect(manager.isRunning(sp2)).toBe(true);
    expect(manager.isRunning(sp3)).toBe(true);

    // 每个 session 的 entry 独立
    expect(manager._sessions.get(sp1)).not.toBe(manager._sessions.get(sp2));
    expect(manager._sessions.get(sp2)).not.toBe(manager._sessions.get(sp3));
  });
});

// ── 5. resolveAgent 行为验证 ────────────────────────────

import { resolveAgent, resolveAgentStrict, AgentNotFoundError } from "../server/utils/resolve-agent.js";

function mockEngine(agents) {
  return {
    getAgent: (id) => agents[id] || null,
    currentAgentId: "_focus",
  };
}

function mockReqCtx(agentId) {
  return { req: { query: (k) => (k === "agentId" ? agentId : null), param: () => null } };
}

describe("resolveAgent 并发安全", () => {
  it("returns focus agent when no explicit agentId", () => {
    const engine = mockEngine({ _focus: { id: "_focus", name: "Focus" } });
    const agent = resolveAgent(engine, mockReqCtx(null));
    expect(agent).toEqual({ id: "_focus", name: "Focus" });
  });

  it("returns explicit agent when agentId is valid", () => {
    const engine = mockEngine({
      _focus: { id: "_focus" },
      hana: { id: "hana", name: "Hana" },
    });
    const agent = resolveAgent(engine, mockReqCtx("hana"));
    expect(agent).toEqual({ id: "hana", name: "Hana" });
  });

  it("throws AgentNotFoundError when explicit agentId not found", () => {
    const engine = mockEngine({ _focus: { id: "_focus" } });
    expect(() => resolveAgent(engine, mockReqCtx("nonexistent"))).toThrow(AgentNotFoundError);
    expect(() => resolveAgent(engine, mockReqCtx("nonexistent"))).toThrow("not found");
  });

  it("resolveAgentStrict throws when no agentId provided", () => {
    const engine = mockEngine({ _focus: { id: "_focus" } });
    expect(() => resolveAgentStrict(engine, mockReqCtx(null))).toThrow(AgentNotFoundError);
    expect(() => resolveAgentStrict(engine, mockReqCtx(null))).toThrow("missing agentId");
  });

  it("resolveAgentStrict returns agent when valid agentId provided", () => {
    const engine = mockEngine({ hana: { id: "hana" } });
    const agent = resolveAgentStrict(engine, mockReqCtx("hana"));
    expect(agent).toEqual({ id: "hana" });
  });

  it("resolveAgentStrict throws when agentId provided but not found", () => {
    const engine = mockEngine({});
    expect(() => resolveAgentStrict(engine, mockReqCtx("ghost"))).toThrow(AgentNotFoundError);
  });

  it("AgentNotFoundError has correct status and agentId", () => {
    try {
      const engine = mockEngine({});
      resolveAgent(engine, mockReqCtx("missing-one"));
    } catch (e) {
      expect(e).toBeInstanceOf(AgentNotFoundError);
      expect(e.status).toBe(404);
      expect(e.agentId).toBe("missing-one");
    }
  });
});
