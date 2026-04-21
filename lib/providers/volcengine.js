/**
 * Volcengine (火山引擎 / 豆包) provider plugin
 *
 * 注意：火山引擎的 model ID 实际是用户在控制台创建的 endpoint ID（如 ep-xxxxxx），
 * 不是标准模型名，故无默认模型列表，用户需通过设置页手动配置。
 *
 * 文档：https://www.volcengine.com/docs/82379/1399008
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const volcenginePlugin = {
  id: "volcengine",
  displayName: "火山引擎 (豆包)",
  authType: "api-key",
  defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  defaultApi: "openai-completions",
};
