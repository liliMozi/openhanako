import { describe, expect, it } from "vitest";

import { createMediaCapabilities } from "../lib/bridge/media-capabilities.js";
import { TELEGRAM_MEDIA_CAPABILITIES } from "../lib/bridge/telegram-adapter.js";
import { FEISHU_MEDIA_CAPABILITIES } from "../lib/bridge/feishu-adapter.js";
import { QQ_MEDIA_CAPABILITIES } from "../lib/bridge/qq-adapter.js";
import { WECHAT_ILINK_MEDIA_CAPABILITIES } from "../lib/bridge/wechat-adapter.js";

describe("bridge media capabilities", () => {
  it("validates supported modes, kinds, and reply context requirements", () => {
    expect(() => createMediaCapabilities({
      platform: "demo",
      inputModes: ["buffer"],
      supportedKinds: ["image"],
      requiresReplyContext: false,
      deliveryByKind: { image: "native_image" },
      source: "docs",
    })).not.toThrow();

    expect(() => createMediaCapabilities({
      platform: "demo",
      inputModes: ["file_data"],
      supportedKinds: ["image"],
      requiresReplyContext: false,
      deliveryByKind: { image: "native_image" },
      source: "docs",
    })).toThrow(/inputModes/);

    expect(() => createMediaCapabilities({
      platform: "demo",
      inputModes: ["buffer"],
      supportedKinds: ["sticker"],
      requiresReplyContext: false,
      deliveryByKind: { sticker: "native_image" },
      source: "docs",
    })).toThrow(/supportedKinds/);
  });

  it("declares Telegram as buffer and URL capable for all file kinds", () => {
    expect(TELEGRAM_MEDIA_CAPABILITIES).toMatchObject({
      platform: "telegram",
      inputModes: ["buffer", "remote_url", "public_url"],
      supportedKinds: ["image", "video", "audio", "document"],
      requiresReplyContext: false,
      deliveryByKind: {
        image: "native_image",
        video: "native_video",
        audio: "native_audio",
        document: "native_document",
      },
    });
    expect(TELEGRAM_MEDIA_CAPABILITIES.maxBytes.buffer.document).toBe(50 * 1024 * 1024);
  });

  it("declares Feishu as upload-key based with explicit size limits", () => {
    expect(FEISHU_MEDIA_CAPABILITIES).toMatchObject({
      platform: "feishu",
      inputModes: ["buffer", "remote_url", "public_url"],
      supportedKinds: ["image", "video", "audio", "document"],
      requiresReplyContext: false,
      deliveryByKind: {
        image: "native_image",
        video: "native_file",
        audio: "native_file",
        document: "native_file",
      },
    });
    expect(FEISHU_MEDIA_CAPABILITIES.maxBytes.buffer.image).toBe(10 * 1024 * 1024);
    expect(FEISHU_MEDIA_CAPABILITIES.maxBytes.buffer.document).toBe(30 * 1024 * 1024);
  });

  it("declares QQ as URL-only for group/C2C rich media and excludes documents", () => {
    expect(QQ_MEDIA_CAPABILITIES).toMatchObject({
      platform: "qq",
      inputModes: ["remote_url", "public_url"],
      supportedKinds: ["image", "video", "audio"],
      requiresReplyContext: false,
      deliveryByKind: {
        image: "native_image",
        video: "native_video",
        audio: "native_audio",
      },
    });
    expect(QQ_MEDIA_CAPABILITIES.supportedKinds).not.toContain("document");
  });

  it("declares WeChat iLink as reply-context bound", () => {
    expect(WECHAT_ILINK_MEDIA_CAPABILITIES).toMatchObject({
      platform: "wechat",
      productSurface: "ilink",
      inputModes: ["buffer", "remote_url", "public_url"],
      supportedKinds: ["image", "video", "audio", "document"],
      requiresReplyContext: true,
      deliveryByKind: {
        image: "native_image",
        video: "native_file",
        audio: "native_file",
        document: "native_file",
      },
    });
  });
});
