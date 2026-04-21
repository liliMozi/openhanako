/**
 * MiniMax provider plugin (API key)
 *
 * MiniMax 按量付费 API 接入。
 * 文档：https://platform.minimax.io/docs
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const minimaxPlugin = {
  id: "minimax",
  displayName: "MiniMax",
  authType: "api-key",
  defaultBaseUrl: "https://api.minimaxi.com/anthropic",
  defaultApi: "anthropic-messages",
};
