export function hasInlineProviderCredentialPatch(block) {
  return !!block && typeof block === "object" && (
    Object.prototype.hasOwnProperty.call(block, "api_key")
    || Object.prototype.hasOwnProperty.call(block, "base_url")
  );
}

export function buildInlineProviderCredentialUpdate(block, fallbackProvider = "") {
  const provider = typeof block?.provider === "string" && block.provider.trim()
    ? block.provider.trim()
    : String(fallbackProvider || "").trim();

  const update = {};
  if (Object.prototype.hasOwnProperty.call(block, "api_key")) {
    update.api_key = block.api_key || "";
  }
  if (Object.prototype.hasOwnProperty.call(block, "base_url")) {
    update.base_url = block.base_url || "";
  }

  return { provider, update };
}

export function clearInlineProviderCredentialFields(block) {
  if (!block || typeof block !== "object") return;
  block.api_key = "";
  block.base_url = "";
}
