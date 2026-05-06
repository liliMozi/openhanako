import { describe, it, expect } from "vitest";

describe("tooltip truncated text", () => {
  it("SessionList component exists", async () => {
    const { default: SessionList } = await import("../../../desktop/src/react/components/SessionList.tsx");
    expect(SessionList).toBeDefined();
  });

  it("FloatPreviewCard component exists", async () => {
    const { default: FloatPreviewCard } = await import("../../../desktop/src/react/components/FloatPreviewCard.tsx");
    expect(FloatPreviewCard).toBeDefined();
  });
});
