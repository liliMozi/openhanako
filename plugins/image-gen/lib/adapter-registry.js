/**
 * plugins/image-gen/lib/adapter-registry.js
 *
 * Registry for media generation adapters. Supports typed queries
 * and default adapter resolution. External adapters register via bus.
 */

export class AdapterRegistry {
  constructor() {
    this._adapters = new Map();
  }

  register(adapter) {
    this._adapters.set(adapter.id, adapter);
  }

  unregister(adapterId) {
    this._adapters.delete(adapterId);
  }

  get(adapterId) {
    return this._adapters.get(adapterId) || null;
  }

  getByType(type) {
    const result = [];
    for (const a of this._adapters.values()) {
      if (a.types.includes(type)) result.push(a);
    }
    return result;
  }

  getDefault(type) {
    for (const a of this._adapters.values()) {
      if (a.types.includes(type)) return a;
    }
    return null;
  }

  list() {
    return [...this._adapters.values()];
  }
}
