import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createAgentSessionMock = vi.fn();
const sessionManagerCreateMock = vi.fn();
const sessionManagerOpenMock = vi.fn();
const emitSessionShutdownMock = vi.fn(async (session) => {
  const runner = session?.extensionRunner;
  if (runner?.hasHandlers?.("session_shutdown")) {
    await runner.emit({ type: "session_shutdown" });
    return true;
  }
  return false;
});

vi.mock("../lib/pi-sdk/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createAgentSession: (...args) => createAgentSessionMock(...args),
    SessionManager: {
      ...actual.SessionManager,
      create: (...args) => sessionManagerCreateMock(...args),
      open: (...args) => sessionManagerOpenMock(...args),
    },
    emitSessionShutdown: (...args) => emitSessionShutdownMock(...args),
  };
});

import { BridgeSessionManager } from "../core/bridge-session-manager.js";

function makeAgent(rootDir, id = "agent-a") {
  const sessionDir = path.join(rootDir, "sessions");
  const agentDir = path.join(rootDir, "agent");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  return {
    id,
    agentName: "Agent A",
    sessionDir,
    agentDir,
    tools: [],
    yuanPrompt: "yuan",
    publicIshiki: "public-ishiki",
    config: {
      models: { chat: { id: "gpt-4o", provider: "openai" } },
      bridge: {},
    },
    buildSystemPrompt: () => "system prompt",
  };
}

function makeDeps(agent) {
  return {
    getHanakoHome: () => rootDir,
    getAgent: () => agent,
    getAgentById: (id) => (id === agent.id ? agent : null),
    getAgents: () => new Map([[agent.id, agent]]),
    getModelManager: () => ({
      availableModels: [{ id: "gpt-4o", provider: "openai", name: "GPT-4o" }],
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: () => "medium",
    }),
    getResourceLoader: () => ({ getSystemPrompt: () => "fallback prompt" }),
    getPreferences: () => ({ thinking_level: "medium" }),
    buildTools: () => ({ tools: [], customTools: [] }),
    getHomeCwd: () => rootCwd,
    registerSessionFile: vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
      id: "sf_bridge_inbound",
      fileId: "sf_bridge_inbound",
      sessionPath,
      filePath,
      realPath: filePath,
      displayName: label,
      filename: path.basename(filePath),
      label,
      ext: "png",
      mime: "image/png",
      size: 4,
      kind: "image",
      origin,
      storageKind,
      createdAt: 1,
    })),
  };
}

let rootDir;
let rootCwd;

describe("BridgeSessionManager teardown", () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-session-teardown-"));
    rootCwd = path.join(rootDir, "cwd");
    fs.mkdirSync(rootCwd, { recursive: true });
    createAgentSessionMock.mockReset();
    sessionManagerCreateMock.mockReset();
    sessionManagerOpenMock.mockReset();
    emitSessionShutdownMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("executeExternalMessage 结束后走 emit -> unsub -> dispose", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s1.jsonl");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const callOrder = [];
    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => { callOrder.push("unsub"); }),
      dispose: vi.fn(() => { callOrder.push("dispose"); }),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: {
        hasHandlers: vi.fn(() => true),
        emit: vi.fn(async () => { callOrder.push("emit"); }),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("hello", "bridge-k1", null, { agentId: "agent-a" });

    expect(callOrder).toEqual(["emit", "unsub", "dispose"]);
    expect(emitSessionShutdownMock).toHaveBeenCalledWith(session);
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(manager.activeSessions.has("bridge-k1")).toBe(false);
  });

  it("registers bridge inbound image files after the bridge session path exists", async () => {
    const agent = makeAgent(rootDir);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-inbound.jsonl");
    const deps = makeDeps(agent);
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const session = {
      model: { input: ["text", "image"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("hello", "bridge-inbound", null, {
      agentId: "agent-a",
      images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      inboundFiles: [{
        type: "image",
        filename: "photo.png",
        mimeType: "image/png",
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      }],
    });

    expect(deps.registerSessionFile).toHaveBeenCalledWith({
      sessionPath: mgrPath,
      filePath: expect.stringContaining(path.join(rootDir, "session-files")),
      label: "photo.png",
      origin: "bridge_inbound",
      storageKind: "managed_cache",
    });
    expect(session.prompt).toHaveBeenCalledWith(
      `[attached_image: ${deps.registerSessionFile.mock.calls[0][0].filePath}]\nhello`,
      expect.objectContaining({
        images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
        imageAttachmentPaths: [deps.registerSessionFile.mock.calls[0][0].filePath],
      }),
    );
  });

  it("abortSession releases a bridge session immediately when provider abort never settles", async () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));
    const abort = vi.fn(() => new Promise(() => {}));
    const dispose = vi.fn();

    manager.activeSessions.set("bridge-k1", {
      isStreaming: true,
      abort,
      dispose,
    });

    const result = await Promise.race([
      manager.abortSession("bridge-k1"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 25)),
    ]);

    expect(result).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalled();
    expect(manager.activeSessions.has("bridge-k1")).toBe(false);
  });

  it("owner bridge session prompt snapshot uses the same home cwd as execution", async () => {
    const agent = makeAgent(rootDir);
    agent.buildSystemPrompt = vi.fn(({ cwdOverride } = {}) => `system prompt @ ${cwdOverride ?? "missing"}`);
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-home.jsonl");
    const manager = new BridgeSessionManager(makeDeps(agent));
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: {
        hasHandlers: vi.fn(() => false),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await manager.executeExternalMessage("hello", "bridge-k-home", null, { agentId: "agent-a" });

    expect(agent.buildSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({ cwdOverride: rootCwd }));
    const createArgs = createAgentSessionMock.mock.calls.at(-1)[0];
    expect(createArgs.cwd).toBe(rootCwd);
    expect(createArgs.resourceLoader.getSystemPrompt()).toBe(`system prompt @ ${rootCwd}`);
  });

  it("owner bridge tools follow the master memory switch instead of session memory state", async () => {
    const agent = makeAgent(rootDir);
    agent.memoryMasterEnabled = true;
    const plainTool = { name: "plain_custom" };
    const memoryTool = { name: "search_memory" };
    agent.tools = [plainTool];
    agent.getToolsSnapshot = vi.fn(({ forceMemoryEnabled } = {}) => (
      forceMemoryEnabled ? [plainTool, memoryTool] : [plainTool]
    ));
    const buildTools = vi.fn((_cwd, customTools) => ({
      tools: [],
      customTools,
    }));
    const deps = {
      ...makeDeps(agent),
      buildTools,
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-master-tools.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    createAgentSessionMock.mockResolvedValue({
      session: {
        model: { input: ["text"] },
        prompt: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => mgrPath },
        extensionRunner: { hasHandlers: vi.fn(() => false) },
      },
    });

    await manager.executeExternalMessage("hello", "bridge-k-master-tools", null, { agentId: "agent-a" });

    expect(agent.getToolsSnapshot).toHaveBeenCalledWith({ forceMemoryEnabled: true });
    expect(buildTools.mock.calls[0][1].map((tool) => tool.name)).toEqual([
      "plain_custom",
      "search_memory",
    ]);
    expect(createAgentSessionMock.mock.calls[0][0].customTools.map((tool) => tool.name)).toContain("search_memory");
  });

  it("owner bridge text-only model prepares images through the vision bridge", async () => {
    const agent = makeAgent(rootDir);
    const visionBridge = {
      prepare: vi.fn(async ({ text }) => ({ text, images: undefined })),
      injectNotes: vi.fn(() => ({ injected: 0 })),
    };
    const deps = {
      ...makeDeps(agent),
      getVisionBridge: () => visionBridge,
      isVisionAuxiliaryEnabled: () => true,
      getModelManager: () => ({
        availableModels: [{ id: "gpt-4o", provider: "openai", name: "GPT-4o", input: ["text"] }],
        authStorage: {},
        modelRegistry: {},
        resolveThinkingLevel: () => "medium",
      }),
    };
    const mgrPath = path.join(agent.sessionDir, "bridge", "owner", "s-vision.jsonl");
    const manager = new BridgeSessionManager(deps);
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => mgrPath });

    const session = {
      model: { id: "gpt-4o", provider: "openai", input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => mgrPath },
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };
    createAgentSessionMock.mockResolvedValue({ session });
    const images = [{ type: "image", data: "BASE64", mimeType: "image/png" }];

    await manager.executeExternalMessage("hello", "bridge-k-vision", null, {
      agentId: "agent-a",
      images,
      imageAttachmentPaths: ["/tmp/upload.png"],
    });

    expect(visionBridge.prepare).toHaveBeenCalledWith(expect.objectContaining({
      targetModel: expect.objectContaining({ input: ["text"] }),
      text: "hello",
      images,
      imageAttachmentPaths: ["/tmp/upload.png"],
    }));
    expect(session.prompt).toHaveBeenCalledWith("hello", undefined);
  });

  it("compactSession 的临时 owner session 结束后也会 shutdown + dispose", async () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const sessionFile = path.join(bridgeDir, "owner", "s1.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    manager.writeIndex({ "bridge-k2": { file: "owner/s1.jsonl" } }, agent);
    sessionManagerOpenMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const callOrder = [];
    const session = {
      isCompacting: false,
      compact: vi.fn(async () => {}),
      getContextUsage: vi.fn()
        .mockReturnValueOnce({ tokens: 900, contextWindow: 128000 })
        .mockReturnValueOnce({ tokens: 300, contextWindow: 128000 }),
      dispose: vi.fn(() => { callOrder.push("dispose"); }),
      extensionRunner: {
        hasHandlers: vi.fn(() => true),
        emit: vi.fn(async () => { callOrder.push("emit"); }),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const result = await manager.compactSession("bridge-k2", { agentId: "agent-a" });

    expect(result).toEqual({ tokensBefore: 900, tokensAfter: 300, contextWindow: 128000 });
    expect(callOrder).toEqual(["emit", "dispose"]);
    expect(emitSessionShutdownMock).toHaveBeenCalledWith(session);
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("open 旧 bridge session 失败后，会把索引自愈到新建文件并保留元数据", async () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const stalePath = path.join(bridgeDir, "owner", "stale.jsonl");
    const freshPath = path.join(bridgeDir, "owner", "fresh.jsonl");
    manager.writeIndex({
      "bridge-k3": { file: "owner/stale.jsonl", name: "Alice", userId: "u-1" },
    }, agent);

    sessionManagerOpenMock.mockImplementation(() => {
      throw new Error(`cannot open ${stalePath}`);
    });
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => freshPath });

    const session = {
      model: { input: ["text"] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
      sessionManager: { getSessionFile: () => freshPath },
      extensionRunner: {
        hasHandlers: vi.fn(() => false),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await manager.executeExternalMessage("hello", "bridge-k3", null, { agentId: "agent-a" });
    } finally {
      warnSpy.mockRestore();
    }

    expect(sessionManagerOpenMock).toHaveBeenCalledOnce();
    expect(sessionManagerCreateMock).toHaveBeenCalledOnce();
    expect(manager.readIndex(agent)["bridge-k3"]).toEqual({
      file: "owner/fresh.jsonl",
      name: "Alice",
      userId: "u-1",
    });
  });

  it("explicit unresolved agentId errors instead of falling back to focus agent", async () => {
    const agent = makeAgent(rootDir);
    const manager = new BridgeSessionManager(makeDeps(agent));

    await expect(
      manager.executeExternalMessage("hello", "bridge-missing", null, { agentId: "missing-agent" }),
    ).resolves.toMatchObject({
      __bridgeError: true,
      message: expect.stringMatching(/agent "missing-agent" not found/),
    });
    expect(() => manager.injectMessage("bridge-missing", "note", { agentId: "missing-agent" }))
      .toThrow(/agent "missing-agent" not found/);
    await expect(
      manager.compactSession("bridge-missing", { agentId: "missing-agent" }),
    ).rejects.toThrow(/agent "missing-agent" not found/);
    expect(sessionManagerCreateMock).not.toHaveBeenCalled();
    expect(sessionManagerOpenMock).not.toHaveBeenCalled();
  });

  it("reconcile cleans bridge indexes for every agent, not just focus agent", () => {
    const focusAgent = makeAgent(path.join(rootDir, "focus"), "focus");
    const otherAgent = makeAgent(path.join(rootDir, "other"), "other");
    const deps = {
      ...makeDeps(focusAgent),
      getAgents: () => new Map([
        [focusAgent.id, focusAgent],
        [otherAgent.id, otherAgent],
      ]),
    };
    const manager = new BridgeSessionManager(deps);

    manager.writeIndex({ "focus-k": { file: "owner/missing-focus.jsonl", name: "Focus" } }, focusAgent);
    manager.writeIndex({ "other-k": { file: "owner/missing-other.jsonl", name: "Other" } }, otherAgent);

    manager.reconcile();

    expect(manager.readIndex(focusAgent)["focus-k"]).toEqual({ name: "Focus" });
    expect(manager.readIndex(otherAgent)["other-k"]).toEqual({ name: "Other" });
  });
});
