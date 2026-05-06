import { describe, expect, it } from "vitest";
import { classifySessionPermission } from "../core/session-permission-mode.js";
import { createCurrentStatusTool } from "../lib/tools/current-status-tool.js";

function textPayload(result) {
  return JSON.parse(result.content[0].text);
}

function makeCtx(sessionPath = "/tmp/agents/hana/sessions/s1.jsonl") {
  return {
    sessionManager: {
      getSessionFile: () => sessionPath,
    },
  };
}

describe("current_status tool", () => {
  it("lists available status keys without returning live status values", async () => {
    const tool = createCurrentStatusTool({
      now: () => new Date("2026-05-03T19:30:00.000Z"),
      getTimezone: () => "Asia/Shanghai",
      getAgent: () => ({ id: "hana", agentName: "Hana" }),
      getSessionModel: () => ({ id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" }),
    });

    const payload = textPayload(await tool.execute("call_1", { action: "list" }));

    expect(payload.available.map((item) => item.key)).toEqual([
      "time",
      "logical_date",
      "agent",
      "model",
      "ui_context",
    ]);
    expect(payload.usage).toContain("list");
    expect(payload.usage).toContain("get");
    expect(JSON.stringify(payload)).not.toContain("Hana");
    expect(JSON.stringify(payload)).not.toContain("claude-sonnet-4-5");
    expect(JSON.stringify(payload)).not.toContain("2026-05-03T19:30:00.000Z");
  });

  it("returns only time fields for get time", async () => {
    const tool = createCurrentStatusTool({
      now: () => new Date("2026-05-03T19:30:00.000Z"),
      getTimezone: () => "Asia/Shanghai",
      getAgent: () => ({ id: "hana", agentName: "Hana" }),
      getSessionModel: () => ({ id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" }),
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "time" }, null, null, makeCtx()));

    expect(payload).toEqual({
      time: {
        iso: "2026-05-03T19:30:00.000Z",
        timezone: "Asia/Shanghai",
        localDateTime: "2026-05-04 03:30:00",
        utcOffset: "+08:00",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("Hana");
    expect(JSON.stringify(payload)).not.toContain("claude-sonnet-4-5");
  });

  it("computes logical date in the configured timezone with the 4am boundary", async () => {
    const tool = createCurrentStatusTool({
      now: () => new Date("2026-05-03T19:30:00.000Z"),
      getTimezone: () => "Asia/Shanghai",
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "logical_date" }));

    expect(payload).toEqual({
      logical_date: {
        date: "2026-05-03",
        timezone: "Asia/Shanghai",
        dayBoundaryHour: 4,
      },
    });
  });

  it("returns only agent fields for get agent", async () => {
    const tool = createCurrentStatusTool({
      getAgent: () => ({ id: "hana", agentName: "Hana" }),
      now: () => new Date("2026-05-03T19:30:00.000Z"),
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "agent" }));

    expect(payload).toEqual({
      agent: {
        id: "hana",
        name: "Hana",
      },
    });
  });

  it("returns the current session model for get model", async () => {
    const tool = createCurrentStatusTool({
      getSessionModel: (sessionPath) => sessionPath.endsWith("s1.jsonl")
        ? { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" }
        : null,
      getCurrentModel: () => ({ id: "fallback", provider: "openai", name: "Fallback" }),
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "model" }, null, null, makeCtx()));

    expect(payload).toEqual({
      model: {
        id: "claude-sonnet-4-5",
        provider: "anthropic",
        name: "Claude Sonnet 4.5",
      },
    });
  });

  it("returns session context usage and model cost rates for get model", async () => {
    const tool = createCurrentStatusTool({
      getSessionModel: () => ({
        id: "priced-model",
        provider: "test",
        name: "Priced Model",
        contextWindow: 128_000,
        cost: { input: 1.25, output: 5 },
      }),
      getSessionUsage: () => ({
        tokens: 32_000,
        contextWindow: 128_000,
        percent: 25,
      }),
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "model" }, null, null, makeCtx()));

    expect(payload).toEqual({
      model: {
        id: "priced-model",
        provider: "test",
        name: "Priced Model",
        usage: {
          contextTokens: 32_000,
          contextWindow: 128_000,
          contextPercent: 25,
        },
        costRates: { input: 1.25, output: 5 },
      },
    });
  });

  it("returns passive UI context metadata for get ui_context", async () => {
    const tool = createCurrentStatusTool({
      getUiContext: (sessionPath) => sessionPath.endsWith("s1.jsonl")
        ? {
            currentViewed: "/workspace/notes",
            activeFile: "/workspace/notes/diary.md",
            activePreview: null,
            pinnedFiles: ["/workspace/spec.md"],
          }
        : null,
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "ui_context" }, null, null, makeCtx()));

    expect(payload).toEqual({
      ui_context: {
        currentViewed: "/workspace/notes",
        activeFile: "/workspace/notes/diary.md",
        activePreview: null,
        pinnedFiles: ["/workspace/spec.md"],
      },
    });
  });

  it("returns an empty UI context shape when no visible UI context is stored", async () => {
    const tool = createCurrentStatusTool({
      getUiContext: () => null,
    });

    const payload = textPayload(await tool.execute("call_1", { action: "get", key: "ui_context" }, null, null, makeCtx()));

    expect(payload).toEqual({
      ui_context: {
        currentViewed: null,
        activeFile: null,
        activePreview: null,
        pinnedFiles: [],
      },
    });
  });

  it("returns a clear error for unknown keys", async () => {
    const tool = createCurrentStatusTool();

    const result = await tool.execute("call_1", { action: "get", key: "session_path" });

    expect(result.content[0].text).toContain("Unknown status key");
    expect(result.details.errorCode).toBe("UNKNOWN_STATUS_KEY");
  });

  it("is allowed in read-only permission mode", () => {
    expect(classifySessionPermission({ mode: "read_only", toolName: "current_status" }))
      .toEqual({ action: "allow" });
  });
});
