/**
 * Infini (无问芯穹) provider plugin
 *
 * 文档：https://cloud.infini-ai.com/genstudio/model/list
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const infiniPlugin = {
  id: "infini",
  displayName: "无问芯穹 (Infini)",
  authType: "api-key",
  defaultBaseUrl: "https://cloud.infini-ai.com/maas/v1",
  defaultApi: "openai-completions",
};
