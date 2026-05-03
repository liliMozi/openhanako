import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaDeliveryService } from "../lib/bridge/media-delivery-service.js";
import { setMediaLocalRoots } from "../lib/bridge/media-utils.js";
import { TELEGRAM_MEDIA_CAPABILITIES } from "../lib/bridge/telegram-adapter.js";
import { FEISHU_MEDIA_CAPABILITIES } from "../lib/bridge/feishu-adapter.js";
import { QQ_MEDIA_CAPABILITIES } from "../lib/bridge/qq-adapter.js";

describe("MediaDeliveryService", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeTempFile(name, content = "hello") {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-media-delivery-"));
    setMediaLocalRoots([tmpDir]);
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
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

  it("delivers QQ images through public URL only", async () => {
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
      sendMediaBuffer: vi.fn(async () => {}),
    };

    await service.send({
      adapter,
      chatId: "chat-1",
      platform: "qq",
      mediaItem: { type: "session_file", fileId: "sf_image" },
    });

    expect(adapter.sendMedia).toHaveBeenCalledWith("chat-1", "https://cdn.example.com/image.png");
    expect(adapter.sendMediaBuffer).not.toHaveBeenCalled();
  });

  it("rejects unsupported QQ documents before adapter calls", async () => {
    const service = makeService({
      id: "sf_doc",
      filename: "note.txt",
      mime: "text/plain",
      kind: "document",
      publicUrl: "https://cdn.example.com/note.txt",
    });
    const adapter = {
      mediaCapabilities: QQ_MEDIA_CAPABILITIES,
      sendMedia: vi.fn(async () => {}),
    };

    await expect(service.send({
      adapter,
      chatId: "chat-1",
      platform: "qq",
      mediaItem: { type: "session_file", fileId: "sf_doc" },
    })).rejects.toThrow(/qq.*document/i);
    expect(adapter.sendMedia).not.toHaveBeenCalled();
  });

  it("rejects QQ local images without public URL", async () => {
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
      sendMediaBuffer: vi.fn(async () => {}),
    };

    await expect(service.send({
      adapter,
      chatId: "chat-1",
      platform: "qq",
      mediaItem: { type: "session_file", fileId: "sf_image" },
    })).rejects.toThrow(/公网可访问 URL/);
    expect(adapter.sendMedia).not.toHaveBeenCalled();
    expect(adapter.sendMediaBuffer).not.toHaveBeenCalled();
  });

  it("publishes QQ local images before sending them as public URLs", async () => {
    const filePath = makeTempFile("image.png", Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const mediaPublisher = {
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

    expect(mediaPublisher.publish).toHaveBeenCalledWith(expect.objectContaining({
      id: "sf_image",
      realPath: filePath,
    }));
    expect(adapter.sendMedia).toHaveBeenCalledWith(
      "chat-1",
      "https://hana.example.com/api/bridge/media/token_123",
    );
    expect(adapter.sendMediaBuffer).not.toHaveBeenCalled();
  });
});
