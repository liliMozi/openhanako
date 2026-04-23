import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSessionMock,
  sessionManagerOpenMock,
} = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerOpenMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  SessionManager: {
    create: vi.fn(),
    open: sessionManagerOpenMock,
  },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
  estimateTokens: vi.fn(() => 0),
  findCutPoint: vi.fn(),
  generateSummary: vi.fn(),
  emitSessionShutdown: vi.fn(),
  refreshSessionModelFromRegistry: vi.fn(),
}));

vi.mock("../lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../core/session-coordinator.js";

function makeTool(name) {
  return { name, execute: vi.fn() };
}

function makeAgent({ id, sessionDir, locale = "en", initialMemoryEnabled = true, memoryMasterEnabled = true }) {
  let sessionMemoryEnabled = initialMemoryEnabled;
  return {
    id,
    agentDir: path.join(path.dirname(sessionDir), id),
    sessionDir,
    tools: [makeTool(`${id}-tool`)],
    config: { locale, tools: {} },
    memoryMasterEnabled,
    get memoryEnabled() { return this.memoryMasterEnabled && sessionMemoryEnabled; },
    get sessionMemoryEnabled() { return sessionMemoryEnabled; },
    setMemoryEnabled: vi.fn((val) => {
      sessionMemoryEnabled = !!val;
    }),
    getToolsSnapshot: vi.fn(({ forceMemoryEnabled } = {}) => (
      (typeof forceMemoryEnabled === "boolean" ? forceMemoryEnabled : (memoryMasterEnabled && sessionMemoryEnabled))
        ? [makeTool(`${id}-tool`), makeTool(`search_memory-${id}`)]
        : [makeTool(`${id}-tool`)]
    )),
    buildSystemPrompt: vi.fn(({ forceMemoryEnabled } = {}) => {
      const enabled = typeof forceMemoryEnabled === "boolean"
        ? forceMemoryEnabled
        : (memoryMasterEnabled && sessionMemoryEnabled);
      return `${id.toUpperCase()} MEMORY ${enabled ? "ON" : "OFF"}`;
    }),
  };
}

describe("SessionCoordinator ensureSessionLoaded owner restore", () => {
  let tempDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-owner-restore-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("restores a detached session with the owner agent context and does not pollute focus session state", async () => {
    const focusSessionDir = path.join(tempDir, "focus", "sessions");
    const ownerSessionDir = path.join(tempDir, "owner", "sessions");
    fs.mkdirSync(focusSessionDir, { recursive: true });
    fs.mkdirSync(ownerSessionDir, { recursive: true });

    const sessionPath = path.join(ownerSessionDir, "attached.jsonl");
    const metaPath = path.join(ownerSessionDir, "session-meta.json");
    fs.writeFileSync(metaPath, JSON.stringify({
      [path.basename(sessionPath)]: { memoryEnabled: false },
    }, null, 2));

    const focusAgent = makeAgent({ id: "focus", sessionDir: focusSessionDir, initialMemoryEnabled: true });
    const ownerAgent = makeAgent({ id: "owner", sessionDir: ownerSessionDir, initialMemoryEnabled: true });

    const focusSession = {
      sessionManager: { getSessionFile: () => path.join(focusSessionDir, "focused.jsonl") },
    };

    const subscribers = [];
    let capturedCreateOpts = null;
    const restoredSession = {
      sessionManager: { getSessionFile: () => sessionPath },
      subscribe: vi.fn((fn) => {
        subscribers.push(fn);
        return vi.fn();
      }),
      setActiveToolsByName: vi.fn(),
      model: { id: "restored-model", provider: "test" },
    };

    sessionManagerOpenMock.mockReturnValue({
      getCwd: () => tempDir,
    });
    createAgentSessionMock.mockImplementation(async (opts) => {
      capturedCreateOpts = opts;
      return { session: restoredSession };
    });

    const emitEvent = vi.fn();
    const skillsMgr = {
      getSkillsForAgent: vi.fn((agent) => ({
        skills: [{ name: `skill-${agent.id}` }],
        diagnostics: [],
      })),
    };

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => focusAgent,
      getActiveAgentId: () => "focus",
      getModels: () => ({
        currentModel: { id: "focus-model", provider: "test" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "FOCUS BASE PROMPT",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [{ name: "skill-focus" }], diagnostics: [] }),
      }),
      getSkills: () => skillsMgr,
      buildTools: (_cwd, customTools) => ({
        tools: [makeTool("read")],
        customTools,
      }),
      emitEvent,
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "owner",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: (id) => (id === "owner" ? ownerAgent : id === "focus" ? focusAgent : null),
      listAgents: () => [],
    });

    coordinator._session = focusSession;
    coordinator._sessionStarted = true;

    const session = await coordinator.ensureSessionLoaded(sessionPath);

    expect(session).toBe(restoredSession);
    expect(capturedCreateOpts.resourceLoader.getSystemPrompt()).toBe("OWNER MEMORY OFF");
    expect(capturedCreateOpts.customTools.map((t) => t.name)).toEqual(["owner-tool"]);
    expect(capturedCreateOpts.resourceLoader.getSkills().skills.map((s) => s.name)).toEqual(["skill-owner"]);
    expect(ownerAgent.setMemoryEnabled).toHaveBeenCalledTimes(2);
    expect(ownerAgent.setMemoryEnabled).toHaveBeenNthCalledWith(1, false);
    expect(ownerAgent.setMemoryEnabled).toHaveBeenNthCalledWith(2, true);
    expect(ownerAgent.sessionMemoryEnabled).toBe(true);
    expect(focusAgent.setMemoryEnabled).not.toHaveBeenCalled();
    expect(coordinator.session).toBe(focusSession);
    expect(coordinator.sessionStarted).toBe(true);
    expect(coordinator._sessions.get(sessionPath)?.agentId).toBe("owner");

    subscribers[0]({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "x" },
    });
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ agentId: "owner" }), sessionPath);
  });

  it("restores the frozen memory snapshot even when the owner's current master switch is off", async () => {
    const ownerSessionDir = path.join(tempDir, "owner", "sessions");
    fs.mkdirSync(ownerSessionDir, { recursive: true });

    const sessionPath = path.join(ownerSessionDir, "cached.jsonl");
    const metaPath = path.join(ownerSessionDir, "session-meta.json");
    fs.writeFileSync(metaPath, JSON.stringify({
      [path.basename(sessionPath)]: { memoryEnabled: true },
    }, null, 2));

    const focusAgent = makeAgent({ id: "focus", sessionDir: path.join(tempDir, "focus", "sessions") });
    const ownerAgent = makeAgent({
      id: "owner",
      sessionDir: ownerSessionDir,
      initialMemoryEnabled: true,
      memoryMasterEnabled: false,
    });

    let capturedCreateOpts = null;
    sessionManagerOpenMock.mockReturnValue({
      getCwd: () => tempDir,
    });
    createAgentSessionMock.mockImplementation(async (opts) => {
      capturedCreateOpts = opts;
      return {
        session: {
          sessionManager: { getSessionFile: () => sessionPath },
          subscribe: vi.fn(() => vi.fn()),
          setActiveToolsByName: vi.fn(),
          model: { id: "restored-model", provider: "test" },
        },
      };
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => focusAgent,
      getActiveAgentId: () => "focus",
      getModels: () => ({
        currentModel: { id: "focus-model", provider: "test" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "FOCUS BASE PROMPT",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
      }),
      getSkills: () => null,
      buildTools: (_cwd, customTools) => ({
        tools: [makeTool("read")],
        customTools,
      }),
      emitEvent: vi.fn(),
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "owner",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: (id) => (id === "owner" ? ownerAgent : id === "focus" ? focusAgent : null),
      listAgents: () => [],
    });

    await coordinator.ensureSessionLoaded(sessionPath);

    expect(capturedCreateOpts.resourceLoader.getSystemPrompt()).toBe("OWNER MEMORY ON");
    expect(capturedCreateOpts.customTools.map((t) => t.name)).toContain("search_memory-owner");
  });
});
