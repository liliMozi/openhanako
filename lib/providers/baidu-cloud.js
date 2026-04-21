/**
 * Baidu Cloud (百度智能云 / 千帆 / 文心) provider plugin
 *
 * 文档：https://cloud.baidu.com/doc/WENXINWORKSHOP/s/jlil56u11
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const baiduCloudPlugin = {
  id: "baidu-cloud",
  displayName: "百度智能云 (文心)",
  authType: "api-key",
  defaultBaseUrl: "https://qianfan.baidubce.com/v2",
  defaultApi: "openai-completions",
};
