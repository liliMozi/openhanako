/**
 * DashScope provider plugin
 *
 * 阿里云百炼 OpenAI 兼容接口，承载 Qwen、MiniMax（通过 DashScope 转发）、
 * GLM、Kimi、SiliconFlow 等众多模型。
 *
 * 文档：https://help.aliyun.com/zh/model-studio/developer-reference/use-qwen-by-calling-api
 */

/** @type {import('../provider-registry.js').ProviderPlugin} */
export const dashscopePlugin = {
  id: "dashscope",
  displayName: "阿里云百炼 (DashScope)",
  authType: "api-key",
  defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  defaultApi: "openai-completions",
};
