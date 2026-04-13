/**
 * SessionCoordinator.writeSessionMeta 序列化回归测试
 *
 * 验证并发调用 writeSessionMeta 不会因 RMW 竞态丢失字段，
 * 且写入失败不会阻塞队列后续项。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: vi.fn(),
  SessionManager: {
    create: vi.fn(),
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
      sessionDir: overrides._sessionDir || "/tmp/agent-sessions",
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "mock-prompt",
      config: {},
      tools: [],
      agentDir: "/tmp/agents/hana",
    }),
    getActiveAgentId: () => "test",
    getModels: () => ({
      currentModel: { id: "m", name: "m" },
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: () => "medium",
    }),
    getResourceLoader: () => ({
      getSystemPrompt: () => "",
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

describe("SessionCoordinator.writeSessionMeta serialization", () => {
  let tmpDir, sessionDir, sessionCoord, fakeSessionPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meta-serial-"));
    sessionDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fakeSessionPath = path.join(sessionDir, "test-session.jsonl");

    const deps = makeCoordinatorDeps({ _sessionDir: sessionDir });
    // override getAgent to return dynamic sessionDir from tmpDir
    deps.getAgent = () => ({
      sessionDir,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "mock-prompt",
      config: {},
      tools: [],
      agentDir: path.join(tmpDir, "agents", "hana"),
    });

    sessionCoord = new SessionCoordinator(deps);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("two concurrent writeSessionMeta calls with different fields preserve both", async () => {
    const p1 = sessionCoord.writeSessionMeta(fakeSessionPath, { memoryEnabled: false });
    const p2 = sessionCoord.writeSessionMeta(fakeSessionPath, { toolNames: ["read", "bash"] });
    await Promise.all([p1, p2]);

    const metaPath = path.join(sessionDir, "session-meta.json");
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    const entry = meta[path.basename(fakeSessionPath)];
    expect(entry.memoryEnabled).toBe(false);
    expect(entry.toolNames).toEqual(["read", "bash"]);
  });

  it("three sequential writes accumulate fields correctly", async () => {
    await sessionCoord.writeSessionMeta(fakeSessionPath, { memoryEnabled: true });
    await sessionCoord.writeSessionMeta(fakeSessionPath, { toolNames: ["a"] });
    await sessionCoord.writeSessionMeta(fakeSessionPath, { memoryEnabled: false });

    const metaPath = path.join(sessionDir, "session-meta.json");
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    const entry = meta[path.basename(fakeSessionPath)];
    expect(entry.memoryEnabled).toBe(false);
    expect(entry.toolNames).toEqual(["a"]);
  });

  it("a failed write does not block subsequent writes from the queue", async () => {
    // Write to a non-existent directory that won't be auto-created (two levels deep)
    // to force a failure, then immediately enqueue a valid write
    const badPath = path.join(tmpDir, "nonexistent", "deep", "nope.jsonl");

    const p1 = sessionCoord.writeSessionMeta(badPath, { memoryEnabled: true });
    const p2 = sessionCoord.writeSessionMeta(fakeSessionPath, { toolNames: ["grep"] });

    // Both settle (p1 fails silently via the queue chain, p2 should succeed)
    await Promise.all([p1, p2]);

    const metaPath = path.join(sessionDir, "session-meta.json");
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    const entry = meta[path.basename(fakeSessionPath)];
    expect(entry.toolNames).toEqual(["grep"]);
  });

  it("model and modelId fields are stripped from written meta", async () => {
    await sessionCoord.writeSessionMeta(fakeSessionPath, {
      memoryEnabled: true,
      model: "should-be-deleted",
      modelId: "also-deleted",
    });

    const metaPath = path.join(sessionDir, "session-meta.json");
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
    const entry = meta[path.basename(fakeSessionPath)];
    expect(entry.model).toBeUndefined();
    expect(entry.modelId).toBeUndefined();
    expect(entry.memoryEnabled).toBe(true);
  });
});
