import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const debugLogMock = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => debugLogMock,
}));

import { MediaDeliveryService } from "../lib/bridge/media-delivery-service.js";
import { setMediaLocalRoots } from "../lib/bridge/media-utils.js";
import { TELEGRAM_MEDIA_CAPABILITIES } from "../lib/bridge/telegram-adapter.js";
import { FEISHU_MEDIA_CAPABILITIES } from "../lib/bridge/feishu-adapter.js";
import { QQ_MEDIA_CAPABILITIES } from "../lib/bridge/qq-adapter.js";
import { WECHAT_ILINK_MEDIA_CAPABILITIES } from "../lib/bridge/wechat-adapter.js";

describe("MediaDeliveryService", () => {
  let tmpDir = null;
  let extraTmpDirs = [];

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const dir of extraTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    tmpDir = null;
    extraTmpDirs = [];
    debugLogMock.log.mockClear();
    debugLogMock.warn.mockClear();
    debugLogMock.error.mockClear();
    setMediaLocalRoots([]);
  });

  function makeTempFile(name, content = "hello") {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-media-delivery-"));
    setMediaLocalRoots([tmpDir]);
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function makeTempFileOutsideAllowedRoots(name, content = "hello") {
    makeTempFile("allowed-placeholder.txt", "allowed");
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hana-media-outside-"));
    extraTmpDirs.push(outsideRoot);
    const outsidePath = path.join(outsideRoot, name);
    fs.writeFileSync(outsidePath, content);
    return { outsidePath, outsideRoot };
  }

  function makeService(sessionFile, extra = {}) {
    return new MediaDeliveryService({
      engine: {
        getSessionFile: vi.fn((id) => id === sessionFile?.id ? sessionFile : null),
      },
      ...extra,
    });
  }

  it("delivers Telegram-like session files through buffer upload", async () => {
    const filePath = makeTempFile("image.png", Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const service = makeService({
      id: "sf_image",
      filePath,
      realPath: filePath,
      filename: "image.png",
      mime: "image/png",
      kind: "image",
    });
    const adapter = {
      mediaCapabilities: TELEGRAM_MEDIA_CAPABILITIES,
      sendMediaBuffer: vi.fn(async () => {}),
      sendMedia: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "chat-1",
      platform: "telegram",
      mediaItem: { type: "session_file", fileId: "sf_image" },
    });

    expect(adapter.sendMediaBuffer).toHaveBeenCalledOnce();
    expect(adapter.sendMediaBuffer.mock.calls[0][0]).toBe("chat-1");
    expect(Buffer.isBuffer(adapter.sendMediaBuffer.mock.calls[0][1])).toBe(true);
    expect(adapter.sendMediaBuffer.mock.calls[0][2]).toEqual({
      mime: "image/png",
      filename: "image.png",
    });
    expect(adapter.sendMedia).not.toHaveBeenCalled();
  });

  it("delivers Feishu-like documents through buffer upload", async () => {
    const filePath = makeTempFile("note.txt", "ok");
    const service = makeService({
      id: "sf_doc",
      filePath,
      realPath: filePath,
      filename: "note.txt",
      mime: "text/plain",
      kind: "document",
    });
    const adapter = {
      mediaCapabilities: FEISHU_MEDIA_CAPABILITIES,
      sendMediaBuffer: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "chat-1",
      platform: "feishu",
      mediaItem: { type: "session_file", fileId: "sf_doc" },
    });

    expect(adapter.sendMediaBuffer).toHaveBeenCalledWith(
      "chat-1",
      expect.any(Buffer),
      { mime: "text/plain", filename: "note.txt" },
    );
  });

  it("delivers WeChat staged files through the same buffer contract", async () => {
    const filePath = makeTempFile("report.pdf", "%PDF");
    const service = makeService({
      id: "sf_doc",
      filePath,
      realPath: filePath,
      filename: "report.pdf",
      mime: "application/pdf",
      kind: "document",
    });
    const adapter = {
      mediaCapabilities: WECHAT_ILINK_MEDIA_CAPABILITIES,
      sendMediaBuffer: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "wechat-user",
      platform: "wechat",
      mediaItem: { type: "session_file", fileId: "sf_doc" },
    });

    expect(adapter.sendMediaBuffer).toHaveBeenCalledWith(
      "wechat-user",
      expect.any(Buffer),
      { mime: "application/pdf", filename: "report.pdf" },
    );
  });

  it("resolves session files with sessionPath so persisted sidecars can be hydrated", async () => {
    const filePath = makeTempFile("image.png", Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const getSessionFile = vi.fn((id, options) => {
      if (id !== "sf_image" || options?.sessionPath !== "/sessions/main.jsonl") return null;
      return {
        id: "sf_image",
        sessionPath: "/sessions/main.jsonl",
        filePath,
        realPath: filePath,
        filename: "image.png",
        mime: "image/png",
        kind: "image",
      };
    });
    const service = new MediaDeliveryService({ engine: { getSessionFile } });
    const adapter = {
      mediaCapabilities: TELEGRAM_MEDIA_CAPABILITIES,
      sendMediaBuffer: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "chat-1",
      platform: "telegram",
      mediaItem: { type: "session_file", fileId: "sf_image", sessionPath: "/sessions/main.jsonl" },
    });

    expect(getSessionFile).toHaveBeenCalledWith("sf_image", { sessionPath: "/sessions/main.jsonl" });
    expect(adapter.sendMediaBuffer).toHaveBeenCalledOnce();
  });

  it("delivers QQ images through public URL with original file metadata", async () => {
    const service = makeService({
      id: "sf_image",
      filename: "image.png",
      mime: "image/png",
      kind: "image",
      size: 4,
      publicUrl: "https://cdn.example.com/image.png",
    });
    const adapter = {
      mediaCapabilities: QQ_MEDIA_CAPABILITIES,
      sendMedia: vi.fn(async () => {}),
      sendMediaBuffer: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "chat-1",
      platform: "qq",
      mediaItem: { type: "session_file", fileId: "sf_image" },
    });

    expect(adapter.sendMedia).toHaveBeenCalledWith("chat-1", "https://cdn.example.com/image.png", {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
      size: 4,
    });
    expect(adapter.sendMediaBuffer).not.toHaveBeenCalled();
  });

  it("delivers QQ documents through public URL for C2C-capable adapters", async () => {
    const service = makeService({
      id: "sf_doc",
      filename: "note.txt",
      mime: "text/plain",
      kind: "document",
      size: 2,
      publicUrl: "https://cdn.example.com/note.txt",
    });
    const adapter = {
      mediaCapabilities: QQ_MEDIA_CAPABILITIES,
      sendMedia: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "chat-1",
      platform: "qq",
      mediaItem: { type: "session_file", fileId: "sf_doc" },
    });

    expect(adapter.sendMedia).toHaveBeenCalledWith("chat-1", "https://cdn.example.com/note.txt", {
      kind: "document",
      mime: "text/plain",
      filename: "note.txt",
      size: 2,
    });
  });

  it("passes bridge target scope metadata to URL-only adapters", async () => {
    const service = makeService({
      id: "sf_image",
      filename: "image.png",
      mime: "image/png",
      kind: "image",
      publicUrl: "https://cdn.example.com/image.png",
    });
    const adapter = {
      mediaCapabilities: QQ_MEDIA_CAPABILITIES,
      sendMedia: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "group-openid",
      platform: "qq",
      mediaItem: { type: "session_file", fileId: "sf_image" },
      isGroup: true,
    });

    expect(adapter.sendMedia).toHaveBeenCalledWith("group-openid", "https://cdn.example.com/image.png", {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
      isGroup: true,
      targetScope: "group",
    });
  });

  it("delivers QQ local images through direct local file upload", async () => {
    const filePath = makeTempFile("image.png", Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const service = makeService({
      id: "sf_image",
      filePath,
      realPath: filePath,
      filename: "image.png",
      mime: "image/png",
      kind: "image",
    });
    const adapter = {
      mediaCapabilities: QQ_MEDIA_CAPABILITIES,
      sendMedia: vi.fn(async () => {}),
      sendMediaFile: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "chat-1",
      platform: "qq",
      mediaItem: { type: "session_file", fileId: "sf_image" },
      isGroup: false,
    });

    expect(adapter.sendMedia).not.toHaveBeenCalled();
    expect(adapter.sendMediaFile).toHaveBeenCalledWith("chat-1", fs.realpathSync(filePath), {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
      isGroup: false,
      targetScope: "dm",
    });
    expect(debugLogMock.log).toHaveBeenCalledWith(
      "bridge",
      expect.stringContaining("mode=local_file"),
    );
  });

  it("keeps local-file delivery behind the allowed local roots", async () => {
    const { outsidePath } = makeTempFileOutsideAllowedRoots("secret.png", "not allowed");
    const service = makeService({
      id: "sf_image",
      filePath: outsidePath,
      realPath: outsidePath,
      filename: "secret.png",
      mime: "image/png",
      kind: "image",
    });
    const adapter = {
      mediaCapabilities: QQ_MEDIA_CAPABILITIES,
      sendMediaFile: vi.fn(async () => {}),
    };

    await expect(service.send({
      adapter,
      chatId: "chat-1",
      platform: "qq",
      mediaItem: { type: "session_file", fileId: "sf_image" },
    })).rejects.toThrow(/outside allowed roots/);
    expect(adapter.sendMediaFile).not.toHaveBeenCalled();
  });

  it("publishes local files before sending them to URL-only adapters", async () => {
    const filePath = makeTempFile("image.png", Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const mediaPublisher = {
      setBaseUrl: vi.fn(),
      publish: vi.fn(() => ({
        publicUrl: "https://hana.example.com/api/bridge/media/token_123",
        expiresAt: 61_000,
      })),
    };
    const service = makeService({
      id: "sf_image",
      filePath,
      realPath: filePath,
      filename: "image.png",
      mime: "image/png",
      kind: "image",
    }, { mediaPublisher });
    const adapter = {
      mediaCapabilities: {
        ...QQ_MEDIA_CAPABILITIES,
        inputModes: ["remote_url", "public_url"],
      },
      sendMedia: vi.fn(async () => {}),
      sendMediaBuffer: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "chat-1",
      platform: "qq",
      mediaItem: { type: "session_file", fileId: "sf_image" },
    });

    expect(mediaPublisher.publish).toHaveBeenCalledWith(expect.objectContaining({
      id: "sf_image",
      realPath: filePath,
    }));
    expect(mediaPublisher.setBaseUrl).toHaveBeenCalledOnce();
    expect(adapter.sendMedia).toHaveBeenCalledWith(
      "chat-1",
      "https://hana.example.com/api/bridge/media/token_123",
      {
        kind: "image",
        mime: "image/png",
        filename: "image.png",
      },
    );
    expect(adapter.sendMediaBuffer).not.toHaveBeenCalled();
  });

  it("explains URL-only fallback without implying every platform needs public URLs", async () => {
    const filePath = makeTempFile("image.png", Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const service = makeService({
      id: "sf_image",
      filePath,
      realPath: filePath,
      filename: "image.png",
      mime: "image/png",
      kind: "image",
    });
    const adapter = {
      mediaCapabilities: {
        platform: "url-only",
        inputModes: ["remote_url", "public_url"],
        supportedKinds: ["image", "document"],
        deliveryByKind: { image: "native_image", document: "native_file" },
      },
      sendMedia: vi.fn(async () => {}),
    };

    await expect(service.send({
      adapter,
      chatId: "chat-1",
      platform: "url-only",
      mediaItem: { type: "session_file", fileId: "sf_image" },
    })).rejects.toThrow(/只能走 public_url fallback/);
  });

  it("refreshes the publisher base URL from preferences before publishing local files for URL-only adapters", async () => {
    const filePath = makeTempFile("image.png", Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const mediaPublisher = {
      setBaseUrl: vi.fn(),
      publish: vi.fn(() => ({
        publicUrl: "https://new.example.com/api/bridge/media/token_123",
        expiresAt: 61_000,
      })),
    };
    const sessionFile = {
      id: "sf_image",
      filePath,
      realPath: filePath,
      filename: "image.png",
      mime: "image/png",
      kind: "image",
    };
    const service = new MediaDeliveryService({
      engine: {
        getBridgeMediaPublicBaseUrl: vi.fn(() => "https://new.example.com"),
        getSessionFile: vi.fn((id) => id === "sf_image" ? sessionFile : null),
      },
      mediaPublisher,
    });
    const adapter = {
      mediaCapabilities: {
        ...QQ_MEDIA_CAPABILITIES,
        inputModes: ["remote_url", "public_url"],
      },
      sendMedia: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "chat-1",
      platform: "qq",
      mediaItem: { type: "session_file", fileId: "sf_image" },
    });

    expect(mediaPublisher.setBaseUrl).toHaveBeenCalledWith("https://new.example.com");
    expect(adapter.sendMedia).toHaveBeenCalledWith(
      "chat-1",
      "https://new.example.com/api/bridge/media/token_123",
      expect.objectContaining({ filename: "image.png" }),
    );
  });
});
