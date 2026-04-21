/**
 * Anthropic provider plugin (API key)
 */

/** @type {import('../provider-registry.js').ProviderPlugin} */
export const anthropicPlugin = {
  id: "anthropic",
  displayName: "Anthropic",
  authType: "api-key",
  defaultBaseUrl: "https://api.anthropic.com",
  defaultApi: "anthropic-messages",
};
