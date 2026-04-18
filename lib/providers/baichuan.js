/**
 * Baichuan (百川智能) provider plugin
 *
 * 文档：https://platform.baichuan-ai.com/docs/api
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const baichuanPlugin = {
  id: "baichuan",
  displayName: "百川智能",
  authType: "api-key",
  defaultBaseUrl: "https://api.baichuan-ai.com/v1",
  defaultApi: "openai-completions",
};
