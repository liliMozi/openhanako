import { describe, it, expect, vi } from "vitest";

import { submitDesktopSessionMessage } from "../core/desktop-session-submit.js";
import fs from "fs";
import os from "os";
import path from "path";

function makeFakeSession({ replyText = "desktop reply", toolMedia = [], toolMediaDetails = null } = {}) {
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
        if (toolMediaDetails) {
          fn({
            type: "tool_execution_end",
            isError: false,
            result: { details: { media: toolMediaDetails } },
          });
        }
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
      toolMedia: [{ type: "remote_url", url: "https://example.com/a.png" }],
    });
  });

  it("prefers structured tool media items over legacy mediaUrls", async () => {
    const item = { type: "session_file", fileId: "sf_1", filePath: "/tmp/a.png" };
    const session = makeFakeSession({
      replyText: "desktop reply",
      toolMediaDetails: { items: [item], mediaUrls: ["/tmp/a.png"] },
    });
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    const result = await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/desk.jsonl",
      text: "hello",
      displayMessage: { text: "hello" },
    });

    expect(result.toolMedia).toEqual([item]);
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
      "[attached_image: /tmp/upload.png]\nsee image",
      {
        images: [{ type: "image", data: "BASE64", mimeType: "image/png" }],
        imageAttachmentPaths: ["/tmp/upload.png"],
      },
    );
  });

  it("registers desktop display attachments into the session file ledger", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-display-attachment-"));
    try {
      const filePath = path.join(tmpDir, "desk.png");
      fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const session = makeFakeSession();
      const sessionPath = path.join(tmpDir, "main.jsonl");
      fs.writeFileSync(sessionPath, "{}\n");
      const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
        id: "sf_desktop_attachment",
        fileId: "sf_desktop_attachment",
        sessionPath,
        filePath,
        realPath: filePath,
        displayName: label,
        filename: path.basename(filePath),
        label,
        ext: "png",
        mime: "image/png",
        size: 4,
        kind: "image",
        origin,
        storageKind,
        createdAt: 1,
      }));
      const engine = {
        hanakoHome: tmpDir,
        registerSessionFile,
        ensureSessionLoaded: vi.fn(async () => session),
        promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
        emitEvent: vi.fn(),
        setUiContext: vi.fn(),
      };

      await submitDesktopSessionMessage(engine, {
        sessionPath,
        text: "local file",
        images: [{ type: "image", data: "BASE64", mimeType: "image/png" }],
        displayMessage: {
          text: "local file",
          attachments: [{
            path: filePath,
            name: "desk.png",
            isDir: false,
            base64Data: "BASE64",
            mimeType: "image/png",
          }],
        },
      });

      expect(registerSessionFile).toHaveBeenCalledWith({
        sessionPath,
        filePath,
        label: "desk.png",
        origin: "user_attachment",
        storageKind: "external",
      });
      expect(engine.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "session_user_message",
          message: expect.objectContaining({
            attachments: [expect.objectContaining({
              fileId: "sf_desktop_attachment",
              path: filePath,
            })],
          }),
        }),
        sessionPath,
      );
      const emittedAttachment = engine.emitEvent.mock.calls
        .find(([event]) => event.type === "session_user_message")?.[0].message.attachments[0];
      expect(emittedAttachment).not.toHaveProperty("base64Data");
      expect(engine.promptSession).toHaveBeenCalledWith(
        sessionPath,
        `[attached_image: ${filePath}]\nlocal file`,
        expect.objectContaining({
          imageAttachmentPaths: [filePath],
        }),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("registers bridge inbound files for desktop /rc target sessions", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-desktop-inbound-"));
    try {
      const session = makeFakeSession();
      const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", "main.jsonl");
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, "{}\n");
      const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
        id: "sf_rc_inbound",
        fileId: "sf_rc_inbound",
        sessionPath,
        filePath,
        realPath: filePath,
        displayName: label,
        filename: path.basename(filePath),
        label,
        ext: "png",
        mime: "image/png",
        size: 4,
        kind: "image",
        origin,
        storageKind,
        createdAt: 1,
      }));
      const engine = {
        hanakoHome: tmpDir,
        registerSessionFile,
        ensureSessionLoaded: vi.fn(async () => session),
        promptSession: vi.fn(async (sessionPath, text, opts) => session.prompt(text, opts)),
        emitEvent: vi.fn(),
        setUiContext: vi.fn(),
      };

      await submitDesktopSessionMessage(engine, {
        sessionPath,
        text: "see bridge image",
        images: [{ type: "image", data: "BASE64", mimeType: "image/png" }],
        inboundFiles: [{
          type: "image",
          filename: "bridge.png",
          mimeType: "image/png",
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        }],
        displayMessage: { text: "see bridge image" },
      });

      const savedPath = registerSessionFile.mock.calls[0][0].filePath;
      expect(registerSessionFile).toHaveBeenCalledWith({
        sessionPath,
        filePath: expect.stringContaining(path.join(tmpDir, "session-files")),
        label: "bridge.png",
        origin: "bridge_inbound",
        storageKind: "managed_cache",
      });
      expect(engine.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "session_user_message",
          message: expect.objectContaining({
            attachments: [expect.objectContaining({ fileId: "sf_rc_inbound", path: savedPath })],
          }),
        }),
        sessionPath,
      );
      expect(engine.promptSession).toHaveBeenCalledWith(
        sessionPath,
        `[attached_image: ${savedPath}]\nsee bridge image`,
        expect.objectContaining({
          imageAttachmentPaths: [savedPath],
        }),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
