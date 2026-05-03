import path from "path";
import { fileURLToPath } from "url";

export function normalizeMediaItems(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  const normalized = [];
  const seen = new Set();

  for (const rawItem of items) {
    const item = normalizeMediaItem(rawItem);
    if (!item) continue;

    const key = mediaItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(item);
  }

  return normalized;
}

export function normalizeMediaItem(rawItem) {
  if (!rawItem) return null;

  if (typeof rawItem === "string") {
    return normalizeMediaString(rawItem);
  }

  if (typeof rawItem !== "object") return null;

  if (rawItem.type === "session_file") {
    const fileId = rawItem.fileId || rawItem.id;
    if (!fileId) return null;
    return { ...rawItem, fileId };
  }

  if (rawItem.type === "remote_url") {
    return normalizeRemoteUrl(rawItem.url);
  }

  if (rawItem.type === "legacy_local_path") {
    return normalizeLocalPath(rawItem.filePath);
  }

  if (rawItem.type === "local_file") {
    return normalizeLocalPath(rawItem.filePath);
  }

  return null;
}

export function mediaItemKey(item) {
  if (!item || typeof item !== "object") return String(item || "");

  if (item.type === "session_file") {
    return `session_file:${item.fileId || item.id || ""}`;
  }
  if (item.type === "remote_url") {
    return `remote_url:${item.url || ""}`;
  }
  if (item.type === "legacy_local_path") {
    return `legacy_local_path:${path.resolve(item.filePath || "")}`;
  }

  return `${item.type || "object"}:${JSON.stringify(item)}`;
}

function normalizeMediaString(source) {
  const value = source.trim();
  if (!value) return null;

  const remote = normalizeRemoteUrl(value);
  if (remote) return remote;

  if (value.startsWith("file://")) {
    try {
      return normalizeLocalPath(fileURLToPath(value));
    } catch {
      return null;
    }
  }

  return normalizeLocalPath(value);
}

function normalizeRemoteUrl(source) {
  if (typeof source !== "string" || !source.trim()) return null;
  const value = source.trim();
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { type: "remote_url", url: value };
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeLocalPath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  const value = filePath.trim();
  if (!path.isAbsolute(value)) return null;
  return { type: "legacy_local_path", filePath: path.resolve(value) };
}
