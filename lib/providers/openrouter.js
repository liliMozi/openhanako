/**
 * OpenRouter provider plugin
 *
 * 聚合多家供应商的路由层，支持 400+ 模型。
 * 注意：模型 ID 可能包含斜杠（如 anthropic/claude-opus-4-6），
 * 在 provider/model 路由键中需要额外转义处理。
 */

/** @type {import('../provider-registry.js').ProviderPlugin} */
export const openrouterPlugin = {
  id: "openrouter",
  displayName: "OpenRouter",
  authType: "api-key",
  defaultBaseUrl: "https://openrouter.ai/api/v1",
  defaultApi: "openai-completions",
};
