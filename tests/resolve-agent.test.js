import { describe, it, expect } from "vitest";
import { resolveAgent, resolveAgentStrict } from "../server/utils/resolve-agent.js";

function mockEngine(agents) {
  return {
    getAgent: (id) => agents[id] || null,
    currentAgentId: "_focus",
  };
}

function mockCtx(agentId) {
  return { req: { query: (k) => k === "agentId" ? agentId : null, param: () => null } };
}

describe("resolveAgentStrict", () => {
  it("找到 agent 时正常返回", () => {
    const engine = mockEngine({ hana: { id: "hana" }, _focus: { id: "_focus" } });
    expect(resolveAgentStrict(engine, mockCtx("hana"))).toEqual({ id: "hana" });
  });

  it("agentId 不存在时抛 AgentNotFoundError", () => {
    const engine = mockEngine({ _focus: { id: "_focus" } });
    expect(() => resolveAgentStrict(engine, mockCtx("ghost"))).toThrow("not found");
  });

  it("无显式 agentId 时抛 AgentNotFoundError", () => {
    const engine = mockEngine({ _focus: { id: "_focus" } });
    expect(() => resolveAgentStrict(engine, mockCtx(null))).toThrow("not found");
  });
});

describe("resolveAgent (读操作)", () => {
  it("显式传入有效 agentId 返回对应 agent", () => {
    const engine = mockEngine({ hana: { id: "hana" }, _focus: { id: "_focus" } });
    expect(resolveAgent(engine, mockCtx("hana"))).toEqual({ id: "hana" });
  });

  it("显式传入无效 agentId 抛 AgentNotFoundError", () => {
    const engine = mockEngine({ _focus: { id: "_focus" } });
    expect(() => resolveAgent(engine, mockCtx("ghost"))).toThrow("not found");
  });

  it("未传 agentId 时用焦点 agent", () => {
    const engine = mockEngine({ _focus: { id: "_focus" } });
    expect(resolveAgent(engine, mockCtx(null))).toEqual({ id: "_focus" });
  });

  it("未传 agentId 且焦点 agent 不存在时抛 AgentNotFoundError", () => {
    const engine = { getAgent: () => null, currentAgentId: "gone" };
    expect(() => resolveAgent(engine, mockCtx(null))).toThrow('agent "gone" not found');
  });
});
