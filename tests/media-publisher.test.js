import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { MediaPublisher } from "../lib/bridge/media-publisher.js";

describe("MediaPublisher", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeFile(name = "image.png") {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-media-publisher-"));
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, "hello");
    return filePath;
  }

  it("publishes registered session files as tokenized expiring public URLs", () => {
    const filePath = makeFile();
    const publisher = new MediaPublisher({
      baseUrl: "https://hana.example.com",
      allowedRoots: [tmpDir],
      ttlMs: 60_000,
      now: () => 1000,
      randomToken: () => "token_123",
    });

    const result = publisher.publish({
      id: "sf_1",
      filePath,
      realPath: fs.realpathSync(filePath),
      filename: "image.png",
      mime: "image/png",
      size: 5,
    });

    expect(result.publicUrl).toBe("https://hana.example.com/api/bridge/media/token_123");
    expect(result.expiresAt).toBe(61_000);
    expect(publisher.resolve("token_123")).toEqual(expect.objectContaining({
      fileId: "sf_1",
      realPath: fs.realpathSync(filePath),
      filename: "image.png",
      mime: "image/png",
      expiresAt: 61_000,
    }));
  });

  it("refuses to publish when no public base URL is configured", () => {
    const filePath = makeFile();
    const publisher = new MediaPublisher({
      allowedRoots: [tmpDir],
      randomToken: () => "token_123",
    });

    expect(() => publisher.publish({
      id: "sf_1",
      filePath,
      realPath: fs.realpathSync(filePath),
      filename: "image.png",
      mime: "image/png",
    })).toThrow(/public media base URL/);
  });

  it("refuses files outside allowed roots", () => {
    const filePath = makeFile();
    const publisher = new MediaPublisher({
      baseUrl: "https://hana.example.com",
      allowedRoots: [path.join(tmpDir, "other")],
      randomToken: () => "token_123",
    });

    expect(() => publisher.publish({
      id: "sf_1",
      filePath,
      realPath: fs.realpathSync(filePath),
      filename: "image.png",
      mime: "image/png",
    })).toThrow(/outside allowed roots/);
  });

  it("refuses filesystem roots as allowed roots", () => {
    const root = path.parse(os.tmpdir()).root;

    expect(() => new MediaPublisher({
      baseUrl: "https://hana.example.com",
      allowedRoots: [root],
      randomToken: () => "token_123",
    })).toThrow(/filesystem root/);
  });

  it("expires tokens", () => {
    const filePath = makeFile();
    let now = 1000;
    const publisher = new MediaPublisher({
      baseUrl: "https://hana.example.com",
      allowedRoots: [tmpDir],
      ttlMs: 10,
      now: () => now,
      randomToken: () => "token_123",
    });

    publisher.publish({
      id: "sf_1",
      filePath,
      realPath: fs.realpathSync(filePath),
      filename: "image.png",
      mime: "image/png",
    });
    now = 1011;

    expect(publisher.resolve("token_123")).toBeNull();
  });

  it("expires tokens after the configured download count", () => {
    const filePath = makeFile();
    const publisher = new MediaPublisher({
      baseUrl: "https://hana.example.com",
      allowedRoots: [tmpDir],
      maxDownloads: 2,
      randomToken: () => "token_123",
    });

    publisher.publish({
      id: "sf_1",
      filePath,
      realPath: fs.realpathSync(filePath),
      filename: "image.png",
      mime: "image/png",
    });

    expect(publisher.resolve("token_123")).toEqual(expect.objectContaining({ fileId: "sf_1" }));
    expect(publisher.resolve("token_123")).toEqual(expect.objectContaining({ fileId: "sf_1" }));
    expect(publisher.resolve("token_123")).toBeNull();
  });
});
