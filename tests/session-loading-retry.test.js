import { describe, it, expect } from "vitest";

describe("session loading retry", () => {
  it("session-actions module exists", async () => {
    const fs = await import("node:fs");
    const actionsPath = new URL("../../../desktop/src/react/stores/session-actions.ts", import.meta.url);
    expect(fs.existsSync(actionsPath)).toBe(true);
  });
});
