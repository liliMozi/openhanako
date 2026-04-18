/**
 * 模型管理 REST 路由
 */
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { t } from "../i18n.js";
import { modelRefEquals, parseModelRef } from "../../shared/model-ref.js";
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
      const activeModel = engine.activeSessionModel;
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
      return c.json({
        models,
        current: cur?.id || null,
        activeModel: activeModel ? { id: activeModel.id, provider: activeModel.provider } : null,
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 健康检测：向 completion 端点发最小请求，验证模型存在且凭证有效
  route.post("/models/health", async (c) => {
    try {
      const body = await safeJson(c);
      const raw = body.modelId;
      if (!raw) return c.json({ error: "modelId required" }, 400);

      const ref = parseModelRef(raw);
      if (body.provider) ref.provider = body.provider;
      if (!ref.id) return c.json({ error: "modelId required" }, 400);

      // 统一凭证解析（找模型 + 拿凭证一步到位）
      const resolved = engine.resolveModelWithCredentials(ref);

      // Codex Responses API 无法简单探测
      if (resolved.api === "openai-codex-responses") {
        return c.json({ ok: true, status: 0, provider: resolved.provider, skipped: t("error.codexNoHealthCheck") });
      }

      // 向 completion 端点发最小请求（max_tokens=2 避免部分 provider 空响应）
      // 只检查 HTTP 状态码，不要求返回有意义的文本
      const { buildProviderAuthHeaders } = await import("../../lib/llm/provider-client.js");
      const base = resolved.base_url.replace(/\/+$/, "");
      let endpoint, headers, reqBody;

      if (resolved.api === "anthropic-messages") {
        endpoint = `${base}/v1/messages`;
        headers = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
        if (resolved.api_key) headers["x-api-key"] = resolved.api_key;
        reqBody = { model: resolved.model, max_tokens: 2, messages: [{ role: "user", content: "." }] };
      } else {
        endpoint = `${base}/chat/completions`;
        headers = buildProviderAuthHeaders(resolved.api, resolved.api_key, { allowMissingApiKey: true });
        reqBody = { model: resolved.model, max_tokens: 2, messages: [{ role: "user", content: "." }] };
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(15_000),
      });

      const authOk = res.status !== 401 && res.status !== 403;
      return c.json({ ok: authOk, status: res.status, provider: resolved.provider });
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

  // 会话内切换模型
  route.post("/models/switch", async (c) => {
    try {
      const body = await safeJson(c);
      const { sessionPath, modelId, provider } = body;
      if (!sessionPath) return c.json({ error: t("error.missingParam", { param: "sessionPath" }) }, 400);
      if (!modelId) return c.json({ error: t("error.missingParam", { param: "modelId" }) }, 400);

      if (engine.isSessionStreaming(sessionPath)) {
        return c.json({ error: "cannot switch model while streaming" }, 409);
      }

      const result = await engine.switchSessionModel(sessionPath, modelId, provider);

      // Build model info for response
      const session = engine.getSessionByPath(sessionPath);
      const sessionModel = session?.model;
      const overrides = engine.config?.models?.overrides;
      const modelInfo = sessionModel ? {
        id: sessionModel.id,
        name: resolveModelName(sessionModel.id, sessionModel.name, overrides, sessionModel.provider),
        provider: sessionModel.provider,
        vision: sessionModel.vision,
        reasoning: sessionModel.reasoning,
        contextWindow: sessionModel.contextWindow,
      } : null;

      return c.json({ ok: true, model: modelInfo, adaptations: result.adaptations });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
