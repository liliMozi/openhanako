import { describe, expect, it } from "vitest";
import { getPlatformPromptNote } from "../core/platform-prompt.js";

const baseOpts = { osType: "TestOS", osRelease: "1.2.3" };

describe("getPlatformPromptNote", () => {
  it("emits Platform/Shell/OS Version on darwin", () => {
    const out = getPlatformPromptNote({ ...baseOpts, platform: "darwin" });
    expect(out).toBe("Platform: darwin\nShell: bash\nOS Version: TestOS 1.2.3");
  });

  it("emits Platform/Shell/OS Version on linux", () => {
    const out = getPlatformPromptNote({ ...baseOpts, platform: "linux" });
    expect(out).toBe("Platform: linux\nShell: bash\nOS Version: TestOS 1.2.3");
  });

  it("emits Platform/Shell/OS Version on win32", () => {
    const out = getPlatformPromptNote({ ...baseOpts, platform: "win32" });
    expect(out).toBe("Platform: win32\nShell: bash\nOS Version: TestOS 1.2.3");
  });

  it("hard-codes Shell: bash regardless of $SHELL (reflects sandbox execution reality)", () => {
    const out = getPlatformPromptNote({ ...baseOpts, platform: "darwin" });
    expect(out).toContain("Shell: bash");
    expect(out).not.toContain("zsh");
    expect(out).not.toContain("fish");
  });
});
