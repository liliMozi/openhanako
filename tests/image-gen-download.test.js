import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const tmpDir = path.join(os.tmpdir(), "hana-test-imgdl-" + Date.now());

afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe("saveImage", () => {
  it("writes buffer to generated/ with correct filename pattern", async () => {
    const { saveImage } = await import("../plugins/image-gen/lib/download.js");
    const buf = Buffer.from("fake-png-data");
    const result = await saveImage(buf, "image/png", tmpDir);

    expect(result.filename).toMatch(/^\d+-[a-f0-9]{8}\.png$/);
    expect(result.filePath).toContain(path.join(tmpDir, "generated"));
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(fs.readFileSync(result.filePath)).toEqual(buf);
  });

  it("derives extension from mimeType", async () => {
    const { saveImage } = await import("../plugins/image-gen/lib/download.js");
    const buf = Buffer.from("fake-jpeg-data");
    const result = await saveImage(buf, "image/jpeg", tmpDir);
    expect(result.filename).toMatch(/\.jpg$/);
  });
});
