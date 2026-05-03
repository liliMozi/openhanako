import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { createBridgeRoute } from "../server/routes/bridge.js";

describe("bridge send-media route", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeApp({ bridgeManagerOverrides = {} } = {}) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-route-"));
    const hanakoHome = path.join(tmpDir, "hana-home");
    const sessionDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(hanakoHome, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });

    const agent = {
      id: "hana",
      sessionDir,
      config: { bridge: {} },
      deskManager: { homePath: hanakoHome },
    };
    const engine = {
      hanakoHome,
      currentAgentId: "hana",
      getAgent: vi.fn((id) => id === "hana" ? agent : null),
      registerSessionFile: vi.fn(({ sessionPath, filePath, label, origin }) => ({
        id: "sf_route",
        sessionPath,
        filePath,
        realPath: filePath,
        filename: label,
        label,
        origin,
        kind: "document",
        mime: "text/plain",
        size: 2,
      })),
      getBridgeReadOnly: vi.fn(() => false),
      getBridgeReceiptEnabled: vi.fn(() => true),
      getBridgeIndex: vi.fn(() => ({})),
    };
    const bridgeManager = {
      getStatus: vi.fn(() => ({})),
      getMessages: vi.fn(() => []),
      sendMediaItem: vi.fn(async () => {}),
      stopPlatform: vi.fn(),
      startPlatformFromConfig: vi.fn(),
      ...bridgeManagerOverrides,
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, bridgeManager));
    return { app, engine, bridgeManager, hanakoHome };
  }

  it("registers the local file as a session_file before bridge delivery", async () => {
    const { app, engine, bridgeManager, hanakoHome } = makeApp();
    const filePath = path.join(hanakoHome, "out.txt");
    fs.writeFileSync(filePath, "ok");

    const res = await app.request("/api/bridge/send-media?agentId=hana", {
      method: "POST",
      body: JSON.stringify({
        platform: "telegram",
        chatId: "chat-1",
        filePath,
      }),
      headers: { "content-type": "application/json" },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, fileId: "sf_route" });
    expect(engine.registerSessionFile).toHaveBeenCalledWith({
      sessionPath: "bridge:hana:telegram:chat-1",
      filePath: fs.realpathSync(filePath),
      label: "out.txt",
      origin: "bridge_manual_send",
    });
    expect(bridgeManager.sendMediaItem).toHaveBeenCalledWith(
      "telegram",
      "chat-1",
      { type: "session_file", fileId: "sf_route", sessionPath: "bridge:hana:telegram:chat-1" },
      "hana",
    );
  });

  it("returns explicit JSON errors from unsupported platform delivery", async () => {
    const deliveryError = new Error("QQ 发送本地文件需要公网可访问 URL");
    const { app, hanakoHome } = makeApp({
      bridgeManagerOverrides: {
        sendMediaItem: vi.fn(async () => {
          throw deliveryError;
        }),
      },
    });
    const filePath = path.join(hanakoHome, "out.txt");
    fs.writeFileSync(filePath, "ok");

    const res = await app.request("/api/bridge/send-media?agentId=hana", {
      method: "POST",
      body: JSON.stringify({
        platform: "qq",
        chatId: "chat-1",
        filePath,
      }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "QQ 发送本地文件需要公网可访问 URL",
    });
  });

  it("serves tokenized bridge media files from the media publisher", async () => {
    const { app, hanakoHome } = makeApp({
      bridgeManagerOverrides: {
        mediaPublisher: {
          resolve: vi.fn((token) => token === "token_123" ? {
            realPath: path.join(hanakoHome, "published.txt"),
            filename: "published.txt",
            mime: "text/plain",
            size: 5,
            expiresAt: Date.now() + 60_000,
          } : null),
        },
      },
    });
    const filePath = path.join(hanakoHome, "published.txt");
    fs.writeFileSync(filePath, "hello");

    const res = await app.request("/api/bridge/media/token_123");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-disposition")).toContain("attachment;");
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''published.txt");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.text()).resolves.toBe("hello");
  });

  it("serves images inline for platform media fetches", async () => {
    const { app, hanakoHome } = makeApp({
      bridgeManagerOverrides: {
        mediaPublisher: {
          resolve: vi.fn((token) => token === "token_123" ? {
            realPath: path.join(hanakoHome, "published.png"),
            filename: "published.png",
            mime: "image/png",
            size: 4,
            expiresAt: Date.now() + 60_000,
          } : null),
        },
      },
    });
    const filePath = path.join(hanakoHome, "published.png");
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4E, 0x47]));

    const res = await app.request("/api/bridge/media/token_123");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("inline;");
    await expect(res.arrayBuffer()).resolves.toHaveProperty("byteLength", 4);
  });

  it("does not echo missing media tokens in the 404 body", async () => {
    const { app } = makeApp({
      bridgeManagerOverrides: {
        mediaPublisher: { resolve: vi.fn(() => null) },
      },
    });

    const res = await app.request("/api/bridge/media/secret_token_123");

    expect(res.status).toBe(404);
    await expect(res.text()).resolves.toBe("media not found");
  });
});
