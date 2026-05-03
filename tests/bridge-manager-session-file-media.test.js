import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge/telegram-adapter.js", () => ({ createTelegramAdapter: vi.fn() }));
vi.mock("../lib/bridge/feishu-adapter.js", () => ({ createFeishuAdapter: vi.fn() }));
vi.mock("../lib/bridge/qq-adapter.js", () => ({ createQQAdapter: vi.fn() }));
vi.mock("../lib/bridge/wechat-adapter.js", () => ({ createWechatAdapter: vi.fn() }));
vi.mock("../lib/debug-log.js", () => ({ debugLog: () => null }));

import { BridgeManager } from "../lib/bridge/bridge-manager.js";

const TELEGRAM_CAPS = {
  inputModes: ["buffer", "remote_url", "public_url"],
  supportedKinds: ["image", "video", "audio", "document"],
};
const QQ_CAPS = {
  inputModes: ["remote_url", "public_url"],
  supportedKinds: ["image", "video", "audio"],
};

describe("BridgeManager session_file media delivery", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeManager(sessionFile) {
    if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-media-"));
    const engine = {
      hanakoHome: tmpDir,
      agent: null,
      getSessionFile: vi.fn((id) => id === sessionFile?.id ? sessionFile : null),
    };
    const hub = { eventBus: { emit: vi.fn() } };
    return new BridgeManager({ engine, hub });
  }

  it("sends a session_file through sendMediaBuffer on buffer-capable platforms", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-media-"));
    const filePath = path.join(tmpDir, "image.png");
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]));
    const sessionFile = {
      id: "sf_image",
      filePath,
      realPath: filePath,
      filename: "image.png",
      mime: "image/png",
      kind: "image",
    };
    const bm = makeManager(sessionFile);
    const adapter = {
      mediaCapabilities: TELEGRAM_CAPS,
      sendMediaBuffer: vi.fn().mockResolvedValue(),
      sendMedia: vi.fn().mockResolvedValue(),
    };

    await bm._sendMediaItem(adapter, "chat-1", { type: "session_file", fileId: "sf_image" }, { platform: "telegram" });

    expect(adapter.sendMediaBuffer).toHaveBeenCalledOnce();
    expect(adapter.sendMediaBuffer.mock.calls[0][0]).toBe("chat-1");
    expect(Buffer.isBuffer(adapter.sendMediaBuffer.mock.calls[0][1])).toBe(true);
    expect(adapter.sendMediaBuffer.mock.calls[0][2]).toEqual({
      mime: "image/png",
      filename: "image.png",
    });
    expect(adapter.sendMedia).not.toHaveBeenCalled();
  });

  it("requires a public URL for QQ local staged files", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-media-"));
    const filePath = path.join(tmpDir, "image.png");
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const bm = makeManager({
      id: "sf_image",
      filePath,
      realPath: filePath,
      filename: "image.png",
      mime: "image/png",
      kind: "image",
    });
    const adapter = {
      mediaCapabilities: QQ_CAPS,
      sendMediaBuffer: vi.fn().mockResolvedValue(),
      sendMedia: vi.fn().mockResolvedValue(),
    };

    await expect(
      bm._sendMediaItem(adapter, "chat-1", { type: "session_file", fileId: "sf_image" }, { platform: "qq" }),
    ).rejects.toThrow(/公网可访问 URL/);
    expect(adapter.sendMediaBuffer).not.toHaveBeenCalled();
    expect(adapter.sendMedia).not.toHaveBeenCalled();
  });

  it("sends QQ staged images through publicUrl when available", async () => {
    const bm = makeManager({
      id: "sf_public",
      filename: "image.png",
      mime: "image/png",
      kind: "image",
      publicUrl: "https://cdn.example.com/image.png",
    });
    const adapter = {
      mediaCapabilities: QQ_CAPS,
      sendMediaBuffer: vi.fn().mockResolvedValue(),
      sendMedia: vi.fn().mockResolvedValue(),
    };

    await bm._sendMediaItem(adapter, "chat-1", { type: "session_file", fileId: "sf_public" }, { platform: "qq" });

    expect(adapter.sendMedia).toHaveBeenCalledWith("chat-1", "https://cdn.example.com/image.png");
    expect(adapter.sendMediaBuffer).not.toHaveBeenCalled();
  });
});
