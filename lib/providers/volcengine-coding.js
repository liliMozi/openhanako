/**
 * Volcengine Coding Plan (火山引擎 Coding Plan) provider plugin
 *
 * 火山方舟 Coding Plan 订阅，与 volcengine (按量付费) 是同一厂商的不同接入方式。
 * 专用端点多了 /coding 路径段。model ID 同样是 endpoint ID。
 *
 * 文档：https://www.volcengine.com/docs/82379/1925114
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const volcegineCodingPlugin = {
  id: "volcengine-coding",
  displayName: "火山引擎 Coding Plan",
  authType: "api-key",
  defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
  defaultApi: "openai-completions",
};
