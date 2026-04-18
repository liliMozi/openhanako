import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readImageSize } from "../lib/image-size.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MINI_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de" +
  "0000000c4944415408d76360000000000400014427a6b00000000049454e44ae426082",
  "hex"
);

describe("readImageSize", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "imgsize-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("reads PNG dimensions", async () => {
    const f = join(tmpDir, "test.png");
    writeFileSync(f, MINI_PNG);
    const size = await readImageSize(f);
    expect(size).toEqual({ width: 1, height: 1 });
  });

  it("returns null for video files", async () => {
    const f = join(tmpDir, "test.mp4");
    writeFileSync(f, Buffer.alloc(32));
    expect(await readImageSize(f)).toBeNull();
  });

  it("returns null for missing files", async () => {
    expect(await readImageSize(join(tmpDir, "nope.png"))).toBeNull();
  });
});
