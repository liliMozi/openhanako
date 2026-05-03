import path from "path";
import { extOfName, inferFileKind } from "../file-metadata.js";
import { downloadMedia, detectMime } from "./media-utils.js";
import { normalizeMediaItems } from "./media-item-normalizer.js";

export class MediaDeliveryService {
  constructor({ engine, mediaPublisher } = {}) {
    this.engine = engine || null;
    this.mediaPublisher = mediaPublisher || null;
  }

  async send({ adapter, chatId, platform, mediaItem } = {}) {
    if (!adapter) throw new Error("media delivery adapter is required");
    if (!chatId) throw new Error("media delivery chatId is required");

    const [item] = normalizeMediaItems(mediaItem);
    if (!item) throw new Error("media source must be a supported MediaItem");

    if (item.type === "session_file") {
      return this._sendSessionFile(adapter, chatId, item, platform);
    }
    if (item.type === "remote_url") {
      return this._sendUrl(adapter, chatId, item.url, platform, "remote_url");
    }
    if (item.type === "legacy_local_path") {
      return this._sendLocalPath(adapter, chatId, item.filePath, platform);
    }

    throw new Error(`unsupported media item type: ${item.type}`);
  }

  describe(item) {
    const [normalized] = normalizeMediaItems(item);
    if (!normalized) return String(item || "").slice(0, 80);
    if (normalized.type === "session_file") return `session_file:${normalized.fileId}`.slice(0, 80);
    if (normalized.type === "remote_url") return `remote_url:${normalized.url}`.slice(0, 80);
    if (normalized.type === "legacy_local_path") return `legacy_local_path:${normalized.filePath}`.slice(0, 80);
    return `${normalized.type}:${JSON.stringify(normalized)}`.slice(0, 80);
  }

  async sendFailureNotice(adapter, chatId, err) {
    if (!adapter?.sendReply) return;
    try {
      await adapter.sendReply(chatId, `[文件发送失败] ${err.message || err}`);
    } catch {}
  }

  async _sendSessionFile(adapter, chatId, source, platform) {
    const file = this._resolveSessionFile(source);
    const kind = normalizeKind(file.kind, file.filename || file.filePath || file.realPath, file.mime);
    const publicUrl = getPublicUrl(file);
    const localPath = file.realPath || file.filePath;

    this._assertKindSupported(adapter, platform, kind);

    if (localPath && this._supportsInputMode(adapter, "buffer")) {
      const buffer = await downloadMedia(localPath);
      this._assertMaxBytes(adapter, "buffer", kind, buffer.length);
      const filename = file.filename || path.basename(file.filePath || localPath);
      const mime = file.mime || detectMime(buffer, "application/octet-stream", filename);
      if (!adapter.sendMediaBuffer) {
        throw new Error(`${platform || "platform"} adapter cannot upload local buffers`);
      }
      await adapter.sendMediaBuffer(chatId, buffer, { mime, filename });
      return;
    }

    if (publicUrl && this._supportsInputMode(adapter, "public_url")) {
      return this._sendUrl(adapter, chatId, publicUrl, platform, "public_url", kind);
    }

    if (localPath && this.mediaPublisher && this._supportsInputMode(adapter, "public_url")) {
      if (Number.isFinite(file.size)) {
        this._assertMaxBytes(adapter, "public_url", kind, file.size);
      }
      let published;
      try {
        published = this.mediaPublisher.publish(file);
      } catch (err) {
        throw new Error(`${platform || "platform"} 发送本地文件需要公网可访问 URL：${err.message || err}`);
      }
      if (!published?.publicUrl) {
        throw new Error(`${platform || "platform"} 发送本地文件需要公网可访问 URL`);
      }
      return this._sendUrl(adapter, chatId, published.publicUrl, platform, "public_url", kind);
    }

    if (localPath && !this._supportsInputMode(adapter, "buffer") && this._supportsInputMode(adapter, "public_url")) {
      throw new Error(`${platform || "platform"} 发送本地文件需要公网可访问 URL，当前 staged file 只有本地路径`);
    }

    throw new Error(`platform adapter cannot deliver staged file ${file.filename || file.fileId || ""}`.trim());
  }

  async _sendUrl(adapter, chatId, url, platform, mode, knownKind = null) {
    const kind = knownKind || kindFromUrl(url);
    this._assertInputMode(adapter, mode, platform);
    this._assertKindSupported(adapter, platform, kind);
    if (!adapter.sendMedia) {
      throw new Error(`${platform || "platform"} adapter cannot deliver media URLs`);
    }
    await adapter.sendMedia(chatId, url);
  }

  async _sendLocalPath(adapter, chatId, filePath, platform) {
    this._assertInputMode(adapter, "buffer", platform);
    const buffer = await downloadMedia(filePath);
    const filename = path.basename(filePath);
    const mime = detectMime(buffer, "application/octet-stream", filename);
    const kind = normalizeKind(null, filename, mime);
    this._assertKindSupported(adapter, platform, kind);
    this._assertMaxBytes(adapter, "buffer", kind, buffer.length);
    if (!adapter.sendMediaBuffer) {
      throw new Error(`${platform || "platform"} adapter cannot upload local buffers`);
    }
    await adapter.sendMediaBuffer(chatId, buffer, { mime, filename });
  }

  _resolveSessionFile(source) {
    const fileId = source.fileId || source.id;
    const lookupOptions = source.sessionPath ? { sessionPath: source.sessionPath } : undefined;
    const registered = fileId ? this.engine?.getSessionFile?.(fileId, lookupOptions) : null;
    const file = { ...source, ...(registered || {}) };
    file.fileId = fileId || file.id;
    file.id = file.id || file.fileId;
    file.publicUrl = getPublicUrl(registered) || getPublicUrl(source) || file.publicUrl;
    if (file.status === "expired") {
      throw new Error(`staged file expired: ${fileId || file.filename || "unknown"}`);
    }
    if (!file.filePath && !file.realPath && !getPublicUrl(file)) {
      throw new Error(`staged file not found: ${fileId || "unknown"}`);
    }
    return file;
  }

  _assertInputMode(adapter, mode, platform) {
    if (!this._supportsInputMode(adapter, mode)) {
      if (mode === "buffer" && this._supportsInputMode(adapter, "public_url")) {
        throw new Error(`${platform || "platform"} 发送本地文件需要公网可访问 URL`);
      }
      throw new Error(`${platform || "platform"} does not support media input mode: ${mode}`);
    }
  }

  _supportsInputMode(adapter, mode) {
    return adapter.mediaCapabilities?.inputModes?.includes(mode) || false;
  }

  _assertKindSupported(adapter, platform, kind) {
    if (adapter.mediaCapabilities?.supportedKinds?.includes(kind)) return;
    throw new Error(`${platform || "platform"} does not support ${kind} media delivery`);
  }

  _assertMaxBytes(adapter, mode, kind, size) {
    const max = adapter.mediaCapabilities?.maxBytes?.[mode]?.[kind];
    if (Number.isFinite(max) && size > max) {
      throw new Error(`${adapter.mediaCapabilities.platform} ${kind} upload exceeds ${(max / 1024 / 1024).toFixed(1)}MB limit`);
    }
  }
}

function getPublicUrl(file) {
  if (!file) return null;
  return file.publicUrl || file.url || file.access?.publicUrl || null;
}

function normalizeKind(kind, filename, mime) {
  if (kind === "image" || kind === "video" || kind === "audio" || kind === "document") return kind;
  const ext = extOfName(filename || "");
  const inferred = inferFileKind({ mime, ext, isDirectory: false });
  if (inferred && inferred !== "unknown") return inferred;
  return kindFromExt(ext) || "document";
}

function kindFromUrl(url) {
  let name = "";
  try { name = new URL(url).pathname; } catch { name = url; }
  const ext = extOfName(name);
  const inferred = inferFileKind({ mime: "", ext, isDirectory: false });
  if (inferred && inferred !== "unknown") return inferred;
  return kindFromExt(ext) || "document";
}

function kindFromExt(ext) {
  const value = String(ext || "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "tiff", "heic", "svg"].includes(value)) return "image";
  if (["mp4", "mov", "webm", "avi", "mkv"].includes(value)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "opus", "silk", "amr"].includes(value)) return "audio";
  return null;
}
