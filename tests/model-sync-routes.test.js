import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clearConfigCache = vi.fn();

vi.mock("../lib/memory/config-loader.js", () => ({
  clearConfigCache,
  getRawConfig: () => ({}),
}));

/** 从 providerRegistry.getCredentials 构造 engine.resolveProviderCredentials（与 ModelManager 行为一致） */
function withResolveCreds(engine) {
  engine.resolveProviderCredentials = (provider) => {
    if (!provider) return { api_key: "", base_url: "", api: "" };
    const cred = engine.providerRegistry?.getCredentials?.(provider);
    if (cred) return { api_key: cred.apiKey || "", base_url: cred.baseUrl || "", api: cred.api || "" };
    return { api_key: "", base_url: "", api: "" };
  };
  return engine;
}

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
    const saveProvider = vi.fn();
    const reload = vi.fn();
    const engine = {
      config: {},
      setHomeFolder: vi.fn(),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      providerRegistry: { saveProvider, removeProvider: vi.fn(), reload },
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
    expect(saveProvider).toHaveBeenCalledTimes(1);
    expect(saveProvider).toHaveBeenCalledWith("dashscope", {
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      api: "openai-completions",
      api_key: "sk-test",
      models: ["qwen-plus"],
    });
    expect(clearConfigCache).toHaveBeenCalledTimes(1);
    expect(engine.updateConfig).toHaveBeenCalledWith({});
    expect(engine.onProviderChanged).toHaveBeenCalledTimes(1);
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

  it("inline 空 api_key 也会同步到 provider 配置，用于真正清空凭证", async () => {
    const { createConfigRoute } = await import("../server/routes/config.js");
    const app = new Hono();
    const saveProvider = vi.fn();
    const engine = {
      config: {},
      configPath: "/tmp/test-config.yaml",
      setHomeFolder: vi.fn(),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      providerRegistry: {
        saveProvider,
        removeProvider: vi.fn(),
      },
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
          provider: "openai",
          api_key: "",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(saveProvider).toHaveBeenCalledWith("openai", { api_key: "" });
    expect(engine.onProviderChanged).toHaveBeenCalledTimes(1);
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
      config: {},
      providerRegistry: { get: () => ({}) },
    };

    app.route("/api", createModelsRoute(engine));

    const allRes = await app.request("/api/models");
    const allData = await allRes.json();
    expect(allRes.status).toBe(200);
    expect(allData.models[0].id).toBe("gpt-5.4");
    expect(allData.models[0].name).toBe("Gpt 5.4");
  });

  it("oauth provider with empty baseUrl falls back to registry", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          provider: "openai-codex",
          contextWindow: 272000,
          maxOutputTokens: 128000,
        },
      ]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "", baseUrl: "", api: "openai-codex-responses" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openai-codex" }),
    });

    expect(res.status).toBe(200);
    expect(engine.getRegistryModelsForProvider).toHaveBeenCalledWith("openai-codex");
    const data = await res.json();
    expect(data.source).toBe("registry");
    expect(data.models[0].id).toBe("gpt-5.4");
  });

  it("oauth provider with empty registry falls back to defaults", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "", baseUrl: "", api: "openai-codex-responses" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: (id) => id === "openai-codex" ? ["gpt-5.4", "gpt-5.3-codex"] : [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openai-codex" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("builtin");
    expect(data.models.map(m => m.id)).toContain("gpt-5.4");
  });

  it("provider with explicit api_key uses remote catalog", async () => {
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

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data.models).toHaveLength(2);
    expect(data.models[0].id).toBe("MiniMax-M2.5");
  });

  it("api-key provider with saved credentials uses remote catalog", async () => {
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

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => null,
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data.models).toHaveLength(3);
  });

  it("remote 404 falls back to registry", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }));

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([
        { id: "gpt-5.4", name: "GPT-5.4", provider: "openai-codex", contextWindow: 272000, maxOutputTokens: 128000 },
      ]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "oauth-token", baseUrl: "https://api.openai.com/v1", api: "openai-codex-responses" }),
        getAuthJsonKey: () => "openai-codex",
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openai-codex-oauth" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("registry");
    expect(data.models[0].id).toBe("gpt-5.4");
  });

  it("remote 401 returns error without fallback", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized" }));

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn(),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "bad-key", baseUrl: "https://api.example.com/v1", api: "openai-completions" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "some-provider" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.error).toContain("401");
    expect(data.models).toEqual([]);
    expect(engine.getRegistryModelsForProvider).not.toHaveBeenCalled();
  });

  it("defaults fallback uses authJsonKey when provider ID has no defaults", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "", baseUrl: "", api: "openai-codex-responses" }),
        getAuthJsonKey: () => "openai-codex",
        getDefaultModels: (id) => {
          if (id === "openai-codex") return ["gpt-5.4", "gpt-5.3-codex"];
          return null;
        },
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openai-codex-oauth" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("builtin");
    expect(data.models.map(m => m.id)).toEqual(["gpt-5.4", "gpt-5.3-codex"]);
  });

  it("anthropic-messages skips remote and goes to defaults", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "sk-test", baseUrl: "https://api.anthropic.com", api: "anthropic-messages" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: (id) => id === "anthropic" ? ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"] : [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "anthropic" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("builtin");
    expect(data.models.map(m => m.id)).toContain("claude-sonnet-4-6");
  });

  it("request body api_key overrides saved credentials", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.js");
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "test-model" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = withResolveCreds({
      getRegistryModelsForProvider: vi.fn().mockReturnValue([]),
      providerRegistry: {
        getCredentials: () => ({ apiKey: "saved-key", baseUrl: "https://api.example.com/v1", api: "openai-completions" }),
        getAuthJsonKey: (id) => id,
        getDefaultModels: () => [],
      },
      hanakoHome: "/tmp",
    });

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-provider",
        api_key: "body-key",
      }),
    });

    expect(res.status).toBe(200);
    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall[1].headers["Authorization"]).toBe("Bearer body-key");
  });
});
