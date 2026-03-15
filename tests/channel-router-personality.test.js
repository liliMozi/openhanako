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

describe("ChannelRouter._executeCheck personality 来源", () => {
  it("当 engine.agents 有该 agent 实例时，使用内存中的 personality 而不读磁盘", async () => {
    const readFileSyncCalls = [];

    // 构造 mock agent 实例（内存中已有）
    const mockAgent = {
      config: { agent: { name: "Hana", yuan: "hanako" } },
      personality: "我是 Hana，一个温柔的助手。这是内存中的 personality。",
    };

    const mockAgentsMap = new Map([["hana", mockAgent]]);

    // triage 返回 NO（我们只验证 personality 来源，不需要真正回复）
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "NO" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

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

    // 捕获 triage 系统提示中的 personality 内容
    const result = await router._executeCheck(
      "hana",
      "general",
      [{ sender: "user", text: "你好" }],
      [],
    );

    expect(result.replied).toBe(false); // triage 返回 NO

    // 验证 fetch 被调用（triage 请求），且 system 消息包含内存中的 personality
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const systemContent = body.messages[0].content;
    expect(systemContent).toContain("我是 Hana，一个温柔的助手。这是内存中的 personality。");

    vi.unstubAllGlobals();
  });

  it("当 engine.agents 为 undefined 时 fallback 到磁盘读取", async () => {
    // 这个测试验证 fallback 路径仍然工作
    // engine.agents 返回 undefined → agentInstance 为 undefined → 走 readFile fallback
    const { loadConfig } = await import("../lib/memory/config-loader.js");

    // 解除 loadConfig 的 throw mock，让它返回正常 config
    loadConfig.mockReturnValueOnce({ agent: { name: "TestAgent", yuan: "hanako" } });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "NO" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const router = new ChannelRouter({
      hub: {
        engine: {
          agentsDir: "/fake/agents",
          channelsDir: "/fake/channels",
          productDir: "/fake/product",
          userDir: "/fake/user",
          agents: undefined, // 没有 agents getter
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

    // _executeCheck 会走 readFile fallback，文件读取会失败但不会 crash
    const result = await router._executeCheck(
      "hana",
      "general",
      [{ sender: "user", text: "你好" }],
      [],
    );

    // 应该正常完成（triage NO → replied false）
    expect(result.replied).toBe(false);
    // loadConfig 被调用了（fallback 路径）
    expect(loadConfig).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
