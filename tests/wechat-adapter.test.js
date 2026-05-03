import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
}));

import { createWechatAdapter } from "../lib/bridge/wechat-adapter.js";

function jsonResponse(body) {
  return {
    ok: true,
    text: async () => JSON.stringify(body),
  };
}

function cdnUploadResponse(downloadParam = "download-param") {
  return {
    ok: true,
    headers: new Headers({ "x-encrypted-param": downloadParam }),
  };
}

describe("createWechatAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not report connected until the first getupdates call succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ret: 0, msgs: [], get_updates_buf: "buf-1" }))
      .mockImplementationOnce(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    const onStatus = vi.fn();
    const adapter = createWechatAdapter({
      botToken: "wx-token",
      agentId: "hana",
      onMessage: vi.fn(),
      onStatus,
    });

    expect(onStatus).not.toHaveBeenCalledWith("connected");
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("connected"));

    adapter.stop();
  });

  it("reports error after repeated poll failures", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const onStatus = vi.fn();
    const adapter = createWechatAdapter({
      botToken: "wx-token",
      agentId: "hana",
      onMessage: vi.fn(),
      onStatus,
    });

    await vi.advanceTimersByTimeAsync(8_000);

    expect(onStatus).toHaveBeenCalledWith("error", expect.stringContaining("network down"));
    adapter.stop();
  });

  it.each([
    ["image/png", "image.png", 2, "image_item"],
    ["text/plain", "note.txt", 4, "file_item"],
  ])("uploads %s buffers and sends the matching iLink message item", async (mime, filename, itemType, itemKey) => {
    let getUpdatesCount = 0;
    const fetchMock = vi.fn(async (url, options = {}) => {
      const requestUrl = String(url);
      if (requestUrl.includes("ilink/bot/getupdates")) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return jsonResponse({
            ret: 0,
            get_updates_buf: "buf-1",
            msgs: [{
              from_user_id: "user-1",
              context_token: "ctx-1",
              item_list: [{ type: 1, text_item: { text: "hi" } }],
            }],
          });
        }
        return new Promise(() => {});
      }
      if (requestUrl.includes("ilink/bot/getuploadurl")) {
        return jsonResponse({ ret: 0, upload_param: "upload-param" });
      }
      if (requestUrl.includes("/c2c/upload")) {
        return cdnUploadResponse();
      }
      if (requestUrl.includes("ilink/bot/sendmessage")) {
        return jsonResponse({ ret: 0 });
      }
      throw new Error(`unexpected fetch: ${requestUrl} ${options.method || "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onMessage = vi.fn();
    const adapter = createWechatAdapter({
      botToken: "wx-token",
      agentId: "hana",
      onMessage,
      onStatus: vi.fn(),
    });

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    expect(adapter.canReply("user-1")).toBe(true);

    await adapter.sendMediaBuffer("user-1", Buffer.from("file"), { mime, filename });

    const sendMessageCall = fetchMock.mock.calls.find(([url]) => String(url).includes("ilink/bot/sendmessage"));
    expect(sendMessageCall).toBeTruthy();
    const payload = JSON.parse(sendMessageCall[1].body);
    const item = payload.msg.item_list[0];
    expect(payload.msg.context_token).toBe("ctx-1");
    expect(item.type).toBe(itemType);
    expect(item[itemKey]).toBeTruthy();
    if (itemKey === "file_item") {
      expect(item.file_item.file_name).toBe(filename);
    }

    adapter.stop();
  });
});
