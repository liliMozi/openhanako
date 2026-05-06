import { describe, expect, it } from "vitest";
import {
  modelSupportsXhigh,
  normalizeThinkingLevelForModel,
  resolveThinkingLevelForModel,
} from "../core/session-thinking-level.js";

describe("session thinking level", () => {
  it("downgrades xhigh while a restored session has not resolved its model yet", () => {
    expect(modelSupportsXhigh(null)).toBe(false);
    expect(normalizeThinkingLevelForModel("xhigh", null)).toBe("high");
    expect(resolveThinkingLevelForModel("xhigh", null)).toBe("high");
  });

  it("keeps xhigh for models that explicitly support it", () => {
    const model = { id: "deepseek-v4-pro", provider: "deepseek", xhigh: true };

    expect(modelSupportsXhigh(model)).toBe(true);
    expect(normalizeThinkingLevelForModel("xhigh", model)).toBe("xhigh");
  });
});
