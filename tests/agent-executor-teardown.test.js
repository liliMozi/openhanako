import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createAgentSessionMock = vi.fn();
const sessionManagerCreateMock = vi.fn();
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
    },
    emitSessionShutdown: (...args) => emitSessionShutdownMock(...args),
  };
});

import { runAgentSession } from "../hub/agent-executor.js";

let rootDir;

function makeAgent(root) {
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  return {
    id: "agent-a",
    agentDir,
    tools: [],
    personality: "personality",
    systemPrompt: "system prompt",
    config: { models: { chat: { id: "gpt-4o", provider: "openai" } } },
  };
}

function makeEngine(agent, cwd) {
  return {
    getAgent: (id) => (id === agent.id ? agent : null),
    getHomeCwd: () => cwd,
    createSessionContext: () => ({
      resourceLoader: {},
      getSkillsForAgent: () => ({ skills: [], diagnostics: [] }),
      buildTools: () => ({ tools: [], customTools: [] }),
      resolveModel: () => ({ id: "gpt-4o", provider: "openai", name: "GPT-4o" }),
      authStorage: {},
      modelRegistry: {},
    }),
  };
}

describe("runAgentSession teardown", () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-executor-teardown-"));
    createAgentSessionMock.mockReset();
    sessionManagerCreateMock.mockReset();
    emitSessionShutdownMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("hub 临时 session 结束后走 emit -> unsub -> dispose", async () => {
    const cwd = path.join(rootDir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const agent = makeAgent(rootDir);
    const engine = makeEngine(agent, cwd);
    const sessionFile = path.join(agent.agentDir, "sessions", "temp", "s1.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");
    sessionManagerCreateMock.mockReturnValue({ getSessionFile: () => sessionFile });

    const callOrder = [];
    const session = {
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => { callOrder.push("unsub"); }),
      dispose: vi.fn(() => { callOrder.push("dispose"); }),
      sessionManager: { getSessionFile: () => sessionFile },
      extensionRunner: {
        hasHandlers: vi.fn(() => true),
        emit: vi.fn(async () => { callOrder.push("emit"); }),
      },
    };
    createAgentSessionMock.mockResolvedValue({ session });

    await runAgentSession("agent-a", [{ text: "hello", capture: true }], { engine });

    expect(callOrder).toEqual(["emit", "unsub", "dispose"]);
    expect(emitSessionShutdownMock).toHaveBeenCalledWith(session);
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(fs.existsSync(sessionFile)).toBe(false);
  });
});
