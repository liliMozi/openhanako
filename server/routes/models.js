/**
 * 模型管理 REST 路由
 */
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { t } from "../i18n.js";
import { findModel, modelRefEquals, parseModelRef } from "../../shared/model-ref.js";
import { lookupKnown } from "../../shared/known-models.js";

/** 查询模型显示名：overrides > SDK name > known-models > id */
function resolveModelName(id, sdkName, overrides, provider) {
  if (overrides?.[id]?.displayName) return overrides[id].displayName;
  if (sdkName && sdkName !== id) return sdkName;
  const known = lookupKnown(provider, id);
  if (known?.name) return known.name;
  return sdkName || id;
}

export function createModelsRoute(engine) {
  const route = new Hono();

  // 列出可用模型
  route.get("/models", async (c) => {
    try {
      const overrides = engine.config?.models?.overrides;
      const cur = engine.currentModel;
      const models = engine.availableModels.map(m => ({
        id: m.id,
        name: resolveModelName(m.id, m.name, overrides, m.provider),
        provider: m.provider,
        isCurrent: modelRefEquals(m, cur),
        vision: m.vision,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      }));
      return c.json({ models, current: cur?.id || null });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 健康检测：发一个最小请求测试模型连通性
  route.post("/models/health", async (c) => {
    try {
      const body = await safeJson(c);
      const raw = body.modelId;
      if (!raw) return c.json({ error: "modelId required" }, 400);

      // 统一解析：接受 {id,provider} 对象、裸字符串、或 body.provider 补充
      const parsed = parseModelRef(raw);
      const modelId = parsed.id;
      const provider = body.provider || parsed.provider;
      if (!modelId) return c.json({ error: "modelId required" }, 400);

      const model = findModel(engine.availableModels, modelId, provider);
      if (!model) return c.json({ error: `model "${modelId}" not found` }, 404);

      // 凭证解析（统一路径：getCredentials 已覆盖 OAuth resourceUrl + token）
      const creds = engine.resolveProviderCredentials(model.provider);

      const baseUrl = creds.base_url || model.baseUrl || "";
      if (!baseUrl) return c.json({ ok: false, error: "no base_url" });

      const apiKey = creds.api_key;
      if (!apiKey) return c.json({ ok: false, error: "no api_key" });

      const api = creds.api || model.api || "openai-completions";

      const { probeProvider } = await import("../../lib/llm/provider-client.js");
      const result = await probeProvider({ baseUrl, api, apiKey, modelId });
      return c.json({ ...result, provider: model.provider });
    } catch (err) {
      return c.json({ ok: false, error: err.message });
    }
  });

  // 切换模型
  route.post("/models/set", async (c) => {
    try {
      const body = await safeJson(c);
      const { modelId, provider } = body;
      if (!modelId) {
        return c.json({ error: t("error.missingParam", { param: "modelId" }) }, 400);
      }
      engine.setPendingModel(modelId, provider);
      return c.json({ ok: true, model: engine.currentModel?.name, pendingModel: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
