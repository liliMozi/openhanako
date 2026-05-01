import { describe, expect, it } from "vitest";
import {
  approveComputerUseApp,
  isComputerUseAppApproved,
  normalizeComputerUseSettings,
  revokeComputerUseApp,
} from "../core/computer-use/settings.js";

describe("Computer Use settings", () => {
  it("normalizes default provider selection and rejects invalid approvals", () => {
    const settings = normalizeComputerUseSettings({
      provider_by_platform: { darwin: "mock", unknown: "x" },
      allow_windows_input_injection: "yes",
      app_approvals: [{ providerId: "macos:cua" }, { providerId: "mock", appId: "app.notes" }],
    });

    expect(settings.provider_by_platform).toMatchObject({
      darwin: "mock",
      win32: "mock",
      linux: "mock",
    });
    expect(settings.enabled).toBe(false);
    expect(settings.allow_windows_input_injection).toBe(false);
    expect(settings.app_approvals).toHaveLength(1);
  });

  it("persists the global enabled switch only when explicitly true", () => {
    expect(normalizeComputerUseSettings({}).enabled).toBe(false);
    expect(normalizeComputerUseSettings({ enabled: "true" }).enabled).toBe(false);
    expect(normalizeComputerUseSettings({ enabled: true }).enabled).toBe(true);
  });

  it("approves and revokes apps by provider/app id", () => {
    const settings = approveComputerUseApp({}, {
      providerId: "macos:cua",
      appId: "com.apple.calculator",
      appName: "Calculator",
    }, { now: () => "2026-05-01T00:00:00.000Z" });

    expect(isComputerUseAppApproved(settings, {
      providerId: "macos:cua",
      appId: "com.apple.calculator",
    })).toBe(true);
    expect(settings.app_approvals[0].approvedAt).toBe("2026-05-01T00:00:00.000Z");

    const revoked = revokeComputerUseApp(settings, {
      providerId: "macos:cua",
      appId: "com.apple.calculator",
    });
    expect(isComputerUseAppApproved(revoked, {
      providerId: "macos:cua",
      appId: "com.apple.calculator",
    })).toBe(false);
  });

  it("deduplicates approvals by replacing the newest entry", () => {
    const settings = normalizeComputerUseSettings({
      app_approvals: [
        { providerId: "macos:cua", appId: "com.apple.calculator", appName: "Old" },
        { providerId: "macos:cua", appId: "com.apple.calculator", appName: "New" },
      ],
    });

    expect(settings.app_approvals).toHaveLength(1);
    expect(settings.app_approvals[0].appName).toBe("New");
  });
});
