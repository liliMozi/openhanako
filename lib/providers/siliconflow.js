/**
 * SiliconFlow (硅基流动) provider plugin
 *
 * 聚合平台，支持 DeepSeek、Qwen、GLM、Llama 等 70+ 开源模型。
 * 文档：https://docs.siliconflow.cn
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const siliconflowPlugin = {
  id: "siliconflow",
  displayName: "SiliconFlow (硅基流动)",
  authType: "api-key",
  defaultBaseUrl: "https://api.siliconflow.cn/v1",
  defaultApi: "openai-completions",
};
