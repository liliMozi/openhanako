import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveGlobalProviders = vi.fn();
const clearConfigCache = vi.fn();

vi.mock("../lib/memory/config-loader.js", () => ({
  saveGlobalProviders,
  clearConfigCache,
  getAllProviders: () => ({}),
  getRawConfig: () => ({}),
}));

describe("model sync related routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("provider-only config updates trigger model registry sync", async () => {
    const { default: configRoute } = await import("../server/routes/config.js");
    const app = Fastify();
    const engine = {
      config: {},
      setHomeFolder: vi.fn(),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
    };

    await configRoute(app, { engine });

    const res = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: {
        providers: {
          dashscope: {
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            api: "openai-completions",
            api_key: "sk-test",
            models: ["qwen-plus"],
          },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(saveGlobalProviders).toHaveBeenCalledTimes(1);
    expect(clearConfigCache).toHaveBeenCalledTimes(1);
    expect(engine.updateConfig).toHaveBeenCalledWith({});
    expect(engine.syncModelsAndRefresh).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("shared model preference updates trigger model registry sync", async () => {
    const { default: preferencesRoute } = await import("../server/routes/preferences.js");
    const app = Fastify();
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({ provider: null, api_key: null })),
      getUtilityApi: vi.fn(() => ({ provider: null, base_url: null, api_key: null })),
      setSharedModels: vi.fn(),
      setSearchConfig: vi.fn(),
      setUtilityApi: vi.fn(),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
    };

    await preferencesRoute(app, { engine });

    const res = await app.inject({
      method: "PUT",
      url: "/api/preferences/models",
      payload: {
        models: {
          utility: "test-model",
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(engine.setSharedModels).toHaveBeenCalledWith({ utility: "test-model" });
    expect(engine.syncModelsAndRefresh).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("inline 凭证缺少显式 provider 时返回 400", async () => {
    const { default: configRoute } = await import("../server/routes/config.js");
    const app = Fastify();
    const engine = {
      config: {},
      configPath: "/tmp/test-config.yaml",
      setHomeFolder: vi.fn(),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
      getHomeFolder: vi.fn(() => null),
      getThinkingLevel: vi.fn(() => "medium"),
      getSandbox: vi.fn(() => "workspace-write"),
      getLocale: vi.fn(() => "zh-CN"),
      getTimezone: vi.fn(() => "Asia/Shanghai"),
      getLearnSkills: vi.fn(() => false),
    };

    await configRoute(app, { engine });

    const res = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: {
        api: {
          api_key: "sk-test",
        },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("api.provider is required");

    await app.close();
  });

  it("model routes expose stable ids and readable display names", async () => {
    const { default: modelsRoute } = await import("../server/routes/models.js");
    const app = Fastify();
    const engine = {
      availableModels: [
        {
          id: "gpt-5.4",
          name: "Gpt 5.4",
          provider: "openai-codex",
          reasoning: true,
        },
      ],
      currentModel: { id: "gpt-5.4", name: "Gpt 5.4" },
      readFavorites: vi.fn(() => ["gpt-5.4"]),
    };

    await modelsRoute(app, { engine });

    const allRes = await app.inject({ method: "GET", url: "/api/models" });
    const allData = allRes.json();
    expect(allRes.statusCode).toBe(200);
    expect(allData.models[0].id).toBe("gpt-5.4");
    expect(allData.models[0].name).toBe("Gpt 5.4");

    const favRes = await app.inject({ method: "GET", url: "/api/models/favorites" });
    const favData = favRes.json();
    expect(favRes.statusCode).toBe(200);
    expect(favData.models[0].id).toBe("gpt-5.4");
    expect(favData.models[0].name).toBe("Gpt 5.4");

    await app.close();
  });

  it("provider fetch prefers Pi registry models for oauth providers", async () => {
    const { default: providersRoute } = await import("../server/routes/providers.js");
    const app = Fastify();
    const engine = {
      availableModels: [
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          provider: "openai-codex",
          contextWindow: 272000,
          maxOutputTokens: 128000,
        },
      ],
      refreshAvailableModels: vi.fn().mockResolvedValue(undefined),
      authStorage: {
        getOAuthProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
        getApiKey: vi.fn(),
      },
      configPath: "/tmp/test-config.yaml",
    };

    await providersRoute(app, { engine });

    const res = await app.inject({
      method: "POST",
      url: "/api/providers/fetch-models",
      payload: {
        name: "openai-codex",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(engine.refreshAvailableModels).toHaveBeenCalledTimes(1);
    expect(res.json()).toEqual({
      source: "registry",
      models: [
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          context: 272000,
          maxOutput: 128000,
        },
      ],
    });

    await app.close();
  });

  it("oauth provider fetch reports registry issue instead of remote /models fallback", async () => {
    const { default: providersRoute } = await import("../server/routes/providers.js");
    const app = Fastify();
    const engine = {
      availableModels: [],
      refreshAvailableModels: vi.fn().mockResolvedValue(undefined),
      authStorage: {
        getOAuthProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
        getApiKey: vi.fn(),
      },
      configPath: "/tmp/test-config.yaml",
    };

    await providersRoute(app, { engine });

    const res = await app.inject({
      method: "POST",
      url: "/api/providers/fetch-models",
      payload: {
        name: "openai-codex",
        base_url: "https://chatgpt.com/backend-api",
        api: "openai-codex-responses",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().error).toContain('Pi registry has no available models for provider "openai-codex"');

    await app.close();
  });

  it("oauth-named provider with explicit api config uses remote catalog", async () => {
    const { default: providersRoute } = await import("../server/routes/providers.js");
    const app = Fastify();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "MiniMax-M2.5", context_length: 1000000, max_output_tokens: 80000 },
          { id: "MiniMax-M2", context_length: 1000000, max_output_tokens: 80000 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = {
      availableModels: [],
      refreshAvailableModels: vi.fn().mockResolvedValue(undefined),
      authStorage: {
        getOAuthProviders: () => [{ id: "minimax", name: "MiniMax" }],
        getApiKey: vi.fn(),
      },
      configPath: "/tmp/test-config.yaml",
    };

    await providersRoute(app, { engine });

    const res = await app.inject({
      method: "POST",
      url: "/api/providers/fetch-models",
      payload: {
        name: "minimax",
        base_url: "https://api.minimaxi.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(engine.refreshAvailableModels).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.json()).toEqual({
      models: [
        { id: "MiniMax-M2.5", name: "MiniMax-M2.5", context: 1000000, maxOutput: 80000 },
        { id: "MiniMax-M2", name: "MiniMax-M2", context: 1000000, maxOutput: 80000 },
      ],
    });

    await app.close();
  });

  it("non-oauth provider fetch uses remote catalog instead of Pi runtime subset", async () => {
    const { default: providersRoute } = await import("../server/routes/providers.js");
    const app = Fastify();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "qwen3.5-flash", context_length: 131072, max_output_tokens: 16384 },
          { id: "qwen3.5-plus", context_length: 1048576, max_output_tokens: 65536 },
          { id: "qwen3-max", context_length: 262144, max_output_tokens: 32768 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = {
      availableModels: [
        {
          id: "qwen3.5-flash",
          name: "Qwen3.5 Flash",
          provider: "dashscope",
          contextWindow: 131072,
          maxOutputTokens: 16384,
        },
        {
          id: "qwen3.5-plus",
          name: "Qwen3.5 Plus",
          provider: "dashscope",
          contextWindow: 1048576,
          maxOutputTokens: 65536,
        },
      ],
      refreshAvailableModels: vi.fn().mockResolvedValue(undefined),
      authStorage: {
        getOAuthProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
        getApiKey: vi.fn(),
      },
      configPath: "/tmp/test-config.yaml",
    };

    await providersRoute(app, { engine });

    const res = await app.inject({
      method: "POST",
      url: "/api/providers/fetch-models",
      payload: {
        name: "dashscope",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(engine.refreshAvailableModels).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.json()).toEqual({
      models: [
        { id: "qwen3.5-flash", name: "qwen3.5-flash", context: 131072, maxOutput: 16384 },
        { id: "qwen3.5-plus", name: "qwen3.5-plus", context: 1048576, maxOutput: 65536 },
        { id: "qwen3-max", name: "qwen3-max", context: 262144, maxOutput: 32768 },
      ],
    });

    await app.close();
  });
});
