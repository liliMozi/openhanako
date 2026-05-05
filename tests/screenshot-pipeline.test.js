import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("screenshot pipeline", () => {
  it("keeps long screenshot stitching in the main process", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    const files = packageJson.build?.files || [];

    expect(mainSource).not.toContain("screenshot-stitch-worker");
    expect(mainSource).not.toContain("runScreenshotStitchWorker");
    expect(files).not.toContain("desktop/screenshot-stitch-worker.cjs");
  });

  it("pins offscreen screenshots to an explicit 2x scale", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).toMatch(/webPreferences:\s*{\s*offscreen:\s*{\s*deviceScaleFactor:\s*2\s*}/);
    expect(mainSource).not.toMatch(/offscreen:\s*true,\s*deviceScaleFactor:\s*2/);
  });

  it("captures explicit screenshot bounds instead of the whole visible page", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).toContain("capturePage({ x: 0, y: 0, width, height: totalHeight }");
    expect(mainSource).toContain("capturePage({ x: 0, y: 0, width, height: segH }");
  });

  it("keeps long screenshot bitmap stitching scale-aware", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).toContain("image.toPNG({ scaleFactor: scale })");
    expect(mainSource).toContain("seg.toBitmap({ scaleFactor: scale })");
    expect(mainSource).toContain("bitmap.length % partRowBytes");
  });

  it("paints a deterministic page background before PNG export", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).toContain("backgroundColor:");
    expect(mainSource).toContain("--screenshot-page-bg");
    expect(mainSource).toContain("background: var(--screenshot-page-bg)");
  });

  it("uses the current app icon for the screenshot watermark", () => {
    const mainSource = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(mainSource).toContain('path.join(__dirname, "src", "icon.png")');
    expect(mainSource).not.toContain('path.join(__dirname, "src", "assets", "Hanako.png")');
  });
});
