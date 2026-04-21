/**
 * Mistral AI provider plugin
 *
 * 文档：https://docs.mistral.ai
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const mistralPlugin = {
  id: "mistral",
  displayName: "Mistral AI",
  authType: "api-key",
  defaultBaseUrl: "https://api.mistral.ai/v1",
  defaultApi: "openai-completions",
};
