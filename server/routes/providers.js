/**
 * 供应商管理 REST 路由
 */
import fs from "fs";
import path from "path";
import os from "os";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { buildProviderAuthHeaders, probeProvider } from "../../lib/llm/provider-client.js";

// ── Models-cache helpers ──

function getCachePath(engine) {
  return path.join(engine.hanakoHome, "models-cache.json");
}

function readModelsCache(engine) {
  try {
    return JSON.parse(fs.readFileSync(getCachePath(engine), "utf-8"));
  } catch {
    return {};
  }
}

/** Atomic write: tmp + rename to avoid partial reads */
function writeModelsCache(engine, cache) {
  const target = getCachePath(engine);
  const tmp = target + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + os.EOL);
  fs.renameSync(tmp, target);
}

export function createProvidersRoute(engine) {
  const route = new Hono();

  // ── Cache helper: persist discovered models per-provider ──
  function saveToCache(providerName, models) {
    if (!providerName || !models?.length) return;
    try {
      const cache = readModelsCache(engine);
      cache[providerName] = { models, fetchedAt: new Date().toISOString() };
      writeModelsCache(engine, cache);
    } catch { /* best-effort; cache miss is harmless */ }
  }

  // ── Provider Summary ──

  /**
   * 统一概览：合并 added-models.yaml + OAuth status + SDK 模型
   * 前端新 ProvidersTab 的核心数据源
   */
  route.get("/providers/summary", async (c) => {
    const rawProviders = engine.providerRegistry.getAllProvidersRaw();
    // 补全凭证和模型列表（getAllProvidersRaw 返回的是 added-models.yaml 原始数据）
    const providers = {};
    for (const [name, p] of Object.entries(rawProviders)) {
      const entry = engine.providerRegistry.get(name);
      providers[name] = {
        base_url: p.base_url || entry?.baseUrl || "",
        api_key: p.api_key || "",
        api: p.api || entry?.api || "",
        models: p.models || [],
      };
    }

    // ProviderRegistry 是 OAuth 判断的唯一权威
    // 只有在 ProviderRegistry 中注册为 authType:"oauth" 的 provider 才是 OAuth provider
    // Pi SDK 内置的危险 OAuth（anthropic/github-copilot 等）不在 Registry 中，不会泄露
    const provRegistry = engine.providerRegistry;

    // OAuth provider 登录状态（Pi SDK AuthStorage，key 是 authJsonKey）
    const oauthProviders = engine.authStorage?.getOAuthProviders?.() || [];
    const oauthLoginMap = new Map();
    for (const p of oauthProviders) {
      const cred = engine.authStorage.get(p.id);
      oauthLoginMap.set(p.id, { name: p.name, loggedIn: cred?.type === "oauth" });
    }

    // OAuth 自定义模型
    const oauthCustom = engine.preferences.getOAuthCustomModels();

    const result = {};

    // OAuth 登录信息查找（oauthLoginMap 用 authJsonKey 索引）
    function getOAuthLoginInfo(name) {
      if (oauthLoginMap.has(name)) return oauthLoginMap.get(name);
      const authKey = provRegistry.getAuthJsonKey(name);
      if (authKey !== name && oauthLoginMap.has(authKey)) return oauthLoginMap.get(authKey);
      return null;
    }

    // 先处理 added-models.yaml 中的 provider（保持顺序）
    for (const [name, p] of Object.entries(providers)) {
      const isOAuth = provRegistry.isOAuth(name);
      const oauthInfo = getOAuthLoginInfo(name);
      // added-models.yaml 是模型列表的唯一信源
      const rawModels = p.models || [];
      const customModels = oauthCustom[name] || [];

      result[name] = {
        type: isOAuth ? "oauth" : "api-key",
        display_name: oauthInfo?.name || name,
        base_url: p.base_url || "",
        api: p.api || "",
        api_key: p.api_key || "",
        models: rawModels,
        custom_models: customModels,
        has_credentials: !!(p.api_key || (isOAuth && oauthInfo?.loggedIn)),
        logged_in: isOAuth ? !!oauthInfo?.loggedIn : undefined,
        supports_oauth: isOAuth,
        is_coding_plan: name.endsWith("-coding"),
        can_delete: !isOAuth || Object.prototype.hasOwnProperty.call(providers, name),
      };
    }

    // 追加 OAuth-only provider（有 auth.json 但没在 added-models.yaml 里）
    // 遍历已注册的 OAuth plugin，用 authJsonKey 查 oauthLoginMap
    for (const oauthId of provRegistry.getOAuthProviderIds()) {
      if (result[oauthId]) continue;
      const authKey = provRegistry.getAuthJsonKey(oauthId);
      const loginInfo = oauthLoginMap.get(authKey);
      if (!loginInfo) continue;
      const customModels = oauthCustom[authKey] || oauthCustom[oauthId] || [];
      result[oauthId] = {
        type: "oauth",
        display_name: loginInfo.name || oauthId,
        base_url: "",
        api: "",
        api_key: "",
        models: [],
        custom_models: customModels,
        has_credentials: !!loginInfo.loggedIn,
        logged_in: !!loginInfo.loggedIn,
        supports_oauth: true,
        is_coding_plan: false,
        can_delete: false,
      };
    }

    // 追加 ProviderRegistry 中已声明但尚未出现的 provider（未配置状态）
    // 让用户在设置页看到所有可用供应商，点击即可配置
    if (provRegistry) {
      for (const [id, entry] of provRegistry.getAll()) {
        if (result[id]) continue;
        if (entry.authType === "oauth") continue; // OAuth provider 走上面的白名单逻辑
        result[id] = {
          type: "api-key",
          display_name: entry.displayName || id,
          base_url: entry.baseUrl || "",
          api: entry.api || "",
          api_key: "",
          models: [],
          custom_models: [],
          has_credentials: false,
          logged_in: undefined,
          supports_oauth: false,
          is_coding_plan: id.endsWith("-coding"),
          can_delete: false,
        };
      }
    }

    return c.json({ providers: result });
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

  /** Registry → defaults 两级 fallback，fetch-models 和 Anthropic 路径共用 */
  function registryOrDefaultsFallback(name) {
    if (!name) {
      return { error: "name is required for model discovery fallback", models: [] };
    }

    // 尝试 Pi SDK registry（含内置 OAuth 模型 + models.json 模型，不经过 availableModels 白名单）
    const registryModels = engine.getRegistryModelsForProvider(name);
    if (registryModels.length > 0) {
      const normalized = normalizeRegistryModels(registryModels);
      saveToCache(name, normalized);
      return { source: "registry", models: normalized };
    }

    // 回退到 default-models.json（用 authJsonKey 兜底，如 openai-codex-oauth → openai-codex）
    const authKey = engine.providerRegistry.getAuthJsonKey(name);
    const defaults = engine.providerRegistry.getDefaultModels(name)
      || engine.providerRegistry.getDefaultModels(authKey)
      || [];
    if (defaults.length > 0) {
      const builtinModels = defaults.map(id => ({ id, name: id, context: null, maxOutput: null }));
      saveToCache(name, builtinModels);
      return { source: "builtin", models: builtinModels };
    }

    return { error: `No models found for provider "${name}"`, models: [] };
  }

  /**
   * 从供应商拉取模型列表
   * 统一瀑布流：凭证解析 → 远程 GET /models → registry fallback → defaults fallback
   * body: { name, base_url?, api?, api_key? }
   */
  route.post("/providers/fetch-models", async (c) => {
    const body = await safeJson(c);
    const { name, base_url, api: explicitApi, api_key } = body;
    if (!name && !base_url) {
      return c.json({ error: "name or base_url is required" }, 400);
    }

    // ── 1. 凭证解析：请求体 > resolveProviderCredentials（统一路径） ──
    const saved = name ? engine.resolveProviderCredentials(name) : { api_key: "", base_url: "", api: "" };

    const effectiveKey = api_key || saved.api_key || "";
    const effectiveBaseUrl = base_url || saved.base_url || "";
    const effectiveApi = explicitApi || saved.api || "";

    // ── 2. Anthropic 快速路径（没有 /models 端点）──
    if (effectiveApi === "anthropic-messages") {
      return c.json(registryOrDefaultsFallback(name));
    }

    // ── 3. 远程 GET /models（baseUrl 为空时跳过）──
    if (effectiveBaseUrl) {
      try {
        const url = effectiveBaseUrl.replace(/\/+$/, "") + "/models";
        let headers = { "Content-Type": "application/json" };
        if (effectiveKey) {
          if (!effectiveApi) {
            return c.json({ error: "api is required when api_key is present", models: [] });
          }
          headers = buildProviderAuthHeaders(effectiveApi, effectiveKey);
        }
        const res = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(15000),
        });

        // 401/403：凭证问题，直接返回错误，不 fallback
        if (res.status === 401 || res.status === 403) {
          return c.json({ error: `HTTP ${res.status}: ${res.statusText}`, models: [] });
        }

        if (res.ok) {
          const data = await res.json();
          const models = (data.data || []).map(m => ({
            id: m.id,
            name: m.id,
            context: m.context_length || m.context_window || m.max_context_length || null,
            maxOutput: m.max_completion_tokens || m.max_output_tokens || null,
          }));
          saveToCache(name, models);
          return c.json({ models });
        }

        // 404 / 其他 → 进入 step 4
      } catch {
        // 网络错误 → 进入 step 4
      }
    }

    // ── 4. Registry + defaults fallback ──
    return c.json(registryOrDefaultsFallback(name));
  });

  /**
   * 读取供应商已发现但尚未添加的模型（缓存）
   * GET /api/providers/:name/discovered-models
   */
  route.get("/providers/:name/discovered-models", (c) => {
    const providerName = c.req.param("name");
    const cache = readModelsCache(engine);
    const entry = cache[providerName];
    if (!entry) return c.json({ models: [], fetchedAt: null });
    return c.json({ models: entry.models || [], fetchedAt: entry.fetchedAt || null });
  });

  /**
   * 测试供应商连接
   * body: { name?, base_url?, api?, api_key? }
   * 凭证解析优先级与 fetch-models 一致：请求体 > resolveProviderCredentials > 插件默认值
   */
  route.post("/providers/test", async (c) => {
    const body = await safeJson(c);
    const { name } = body;
    // 清洗 API key：去除非 ASCII 字符（防止粘贴时输入法带入中文）
    const bodyKey = (body.api_key || "").replace(/[^\x20-\x7E]/g, "").trim();

    // ── 凭证解析：请求体 > resolveProviderCredentials（统一路径） ──
    const saved = name ? engine.resolveProviderCredentials(name) : { api_key: "", base_url: "", api: "" };

    const api_key = bodyKey || saved.api_key || "";
    const base_url = body.base_url || saved.base_url || "";
    const api = body.api || saved.api || "";

    if (!base_url) {
      return c.json({ error: "base_url is required" }, 400);
    }
    if (api_key && !api) {
      return c.json({ error: "api is required when api_key is present" }, 400);
    }

    try {
      const result = await probeProvider({ baseUrl: base_url, api, apiKey: api_key });
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: err.message });
    }
  });

  /**
   * 更新模型元数据（context/vision/reasoning/maxOutput/name）
   * 写回 added-models.yaml → 触发 model-sync → SDK 模型对象更新
   */
  route.put("/providers/:name/models/:modelId", async (c) => {
    const providerName = c.req.param("name");
    const modelId = decodeURIComponent(c.req.param("modelId"));
    const body = await safeJson(c);
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid body" }, 400);
    }
    try {
      engine.providerRegistry.updateModelEntry(providerName, modelId, body);
      await engine.onProviderChanged();
      return c.json({ ok: true });
    } catch (err) {
      const status = err.message?.includes("not found") ? 404 : 500;
      return c.json({ error: err.message }, status);
    }
  });

  return route;
}
