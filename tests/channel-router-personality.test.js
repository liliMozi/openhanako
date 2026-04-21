import { describe, expect, it, vi } from "vitest";
import { ChannelRouter } from "../hub/channel-router.js";

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => ({ log: vi.fn(), error: vi.fn() }),
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../lib/channels/channel-store.js", () => ({
  formatMessagesForLLM: (msgs) => msgs.map(m => `${m.sender}: ${m.text}`).join("\n"),
  appendMessage: vi.fn(),
}));

vi.mock("../lib/memory/config-loader.js", () => ({
  loadConfig: vi.fn(() => {
    throw new Error("loadConfig should NOT be called when agent instance exists");
  }),
}));

// mock callText（现在 triage 走 Pi SDK，不再直接 fetch）
let callTextSpy;
vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn(async () => "NO"),
}));

describe("ChannelRouter._executeCheck personality 来源", () => {
  it("当 engine.agents 有该 agent 实例时，使用内存中的 personality 而不读磁盘", async () => {
    const { callText } = await import("../core/llm-client.js");
    callTextSpy = callText;
    callTextSpy.mockResolvedValue("NO");

    const mockAgent = {
      config: { agent: { name: "Hana", yuan: "hanako" } },
      personality: "我是 Hana，一个温柔的助手。这是内存中的 personality。",
    };

    const mockAgentsMap = new Map([["hana", mockAgent]]);

    const router = new ChannelRouter({
      hub: {
        engine: {
          agentsDir: "/fake/agents",
          channelsDir: "/fake/channels",
          userDir: "/fake/user",
          agents: mockAgentsMap,
          resolveUtilityConfig: () => ({
            utility: "test-model",
            utility_large: "test-model-large",
            api_key: "test-key",
            base_url: "https://test.api",
            api: "openai-completions",
            large_api_key: "test-key",
            large_base_url: "https://test.api",
            large_api: "openai-completions",
          }),
        },
        eventBus: { emit: vi.fn() },
      },
    });

    const result = await router._executeCheck(
      "hana",
      "general",
      [{ sender: "user", text: "你好" }],
      [],
    );

    expect(result.replied).toBe(false);

    // 验证 callText 被调用，且 systemPrompt 包含内存中的 personality
    expect(callTextSpy).toHaveBeenCalledTimes(1);
    const callArgs = callTextSpy.mock.calls[0][0];
    expect(callArgs.systemPrompt).toContain("我是 Hana，一个温柔的助手。这是内存中的 personality。");
  });

  it("当 engine.agents 为 undefined 时 fallback 到磁盘读取", async () => {
    const { callText } = await import("../core/llm-client.js");
    callText.mockResolvedValue("NO");

    const { loadConfig } = await import("../lib/memory/config-loader.js");
    loadConfig.mockReturnValueOnce({ agent: { name: "TestAgent", yuan: "hanako" } });

    const router = new ChannelRouter({
      hub: {
        engine: {
          agentsDir: "/fake/agents",
          channelsDir: "/fake/channels",
          productDir: "/fake/product",
          userDir: "/fake/user",
          agents: undefined,
          resolveUtilityConfig: () => ({
            utility: "test-model",
            utility_large: "test-model-large",
            api_key: "test-key",
            base_url: "https://test.api",
            api: "openai-completions",
            large_api_key: "test-key",
            large_base_url: "https://test.api",
            large_api: "openai-completions",
          }),
        },
        eventBus: { emit: vi.fn() },
      },
    });

    const result = await router._executeCheck(
      "hana",
      "general",
      [{ sender: "user", text: "你好" }],
      [],
    );

    expect(result.replied).toBe(false);
    expect(loadConfig).toHaveBeenCalled();
  });
});
