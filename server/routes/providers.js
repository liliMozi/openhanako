/**
 * 供应商管理 REST 路由
 */
import { getAllProviders } from "../../lib/memory/config-loader.js";
import { buildProviderAuthHeaders } from "../../lib/llm/provider-client.js";

export default async function providersRoute(app, { engine }) {
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
