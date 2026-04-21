/**
 * xAI (Grok) provider plugin
 *
 * 文档：https://docs.x.ai
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const xaiPlugin = {
  id: "xai",
  displayName: "xAI (Grok)",
  authType: "api-key",
  defaultBaseUrl: "https://api.x.ai/v1",
  defaultApi: "openai-completions",
};
