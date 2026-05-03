/**
 * file-metadata.js — shared file metadata helpers.
 *
 * Kept outside Bridge/Desktop so file identity can be resolved before a
 * consumer decides how to present or deliver the resource.
 */

const MAGIC_TABLE = [
  { bytes: [0xFF, 0xD8, 0xFF],                         mime: "image/jpeg" },
  { bytes: [0x89, 0x50, 0x4E, 0x47],                   mime: "image/png" },
  { bytes: [0x47, 0x49, 0x46, 0x38],                   mime: "image/gif" },
  { bytes: [0x52, 0x49, 0x46, 0x46],                   mime: "image/webp", offset: 8, extra: [0x57, 0x45, 0x42, 0x50] },
  { bytes: [0x25, 0x50, 0x44, 0x46],                   mime: "application/pdf" },
  { bytes: [0x49, 0x44, 0x33],                         mime: "audio/mpeg" },
  { bytes: [0x4F, 0x67, 0x67, 0x53],                   mime: "audio/ogg" },
  { bytes: [0x00, 0x00, 0x00],                         mime: "video/mp4", minLen: 8, check: (b) => b.length >= 8 && (b.toString("ascii", 4, 8) === "ftyp") },
];

const EXT_MIME = {
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown", json: "application/json",
  csv: "text/csv", xml: "text/xml", html: "text/html", htm: "text/html",
  svg: "image/svg+xml", yml: "text/yaml", yaml: "text/yaml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
};

export function extOfName(name) {
  if (!name) return "";
  const value = String(name);
  const dot = value.lastIndexOf(".");
  if (dot < 0 || dot === value.length - 1) return "";
  return value.slice(dot + 1).toLowerCase();
}

export function detectMime(buffer, fallback, filename) {
  for (const entry of MAGIC_TABLE) {
    if (buffer.length < (entry.minLen || entry.bytes.length)) continue;
    const match = entry.bytes.every((b, i) => buffer[i] === b);
    if (!match) continue;
    if (entry.extra) {
      const off = entry.offset || 0;
      if (buffer.length < off + entry.extra.length) continue;
      if (!entry.extra.every((b, i) => buffer[off + i] === b)) continue;
    }
    if (entry.check && !entry.check(buffer)) continue;
    return entry.mime;
  }
  const ext = extOfName(filename);
  if (ext && EXT_MIME[ext]) return EXT_MIME[ext];
  return fallback || "application/octet-stream";
}

export function inferFileKind({ mime, ext, isDirectory = false } = {}) {
  if (isDirectory) return "directory";
  const lowerMime = String(mime || "").toLowerCase();
  if (lowerMime.startsWith("image/")) return "image";
  if (lowerMime.startsWith("video/")) return "video";
  if (lowerMime.startsWith("audio/")) return "audio";
  const lowerExt = String(ext || "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(lowerExt)) return "image";
  if (["mp4", "mov", "webm"].includes(lowerExt)) return "video";
  if (["mp3", "wav", "ogg", "m4a"].includes(lowerExt)) return "audio";
  if (["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "md", "markdown", "txt", "csv", "json", "yaml", "yml", "xml", "html", "htm"].includes(lowerExt)) {
    return "document";
  }
  if (lowerMime && lowerMime !== "application/octet-stream") return "document";
  return "unknown";
}

export function formatSize(bytes) {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
