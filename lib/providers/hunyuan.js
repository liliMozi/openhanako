/**
 * Tencent Hunyuan (腾讯混元) provider plugin
 *
 * 文档：https://cloud.tencent.com/document/product/1729
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const hunyuanPlugin = {
  id: "hunyuan",
  displayName: "腾讯混元",
  authType: "api-key",
  defaultBaseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
  defaultApi: "openai-completions",
};
