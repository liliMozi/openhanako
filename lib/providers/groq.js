/**
 * Groq provider plugin
 *
 * 超低延迟推理，支持 Llama、Mixtral 等开源模型。
 * 文档：https://console.groq.com/docs
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const groqPlugin = {
  id: "groq",
  displayName: "Groq",
  authType: "api-key",
  defaultBaseUrl: "https://api.groq.com/openai/v1",
  defaultApi: "openai-completions",
};
