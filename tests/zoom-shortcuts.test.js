import { describe, it, expect } from "vitest";

describe("zoom shortcuts", () => {
  it("main.cjs module exists", async () => {
    const fs = await import("node:fs");
    const mainPath = new URL("../../../desktop/main.cjs", import.meta.url);
    expect(fs.existsSync(mainPath)).toBe(true);
  });
});
