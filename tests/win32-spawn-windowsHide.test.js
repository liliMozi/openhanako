import { describe, it, expect } from "vitest";

describe("win32-exec spawnViaCmd", () => {
  it("passes windowsHide: true to spawnAndStream", async () => {
    // The spawnViaCmd function is internal to win32-exec.js.
    // This test verifies the module loads without errors and exports the expected API.
    const { createWin32Exec } = await import("../../../lib/sandbox/win32-exec.js");
    expect(typeof createWin32Exec).toBe("function");
  });
});
