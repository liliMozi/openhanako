const INPUT_MODES = new Set(["buffer", "remote_url", "public_url"]);
const FILE_KINDS = new Set(["image", "video", "audio", "document"]);
const DELIVERY_MODES = new Set(["native_image", "native_video", "native_audio", "native_document", "native_file"]);

export function createMediaCapabilities(def = {}) {
  if (!def.platform || typeof def.platform !== "string") {
    throw new Error("mediaCapabilities.platform is required");
  }
  validateArray("inputModes", def.inputModes, INPUT_MODES);
  validateArray("supportedKinds", def.supportedKinds, FILE_KINDS);
  if (typeof def.requiresReplyContext !== "boolean") {
    throw new Error("mediaCapabilities.requiresReplyContext must be boolean");
  }
  if (!def.source || typeof def.source !== "string") {
    throw new Error("mediaCapabilities.source is required");
  }

  const deliveryByKind = def.deliveryByKind || {};
  for (const kind of def.supportedKinds) {
    const mode = deliveryByKind[kind];
    if (!DELIVERY_MODES.has(mode)) {
      throw new Error(`mediaCapabilities.deliveryByKind.${kind} is invalid`);
    }
  }

  return Object.freeze({
    ...def,
    inputModes: Object.freeze([...def.inputModes]),
    supportedKinds: Object.freeze([...def.supportedKinds]),
    deliveryByKind: Object.freeze({ ...deliveryByKind }),
    maxBytes: freezeMaxBytes(def.maxBytes),
  });
}

function validateArray(name, values, allowed) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`mediaCapabilities.${name} must be a non-empty array`);
  }
  for (const value of values) {
    if (!allowed.has(value)) {
      throw new Error(`mediaCapabilities.${name} contains unsupported value: ${value}`);
    }
  }
}

function freezeMaxBytes(maxBytes) {
  if (!maxBytes) return Object.freeze({});
  const out = {};
  for (const [mode, limits] of Object.entries(maxBytes)) {
    out[mode] = Object.freeze({ ...limits });
  }
  return Object.freeze(out);
}
