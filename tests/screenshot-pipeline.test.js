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
});
