import { describe, it, expect } from "vitest";

describe("image size locale", () => {
  it("locale files mention 10MB", async () => {
    const fs = await import("node:fs");
    const enJson = JSON.parse(fs.readFileSync(new URL("../../../desktop/src/locales/en.json", import.meta.url), "utf-8"));
    expect(enJson.error.imageTooLarge).toContain("10MB");
  });
});
