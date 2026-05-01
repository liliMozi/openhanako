export const DEFAULT_COMPUTER_PROVIDER_BY_PLATFORM = Object.freeze({
  darwin: "macos:cua",
  win32: "windows:uia",
  linux: "mock",
});

export const COMPUTER_PROVIDER_CAPABILITY_DEFAULTS = Object.freeze({
  platform: "sandbox",
  observationModes: ["vision-native"],
  screenshot: false,
  accessibilityTree: false,
  elementActions: false,
  backgroundControl: "none",
  pointClick: "unsupported",
  drag: "unsupported",
  textInput: "unsupported",
  keyboardInput: "unsupported",
  requiresForegroundForInput: true,
  isolated: false,
});

export function normalizeComputerProviderCapabilities(capabilities = {}) {
  return {
    ...COMPUTER_PROVIDER_CAPABILITY_DEFAULTS,
    ...capabilities,
    observationModes: Array.isArray(capabilities.observationModes)
      ? [...capabilities.observationModes]
      : [...COMPUTER_PROVIDER_CAPABILITY_DEFAULTS.observationModes],
  };
}

export function normalizeComputerProvider(provider) {
  if (!provider?.providerId) {
    throw new Error("Computer provider must declare providerId");
  }
  provider.capabilities = normalizeComputerProviderCapabilities(provider.capabilities);
  return provider;
}

export function resolveComputerProviderId({
  explicitProviderId,
  settings = {},
  platform = process.platform,
  defaultProviderId = "mock",
  hasProvider = () => false,
} = {}) {
  if (explicitProviderId) return explicitProviderId;

  const configured = settings.provider_by_platform?.[platform];
  if (configured && hasProvider(configured)) return configured;

  const platformDefault = DEFAULT_COMPUTER_PROVIDER_BY_PLATFORM[platform];
  if (platformDefault && hasProvider(platformDefault)) return platformDefault;

  return defaultProviderId;
}
