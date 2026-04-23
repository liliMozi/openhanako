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

function makeAgent(rootDir) {
  const sessionDir = path.join(rootDir, "sessions");
  const agentDir = path.join(rootDir, "agent");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  return {
    id: "agent-a",
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
    getAgent: () => agent,
    getAgentById: (id) => (id === agent.id ? agent : null),
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
});
