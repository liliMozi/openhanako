/**
 * 供应商管理 REST 路由
 */
import { getAllProviders } from "../../lib/memory/config-loader.js";
import { buildProviderAuthHeaders } from "../../lib/llm/provider-client.js";

function maskKey(key) {
  if (!key || key.length < 8) return key ? "***" : "";
  return key.slice(0, 4) + "..." + key.slice(-4);
}

// OAuth provider 白名单：只暴露合规可用的（其他 coding plan 会封号）
const ALLOWED_OAUTH = new Set(["minimax", "openai-codex"]);

export default async function providersRoute(app, { engine }) {

  // ── Provider Summary ──

  /**
   * 统一概览：合并 providers.yaml + OAuth status + favorites + SDK 模型
   * 前端新 ProvidersTab 的核心数据源
   */
  app.get("/api/providers/summary", async () => {
    const providers = getAllProviders(engine.configPath);
    const favorites = engine.readFavorites();
    const favSet = new Set(favorites);

    // OAuth provider 信息
    const oauthProviders = engine.authStorage?.getOAuthProviders?.() || [];
    const oauthMap = new Map();
    for (const p of oauthProviders) {
      const cred = engine.authStorage.get(p.id);
      oauthMap.set(p.id, { name: p.name, loggedIn: cred?.type === "oauth" });
    }

    // OAuth 自定义模型
    const oauthCustom = engine.preferences.getOAuthCustomModels();

    // SDK 可用模型（含 OAuth 注入的）
    const sdkModels = engine.availableModels || [];
    const sdkByProvider = new Map();
    for (const m of sdkModels) {
      if (!sdkByProvider.has(m.provider)) sdkByProvider.set(m.provider, []);
      sdkByProvider.get(m.provider).push(m.id);
    }

    const result = {};

    // 先处理 providers.yaml 中的 provider（保持顺序）
    for (const [name, p] of Object.entries(providers)) {
      const isOAuth = oauthMap.has(name);
      const oauthInfo = oauthMap.get(name);
      const sdkIds = sdkByProvider.get(name) || [];
      // 合并：providers.yaml models + SDK 发现的模型
      const allModels = [...new Set([...(p.models || []), ...sdkIds])];
      const customModels = oauthCustom[name] || [];

      result[name] = {
        type: isOAuth ? "oauth" : "api-key",
        display_name: oauthInfo?.name || name,
        base_url: p.base_url || "",
        api: p.api || "",
        api_key_masked: p.api_key ? maskKey(p.api_key) : "",
        models: allModels,
        custom_models: customModels,
        has_credentials: !!(p.api_key || (isOAuth && oauthInfo?.loggedIn)),
        logged_in: isOAuth ? !!oauthInfo?.loggedIn : undefined,
        supports_oauth: isOAuth && ALLOWED_OAUTH.has(name),
        can_delete: !isOAuth || Object.prototype.hasOwnProperty.call(providers, name),
      };
    }

    // 追加 OAuth-only provider（有 auth.json 但没在 providers.yaml 里）
    // 只暴露白名单内的，其他 coding plan 会封号
    for (const [id, info] of oauthMap) {
      if (result[id]) continue;
      if (!ALLOWED_OAUTH.has(id)) continue;
      const sdkIds = sdkByProvider.get(id) || [];
      const customModels = oauthCustom[id] || [];
      result[id] = {
        type: "oauth",
        display_name: info.name || id,
        base_url: "",
        api: "",
        api_key_masked: "",
        models: sdkIds,
        custom_models: customModels,
        has_credentials: !!info.loggedIn,
        logged_in: !!info.loggedIn,
        supports_oauth: true,
        can_delete: false,
      };
    }

    return { providers: result, favorites };
  });

  // ── Fetch / Test ──

  function normalizeRegistryModels(models) {
    return models.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      context: model.contextWindow ?? model.context ?? null,
      maxOutput: model.maxOutputTokens ?? model.maxOutput ?? null,
    }));
  }

  /**
   * 从供应商的 /v1/models (OpenAI 兼容) 端点拉取模型列表
   * body: { name, base_url, api, api_key? }
   */
  app.post("/api/providers/fetch-models", async (req, reply) => {
    const { name, base_url, api: explicitApi, api_key } = req.body || {};
    if (!name && !base_url) {
      reply.code(400);
      return { error: "name or base_url is required" };
    }

    const providers = name ? getAllProviders(engine.configPath) : {};
    const savedProvider = name ? providers[name] || {} : {};
    const savedKey = savedProvider.api_key || "";
    const effectiveBaseUrl = base_url || savedProvider.base_url || "";
    const effectiveApi = explicitApi || savedProvider.api || "";
    const hasExplicitRemoteConfig = !!(effectiveBaseUrl && effectiveApi && (api_key || savedKey));

    const oauthProviderIds = new Set(
      (engine.authStorage?.getOAuthProviders?.() || []).map((provider) => provider.id),
    );
    const isOAuthProvider = !!name && oauthProviderIds.has(name);

    if (isOAuthProvider && !hasExplicitRemoteConfig) {
      try {
        await engine.refreshAvailableModels();
        const registryModels = engine.availableModels.filter((model) => model.provider === name);
        if (registryModels.length > 0) {
          return { source: "registry", models: normalizeRegistryModels(registryModels) };
        }

        return {
          error: `Pi registry has no available models for provider "${name}" yet. Please finish login or re-login, then try again.`,
          models: [],
        };
      } catch (err) {
        return { error: err.message, models: [] };
      }
    }

    if (!base_url) {
      reply.code(400);
      return { error: "base_url is required for remote model fetch" };
    }

    // 解析 api_key：显式传入 > providers 块 > auth.json OAuth token
    let key = api_key || "";
    let api = explicitApi || "";
    if (!key && name) {
      key = savedKey;
      api = api || savedProvider.api || "";
    }
    // OAuth provider fallback：从 AuthStorage 获取 token
    if (!key && name) {
      try {
        key = await engine.authStorage.getApiKey(name) || "";
      } catch {}
    }

    // Anthropic 格式没有 /models 端点，直接从 Pi SDK 内置模型列表返回
    if (api === "anthropic-messages") {
      const registryModels = engine.modelRegistry
        ? engine.modelRegistry.getAll().filter((m) => m.provider === name)
        : [];
      if (registryModels.length > 0) {
        return { source: "registry", models: normalizeRegistryModels(registryModels) };
      }
      return { error: "No built-in models found for this provider", models: [] };
    }

    try {
      const url = base_url.replace(/\/+$/, "") + "/models";
      let headers = { "Content-Type": "application/json" };
      if (key) {
        if (!api) {
          return { error: "api is required when api_key is present", models: [] };
        }
        headers = buildProviderAuthHeaders(api, key);
      }
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        return { error: `HTTP ${res.status}: ${res.statusText}`, models: [] };
      }

      const data = await res.json();
      // OpenAI 兼容格式：{ data: [{ id, ... }] }
      // 尝试从返回里抓取上下文长度和最大输出（各 provider 扩展字段不同）
      const models = (data.data || []).map(m => ({
        id: m.id,
        name: m.id,
        context: m.context_length || m.context_window || m.max_context_length || null,
        maxOutput: m.max_completion_tokens || m.max_output_tokens || null,
      }));

      return { models };
    } catch (err) {
      return { error: err.message, models: [] };
    }
  });

  /**
   * 测试供应商连接
   * body: { base_url, api, api_key }
   */
  app.post("/api/providers/test", async (req, reply) => {
    const { base_url, api } = req.body || {};
    // 清洗 API key：去除非 ASCII 字符（防止粘贴时输入法带入中文）
    const api_key = (req.body?.api_key || "").replace(/[^\x20-\x7E]/g, "").trim();
    if (!base_url) {
      reply.code(400);
      return { error: "base_url is required" };
    }

    try {
      // Anthropic 格式没有 /models 端点，用最小化 messages 请求验证认证
      if (api === "anthropic-messages") {
        const baseUrl = base_url.replace(/\/+$/, "");
        const headers = buildProviderAuthHeaders(api, api_key);
        // Kimi Coding requires valid model ID, use kimi-for-coding for testing
        const testModel = base_url.includes("kimi.com") ? "kimi-for-coding" : "test";
        const res = await fetch(baseUrl + "/messages", {
          method: "POST",
          headers,
          body: JSON.stringify({ model: testModel, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
          signal: AbortSignal.timeout(10000),
        });
        // 401/403 = key 无效，其他错误（400 model not found 等）说明认证通过了
        const authOk = res.status !== 401 && res.status !== 403;
        return { ok: authOk, status: res.status };
      }

      const url = base_url.replace(/\/+$/, "") + "/models";
      let headers = {};
      if (api_key) {
        if (!api) {
          reply.code(400);
          return { error: "api is required when api_key is present" };
        }
        headers = buildProviderAuthHeaders(api, api_key);
      }
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}
