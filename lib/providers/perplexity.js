/**
 * Perplexity provider plugin
 *
 * 搜索增强 LLM。
 * 文档：https://docs.perplexity.ai
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const perplexityPlugin = {
  id: "perplexity",
  displayName: "Perplexity",
  authType: "api-key",
  defaultBaseUrl: "https://api.perplexity.ai",
  defaultApi: "openai-completions",
};
