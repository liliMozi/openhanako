/**
 * MiniMax provider plugin (API key)
 *
 * MiniMax 按量付费 API 接入。与 minimax-oauth（走 OAuth）是同一厂商的不同接入方式。
 * 文档：https://platform.minimax.io/docs
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const minimaxPlugin = {
  id: "minimax",
  displayName: "MiniMax",
  authType: "api-key",
  defaultBaseUrl: "https://api.minimaxi.com/v1",
  defaultApi: "openai-completions",
  capabilities: {
    vision: true,
    functionCall: true,
    streaming: true,
    reasoning: false,
    quirks: [],
  },
};
