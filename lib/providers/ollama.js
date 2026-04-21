/**
 * Ollama provider plugin (本地模型)
 *
 * 无需认证，默认监听 localhost:11434。
 */

/** @type {import('../provider-registry.js').ProviderPlugin} */
export const ollamaPlugin = {
  id: "ollama",
  displayName: "Ollama (本地)",
  authType: "none",
  defaultBaseUrl: "http://localhost:11434/v1",
  defaultApi: "openai-completions",
};
