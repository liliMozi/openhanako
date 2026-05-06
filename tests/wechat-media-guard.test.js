import { describe, it, expect } from "vitest";

describe("wechat media guard", () => {
  it("wechat adapter module exists", async () => {
    const fs = await import("node:fs");
    const adapterPath = new URL("../../../lib/bridge/wechat-adapter.js", import.meta.url);
    expect(fs.existsSync(adapterPath)).toBe(true);
  });
});
