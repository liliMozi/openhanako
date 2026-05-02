import { describe, it, expect, vi } from "vitest";

import { submitDesktopSessionMessage } from "../core/desktop-session-submit.js";

function makeFakeSession({ replyText = "desktop reply", toolMedia = [] } = {}) {
  const subs = [];
  return {
    subscribe: (fn) => {
      subs.push(fn);
      return () => {
        const idx = subs.indexOf(fn);
        if (idx >= 0) subs.splice(idx, 1);
      };
    },
    prompt: vi.fn(async () => {
      for (const fn of subs) {
        fn({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: replyText } });
        for (const url of toolMedia) {
          fn({
            type: "tool_execution_end",
            isError: false,
            result: { details: { media: { mediaUrls: [url] } } },
          });
        }
      }
    }),
    model: null,
  };
}

describe("submitDesktopSessionMessage", () => {
  it("emits a session-scoped user message, toggles streaming status, and returns captured assistant output", async () => {
    const session = makeFakeSession({
      replyText: "desktop reply",
      toolMedia: ["https://example.com/a.png"],
    });
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };
    const onDelta = vi.fn();

    const result = await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello from bridge",
      displayMessage: { text: "hello from bridge" },
      uiContext: null,
      onDelta,
    });

    expect(engine.ensureSessionLoaded).toHaveBeenCalledWith("/tmp/desk.jsonl");
    expect(engine.setUiContext).toHaveBeenCalledWith("/tmp/desk.jsonl", null);
    expect(engine.emitEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "session_status", isStreaming: true }),
      "/tmp/desk.jsonl",
    );
    expect(engine.emitEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "session_user_message",
        message: expect.objectContaining({ text: "hello from bridge" }),
      }),
      "/tmp/desk.jsonl",
    );
    expect(engine.promptSession).toHaveBeenCalledWith("/tmp/desk.jsonl", "hello from bridge", undefined);
    expect(onDelta).toHaveBeenCalledWith("desktop reply", "desktop reply");
    expect(engine.emitEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "session_status", isStreaming: false }),
      "/tmp/desk.jsonl",
    );
    expect(result).toEqual({
      text: "desktop reply",
      toolMedia: ["https://example.com/a.png"],
    });
  });

  it("still emits session_status=false when promptSession throws", async () => {
    const session = makeFakeSession();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async () => {
        throw new Error("boom");
      }),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    await expect(submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello",
      displayMessage: { text: "hello" },
    })).rejects.toThrow("boom");

    expect(engine.emitEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "session_status", isStreaming: true }),
      "/tmp/desk.jsonl",
    );
    expect(engine.emitEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "session_status", isStreaming: false }),
      "/tmp/desk.jsonl",
    );
  });

  it("forwards image attachment paths to promptSession", async () => {
    const session = makeFakeSession();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "see image",
      images: [{ type: "image", data: "BASE64", mimeType: "image/png" }],
      imageAttachmentPaths: ["/tmp/upload.png"],
      displayMessage: { text: "see image" },
    });

    expect(engine.promptSession).toHaveBeenCalledWith(
      "/tmp/desk.jsonl",
      "see image",
      {
        images: [{ type: "image", data: "BASE64", mimeType: "image/png" }],
        imageAttachmentPaths: ["/tmp/upload.png"],
      },
    );
  });
});
