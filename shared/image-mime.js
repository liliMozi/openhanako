export const ALLOWED_CHAT_IMAGE_MIME_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export const MAX_CHAT_IMAGE_BASE64_CHARS = 10 * 1024 * 1024;

const MIME_TO_EXT = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
});

export function normalizeImageMimeType(mimeType) {
  return typeof mimeType === "string" ? mimeType.trim().toLowerCase() : "";
}

export function isAllowedChatImageMime(mimeType) {
  return ALLOWED_CHAT_IMAGE_MIME_TYPES.includes(normalizeImageMimeType(mimeType));
}

export function extensionFromChatImageMime(mimeType) {
  return MIME_TO_EXT[normalizeImageMimeType(mimeType)] || "";
}

export function isChatImageBase64WithinLimit(base64Data) {
  return typeof base64Data === "string" && base64Data.length <= MAX_CHAT_IMAGE_BASE64_CHARS;
}
