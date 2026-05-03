import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ws", () => {
  class MockWebSocket {
    static OPEN = 1;
    readyState = 0;
    on() {}
    send() {}
    close() {}
  }
  return { default: MockWebSocket };
});

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
}));

import { createQQAdapter } from "../lib/bridge/qq-adapter.js";

function jsonResponse(body) {
  return {
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("createQQAdapter media delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("/app/getAppAccessToken")) {
        return jsonResponse({ access_token: "qq-token", expires_in: 7200 });
      }
      if (href.endsWith("/gateway")) {
        return jsonResponse({ url: "ws://localhost/qq" });
      }
      if (href.includes("/files")) {
        return jsonResponse({ file_info: "file-info" });
      }
      return jsonResponse({});
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects local buffer media with an explicit unsupported error", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    });

    await expect(
      adapter.sendMediaBuffer("chat-1", Buffer.from("png"), {
        mime: "image/png",
        filename: "image.png",
      }),
    ).rejects.toThrow(/QQ.*本地.*公网可访问 URL/);

    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/files"),
      expect.anything(),
    );
    adapter.stop();
  });
});
