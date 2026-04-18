import { describe, expect, it } from "vitest";
import { getPlatformPromptNote } from "../core/platform-prompt.js";

describe("getPlatformPromptNote", () => {
  it("returns Windows guidance only on win32", () => {
    expect(getPlatformPromptNote({ platform: "win32", isZh: true })).toContain("Windows");
    expect(getPlatformPromptNote({ platform: "darwin", isZh: true })).toBe("");
    expect(getPlatformPromptNote({ platform: "linux", isZh: false })).toBe("");
  });
});
