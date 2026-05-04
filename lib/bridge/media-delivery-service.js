import path from "path";
import { debugLog } from "../debug-log.js";
import { extOfName, inferFileKind } from "../file-metadata.js";
import { downloadMedia, detectMime, resolveAllowedLocalPath } from "./media-utils.js";
import { normalizeMediaItems } from "./media-item-normalizer.js";

export class MediaDeliveryService {
  constructor({ engine, mediaPublisher } = {}) {
    this.engine = engine || null;
    this.mediaPublisher = mediaPublisher || null;
  }

  async send({ adapter, chatId, platform, mediaItem, isGroup } = {}) {
    if (!adapter) throw new Error("media delivery adapter is required");
    if (!chatId) throw new Error("media delivery chatId is required");

    const [item] = normalizeMediaItems(mediaItem);
    if (!item) throw new Error("media source must be a supported MediaItem");
    const targetMetadata = targetDeliveryMetadata({ isGroup });

    if (item.type === "session_file") {
      return this._sendSessionFile(adapter, chatId, item, platform, targetMetadata);
    }
    if (item.type === "remote_url") {
      return this._sendUrl(adapter, chatId, item.url, platform, "remote_url", null, targetMetadata);
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

  async _sendSessionFile(adapter, chatId, source, platform, targetMetadata = {}) {
    const file = this._resolveSessionFile(source);
    const kind = normalizeKind(file.kind, file.filename || file.filePath || file.realPath, file.mime);
    const publicUrl = getPublicUrl(file);
    const localPath = file.realPath || file.filePath;
    const metadata = { ...mediaMetadata(file, kind), ...targetMetadata };

    this._assertKindSupported(adapter, platform, kind);

    if (localPath && this._supportsInputMode(adapter, "local_file")) {
      const realPath = resolveAllowedLocalPath(localPath);
      const filename = file.filename || path.basename(file.filePath || realPath);
      const statSize = Number.isFinite(file.size) ? file.size : undefined;
      if (Number.isFinite(statSize)) {
        this._assertMaxBytes(adapter, "local_file", kind, statSize);
      }
      if (!adapter.sendMediaFile) {
        throw new Error(`${platform || "platform"} adapter cannot upload local files`);
      }
      logDelivery({ platform, mode: "local_file", kind, file, filename, size: statSize });
      await adapter.sendMediaFile(chatId, realPath, {
        ...metadata,
        filename,
      });
      return;
    }

    if (localPath && this._supportsInputMode(adapter, "buffer")) {
      const buffer = await downloadMedia(localPath);
      this._assertMaxBytes(adapter, "buffer", kind, buffer.length);
      const filename = file.filename || path.basename(file.filePath || localPath);
      const mime = file.mime || detectMime(buffer, "application/octet-stream", filename);
      if (!adapter.sendMediaBuffer) {
        throw new Error(`${platform || "platform"} adapter cannot upload local buffers`);
      }
      logDelivery({ platform, mode: "buffer", kind, file, filename, size: buffer.length });
      await adapter.sendMediaBuffer(chatId, buffer, { mime, filename });
      return;
    }

    if (publicUrl && this._supportsInputMode(adapter, "public_url")) {
      return this._sendUrl(adapter, chatId, publicUrl, platform, "public_url", kind, metadata);
    }

    if (localPath && this.mediaPublisher && this._supportsInputMode(adapter, "public_url")) {
      if (Number.isFinite(file.size)) {
        this._assertMaxBytes(adapter, "public_url", kind, file.size);
      }
      let published;
      try {
        this._refreshPublisherBaseUrl();
        published = this.mediaPublisher.publish(file);
      } catch (err) {
        throw new Error(publicUrlRequiredMessage(platform, err));
      }
      if (!published?.publicUrl) {
        throw new Error(publicUrlRequiredMessage(platform));
      }
      return this._sendUrl(adapter, chatId, published.publicUrl, platform, "public_url", kind, metadata);
    }

    if (localPath && !this._supportsInputMode(adapter, "buffer") && this._supportsInputMode(adapter, "public_url")) {
      throw new Error(publicUrlRequiredMessage(platform, "当前 staged file 只有本地路径"));
    }

    throw new Error(`platform adapter cannot deliver staged file ${file.filename || file.fileId || ""}`.trim());
  }

  _refreshPublisherBaseUrl() {
    if (!this.mediaPublisher?.setBaseUrl) return;
    const baseUrl = this.engine?.getBridgeMediaPublicBaseUrl?.() || process.env.HANA_BRIDGE_PUBLIC_BASE_URL || "";
    this.mediaPublisher.setBaseUrl(baseUrl);
  }

  async _sendUrl(adapter, chatId, url, platform, mode, knownKind = null, metadata = {}) {
    const kind = knownKind || kindFromUrl(url);
    this._assertInputMode(adapter, mode, platform);
    this._assertKindSupported(adapter, platform, kind);
    if (!adapter.sendMedia) {
      throw new Error(`${platform || "platform"} adapter cannot deliver media URLs`);
    }
    logDelivery({ platform, mode, kind, metadata, filename: metadata.filename, size: metadata.size });
    await adapter.sendMedia(chatId, url, { ...metadata, kind });
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
    logDelivery({ platform, mode: "buffer", kind, filename, size: buffer.length });
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
        throw new Error(publicUrlRequiredMessage(platform));
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

function mediaMetadata(file, kind) {
  if (!file) return {};
  const filename = file.filename || file.label || (file.filePath ? path.basename(file.filePath) : undefined);
  return {
    kind,
    ...(file.mime ? { mime: file.mime } : {}),
    ...(filename ? { filename } : {}),
    ...(Number.isFinite(file.size) ? { size: file.size } : {}),
  };
}

function targetDeliveryMetadata({ isGroup } = {}) {
  if (isGroup === true) return { isGroup: true, targetScope: "group" };
  if (isGroup === false) return { isGroup: false, targetScope: "dm" };
  return {};
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

function publicUrlRequiredMessage(platform, detail = null) {
  const suffix = detail ? `：${detail.message || detail}` : "";
  return `${platform || "platform"} 当前 adapter 不能直接消费这个本地 staged file，只能走 public_url fallback（配置 bridge_media_public_base_url 或 HANA_BRIDGE_PUBLIC_BASE_URL 后可启用）${suffix}`;
}

function logDelivery({ platform, mode, kind, file, metadata, filename, size } = {}) {
  const fileId = file?.fileId || file?.id || metadata?.fileId || "n/a";
  const name = filename || file?.filename || file?.label || metadata?.filename || "unnamed";
  const byteSize = Number.isFinite(size) ? size : (Number.isFinite(file?.size) ? file.size : "unknown");
  debugLog()?.log(
    "bridge",
    `[media] platform=${platform || "platform"} mode=${mode} kind=${kind || "unknown"} fileId=${fileId} filename=${safeLogToken(name)} size=${byteSize}`,
  );
}

function safeLogToken(value) {
  return String(value || "")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 120);
}
