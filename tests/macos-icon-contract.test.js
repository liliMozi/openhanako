import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

function readIcnsChunks(filePath) {
  const buf = fs.readFileSync(filePath);
  expect(buf.subarray(0, 4).toString("ascii")).toBe("icns");
  expect(buf.readUInt32BE(4)).toBe(buf.length);

  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const type = buf.subarray(offset, offset + 4).toString("ascii");
    const size = buf.readUInt32BE(offset + 4);
    const payload = buf.subarray(offset + 8, offset + size);
    chunks.push({
      type,
      size,
      pngWidth: payload.subarray(1, 4).toString("ascii") === "PNG" ? payload.readUInt32BE(16) : null,
      pngHeight: payload.subarray(1, 4).toString("ascii") === "PNG" ? payload.readUInt32BE(20) : null,
      pngColorType: payload.subarray(1, 4).toString("ascii") === "PNG" ? payload[25] : null,
    });
    offset += size;
  }

  expect(offset).toBe(buf.length);
  return chunks;
}

describe("macOS icon contract", () => {
  it("uses the app ICNS for macOS packaging", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));

    expect(pkg.build.mac.icon).toBe("desktop/src/icon.icns");
    expect(pkg.build.files).toContain("desktop/src/**/*.{html,icns,ico,png,svg,json}");
    expect(pkg.scripts["generate:macos-icon"]).toBe("node scripts/generate-macos-icon.cjs");
  });

  it("keeps Dock-friendly small icon representations", () => {
    const chunks = readIcnsChunks(path.join(ROOT, "desktop", "src", "icon.icns"));
    const byType = new Map(chunks.map((chunk) => [chunk.type, chunk]));

    for (const [type, size] of [
      ["icp4", 16],
      ["icp5", 32],
      ["icp6", 64],
      ["ic07", 128],
      ["ic08", 256],
      ["ic09", 512],
      ["ic10", 1024],
    ]) {
      const chunk = byType.get(type);
      expect(chunk).toBeTruthy();
      expect(chunk.pngWidth).toBe(size);
      expect(chunk.pngHeight).toBe(size);
      expect(chunk.pngColorType).toBe(6);
    }
  });
});
