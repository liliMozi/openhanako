/**
 * 供应商管理 REST 路由
 */
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { getAllProviders } from "../../lib/memory/config-loader.js";
import { buildProviderAuthHeaders, buildProbeUrl } from "../../lib/llm/provider-client.js";

function maskKey(key) {
  if (!key || key.length < 8) return key ? "***" : "";
  return key.slice(0, 4) + "..." + key.slice(-4);
}

export function createProvidersRoute(engine) {
  const route = new Hono();

  // ── Provider Summary ──

  /**
   * 统一概览：合并 providers.yaml + OAuth status + favorites + SDK 模型
   * 前端新 ProvidersTab 的核心数据源
   */
  route.get("/providers/summary", async (c) => {
    const providers = getAllProviders(engine.configPath);

    // ProviderRegistry 作为 OAuth 判断的权威来源
    const provRegistry = engine.providerRegistry;

    // OAuth 白名单：authJsonKey 集合（auth.json 中的 key，如 minimax / openai-codex）
    const ALLOWED_OAUTH = provRegistry
      ? new Set(provRegistry.getOAuthProviderIds().map(id => provRegistry.getAuthJsonKey(id)))
      : new Set(["minimax", "openai-codex"]); // fallback

    // authJsonKey → registryId 映射（如 minimax → minimax-oauth）
    const authKeyToRegistryId = new Map();
    if (provRegistry) {
      for (const id of provRegistry.getOAuthProviderIds()) {
        const authKey = provRegistry.getAuthJsonKey(id);
        if (authKey !== id) authKeyToRegistryId.set(authKey, id);
      }
    }

    const favorites = engine.readFavorites();
    const favSet = new Set(favorites);

    // OAuth provider 登录状态（Pi SDK AuthStorage，key 是 authJsonKey 如 minimax）
    const oauthProviders = engine.authStorage?.getOAuthProviders?.() || [];
    const oauthLoginMap = new Map();
    for (const p of oauthProviders) {
      const cred = engine.authStorage.get(p.id);
      oauthLoginMap.set(p.id, { name: p.name, loggedIn: cred?.type === "oauth" });
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

    // 判断 provider 是否为 OAuth 类型（优先用 ProviderRegistry，回退到 oauthLoginMap）
    function isOAuthProvider(name) {
      if (provRegistry) {
        // 直接匹配 registry ID（如 minimax-oauth）
        if (provRegistry.isOAuth(name)) return true;
        // 或者 name 是某个 OAuth provider 的 authJsonKey（如 minimax）
        const registryId = authKeyToRegistryId.get(name);
        if (registryId && provRegistry.isOAuth(registryId)) return true;
        return false;
      }
      return oauthLoginMap.has(name);
    }

    // 获取 OAuth 登录信息（oauthLoginMap 用 authJsonKey 索引）
    function getOAuthLoginInfo(name) {
      if (oauthLoginMap.has(name)) return oauthLoginMap.get(name);
      // name 可能是 registry ID（如 minimax-oauth），查对应的 authJsonKey
      if (provRegistry) {
        const authKey = provRegistry.getAuthJsonKey(name);
        if (authKey !== name && oauthLoginMap.has(authKey)) return oauthLoginMap.get(authKey);
      }
      return null;
    }

    // Coding Plan 判断（id 以 -coding 结尾的 provider）
    function isCodingPlan(name) {
      return name.endsWith("-coding");
    }

    // 先处理 providers.yaml 中的 provider（保持顺序）
    for (const [name, p] of Object.entries(providers)) {
      const isOAuth = isOAuthProvider(name);
      const oauthInfo = getOAuthLoginInfo(name);
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
        is_coding_plan: isCodingPlan(name),
        can_delete: !isOAuth || Object.prototype.hasOwnProperty.call(providers, name),
      };
    }

    // 追加 OAuth-only provider（有 auth.json 但没在 providers.yaml 里）
    // 只暴露白名单内的，其他 coding plan 会封号
    for (const [id, info] of oauthLoginMap) {
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

    // 追加 ProviderRegistry 中已声明但尚未出现的 provider（未配置状态）
    // 让用户在设置页看到所有可用供应商，点击即可配置
    if (provRegistry) {
      for (const [id, entry] of provRegistry.getAll()) {
        if (result[id]) continue;
        if (entry.authType === "oauth") continue; // OAuth provider 走上面的白名单逻辑
        const sdkIds = sdkByProvider.get(id) || [];
        result[id] = {
          type: "api-key",
          display_name: entry.displayName || id,
          base_url: entry.baseUrl || "",
          api: entry.api || "",
          api_key_masked: "",
          models: sdkIds,
          custom_models: [],
          has_credentials: false,
          logged_in: undefined,
          supports_oauth: false,
          is_coding_plan: isCodingPlan(id),
          can_delete: false,
        };
      }
    }

    return c.json({ providers: result, favorites });
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
  route.post("/providers/fetch-models", async (c) => {
    const body = await safeJson(c);
    const { name, base_url, api: explicitApi, api_key } = body;
    if (!name && !base_url) {
      return c.json({ error: "name or base_url is required" }, 400);
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
          return c.json({ source: "registry", models: normalizeRegistryModels(registryModels) });
        }

        return c.json({
          error: `Pi registry has no available models for provider "${name}" yet. Please finish login or re-login, then try again.`,
          models: [],
        });
      } catch (err) {
        return c.json({ error: err.message, models: [] });
      }
    }

    if (!base_url) {
      return c.json({ error: "base_url is required for remote model fetch" }, 400);
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

    // Anthropic 格式没有 /models 端点，从 Pi SDK registry 或 default-models.json 返回
    if (api === "anthropic-messages") {
      const registryModels = engine.modelRegistry
        ? engine.modelRegistry.getAll().filter((m) => m.provider === name)
        : [];
      if (registryModels.length > 0) {
        return c.json({ source: "registry", models: normalizeRegistryModels(registryModels) });
      }
      // fallback：从 default-models.json 返回默认模型列表
      const defaults = engine.providerRegistry?.getDefaultModels(name) || [];
      if (defaults.length > 0) {
        return c.json({
          source: "builtin",
          models: defaults.map(id => ({ id, name: id, context: null, maxOutput: null })),
        });
      }
      return c.json({ error: "No built-in models found for this provider", models: [] });
    }

    try {
      const url = base_url.replace(/\/+$/, "") + "/models";
      let headers = { "Content-Type": "application/json" };
      if (key) {
        if (!api) {
          return c.json({ error: "api is required when api_key is present", models: [] });
        }
        headers = buildProviderAuthHeaders(api, key);
      }
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        return c.json({ error: `HTTP ${res.status}: ${res.statusText}`, models: [] });
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

      return c.json({ models });
    } catch (err) {
      return c.json({ error: err.message, models: [] });
    }
  });

  /**
   * 测试供应商连接
   * body: { base_url, api, api_key }
   */
  route.post("/providers/test", async (c) => {
    const body = await safeJson(c);
    const { base_url, api } = body;
    // 清洗 API key：去除非 ASCII 字符（防止粘贴时输入法带入中文）
    const api_key = (body.api_key || "").replace(/[^\x20-\x7E]/g, "").trim();
    if (!base_url) {
      return c.json({ error: "base_url is required" }, 400);
    }

    try {
      const probe = buildProbeUrl(base_url, api);

      if (api === "anthropic-messages") {
        const headers = buildProviderAuthHeaders(api, api_key);
        const res = await fetch(probe.url, {
          method: probe.method,
          headers,
          body: JSON.stringify({ model: "test", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
          signal: AbortSignal.timeout(10000),
        });
        // 401/403 = key 无效，其他错误（400 model not found 等）说明认证通过了
        const authOk = res.status !== 401 && res.status !== 403;
        return c.json({ ok: authOk, status: res.status });
      }

      let headers = {};
      if (api_key) {
        if (!api) {
          return c.json({ error: "api is required when api_key is present" }, 400);
        }
        headers = buildProviderAuthHeaders(api, api_key);
      }
      const res = await fetch(probe.url, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      return c.json({ ok: res.ok, status: res.status });
    } catch (err) {
      return c.json({ ok: false, error: err.message });
    }
  });

  return route;
}
