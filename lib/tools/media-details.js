import { normalizeMediaItems } from "../bridge/media-item-normalizer.js";

export function collectMediaItems(media) {
  if (!media || typeof media !== "object") return [];
  if (Array.isArray(media.items) && media.items.length) {
    return normalizeMediaItems(media.items);
  }
  if (Array.isArray(media.mediaUrls)) {
    return normalizeMediaItems(media.mediaUrls);
  }
  return [];
}
