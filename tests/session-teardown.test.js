/**
 * SessionCoordinator._teardownSessionEntry — 统一 session 释放入口
 *
 * 契约:
 *   1. emit session_shutdown (让扩展清理 setInterval、store 订阅)
 *   2. 调 entry.unsub() (取消 Hanako 层的 session 事件订阅)
 *   3. 调 entry.session.dispose() (SDK 层 disconnect + 清 listeners)
 *
 * 错误处理:
 *   - 任何一步失败 log.warn 但不阻塞后续步骤
 *   - 保证下游资源一定被释放
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionCoordinator } from "../core/session-coordinator.js";

function makeMockEntry({ hasShutdownHandlers = true } = {}) {
  const emit = vi.fn(async () => {});
  const dispose = vi.fn();
  const unsub = vi.fn();
  const session = {
    extensionRunner: {
      hasHandlers: vi.fn((type) =>
        type === "session_shutdown" && hasShutdownHandlers,
      ),
      emit,
    },
    dispose,
  };
  return {
    entry: { session, unsub, agentId: "test-agent" },
    spies: { emit, dispose, unsub, hasHandlers: session.extensionRunner.hasHandlers },
  };
}

function makeCoordinator() {
  // _teardownSessionEntry 只依赖 entry + log, 无需真实 deps
  // 通过最小 stub 构造实例
  return new SessionCoordinator({
    agentsDir: "/tmp/fake",
    getAgent: () => ({ id: "test-agent" }),
    getActiveAgentId: () => "test-agent",
    getModels: () => ({}),
    getResourceLoader: () => ({}),
    getSkills: () => ({}),
    buildTools: () => ({ tools: [], customTools: [] }),
    emitEvent: () => {},
    getHomeCwd: () => "/tmp",
    agentIdFromSessionPath: () => "test-agent",
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getAgents: () => new Map(),
    getActivityStore: () => ({}),
    getAgentById: () => ({ id: "test-agent" }),
    listAgents: () => [],
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
  });
}

describe("SessionCoordinator._teardownSessionEntry", () => {
  let coord;
  beforeEach(() => {
    coord = makeCoordinator();
  });

  it("按 emit → unsub → dispose 顺序调用", async () => {
    const { entry, spies } = makeMockEntry();
    const callOrder = [];
    spies.emit.mockImplementation(async () => { callOrder.push("emit"); });
    spies.unsub.mockImplementation(() => { callOrder.push("unsub"); });
    spies.dispose.mockImplementation(() => { callOrder.push("dispose"); });

    await coord._teardownSessionEntry(entry, "/tmp/fake/session.jsonl", "test");

    expect(callOrder).toEqual(["emit", "unsub", "dispose"]);
    expect(spies.emit).toHaveBeenCalledWith({ type: "session_shutdown" });
  });

  it("无 session_shutdown handler 时跳过 emit 但仍 unsub + dispose", async () => {
    const { entry, spies } = makeMockEntry({ hasShutdownHandlers: false });

    await coord._teardownSessionEntry(entry, "/tmp/fake/session.jsonl", "test");

    expect(spies.emit).not.toHaveBeenCalled();
    expect(spies.unsub).toHaveBeenCalledOnce();
    expect(spies.dispose).toHaveBeenCalledOnce();
  });

  it("emit 抛错时仍执行 unsub + dispose", async () => {
    const { entry, spies } = makeMockEntry();
    spies.emit.mockRejectedValue(new Error("emit boom"));

    await coord._teardownSessionEntry(entry, "/tmp/fake/session.jsonl", "test");

    expect(spies.unsub).toHaveBeenCalledOnce();
    expect(spies.dispose).toHaveBeenCalledOnce();
  });

  it("unsub 抛错时仍执行 dispose", async () => {
    const { entry, spies } = makeMockEntry();
    spies.unsub.mockImplementation(() => { throw new Error("unsub boom"); });

    await coord._teardownSessionEntry(entry, "/tmp/fake/session.jsonl", "test");

    expect(spies.dispose).toHaveBeenCalledOnce();
  });

  it("dispose 抛错时不再抛出", async () => {
    const { entry, spies } = makeMockEntry();
    spies.dispose.mockImplementation(() => { throw new Error("dispose boom"); });

    await expect(
      coord._teardownSessionEntry(entry, "/tmp/fake/session.jsonl", "test"),
    ).resolves.toBeUndefined();
  });

  it("entry.session 为 null 时不崩溃", async () => {
    const entry = { session: null, unsub: vi.fn() };
    await expect(
      coord._teardownSessionEntry(entry, "/tmp/fake/session.jsonl", "test"),
    ).resolves.toBeUndefined();
    expect(entry.unsub).toHaveBeenCalledOnce();
  });
});
