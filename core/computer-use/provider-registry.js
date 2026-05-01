import { COMPUTER_USE_ERRORS, computerUseError } from "./errors.js";
import { normalizeComputerProvider } from "./provider-contract.js";

export class ComputerProviderRegistry {
  constructor() {
    this._providers = new Map();
  }

  register(provider) {
    provider = normalizeComputerProvider(provider);
    if (this._providers.has(provider.providerId)) {
      throw new Error(`Computer provider already registered: ${provider.providerId}`);
    }
    this._providers.set(provider.providerId, provider);
  }

  get(providerId) {
    return this._providers.get(providerId) || null;
  }

  has(providerId) {
    return this._providers.has(providerId);
  }

  require(providerId) {
    const provider = this.get(providerId);
    if (!provider) {
      throw computerUseError(COMPUTER_USE_ERRORS.PROVIDER_UNAVAILABLE, `Computer provider unavailable: ${providerId}`, { providerId });
    }
    return provider;
  }

  list() {
    return [...this._providers.values()];
  }
}
