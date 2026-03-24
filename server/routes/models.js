/**
 * 模型管理 REST 路由
 */
import { supportsXhigh } from "@mariozechner/pi-ai";
import { t } from "../i18n.js";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const _knownModels = _require("../../lib/known-models.json");

/** 查询模型显示名：overrides > SDK name > known-models > id */
function resolveModelName(id, sdkName, overrides) {
  if (overrides?.[id]?.displayName) return overrides[id].displayName;
  if (sdkName && sdkName !== id) return sdkName;
  if (_knownModels[id]?.name) return _knownModels[id].name;
  return sdkName || id;
}

export default async function modelsRoute(app, { engine }) {

  // 列出可用模型
  app.get("/api/models", async (req, reply) => {
    try {
      const overrides = engine.config?.models?.overrides;
      const models = engine.availableModels.map(m => ({
        id: m.id,
        name: resolveModelName(m.id, m.name, overrides),
        provider: m.provider,
        isCurrent: m.id === engine.currentModel?.id,
      }));
      return { models, current: engine.currentModel?.id || null };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // 收藏模型列表（给聊天页面用，直接读 favorites，和设置页同源）
  app.get("/api/models/favorites", async (req, reply) => {
    try {
      const favorites = engine.readFavorites();
      const available = engine.availableModels;

      const overrides = engine.config?.models?.overrides;
      const result = favorites.map(id => {
        const m = available.find(am => am.id === id);
        return {
          id,
          name: resolveModelName(id, m?.name, overrides),
          provider: m?.provider || "",
          isCurrent: id === engine.currentModel?.id,
          reasoning: m ? !!m.reasoning : false,
          xhigh: m ? supportsXhigh(m) : false,
          vision: m?.provider ? (engine.providerRegistry.get(m.provider)?.capabilities?.vision !== false) : true,
        };
      });

      return {
        models: result,
        current: engine.currentModel?.id || null,
        hasFavorites: favorites.length > 0,
      };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });


  // 健康检测：发一个最小请求测试模型连通性
  app.post("/api/models/health", async (req, reply) => {
    try {
      const { modelId } = req.body || {};
      if (!modelId) { reply.code(400); return { error: "modelId required" }; }

      const model = engine.availableModels.find(m => m.id === modelId);
      if (!model) { reply.code(404); return { error: `model "${modelId}" not found` }; }

      // 凭证解析：providers.yaml → auth.json OAuth（含 resourceUrl）→ 模型对象自带 baseUrl
      const creds = engine.resolveProviderCredentials(model.provider);

      // OAuth provider 可能有 resourceUrl（实际使用的域名，可能和内置不同）
      const oauthCred = engine.authStorage.get(model.provider);
      const oauthBaseUrl = oauthCred?.type === "oauth" ? oauthCred.resourceUrl : "";

      const baseUrl = creds.base_url || oauthBaseUrl || model.baseUrl || "";
      if (!baseUrl) return { ok: false, error: "no base_url" };

      let apiKey = creds.api_key;
      if (!apiKey) {
        try { apiKey = await engine.authStorage.getApiKey(model.provider); } catch {}
      }
      if (!apiKey) return { ok: false, error: "no api_key" };

      const { buildProviderAuthHeaders, buildProbeUrl } = await import("../../lib/llm/provider-client.js");
      const api = creds.api || model.api || "openai-completions";

      // OpenAI Codex Responses API：无法通过简单请求检测（Cloudflare 反爬），跳过
      if (api === "openai-codex-responses") {
        return { ok: true, status: 0, provider: model.provider, skipped: t("error.codexNoHealthCheck") };
      }

      const probe = buildProbeUrl(baseUrl, api);
      const headers = buildProviderAuthHeaders(api, apiKey);

      if (api === "anthropic-messages") {
        const res = await fetch(probe.url, {
          method: probe.method,
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: "user", content: "." }] }),
          signal: AbortSignal.timeout(10000),
        });
        return { ok: res.ok || res.status === 400, status: res.status, provider: model.provider };
      }

      const res = await fetch(probe.url, { headers, signal: AbortSignal.timeout(10000) });
      return { ok: res.ok, status: res.status, provider: model.provider };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 切换模型
  app.post("/api/models/set", async (req, reply) => {
    try {
      const { modelId } = req.body || {};
      if (!modelId) {
        reply.code(400);
        return { error: t("error.missingParam", { param: "modelId" }) };
      }
      await engine.setModel(modelId);
      return { ok: true, model: engine.currentModel?.name };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });
}
