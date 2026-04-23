import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const browserManagerMock = {
  _sessions: new Map(), // sessionPath → { running, url }
  isRunning(sp) { return this._sessions.get(sp)?.running ?? false; },
  currentUrl(sp) { return this._sessions.get(sp)?.url ?? null; },
  get hasAnyRunning() { for (const s of this._sessions.values()) if (s.running) return true; return false; },
  suspendForSession: vi.fn(async (sp) => {
    const s = browserManagerMock._sessions.get(sp);
    if (s) s.running = false;
  }),
  resumeForSession: vi.fn(async (sp) => {
    browserManagerMock._sessions.set(sp, { running: true, url: "https://after.example.com" });
  }),
  closeBrowserForSession: vi.fn(),
  getBrowserSessions: vi.fn(() => ({})),
};

vi.mock("../lib/browser/browser-manager.js", () => ({
  BrowserManager: {
    instance: () => browserManagerMock,
  },
}));

vi.mock("../core/message-utils.js", () => ({
  extractTextContent: vi.fn(() => ({ text: "", images: [], thinking: "", toolUses: [] })),
  loadSessionHistoryMessages: vi.fn(async () => []),
  loadLatestAssistantSummaryFromSessionFile: vi.fn(async () => null),
  isValidSessionPath: vi.fn(() => true),
}));

describe("sessions route", () => {
  let tmpDir;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-sessions-route-"));
    browserManagerMock._sessions.clear();
    browserManagerMock._sessions.set("/tmp/agents/a/sessions/old.jsonl", { running: true, url: "https://before.example.com" });
    browserManagerMock.suspendForSession.mockClear();
    browserManagerMock.resumeForSession.mockClear();
    browserManagerMock.closeBrowserForSession.mockClear();
  });

  it("restores browser state for the target session after switch", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const app = new Hono();

    const engine = {
      agentsDir: "/tmp/agents",
      currentSessionPath: "/tmp/agents/a/sessions/old.jsonl",
      messages: [{ role: "assistant", content: "ok" }],
      memoryEnabled: true,
      planMode: false,
      memoryModelUnavailableReason: null,
      cwd: "/tmp/workspace",
      currentAgentId: "hana",
      agentName: "Hana",
      currentModel: { id: "gpt-test", provider: "openai" },
      isSessionStreaming: vi.fn(() => false),
      switchSession: vi.fn(async (sessionPath) => {
        engine.currentSessionPath = sessionPath;
      }),
      getSessionByPath: vi.fn((sp) => ({
        messages: [{ role: "assistant", content: "ok" }],
      })),
      getAgent: vi.fn(() => ({ agentName: "Hana" })),
      agentIdFromSessionPath: vi.fn((sp) => {
        const p = require("path");
        const rel = p.relative("/tmp/agents", sp);
        return rel.split(p.sep)[0] || null;
      }),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/agents/a/sessions/new.jsonl", currentSessionPath: "/tmp/agents/a/sessions/old.jsonl" }),
    });

    const data = await res.json();
    expect(res.status).toBe(200);
    expect(browserManagerMock.suspendForSession).toHaveBeenCalledWith("/tmp/agents/a/sessions/old.jsonl");
    expect(browserManagerMock.resumeForSession).toHaveBeenCalledWith("/tmp/agents/a/sessions/new.jsonl");
    expect(data.browserRunning).toBe(true); // resumeForSession sets it running
    expect(data.browserUrl).toBe("https://after.example.com"); // per-session URL
  });

  it("infers subagent agent identity from child sessionPath when history details are missing", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const msgUtils = await import("../core/message-utils.js");
    const app = new Hono();

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "do work",
          sessionPath: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
          streamStatus: "done",
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: null,
      agentIdFromSessionPath: vi.fn((sp) => {
        const p = require("path");
        const rel = p.relative("/tmp/agents", sp);
        return rel.split(p.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => (id === "hanako" ? { agentName: "Hanako" } : null)),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks).toHaveLength(1);
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      agentId: "hanako",
      agentName: "Hanako",
      streamKey: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
    });
  });

  it("prefers explicit executor metadata over owner-path inference", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const msgUtils = await import("../core/message-utils.js");
    const app = new Hono();

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "delegate to butter",
          requestedAgentId: "butter",
          requestedAgentNameSnapshot: "butter",
          executorAgentId: "butter",
          executorAgentNameSnapshot: "butter",
          sessionPath: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
          streamStatus: "done",
        },
      },
    ]);

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: null,
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative("/tmp/agents", sp);
        return rel.split(path.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => {
        if (id === "hanako") return { agentName: "Hanako" };
        if (id === "butter") return { agentName: "butter" };
        return null;
      }),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks).toHaveLength(1);
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      agentId: "butter",
      agentName: "butter",
      requestedAgentId: "butter",
      requestedAgentName: "butter",
      streamKey: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
    });
  });

  it("uses child-session executor snapshot when live agent has been deleted", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const msgUtils = await import("../core/message-utils.js");
    const app = new Hono();

    const agentsDir = path.join(tmpDir, "agents");
    const childSessionPath = path.join(agentsDir, "hanako", "subagent-sessions", "child.jsonl");
    fs.mkdirSync(path.dirname(childSessionPath), { recursive: true });
    fs.writeFileSync(childSessionPath, "", "utf-8");
    fs.writeFileSync(
      path.join(path.dirname(childSessionPath), "session-meta.json"),
      JSON.stringify({
        "child.jsonl": {
          executorAgentId: "deleted-butter",
          executorAgentNameSnapshot: "butter",
          executorMetaVersion: 1,
        },
      }, null, 2),
      "utf-8",
    );

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "legacy delegated task",
          sessionPath: childSessionPath,
          streamStatus: "done",
        },
      },
    ]);

    const engine = {
      agentsDir,
      deferredResults: null,
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative(agentsDir, sp);
        return rel.split(path.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => (id === "hanako" ? { agentName: "Hanako" } : null)),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.blocks).toHaveLength(1);
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      agentId: "deleted-butter",
      agentName: "butter",
      streamKey: childSessionPath,
    });
  });

  it("marks running subagent block done when child-session tail summary is available", async () => {
    const { createSessionsRoute } = await import("../server/routes/sessions.js");
    const msgUtils = await import("../core/message-utils.js");
    const app = new Hono();

    vi.mocked(msgUtils.extractTextContent)
      .mockReturnValueOnce({ text: "parent says hi", images: [], thinking: "", toolUses: [] });
    vi.mocked(msgUtils.loadSessionHistoryMessages).mockResolvedValueOnce([
      { role: "assistant", content: "parent says hi" },
      {
        role: "toolResult",
        toolName: "subagent",
        details: {
          taskId: "subagent-1",
          task: "do work",
          sessionPath: "/tmp/agents/hanako/subagent-sessions/child.jsonl",
          streamStatus: "running",
        },
      },
    ]);
    vi.mocked(msgUtils.loadLatestAssistantSummaryFromSessionFile)
      .mockResolvedValueOnce("child finished");

    const engine = {
      agentsDir: "/tmp/agents",
      deferredResults: null,
      agentIdFromSessionPath: vi.fn((sp) => {
        const rel = path.relative("/tmp/agents", sp);
        return rel.split(path.sep)[0] || null;
      }),
      getAgent: vi.fn((id) => (id === "hanako" ? { agentName: "Hanako" } : null)),
    };

    app.route("/api", createSessionsRoute(engine));

    const res = await app.request("/api/sessions/messages");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(msgUtils.loadLatestAssistantSummaryFromSessionFile).toHaveBeenCalledWith("/tmp/agents/hanako/subagent-sessions/child.jsonl");
    expect(data.blocks[0]).toMatchObject({
      type: "subagent",
      streamStatus: "done",
      summary: "child finished",
    });
  });
});
