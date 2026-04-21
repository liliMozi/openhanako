import { describe, expect, it, vi } from "vitest";

const { estimateTokensMock } = vi.hoisted(() => ({
  estimateTokensMock: vi.fn(() => 2000),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  createAgentSession: vi.fn(),
  SessionManager: {
    create: vi.fn(),
    open: vi.fn(),
  },
  estimateTokens: estimateTokensMock,
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

describe("SessionCoordinator.switchSessionModel", () => {
  it("does not crash when context usage exists and adaptation is needed", async () => {
    const coord = new SessionCoordinator({
      agentsDir: "/tmp/agents",
      getAgent: () => ({ sessionDir: "/tmp/sessions" }),
      getActiveAgentId: () => "hana",
      getModels: () => null,
      getResourceLoader: () => null,
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getHomeCwd: () => "/tmp",
      agentIdFromSessionPath: () => null,
      switchAgentOnly: async () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
      getAgents: () => new Map(),
      getActivityStore: () => null,
      getAgentById: () => null,
      listAgents: () => [],
    });

    const setModel = vi.fn(async () => {});
    const entry = {
      session: {
        model: { id: "old-model", provider: "test", contextWindow: 64000 },
        isCompacting: false,
        getContextUsage: () => ({ tokens: 10000 }),
        agent: {
          state: {
            messages: [
              { role: "system", content: "sys" },
              { role: "user", content: "question" },
              { role: "assistant", content: "answer" },
            ],
          },
        },
        setModel,
      },
      modelId: "old-model",
      modelProvider: "test",
    };
    coord.sessions.set("/tmp/session.jsonl", entry);

    const compactSpy = vi.spyOn(coord, "_compactWithModel").mockResolvedValue();
    const truncateSpy = vi.spyOn(coord, "_hardTruncate").mockResolvedValue();

    const result = await coord.switchSessionModel("/tmp/session.jsonl", {
      id: "new-model",
      provider: "test",
      contextWindow: 12000,
    });

    expect(result).toEqual({ adaptations: ["compacted"] });
    expect(compactSpy).toHaveBeenCalledOnce();
    expect(truncateSpy).not.toHaveBeenCalled();
    expect(setModel).toHaveBeenCalledWith({
      id: "new-model",
      provider: "test",
      contextWindow: 12000,
    });
    expect(entry.modelId).toBe("new-model");
    expect(entry.modelProvider).toBe("test");
  });
});
