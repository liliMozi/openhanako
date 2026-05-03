import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

const { createAgentSessionMock, sessionManagerCreateMock, emitSessionShutdownMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
  emitSessionShutdownMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  emitSessionShutdown: emitSessionShutdownMock,
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

describe("SessionCoordinator", () => {
  let tempDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-coordinator-"));
    sessionManagerCreateMock.mockReturnValue({ getCwd: () => "/tmp/workspace" });
    emitSessionShutdownMock.mockResolvedValue(false);
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("applies session memory before creating the agent session", async () => {
    let sessionMemoryEnabled = true;
    const agent = {
      sessionDir: "/tmp/agent-sessions",
      setMemoryEnabled: vi.fn((enabled) => {
        sessionMemoryEnabled = !!enabled;
      }),
      buildSystemPrompt: () => sessionMemoryEnabled ? "MEMORY ON" : "MEMORY OFF",
    };

    const resourceLoader = {
      getSystemPrompt: () => (sessionMemoryEnabled ? "MEMORY ON" : "MEMORY OFF"),
    };

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => resourceLoader,
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", false);

    expect(agent.setMemoryEnabled).toHaveBeenCalledWith(false);
    expect(createAgentSessionMock).toHaveBeenCalledOnce();
    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt()).toBe("MEMORY OFF");
  });

  it("builds session tools with sandbox workspace pinned to the effective cwd", async () => {
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [{ name: "write" }],
    };
    const buildTools = vi.fn((_cwd, customTools) => ({ tools: [], customTools }));
    const homeCwd = path.join(tempDir, "agent-home");
    const sessionCwd = path.join(tempDir, "session-cwd");

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => homeCwd,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, sessionCwd, true);

    expect(buildTools).toHaveBeenCalledWith(
      sessionCwd,
      agent.tools,
      expect.objectContaining({
        agentDir: agent.agentDir,
        workspace: sessionCwd,
      }),
    );
  });

  it("passes the frozen experience state into the agent tool snapshot", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "experience.jsonl");
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      memoryEnabled: true,
      experienceEnabled: false,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      getToolsSnapshot: vi.fn(() => []),
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: vi.fn(() => ({ tools: [], customTools: [] })),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);

    expect(agent.getToolsSnapshot).toHaveBeenCalledWith({
      forceMemoryEnabled: true,
      forceExperienceEnabled: false,
      model: { name: "test-model" },
    });
  });

  it("keeps legacy create_artifact out of fresh sessions but restores it for old sessions", async () => {
    const freshSessionFile = path.join(tempDir, "agents", "hana", "sessions", "fresh.jsonl");
    const restoredSessionFile = path.join(tempDir, "agents", "hana", "sessions", "restored.jsonl");
    const restoredNewSessionFile = path.join(tempDir, "agents", "hana", "sessions", "restored-new.jsonl");
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      memoryEnabled: true,
      experienceEnabled: false,
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      getToolsSnapshot: vi.fn((options = {}) => [
        { name: "stage_files" },
        ...(options.includeLegacyArtifactTool ? [{ name: "create_artifact" }] : []),
      ]),
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    const buildTools = vi.fn((_cwd, customTools) => ({ tools: [], customTools }));
    createAgentSessionMock
      .mockResolvedValueOnce({
        session: {
          sessionManager: { getSessionFile: () => freshSessionFile },
          subscribe: vi.fn(() => vi.fn()),
          setActiveToolsByName: vi.fn(),
        },
      })
      .mockResolvedValueOnce({
        session: {
          sessionManager: { getSessionFile: () => restoredSessionFile },
          subscribe: vi.fn(() => vi.fn()),
          setActiveToolsByName: vi.fn(),
        },
      })
      .mockResolvedValueOnce({
        session: {
          sessionManager: { getSessionFile: () => restoredNewSessionFile },
          subscribe: vi.fn(() => vi.fn()),
          setActiveToolsByName: vi.fn(),
        },
      });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);
    await coordinator.createSession(null, tempDir, true, null, { restore: true });
    fs.writeFileSync(
      path.join(agent.sessionDir, "session-meta.json"),
      JSON.stringify({ [path.basename(restoredNewSessionFile)]: { toolNames: ["stage_files"] } }, null, 2),
    );
    await coordinator.createSession(
      { getCwd: () => tempDir, getSessionFile: () => restoredNewSessionFile },
      tempDir,
      true,
      null,
      { restore: true },
    );

    expect(buildTools.mock.calls[0][1].map((tool) => tool.name)).toEqual(["stage_files"]);
    expect(buildTools.mock.calls[1][1].map((tool) => tool.name)).toEqual([
      "stage_files",
      "create_artifact",
    ]);
    expect(buildTools.mock.calls[2][1].map((tool) => tool.name)).toEqual(["stage_files"]);
    expect(agent.getToolsSnapshot.mock.calls[0][0]).not.toHaveProperty("includeLegacyArtifactTool", true);
    expect(agent.getToolsSnapshot.mock.calls[1][0]).toMatchObject({
      includeLegacyArtifactTool: true,
    });
    expect(agent.getToolsSnapshot.mock.calls[2][0]).not.toHaveProperty("includeLegacyArtifactTool", true);
  });

  it("threads extra workspace folders into tools, prompt context, and session meta", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "scope.jsonl");
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [{ name: "read" }],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
      },
    });
    const buildTools = vi.fn((_cwd, customTools) => ({ tools: [], customTools }));
    const sessionCwd = path.join(tempDir, "main-workspace");
    const extra = path.join(tempDir, "reference");

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => sessionCwd,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, sessionCwd, true, null, {
      workspaceFolders: [extra, sessionCwd, extra],
    });

    expect(buildTools).toHaveBeenCalledWith(
      sessionCwd,
      agent.tools,
      expect.objectContaining({
        workspace: sessionCwd,
        workspaceFolders: [extra],
      }),
    );
    const appendPrompt = createAgentSessionMock.mock.calls[0][0].resourceLoader.getAppendSystemPrompt();
    expect(appendPrompt.join("\n")).toContain("额外文件夹");
    expect(appendPrompt.join("\n")).toContain(extra);

    const meta = JSON.parse(fs.readFileSync(path.join(agent.sessionDir, "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionFile)].workspaceFolders).toEqual([extra]);
    expect(coordinator.getSessionWorkspaceFolders(sessionFile)).toEqual([extra]);
  });

  it("freezes the DeepSeek prompt patch when the session is created with a DeepSeek reasoning model", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "deepseek.jsonl");
    const deepseekModel = {
      id: "deepseek/deepseek-v4-pro",
      provider: "openrouter",
      reasoning: true,
      name: "DeepSeek V4 Pro",
    };
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        model: deepseekModel,
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: deepseekModel,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "high",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => ["BASE APPEND"],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "high" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);

    const appendPrompt = createAgentSessionMock.mock.calls[0][0].resourceLoader.getAppendSystemPrompt();
    expect(appendPrompt.join("\n")).toContain("如果你使用的是 DeepSeek 模型");
    expect(appendPrompt.join("\n")).toContain("DeepSeek 输出契约");
  });

  it("does not add the DeepSeek prompt patch when a non-DeepSeek session later switches models", async () => {
    const sessionFile = path.join(tempDir, "agents", "hana", "sessions", "non-deepseek.jsonl");
    const qwenModel = { id: "qwen3.6-max-preview", provider: "dashscope", reasoning: true };
    const deepseekModel = { id: "deepseek-v4-pro", provider: "deepseek", reasoning: true };
    let currentModel = qwenModel;
    const session = {
      sessionManager: { getSessionFile: () => sessionFile },
      subscribe: vi.fn(() => vi.fn()),
      setActiveToolsByName: vi.fn(),
      model: qwenModel,
    };
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });
    createAgentSessionMock.mockResolvedValueOnce({ session });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "high",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => ["BASE APPEND"],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "high" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, tempDir, true);
    currentModel = deepseekModel;
    session.model = deepseekModel;

    const appendPrompt = createAgentSessionMock.mock.calls[0][0].resourceLoader.getAppendSystemPrompt();
    expect(appendPrompt.join("\n")).not.toContain("DeepSeek 输出契约");
  });

  it("blocks image prompts for text-only models when auxiliary vision is disabled", async () => {
    const sessionFile = path.join(tempDir, "text-only-images.jsonl");
    const sessionPrompt = vi.fn();
    const prepare = vi.fn(async () => ({
      text: "vision notes",
      images: [],
    }));
    const textOnlyModel = { id: "deepseek-v4-pro", provider: "deepseek", input: ["text"] };
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      sessionMemoryEnabled: true,
      memoryMasterEnabled: true,
      config: { locale: "zh-CN" },
      setMemoryEnabled: vi.fn(),
      buildSystemPrompt: () => "BASE",
      tools: [],
    };
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        prompt: sessionPrompt,
        model: textOnlyModel,
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: textOnlyModel,
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
      getEngine: () => ({
        isVisionAuxiliaryEnabled: () => false,
        getVisionBridge: () => ({ prepare }),
      }),
    });

    await coordinator.createSession(null, tempDir, true);

    await expect(coordinator.prompt("看一下", {
      images: [{ type: "image", data: "abc", mimeType: "image/png" }],
    })).rejects.toThrow(/vision auxiliary is disabled/);
    expect(prepare).not.toHaveBeenCalled();
    expect(sessionPrompt).not.toHaveBeenCalled();
  });

  it("fresh session freezes the effective memory state into meta for cache safety", async () => {
    const sessionFile = path.join(tempDir, "frozen-memory.jsonl");
    let sessionMemoryEnabled = true;
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      memoryMasterEnabled: false,
      get sessionMemoryEnabled() { return sessionMemoryEnabled; },
      get memoryEnabled() { return this.memoryMasterEnabled && sessionMemoryEnabled; },
      setMemoryEnabled: vi.fn((enabled) => {
        sessionMemoryEnabled = !!enabled;
      }),
      getToolsSnapshot: vi.fn(({ forceMemoryEnabled } = {}) =>
        forceMemoryEnabled ? [{ name: "search_memory" }] : [{ name: "todo_write" }],
      ),
      buildSystemPrompt: vi.fn(({ forceMemoryEnabled } = {}) =>
        forceMemoryEnabled ? "MEMORY ON" : "MEMORY OFF",
      ),
      config: { tools: {} },
      tools: [{ name: "todo_write" }],
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => "/tmp/workspace",
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        setActiveToolsByName: vi.fn(),
        model: { id: "test-model", provider: "test" },
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        currentModel: { id: "test-model", provider: "test", name: "test-model" },
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({
        getSystemPrompt: () => "BASE",
        getAppendSystemPrompt: () => [],
        getExtensions: () => ({ extensions: [], errors: [] }),
      }),
      getSkills: () => null,
      buildTools: (_cwd, customTools) => ({ tools: [], customTools }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.createSession(null, "/tmp/workspace", true);

    expect(createAgentSessionMock.mock.calls[0][0].resourceLoader.getSystemPrompt()).toBe("MEMORY OFF");
    const meta = JSON.parse(fs.readFileSync(path.join(tempDir, "hana", "sessions", "session-meta.json"), "utf-8"));
    expect(meta[path.basename(sessionFile)].memoryEnabled).toBe(false);
  });

  it("cleans up the temporary session file when aborted after session creation", async () => {
    const sessionFile = path.join(tempDir, "isolated.jsonl");
    fs.writeFileSync(sessionFile, "temp");

    const controller = new AbortController();
    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockImplementation(async () => {
      controller.abort();
      return {
        session: {
          sessionManager: { getSessionFile: () => sessionFile },
          subscribe: vi.fn(() => vi.fn()),
          abort: vi.fn(),
        },
      };
    });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({
        agentDir: tempDir,
        sessionDir: tempDir,
        agentName: "test-agent",
        config: { models: { chat: { id: "default-model", provider: "test" } } },
        tools: [],
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    const result = await coordinator.executeIsolated("subagent task", {
      signal: controller.signal,
    });

    expect(result).toEqual({
      sessionPath: null,
      replyText: "",
      error: "aborted",
    });
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it("releases a streaming session immediately when the provider abort never settles", async () => {
    const sessionFile = path.join(tempDir, "stuck-stream.jsonl");
    const emitEvent = vi.fn();
    const unsubscribe = vi.fn();
    const dispose = vi.fn();
    const abort = vi.fn(() => new Promise(() => {}));
    const stuckSession = {
      isStreaming: true,
      sessionManager: { getSessionFile: () => sessionFile },
      abort,
      dispose,
      extensionRunner: null,
    };

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => ({
        id: "hana",
        agentDir: tempDir,
        sessionDir: tempDir,
        _memoryTicker: { notifySessionEnd: vi.fn(() => Promise.resolve()) },
      }),
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent,
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });
    coordinator.sessions.set(sessionFile, {
      session: stuckSession,
      agentId: "hana",
      lastTouchedAt: Date.now(),
      unsub: unsubscribe,
    });
    coordinator._session = stuckSession;

    const result = await Promise.race([
      coordinator.abortSession(sessionFile),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 25)),
    ]);

    expect(result).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalled();
    expect(coordinator.isSessionStreaming(sessionFile)).toBe(false);
    expect(coordinator.session).toBeNull();
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session_status", isStreaming: false, aborted: true }),
      sessionFile,
    );
  });

  it("executeIsolated builds non-session tools from the master memory switch, not the focused session switch", async () => {
    const sessionFile = path.join(tempDir, "isolated-master-tools.jsonl");
    const builtinTool = { name: "read" };
    const plainTool = { name: "plain_custom" };
    const memoryTool = { name: "search_memory" };
    const getToolsSnapshot = vi.fn(({ forceMemoryEnabled } = {}) => (
      forceMemoryEnabled ? [plainTool, memoryTool] : [plainTool]
    ));
    const buildTools = vi.fn((_cwd, customTools) => ({
      tools: [builtinTool],
      customTools,
    }));
    const agent = {
      id: "hana",
      agentDir: tempDir,
      sessionDir: tempDir,
      agentName: "hana",
      memoryMasterEnabled: true,
      sessionMemoryEnabled: false,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      systemPrompt: "MEMORY MASTER PROMPT",
      tools: [plainTool],
      getToolsSnapshot,
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => tempDir,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => tempDir,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await coordinator.executeIsolated("background check");

    expect(getToolsSnapshot).toHaveBeenCalledWith({
      forceMemoryEnabled: true,
      model: { id: "default-model", provider: "test" },
    });
    expect(buildTools.mock.calls[0][1].map((tool) => tool.name)).toEqual([
      "plain_custom",
      "search_memory",
    ]);
    expect(createAgentSessionMock.mock.calls[0][0].customTools.map((tool) => tool.name)).toContain("search_memory");
  });

  it("executeIsolated builds sandboxed tools against the inherited execution cwd", async () => {
    const sessionFile = path.join(tempDir, "isolated-cwd-tools.jsonl");
    const buildTools = vi.fn((_cwd, customTools) => ({ tools: [], customTools }));
    const homeCwd = path.join(tempDir, "agent-home");
    const inheritedCwd = path.join(tempDir, "inherited-session-cwd");
    const agent = {
      id: "hana",
      agentDir: path.join(tempDir, "agents", "hana"),
      sessionDir: path.join(tempDir, "agents", "hana", "sessions"),
      agentName: "hana",
      memoryMasterEnabled: true,
      config: { models: { chat: { id: "default-model", provider: "test" } } },
      tools: [{ name: "write" }],
    };

    sessionManagerCreateMock.mockReturnValue({
      getCwd: () => inheritedCwd,
      getSessionFile: () => sessionFile,
    });
    createAgentSessionMock.mockResolvedValue({
      session: {
        sessionManager: { getSessionFile: () => sessionFile },
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(async () => {}),
        abort: vi.fn(),
      },
    });

    const coordinator = new SessionCoordinator({
      agentsDir: path.join(tempDir, "agents"),
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({
        authStorage: {},
        modelRegistry: {},
        defaultModel: { id: "default-model", provider: "test" },
        availableModels: [{ id: "default-model", provider: "test" }],
        resolveExecutionModel: (model) => model,
        resolveThinkingLevel: () => "medium",
      }),
      getResourceLoader: () => ({ getSystemPrompt: () => "prompt" }),
      getSkills: () => ({ getSkillsForAgent: () => [] }),
      buildTools,
      emitEvent: () => {},
      getHomeCwd: () => homeCwd,
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [],
    });

    await coordinator.executeIsolated("background check", { cwd: inheritedCwd });

    expect(buildTools).toHaveBeenCalledWith(
      inheritedCwd,
      agent.tools,
      expect.objectContaining({
        agentDir: agent.agentDir,
        workspace: inheritedCwd,
      }),
    );
  });

  it("switchSession 拒绝 subagent-sessions/activity/.ephemeral 等旁路路径", async () => {
    const coordinator = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({ sessionDir: "/tmp/agents/hana/sessions" }),
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "BASE" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    await expect(
      coordinator.switchSession("/tmp/agents/hana/subagent-sessions/child.jsonl"),
    ).rejects.toThrow(/path must be in/);
    await expect(
      coordinator.switchSession("/tmp/agents/hana/activity/tick.jsonl"),
    ).rejects.toThrow(/path must be in/);
    await expect(
      coordinator.switchSession("/tmp/agents/hana/.ephemeral/iso.jsonl"),
    ).rejects.toThrow(/path must be in/);
  });

  it("listSessions 不给旁路路径（subagent-sessions 等）伪造占位条目", async () => {
    const agent = {
      id: "hana",
      agentName: "小花",
      sessionDir: path.join(tempDir, "hana", "sessions"),
    };
    fs.mkdirSync(agent.sessionDir, { recursive: true });

    const coordinator = new SessionCoordinator({
      agentsDir: tempDir,
      getAgent: () => agent,
      getActiveAgentId: () => "hana",
      getModels: () => ({ authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "BASE" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp/home",
      agentIdFromSessionPath: () => "hana",
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => agent,
      listAgents: () => [{ id: "hana", name: "小花" }],
    });

    // 模拟焦点被污染到 subagent-sessions 下
    const subagentPath = path.join(tempDir, "hana", "subagent-sessions", "child.jsonl");
    coordinator._session = {
      sessionManager: {
        getSessionFile: () => subagentPath,
        getCwd: () => "/tmp/home",
      },
    };
    coordinator._sessionStarted = true;

    const sessions = await coordinator.listSessions();
    expect(sessions.find((s) => s.path === subagentPath)).toBeUndefined();
  });
});
