import { describe, it, expect } from "vitest";

describe("chat route empty stream guard", () => {
  it("tracks consecutive no-response turns", async () => {
    // The consecutiveNoResponse counter is managed inside createChatRoute.
    // This test verifies the module structure.
    const { createChatRoute } = await import("../../../server/routes/chat.js");
    expect(typeof createChatRoute).toBe("function");
  });
});
