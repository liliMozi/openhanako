/**
 * lib/llm/provider-client.js — Provider 认证 header 和连通性探测 URL 构造
 *
 * callProviderText 已迁移到 core/llm-client.js（走 Pi SDK），
 * 本文件只保留 test/health 路由需要的辅助函数。
 */

import { t } from "../../server/i18n.js";

/**
 * 构建 provider 认证 header
 * 被 /api/providers/test 和 /api/models/health 路由使用
 */
export function buildProviderAuthHeaders(api, apiKey, opts = {}) {
  const allowMissingApiKey = opts.allowMissingApiKey === true;
  if (!api) {
    throw new Error(t("error.missingApiProtocol"));
  }
  if (!apiKey && !allowMissingApiKey) {
    throw new Error(t("error.missingApiKey"));
  }

  if (api === "anthropic-messages") {
    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (apiKey) headers["x-api-key"] = apiKey;
    return headers;
  }

  if (api === "openai-completions" || api === "openai-codex-responses" || api === "openai-responses") {
    const headers = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    return headers;
  }

  throw new Error(t("error.unsupportedApiProtocol", { api }));
}

/**
 * 构建连通性探测 URL（统一 test/health 两条路由的 URL 逻辑）
 *
 * Anthropic 协议：POST baseUrl/v1/messages（和 Pi SDK Anthropic provider 一致）
 * OpenAI 兼容协议：GET baseUrl/models
 *
 * @param {string} baseUrl
 * @param {string} api
 * @returns {{ url: string, method: string }}
 */
export function buildProbeUrl(baseUrl, api) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (api === "anthropic-messages") {
    return { url: `${base}/v1/messages`, method: "POST" };
  }
  return { url: `${base}/models`, method: "GET" };
}

/**
 * 探测 provider 连通性（统一 health check + test 的唯一实现）
 *
 * 判断标准：排除 401/403（认证失败），其余状态码都视为连通。
 * Codex Responses API 因 Cloudflare 反爬无法探测，直接跳过返回 ok。
 *
 * @param {{ baseUrl: string, api: string, apiKey: string, modelId?: string }} params
 * @returns {Promise<{ ok: boolean, status: number, skipped?: string, error?: string }>}
 */
export async function probeProvider({ baseUrl, api, apiKey, modelId }) {
  if (api === "openai-codex-responses") {
    return { ok: true, status: 0, skipped: t("error.codexNoHealthCheck") };
  }

  const probe = buildProbeUrl(baseUrl, api);

  // 无 apiKey 时跳过认证 header（支持 ollama 等本地无认证 provider）
  const headers = (api && apiKey)
    ? buildProviderAuthHeaders(api, apiKey)
    : { "Content-Type": "application/json" };

  if (api === "anthropic-messages") {
    const res = await fetch(probe.url, {
      method: probe.method,
      headers,
      body: JSON.stringify({
        model: modelId || "test",
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    const authOk = res.status !== 401 && res.status !== 403;
    return { ok: authOk, status: res.status };
  }

  const res = await fetch(probe.url, { headers, signal: AbortSignal.timeout(10000) });
  const authOk = res.status !== 401 && res.status !== 403;
  return { ok: authOk, status: res.status };
}
