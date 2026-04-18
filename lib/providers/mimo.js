/**
 * Xiaomi MiMo provider plugin
 *
 * 文档：https://dev.mi.com/mimo-open-platform
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const mimoPlugin = {
  id: "mimo",
  displayName: "Xiaomi (MiMo)",
  authType: "api-key",
  defaultBaseUrl: "https://api.xiaomimimo.com/v1",
  defaultApi: "openai-completions",
};
