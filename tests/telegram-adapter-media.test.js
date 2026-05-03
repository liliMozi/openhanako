import { beforeEach, describe, expect, it, vi } from "vitest";

const botInstances = [];

vi.mock("node-telegram-bot-api", () => {
  class MockTelegramBot {
    constructor() {
      this.on = vi.fn();
      this.removeAllListeners = vi.fn();
      this.stopPolling = vi.fn();
      this.sendMessage = vi.fn(async () => {});
      this.sendPhoto = vi.fn(async () => {});
      this.sendVideo = vi.fn(async () => {});
      this.sendAudio = vi.fn(async () => {});
      this.sendDocument = vi.fn(async () => {});
      this._request = vi.fn(async () => {});
      this.getMe = vi.fn(async () => ({ username: "hana" }));
      botInstances.push(this);
    }
  }
  return { default: MockTelegramBot };
});

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
}));

import { createTelegramAdapter } from "../lib/bridge/telegram-adapter.js";

describe("createTelegramAdapter media delivery", () => {
  beforeEach(() => {
    botInstances.length = 0;
  });

  function makeAdapter() {
    const adapter = createTelegramAdapter({
      token: "tg-token",
      agentId: "hana",
      onMessage: vi.fn(),
    });
    return { adapter, bot: botInstances[0] };
  }

  it.each([
    ["image/png", "image.png", "sendPhoto"],
    ["video/mp4", "video.mp4", "sendVideo"],
    ["audio/mpeg", "audio.mp3", "sendAudio"],
    ["text/plain", "note.txt", "sendDocument"],
  ])("sends local %s buffers through the documented Telegram method", async (mime, filename, method) => {
    const { adapter, bot } = makeAdapter();
    const buffer = Buffer.from("file");

    await adapter.sendMediaBuffer("chat-1", buffer, { mime, filename });

    expect(bot[method]).toHaveBeenCalledWith(
      "chat-1",
      buffer,
      {},
      { filename, contentType: mime },
    );
    adapter.stop();
  });

  it.each([
    ["https://example.com/image.png", "sendPhoto"],
    ["https://example.com/video.mp4", "sendVideo"],
    ["https://example.com/audio.mp3", "sendAudio"],
    ["https://example.com/archive.zip", "sendDocument"],
  ])("routes remote URL %s by extension", async (url, method) => {
    const { adapter, bot } = makeAdapter();

    await adapter.sendMedia("chat-1", url);

    expect(bot[method]).toHaveBeenCalledWith("chat-1", url);
    adapter.stop();
  });

  it("declares Telegram draft streaming and sends required draft metadata", async () => {
    const { adapter, bot } = makeAdapter();

    expect(adapter.streamingCapabilities).toMatchObject({
      mode: "draft",
      scopes: ["dm"],
      maxChars: 4096,
    });

    await adapter.sendDraft("chat-1", "streaming text", {
      draftId: 12345,
      messageThreadId: 67890,
    });

    expect(bot._request).toHaveBeenCalledWith("sendMessageDraft", {
      form: {
        chat_id: "chat-1",
        draft_id: 12345,
        message_thread_id: 67890,
        text: "streaming text",
      },
    });
    adapter.stop();
  });
});
