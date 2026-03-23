/**
 * Kimi Coding Plan provider plugin
 *
 * 月之暗面 Kimi 会员 Coding 权益，走 Anthropic 兼容协议。
 * 与 moonshot (OpenAI 兼容) 是同一厂商的不同接入方式。
 *
 * 文档：https://platform.moonshot.cn/docs/guide/kimi-k2-5-quickstart
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const kimiCodingPlugin = {
  id: "kimi-coding",
  displayName: "Kimi Coding Plan",
  authType: "api-key",
  defaultBaseUrl: "https://api.moonshot.cn/anthropic",
  defaultApi: "anthropic-messages",
  capabilities: {
    vision: true,
    functionCall: true,
    streaming: true,
    reasoning: true,
    quirks: [],
  },
};
