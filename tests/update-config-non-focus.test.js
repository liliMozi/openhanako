import { describe, it, expect, vi } from "vitest";
import { ConfigCoordinator } from "../core/config-coordinator.js";

describe("updateConfig with agentId", () => {
  function makeDeps(overrides = {}) {
    const focusAgent = { id: "focus", updateConfig: vi.fn() };
    const targetAgent = { id: "target", updateConfig: vi.fn() };
    return {
      focusAgent,
      targetAgent,
      deps: {
        hanakoHome: "/tmp/test",
        agentsDir: "/tmp/test/agents",
        getAgent: () => focusAgent,
        getAgentById: (id) => (id === "target" ? targetAgent : null),
        getActiveAgentId: () => "focus",
        getAgents: () => new Map([["focus", focusAgent], ["target", targetAgent]]),
        getModels: () => ({ availableModels: [], defaultModel: null }),
        getPrefs: () => ({ getPreferences: () => ({}), savePreferences: vi.fn() }),
        getSkills: () => ({ syncAgentSkills: vi.fn() }),
        getSession: () => null,
        getSessionCoordinator: () => null,
        getHub: () => null,
        emitEvent: vi.fn(),
        emitDevLog: vi.fn(),
        getCurrentModel: () => null,
        ...overrides,
      },
    };
  }

  it("传入 agentId 时刷新目标 agent 而非焦点 agent", async () => {
    const { focusAgent, targetAgent, deps } = makeDeps();
    const coord = new ConfigCoordinator(deps);

    await coord.updateConfig({}, { agentId: "target" });

    expect(targetAgent.updateConfig).toHaveBeenCalledWith({});
    expect(focusAgent.updateConfig).not.toHaveBeenCalled();
  });

  it("不传 agentId 时刷新焦点 agent", async () => {
    const { focusAgent, targetAgent, deps } = makeDeps();
    const coord = new ConfigCoordinator(deps);

    await coord.updateConfig({});

    expect(focusAgent.updateConfig).toHaveBeenCalledWith({});
    expect(targetAgent.updateConfig).not.toHaveBeenCalled();
  });

  it("agentId 等于焦点 agent 时，模型切换逻辑正常执行", async () => {
    const models = { availableModels: [{ id: "gpt-4", name: "GPT-4" }], defaultModel: null };
    const { focusAgent, deps } = makeDeps({
      getModels: () => models,
      getActiveAgentId: () => "focus",
    });
    const coord = new ConfigCoordinator(deps);

    await coord.updateConfig({ models: { chat: "gpt-4" } }, { agentId: "focus" });

    expect(focusAgent.updateConfig).toHaveBeenCalled();
    // defaultModel 应被设置（findModel 会找到 gpt-4）
    expect(models.defaultModel).toEqual({ id: "gpt-4", name: "GPT-4" });
  });

  it("agentId 为非焦点 agent 时，不执行模型切换", async () => {
    const models = { availableModels: [{ id: "gpt-4", name: "GPT-4" }], defaultModel: null };
    const { targetAgent, deps } = makeDeps({
      getModels: () => models,
    });
    const coord = new ConfigCoordinator(deps);

    await coord.updateConfig({ models: { chat: "gpt-4" } }, { agentId: "target" });

    expect(targetAgent.updateConfig).toHaveBeenCalled();
    // defaultModel 不应被设置（非焦点 agent 不做模型切换）
    expect(models.defaultModel).toBeNull();
  });
});
