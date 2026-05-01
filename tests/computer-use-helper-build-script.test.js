import path from "path";
import { describe, expect, it } from "vitest";
import {
  computerUseHelperOutputDir,
  shouldBuildComputerUseHelper,
  swiftBuildScratchPath,
  swiftArchForNodeArch,
} from "../scripts/build-computer-use-helper.mjs";

describe("Computer Use helper build script", () => {
  it("skips the Swift helper build outside macOS", () => {
    expect(shouldBuildComputerUseHelper({ platform: "linux" })).toBe(false);
    expect(shouldBuildComputerUseHelper({ platform: "win32" })).toBe(false);
    expect(shouldBuildComputerUseHelper({ platform: "darwin" })).toBe(true);
  });

  it("maps Node architecture names to Swift architecture names", () => {
    expect(swiftArchForNodeArch("arm64")).toBe("arm64");
    expect(swiftArchForNodeArch("x64")).toBe("x86_64");
  });

  it("writes the macOS helper into the Electron extraResources source directory", () => {
    expect(computerUseHelperOutputDir({
      rootDir: "/repo",
      osName: "mac",
      arch: "arm64",
    })).toBe(path.join("/repo", "dist-computer-use", "mac-arm64"));
  });

  it("keeps SwiftPM checkouts in the ignored cache directory instead of the source tree", () => {
    expect(swiftBuildScratchPath({
      rootDir: "/repo",
      arch: "arm64",
    })).toBe(path.join("/repo", ".cache", "computer-use-helper", "swift-build", "mac-arm64"));
  });
});
