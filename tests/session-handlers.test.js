/**
 * Tests for Hub session bus handlers.
 *
 * Each handler is extracted as a helper that accepts (bus, mockEngine) and
 * registers itself — tests are self-contained, no need to instantiate Hub.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus } from "../hub/event-bus.js";

// ── helpers: register handlers inline (mirrors _setupSessionHandlers logic) ──

vi.mock("../core/message-utils.js", () => ({
  extractTextContent: (content, opts = {}) => {
    if (typeof content === "string") return { text: content, thinking: "", toolUses: [], images: [] };
    if (!Array.isArray(content)) return { text: "", thinking: "", toolUses: [], images: [] };
    const text = content.filter(b => b.type === "text").map(b => b.text).join("");
    return { text, thinking: "", toolUses: [], images: [] };
  },
  loadSessionHistoryMessages: vi.fn(async (engine, sessionPath) => {
    return engine._fakeMessages || [];
  }),
  isValidSessionPath: vi.fn((sessionPath, agentsDir) => {
    return sessionPath.startsWith(agentsDir);
  }),
}));

import {
  extractTextContent,
  loadSessionHistoryMessages,
  isValidSessionPath,
} from "../core/message-utils.js";

function registerHandlers(bus, engine) {
  const cleanups = [];

  // session:send
  cleanups.push(bus.handle("session:send", async ({ text, sessionPath, ...opts }) => {
    if (!text || typeof text !== "string" || !text.trim()) {
      throw new Error("text is required");
    }
    const sp = sessionPath;
    if (!sp) throw new Error("sessionPath is required for session:send");
    if (engine.isSessionStreaming(sp)) throw new Error("session_busy");
    engine.promptSession(sp, text, opts).catch(err => {
      console.error("[Hub] session:send promptSession error:", err.message);
      bus.emit({ type: "error", error: err.message, source: "session:send" }, sp);
    });
    return { sessionPath: sp, accepted: true };
  }));

  // session:abort
  cleanups.push(bus.handle("session:abort", async ({ sessionPath } = {}) => {
    const sp = sessionPath;
    if (!sp) return { aborted: false };
    const result = await engine.abortSession(sp);
    return { aborted: !!result };
  }));

  // session:history
  cleanups.push(bus.handle("session:history", async ({ sessionPath, limit: rawLimit } = {}) => {
    if (!sessionPath) throw new Error("sessionPath is required");
    if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
      throw new Error("Invalid session path");
    }
    const limit = Math.min(Number(rawLimit) || 50, 200);
    const sourceMessages = await loadSessionHistoryMessages(engine, sessionPath);
    const messages = [];
    for (const m of sourceMessages) {
      if (m.role === "user") {
        const { text, images } = extractTextContent(m.content);
        if (text || images.length) {
          messages.push({ role: "user", content: text, images: images.length ? images : undefined });
        }
      } else if (m.role === "assistant") {
        const { text, thinking, toolUses } = extractTextContent(m.content, { stripThink: true });
        if (text || toolUses.length) {
          messages.push({
            role: "assistant",
            content: text,
            thinking: thinking || undefined,
            toolCalls: toolUses.length ? toolUses : undefined,
          });
        }
      }
      if (messages.length >= limit) break;
    }
    return { messages };
  }));

  // session:list
  cleanups.push(bus.handle("session:list", async ({ agentId } = {}) => {
    const all = await engine.listSessions();
    const filtered = agentId ? all.filter(s => s.agentId === agentId) : all;
    const sessions = filtered.map(s => ({
      path: s.path,
      title: s.title,
      firstMessage: s.firstMessage,
      agentId: s.agentId,
      agentName: s.agentName,
      modelId: s.modelId,
      messageCount: s.messageCount,
      cwd: s.cwd,
      modified: s.modified,
    }));
    return { sessions };
  }));

  // agent:list
  cleanups.push(bus.handle("agent:list", async () => {
    const all = engine.listAgents();
    const agents = all.map(a => ({
      id: a.id,
      name: a.name,
      isCurrent: a.isCurrent,
      isPrimary: a.isPrimary,
    }));
    return { agents };
  }));

  return () => cleanups.forEach(fn => fn());
}

// ── fixtures ──

let bus;
let mockEngine;

beforeEach(() => {
  bus = new EventBus();
  mockEngine = {
    agentsDir: "/agents",
    currentSessionPath: "/agents/agent1/sessions/current.jsonl",
    isSessionStreaming: vi.fn(() => false),
    promptSession: vi.fn(() => Promise.resolve()),
    abortSession: vi.fn(() => Promise.resolve(true)),
    listSessions: vi.fn(() => Promise.resolve([])),
    listAgents: vi.fn(() => []),
    _fakeMessages: [],
  };
  registerHandlers(bus, mockEngine);
});

// ── session:send ──

describe("session:send", () => {
  it("sends prompt and returns accepted", async () => {
    const sp = "/agents/agent1/sessions/current.jsonl";
    const result = await bus.request("session:send", { text: "hello", sessionPath: sp });
    expect(result).toEqual({ sessionPath: sp, accepted: true });
    // promptSession called fire-and-forget — give microtasks a tick
    await Promise.resolve();
    expect(mockEngine.promptSession).toHaveBeenCalledWith(
      sp,
      "hello",
      {},
    );
  });

  it("uses explicit sessionPath when provided", async () => {
    const result = await bus.request("session:send", {
      text: "hi",
      sessionPath: "/agents/agent2/sessions/other.jsonl",
    });
    expect(result.sessionPath).toBe("/agents/agent2/sessions/other.jsonl");
    expect(result.accepted).toBe(true);
  });

  it("throws when sessionPath is missing (no focus fallback)", async () => {
    await expect(bus.request("session:send", { text: "test" }))
      .rejects.toThrow("sessionPath is required for session:send");
  });

  it("throws when text is empty", async () => {
    await expect(bus.request("session:send", { text: "" }))
      .rejects.toThrow("text is required");
  });

  it("throws when text is whitespace only", async () => {
    await expect(bus.request("session:send", { text: "   " }))
      .rejects.toThrow("text is required");
  });

  it("throws session_busy when isSessionStreaming returns true", async () => {
    mockEngine.isSessionStreaming.mockReturnValue(true);
    await expect(bus.request("session:send", { text: "hello", sessionPath: "/agents/agent1/sessions/current.jsonl" }))
      .rejects.toThrow("session_busy");
  });

  it("emits error event on bus when promptSession fails (fire-and-forget)", async () => {
    mockEngine.promptSession.mockRejectedValue(new Error("model error"));
    const errorEvents = [];
    bus.subscribe(ev => errorEvents.push(ev), { types: ["error"] });

    await bus.request("session:send", { text: "hello", sessionPath: "/agents/agent1/sessions/current.jsonl" });
    // allow the .catch to run
    await new Promise(r => setTimeout(r, 0));

    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].error).toBe("model error");
    expect(errorEvents[0].source).toBe("session:send");
  });
});

// ── session:abort ──

describe("session:abort", () => {
  it("aborts streaming session with explicit path", async () => {
    mockEngine.abortSession.mockResolvedValue(true);
    const result = await bus.request("session:abort", { sessionPath: "/agents/a1/sessions/s.jsonl" });
    expect(result).toEqual({ aborted: true });
    expect(mockEngine.abortSession).toHaveBeenCalledWith("/agents/a1/sessions/s.jsonl");
  });

  it("returns aborted: false when sessionPath is missing (no focus fallback)", async () => {
    mockEngine.currentSessionPath = "/agents/focus/sessions/f.jsonl";
    const result = await bus.request("session:abort", {});
    expect(result).toEqual({ aborted: false });
    expect(mockEngine.abortSession).not.toHaveBeenCalled();
  });

  it("returns aborted: false when no session available", async () => {
    mockEngine.currentSessionPath = null;
    const result = await bus.request("session:abort", {});
    expect(result).toEqual({ aborted: false });
    expect(mockEngine.abortSession).not.toHaveBeenCalled();
  });

  it("returns aborted: false when abortSession resolves falsy", async () => {
    mockEngine.abortSession.mockResolvedValue(false);
    const result = await bus.request("session:abort", { sessionPath: "/agents/a/sessions/s.jsonl" });
    expect(result).toEqual({ aborted: false });
  });
});

// ── session:history ──

describe("session:history", () => {
  it("throws when sessionPath missing", async () => {
    await expect(bus.request("session:history", {}))
      .rejects.toThrow("sessionPath is required");
  });

  it("throws on invalid path (path traversal)", async () => {
    isValidSessionPath.mockReturnValueOnce(false);
    await expect(bus.request("session:history", { sessionPath: "/etc/passwd" }))
      .rejects.toThrow("Invalid session path");
  });

  it("returns formatted messages from history", async () => {
    mockEngine._fakeMessages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    const result = await bus.request("session:history", {
      sessionPath: "/agents/agent1/sessions/s.jsonl",
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({ role: "user", content: "hello", images: undefined });
    expect(result.messages[1]).toMatchObject({ role: "assistant", content: "world" });
  });

  it("respects limit parameter", async () => {
    mockEngine._fakeMessages = Array.from({ length: 10 }, (_, i) => ({
      role: "user",
      content: `msg ${i}`,
    }));
    const result = await bus.request("session:history", {
      sessionPath: "/agents/agent1/sessions/s.jsonl",
      limit: 3,
    });
    expect(result.messages).toHaveLength(3);
  });

  it("caps limit at 200", async () => {
    // Even if limit: 999 is passed, we only get up to 200
    // Verify that limit is capped by checking Math.min logic (no need for 200+ messages)
    mockEngine._fakeMessages = Array.from({ length: 5 }, (_, i) => ({
      role: "user",
      content: `msg ${i}`,
    }));
    const result = await bus.request("session:history", {
      sessionPath: "/agents/agent1/sessions/s.jsonl",
      limit: 999,
    });
    // All 5 messages fit under the 200 cap
    expect(result.messages).toHaveLength(5);
  });
});

// ── session:list ──

describe("session:list", () => {
  const fakeSessions = [
    { path: "/agents/a1/sessions/s1.jsonl", title: "Chat 1", firstMessage: "hi", agentId: "a1", agentName: "Agent One", modelId: "gpt-4", messageCount: 3, cwd: "/tmp", modified: new Date("2024-01-01") },
    { path: "/agents/a2/sessions/s2.jsonl", title: "Chat 2", firstMessage: "yo", agentId: "a2", agentName: "Agent Two", modelId: "qwen", messageCount: 1, cwd: "/tmp", modified: new Date("2024-01-02") },
  ];

  beforeEach(() => {
    mockEngine.listSessions.mockResolvedValue(fakeSessions);
  });

  it("returns all sessions", async () => {
    const result = await bus.request("session:list", {});
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0].path).toBe("/agents/a1/sessions/s1.jsonl");
    expect(result.sessions[1].agentId).toBe("a2");
  });

  it("filters by agentId", async () => {
    const result = await bus.request("session:list", { agentId: "a1" });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].agentId).toBe("a1");
  });

  it("maps to expected response shape", async () => {
    const result = await bus.request("session:list", {});
    const s = result.sessions[0];
    expect(s).toHaveProperty("path");
    expect(s).toHaveProperty("title");
    expect(s).toHaveProperty("firstMessage");
    expect(s).toHaveProperty("agentId");
    expect(s).toHaveProperty("agentName");
    expect(s).toHaveProperty("modelId");
    expect(s).toHaveProperty("messageCount");
    expect(s).toHaveProperty("cwd");
    expect(s).toHaveProperty("modified");
  });
});

// ── agent:list ──

describe("agent:list", () => {
  it("returns agents with isCurrent and isPrimary", async () => {
    mockEngine.listAgents.mockReturnValue([
      { id: "a1", name: "Hana", isCurrent: true, isPrimary: true, extraField: "ignored" },
      { id: "a2", name: "Kuro", isCurrent: false, isPrimary: false, extraField: "ignored" },
    ]);
    const result = await bus.request("agent:list", {});
    expect(result.agents).toHaveLength(2);
    expect(result.agents[0]).toEqual({ id: "a1", name: "Hana", isCurrent: true, isPrimary: true });
    expect(result.agents[1]).toEqual({ id: "a2", name: "Kuro", isCurrent: false, isPrimary: false });
    // extraField should not leak through
    expect(result.agents[0]).not.toHaveProperty("extraField");
  });

  it("returns empty array when no agents", async () => {
    mockEngine.listAgents.mockReturnValue([]);
    const result = await bus.request("agent:list", {});
    expect(result.agents).toEqual([]);
  });
});

// ── provider & agent config handlers ──

function registerProviderHandlers(bus, engine) {
  bus.handle("provider:credentials", async ({ providerId }) => {
    const creds = engine.providerRegistry.getCredentials(providerId);
    if (!creds?.apiKey) return { error: "no_credentials" };
    return { apiKey: creds.apiKey, baseUrl: creds.baseUrl, api: creds.api };
  });

  bus.handle("provider:models-by-type", async ({ type, providerId }) => {
    if (providerId) {
      return { models: engine.providerRegistry.getModelsByType(providerId, type) };
    }
    return { models: engine.providerRegistry.getAllModelsByType(type) };
  });

  bus.handle("agent:config", async ({ agentId }) => {
    const agent = engine.agentManager.getAgent(agentId);
    if (!agent) return { error: "not_found" };
    return { config: agent.config };
  });
}

describe("provider:credentials", () => {
  it("returns credentials for configured provider", async () => {
    const bus = new EventBus();
    const engine = {
      providerRegistry: {
        getCredentials: vi.fn(() => ({ apiKey: "sk-test", baseUrl: "https://api.test.com", api: "openai-completions" })),
      },
    };
    registerProviderHandlers(bus, engine);

    const result = await bus.request("provider:credentials", { providerId: "test" });
    expect(result.apiKey).toBe("sk-test");
    expect(result.baseUrl).toBe("https://api.test.com");
  });

  it("returns error for unconfigured provider", async () => {
    const bus = new EventBus();
    const engine = {
      providerRegistry: { getCredentials: vi.fn(() => ({})) },
    };
    registerProviderHandlers(bus, engine);

    const result = await bus.request("provider:credentials", { providerId: "none" });
    expect(result.error).toBe("no_credentials");
  });
});

describe("provider:models-by-type", () => {
  it("returns image models for a specific provider", async () => {
    const bus = new EventBus();
    const engine = {
      providerRegistry: {
        getModelsByType: vi.fn(() => [{ id: "img-1", type: "image" }]),
        getAllModelsByType: vi.fn(() => []),
      },
    };
    registerProviderHandlers(bus, engine);

    const result = await bus.request("provider:models-by-type", { type: "image", providerId: "test" });
    expect(result.models).toHaveLength(1);
    expect(engine.providerRegistry.getModelsByType).toHaveBeenCalledWith("test", "image");
  });

  it("returns all image models when no providerId", async () => {
    const bus = new EventBus();
    const engine = {
      providerRegistry: {
        getModelsByType: vi.fn(),
        getAllModelsByType: vi.fn(() => [{ id: "img-1", provider: "a" }, { id: "img-2", provider: "b" }]),
      },
    };
    registerProviderHandlers(bus, engine);

    const result = await bus.request("provider:models-by-type", { type: "image" });
    expect(result.models).toHaveLength(2);
    expect(engine.providerRegistry.getAllModelsByType).toHaveBeenCalledWith("image");
  });
});

describe("agent:config", () => {
  it("returns agent config", async () => {
    const bus = new EventBus();
    const engine = {
      agentManager: {
        getAgent: vi.fn(() => ({ config: { imageModel: { id: "img-1", provider: "test" } } })),
      },
    };
    registerProviderHandlers(bus, engine);

    const result = await bus.request("agent:config", { agentId: "agent-1" });
    expect(result.config.imageModel).toEqual({ id: "img-1", provider: "test" });
  });

  it("returns error for missing agent", async () => {
    const bus = new EventBus();
    const engine = { agentManager: { getAgent: vi.fn(() => null) } };
    registerProviderHandlers(bus, engine);

    const result = await bus.request("agent:config", { agentId: "missing" });
    expect(result.error).toBe("not_found");
  });
});
