import { describe, expect, it, vi } from "vitest";
import { createWindowsUiaProvider } from "../core/computer-use/providers/windows-uia-provider.js";
import { COMPUTER_USE_ERRORS } from "../core/computer-use/errors.js";

function helperResult(data) {
  return { stdout: JSON.stringify({ ok: true, data }), stderr: "", exitCode: 0 };
}

function makeRunner(handler) {
  const calls = [];
  return {
    calls,
    runner: {
      run: vi.fn(async (command, args, options) => {
        calls.push({ command, args, options });
        return handler(command, args, options);
      }),
    },
  };
}

describe("Windows UIA provider", () => {
  it("reports unavailable on non-Windows platforms", async () => {
    const provider = createWindowsUiaProvider({ platform: "darwin" });

    await expect(provider.getStatus()).resolves.toMatchObject({
      available: false,
      reason: "unsupported-platform",
    });
    await expect(provider.listApps()).rejects.toMatchObject({
      code: COMPUTER_USE_ERRORS.PROVIDER_UNAVAILABLE,
    });
  });

  it("invokes PowerShell helper with request JSON over stdin", async () => {
    const { runner, calls } = makeRunner(() => helperResult({ apps: [] }));
    const provider = createWindowsUiaProvider({
      platform: "win32",
      command: "powershell.exe",
      helperScript: "Write-Output '{}'",
      runner,
    });

    await provider.listApps();

    expect(calls[0].command).toBe("powershell.exe");
    expect(calls[0].args).toEqual(expect.arrayContaining(["-WindowStyle", "Hidden"]));
    expect(calls[0].args).toContain("-EncodedCommand");
    expect(calls[0].options.windowsHide).toBe(true);
    expect(JSON.parse(calls[0].options.stdin)).toEqual({ command: "list_apps" });
  });

  it("normalizes list_apps and lease provider state", async () => {
    const { runner } = makeRunner(() => helperResult({
      apps: [{
        appId: "pid:12",
        name: "Notepad",
        processId: 12,
        windows: [{ windowId: "123", title: "Untitled - Notepad" }],
      }],
    }));
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner });

    const apps = await provider.listApps();
    const lease = await provider.createLease({}, { appId: "pid:12", windowId: "123" });

    expect(apps[0]).toMatchObject({
      appId: "pid:12",
      name: "Notepad",
      pid: 12,
      windows: [{ windowId: "123", title: "Untitled - Notepad" }],
    });
    expect(lease).toMatchObject({
      appId: "pid:12",
      windowId: "123",
      providerState: { appId: "pid:12", processId: 12, windowId: 123 },
    });
  });

  it("declares background-only UIA capabilities and omits foreground raw input actions from leases", async () => {
    const { runner } = makeRunner(() => helperResult({ ok: true }));
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner });

    const lease = await provider.createLease({}, { appId: "pid:12", windowId: "123" });

    expect(provider.capabilities).toMatchObject({
      backgroundControl: "partial",
      pointClick: "unsupported",
      drag: "unsupported",
      keyboardInput: "unsupported",
      requiresForegroundForInput: false,
    });
    expect(lease.allowedActions).toEqual([
      "click_element",
      "type_text",
      "scroll",
      "stop",
    ]);
  });

  it("normalizes helper snapshots into Hana snapshots", async () => {
    const { runner } = makeRunner(() => helperResult({
      appId: "pid:12",
      windowId: "123",
      screenshot: "png-base64",
      display: { x: 10, y: 20, width: 300, height: 200 },
      elements: [{ elementId: "uia:1", role: "ControlType.Button", label: "OK", patterns: ["InvokePattern"] }],
      providerState: { processId: 12, windowId: 123 },
    }));
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner });

    const snapshot = await provider.getAppState({}, {
      leaseId: "lease-1",
      appId: "pid:12",
      windowId: "123",
      providerState: { processId: 12, windowId: 123 },
    });

    expect(snapshot).toMatchObject({
      mode: "vision-native",
      appId: "pid:12",
      windowId: "123",
      screenshot: { type: "image", mimeType: "image/png", data: "png-base64" },
      elements: [{ elementId: "uia:1", role: "ControlType.Button", label: "OK" }],
    });
  });

  it("maps only snapshot-bound semantic UIA actions to the helper", async () => {
    const { runner, calls } = makeRunner(() => helperResult({ ok: true }));
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner });
    const lease = { leaseId: "lease-1", providerState: { processId: 12, windowId: 123 } };
    const snapshotElement = {
      elementId: "uia:1",
      role: "ControlType.Button",
      label: "OK",
      automationId: "ok",
      bounds: { x: 10, y: 20, width: 80, height: 30 },
    };

    await provider.performAction({}, lease, { type: "click_element", elementId: "uia:1", snapshotElement });
    await provider.performAction({}, lease, { type: "type_text", elementId: "uia:1", text: "hello", snapshotElement });
    await provider.performAction({}, lease, { type: "scroll", elementId: "uia:1", direction: "down", snapshotElement });

    expect(JSON.parse(calls[0].options.stdin)).toMatchObject({
      command: "perform_action",
      action: { type: "click_element", elementId: "uia:1", snapshotElement },
    });
    expect(JSON.parse(calls[1].options.stdin)).toMatchObject({
      command: "perform_action",
      action: { type: "type_text", elementId: "uia:1", text: "hello", snapshotElement },
    });
    expect(JSON.parse(calls[2].options.stdin)).toMatchObject({
      command: "perform_action",
      action: { type: "scroll", elementId: "uia:1", direction: "down", snapshotElement },
    });
  });

  it("rejects foreground-only actions before invoking the helper", async () => {
    const { runner, calls } = makeRunner(() => helperResult({ ok: true }));
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner });
    const lease = { leaseId: "lease-1", providerState: { processId: 12, windowId: 123 } };

    await expect(provider.performAction({}, lease, { type: "click_point", x: 1, y: 2 }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_REQUIRES_FOREGROUND });
    await expect(provider.performAction({}, lease, { type: "double_click", x: 1, y: 2 }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_REQUIRES_FOREGROUND });
    await expect(provider.performAction({}, lease, { type: "drag", fromX: 1, fromY: 2, toX: 3, toY: 4 }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_REQUIRES_FOREGROUND });
    await expect(provider.performAction({}, lease, { type: "press_key", key: "Return" }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_REQUIRES_FOREGROUND });
    await expect(provider.performAction({}, lease, { type: "type_text", text: "foreground text" }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_REQUIRES_FOREGROUND });
    await expect(provider.performAction({}, lease, { type: "scroll", direction: "down" }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_REQUIRES_FOREGROUND });

    expect(calls).toHaveLength(0);
  });

  it("rejects element-indexed actions unless the host provides snapshot-bound metadata", async () => {
    const { runner } = makeRunner(() => helperResult({ ok: true }));
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner });
    const lease = { leaseId: "lease-1", providerState: { processId: 12, windowId: 123 } };

    await expect(provider.performAction({}, lease, { type: "click_element", elementId: "uia:1" }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.STALE_SNAPSHOT });
    await expect(provider.performAction({}, lease, { type: "scroll", elementId: "uia:1", direction: "down" }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.STALE_SNAPSHOT });
  });

  it("rejects malformed foreground input before invoking the helper", async () => {
    const { runner } = makeRunner(() => helperResult({ ok: true }));
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner });
    const lease = { leaseId: "lease-1", providerState: { processId: 12, windowId: 123 } };

    await expect(provider.performAction({}, lease, { type: "click_point", x: 1 }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_BLOCKED_BY_POLICY });
    await expect(provider.performAction({}, lease, { type: "drag", fromX: 1, fromY: 2, toX: 3 }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_BLOCKED_BY_POLICY });
    await expect(provider.performAction({}, lease, { type: "press_key" }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.ACTION_BLOCKED_BY_POLICY });
  });

  it("converts helper errors into typed Hana errors", async () => {
    const { runner } = makeRunner(() => ({
      stdout: JSON.stringify({ ok: false, errorCode: "TARGET_NOT_FOUND", message: "Window not found." }),
      stderr: "",
      exitCode: 0,
    }));
    const provider = createWindowsUiaProvider({ platform: "win32", command: "powershell.exe", runner });

    await expect(provider.getAppState({}, { leaseId: "lease-1", providerState: { processId: 12 } }))
      .rejects.toMatchObject({ code: COMPUTER_USE_ERRORS.TARGET_NOT_FOUND });
  });
});
