import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeBridgeInboundFiles } from "../lib/session-files/bridge-inbound-files.js";

describe("materializeBridgeInboundFiles", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("stores bridge inbound bytes in session cache and registers session files", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-bridge-inbound-"));
    const sessionPath = path.join(tmpDir, "agents", "hana", "sessions", "main.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n");
    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
      id: "sf_inbound",
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

    const result = await materializeBridgeInboundFiles({
      hanakoHome: tmpDir,
      sessionPath,
      registerSessionFile,
      files: [{
        type: "image",
        filename: "photo.png",
        mimeType: "image/png",
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      }],
    });

    expect(registerSessionFile).toHaveBeenCalledWith({
      sessionPath,
      filePath: expect.stringContaining(path.join(tmpDir, "session-files")),
      label: "photo.png",
      origin: "bridge_inbound",
      storageKind: "managed_cache",
    });
    const savedPath = registerSessionFile.mock.calls[0][0].filePath;
    expect(fs.existsSync(savedPath)).toBe(true);
    expect(fs.readFileSync(savedPath)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(result.sessionFiles).toEqual([expect.objectContaining({
      fileId: "sf_inbound",
      origin: "bridge_inbound",
      storageKind: "managed_cache",
    })]);
    expect(result.imageAttachmentPaths).toEqual([savedPath]);
    expect(result.displayAttachments).toEqual([expect.objectContaining({
      fileId: "sf_inbound",
      path: savedPath,
      name: "photo.png",
      mimeType: "image/png",
    })]);
  });
});
