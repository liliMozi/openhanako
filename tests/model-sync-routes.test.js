import { Hono } from "hono";
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
    const { createConfigRoute } = await import("../server/routes/config.js");
    const app = new Hono();
    const engine = {
      config: {},
      setHomeFolder: vi.fn(),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
    };

    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          dashscope: {
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            api: "openai-completions",
            api_key: "sk-test",
            models: ["qwen-plus"],
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(saveGlobalProviders).toHaveBeenCalledTimes(1);
    expect(clearConfigCache).toHaveBeenCalledTimes(1);
    expect(engine.updateConfig).toHaveBeenCalledWith({});
    expect(engine.syncModelsAndRefresh).toHaveBeenCalledTimes(1);
  });

  it("shared model preference updates trigger model registry sync", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.js");
    const app = new Hono();
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({ provider: null, api_key: null })),
      getUtilityApi: vi.fn(() => ({ provider: null, base_url: null, api_key: null })),
      setSharedModels: vi.fn(),
      setSearchConfig: vi.fn(),
      setUtilityApi: vi.fn(),
      syncModelsAndRefresh: vi.fn().mockResolvedValue(true),
    };

    app.route("/api", createPreferencesRoute(engine));

    const res = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: {
          utility: "test-model",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.setSharedModels).toHaveBeenCalledWith({ utility: "test-model" });
    expect(engine.syncModelsAndRefresh).toHaveBeenCalledTimes(1);
  });

  it("inline 凭证缺少显式 provider 时返回 400", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const app = new Hono();
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

    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api: {
          api_key: "sk-test",
        },
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("api.provider is required");
  });

  it("model routes expose stable ids and readable display names", async () => {
    const { createModelsRoute } = await import("../server/routes/models.js");
    const app = new Hono();
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
      config: {},
      providerRegistry: { get: () => ({ capabilities: {} }) },
    };

    app.route("/api", createModelsRoute(engine));

    const allRes = await app.request("/api/models");
    const allData = await allRes.json();
    expect(allRes.status).toBe(200);
    expect(allData.models[0].id).toBe("gpt-5.4");
    expect(allData.models[0].name).toBe("Gpt 5.4");

    const favRes = await app.request("/api/models/favorites");
    const favData = await favRes.json();
    expect(favRes.status).toBe(200);
    expect(favData.models[0].id).toBe("gpt-5.4");
    expect(favData.models[0].name).toBe("Gpt 5.4");
  });

  it("provider fetch prefers Pi registry models for oauth providers", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
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

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "openai-codex",
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.refreshAvailableModels).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data).toEqual({
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
  });

  it("oauth provider fetch reports registry issue instead of remote /models fallback", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const engine = {
      availableModels: [],
      refreshAvailableModels: vi.fn().mockResolvedValue(undefined),
      authStorage: {
        getOAuthProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
        getApiKey: vi.fn(),
      },
      configPath: "/tmp/test-config.yaml",
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "openai-codex",
        base_url: "https://chatgpt.com/backend-api",
        api: "openai-codex-responses",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.error).toContain('Pi registry has no available models for provider "openai-codex"');
  });

  it("oauth-named provider with explicit api config uses remote catalog", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
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

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "minimax",
        base_url: "https://api.minimaxi.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.refreshAvailableModels).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data).toEqual({
      models: [
        { id: "MiniMax-M2.5", name: "MiniMax-M2.5", context: 1000000, maxOutput: 80000 },
        { id: "MiniMax-M2", name: "MiniMax-M2", context: 1000000, maxOutput: 80000 },
      ],
    });
  });

  it("non-oauth provider fetch uses remote catalog instead of Pi runtime subset", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
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

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "dashscope",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
      }),
    });

    expect(res.status).toBe(200);
    expect(engine.refreshAvailableModels).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data).toEqual({
      models: [
        { id: "qwen3.5-flash", name: "qwen3.5-flash", context: 131072, maxOutput: 16384 },
        { id: "qwen3.5-plus", name: "qwen3.5-plus", context: 1048576, maxOutput: 65536 },
        { id: "qwen3-max", name: "qwen3-max", context: 262144, maxOutput: 32768 },
      ],
    });
  });
});
