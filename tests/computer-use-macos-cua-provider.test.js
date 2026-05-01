import { describe, expect, it, vi } from "vitest";
import { createMacosCuaProvider, resolveCuaDriverCommand } from "../core/computer-use/providers/macos-cua-provider.js";
import { COMPUTER_USE_ERRORS } from "../core/computer-use/errors.js";

function rawResult(structuredContent, content = [{ type: "text", text: "ok" }]) {
  return {
    stdout: JSON.stringify({ content, structuredContent }),
    stderr: "",
    exitCode: 0,
  };
}

function makeRunner(handler) {
  const calls = [];
  return {
    calls,
    runner: {
      run: vi.fn(async (command, args) => {
        calls.push({ command, args });
        return handler(command, args);
      }),
    },
  };
}

describe("macos Cua provider", () => {
  it("resolves a configured Cua Driver command before common locations", () => {
    const command = resolveCuaDriverCommand({
      env: { HANA_CUA_DRIVER_PATH: "/opt/cua-driver" },
      existsSync: (p) => p === "/opt/cua-driver",
      homeDir: "/Users/hana",
    });

    expect(command).toBe("/opt/cua-driver");
  });

  it("prefers a Hana-bundled Computer Use helper over an external Cua Driver install", () => {
    const command = resolveCuaDriverCommand({
      env: {
        HANA_ROOT: "/Applications/Hanako.app/Contents/Resources/server",
        HANA_CUA_DRIVER_PATH: "/opt/cua-driver",
      },
      existsSync: (p) => p === "/Applications/Hanako.app/Contents/Resources/computer-use/macos/hana-computer-use-helper"
        || p === "/opt/cua-driver",
      homeDir: "/Users/hana",
      arch: "arm64",
      cwd: "/Users/hana/project-hana",
    });

    expect(command).toBe("/Applications/Hanako.app/Contents/Resources/computer-use/macos/hana-computer-use-helper");
  });

  it("resolves the development helper build output before falling back to PATH", () => {
    const command = resolveCuaDriverCommand({
      env: { HANA_ROOT: "/Users/hana/project-hana" },
      existsSync: (p) => p === "/Users/hana/project-hana/dist-computer-use/mac-arm64/hana-computer-use-helper",
      homeDir: "/Users/hana",
      arch: "arm64",
      cwd: "/Users/hana/project-hana",
    });

    expect(command).toBe("/Users/hana/project-hana/dist-computer-use/mac-arm64/hana-computer-use-helper");
  });

  it("reports unavailable on non-macOS platforms", async () => {
    const provider = createMacosCuaProvider({ platform: "win32", command: "cua-driver" });

    await expect(provider.listApps()).rejects.toMatchObject({
      code: COMPUTER_USE_ERRORS.PROVIDER_UNAVAILABLE,
    });
    await expect(provider.getStatus()).resolves.toMatchObject({
      available: false,
      reason: "unsupported-platform",
    });
  });

  it("normalizes text-only permission output from the embedded helper", async () => {
    const { runner } = makeRunner((_command, args) => {
      if (args[0] === "status") {
        return { stdout: "hana-computer-use-helper running", stderr: "", exitCode: 0 };
      }
      expect(args[0]).toBe("check_permissions");
      return rawResult(null, [{ type: "text", text: "✅ Accessibility: granted.\n❌ Screen Recording: NOT granted." }]);
    });
    const provider = createMacosCuaProvider({ platform: "darwin", command: "/tmp/hana-computer-use-helper", runner });

    await expect(provider.getStatus()).resolves.toMatchObject({
      available: true,
      permissions: [
        { name: "Accessibility", granted: true },
        { name: "Screen Recording", granted: false },
      ],
    });
  });

  it("maps appId lease creation to launch_app and stores pid/window state", async () => {
    const { runner, calls } = makeRunner((_command, args) => {
      expect(args[0]).toBe("launch_app");
      return rawResult({
        pid: 844,
        bundle_id: "com.apple.calculator",
        name: "Calculator",
        windows: [{ window_id: 10725, title: "Calculator" }],
      });
    });
    const provider = createMacosCuaProvider({ platform: "darwin", command: "/tmp/cua-driver", runner });

    const lease = await provider.createLease({}, { appId: "com.apple.calculator" });

    expect(calls[0].args).toEqual([
      "launch_app",
      JSON.stringify({ bundle_id: "com.apple.calculator" }),
      "--raw",
      "--compact",
    ]);
    expect(lease).toMatchObject({
      appId: "com.apple.calculator",
      windowId: "10725",
      providerState: { pid: 844, windowId: 10725, bundleId: "com.apple.calculator" },
    });
    expect(lease.allowedActions).toContain("click_point");
    expect(lease.allowedActions).toContain("double_click");
    expect(lease.allowedActions).not.toContain("click_element");
  });

  it("configures the native agent cursor with Hana's cursor image before controlling an app", async () => {
    const { runner, calls } = makeRunner((_command, args) => {
      if (args[0] === "set_agent_cursor_enabled") return rawResult({ ok: true });
      if (args[0] === "set_agent_cursor_style") return rawResult({ ok: true });
      if (args[0] === "launch_app") {
        return rawResult({
          pid: 844,
          bundle_id: "com.apple.calculator",
          name: "Calculator",
          windows: [{ window_id: 10725, title: "Calculator" }],
        });
      }
      if (args[0] === "get_window_state") {
        return rawResult(
          { tree_markdown: "- [14] AXButton \"Three\"" },
          [
            { type: "text", text: '✅ Calculator\n- [14] AXButton "Three"' },
            { type: "image", mimeType: "image/png", data: "abc" },
          ],
        );
      }
      throw new Error(`unexpected helper tool: ${args[0]}`);
    });
    const provider = createMacosCuaProvider({
      platform: "darwin",
      command: "/tmp/cua-driver",
      runner,
      cursorImagePath: "/tmp/hana-cursor.svg",
    });

    expect(provider.capabilities.nativeCursor).toBe(true);

    const lease = await provider.createLease({}, { appId: "com.apple.calculator" });
    await provider.getAppState({}, {
      ...lease,
      leaseId: "lease-1",
    });

    expect(calls.slice(0, 3).map((call) => call.args[0])).toEqual([
      "set_agent_cursor_enabled",
      "set_agent_cursor_style",
      "launch_app",
    ]);
    expect(calls[0].args[1]).toBe(JSON.stringify({ enabled: true }));
    expect(calls[1].args[1]).toBe(JSON.stringify({
      image_path: "/tmp/hana-cursor.svg",
      bloom_color: "#537D96",
    }));
    expect(calls.filter((call) => call.args[0] === "set_agent_cursor_enabled")).toHaveLength(1);
    expect(calls.filter((call) => call.args[0] === "set_agent_cursor_style")).toHaveLength(1);
  });

  it("waits for launch_app to expose a usable window", async () => {
    let attempts = 0;
    const { runner, calls } = makeRunner((_command, args) => {
      expect(args[0]).toBe("launch_app");
      attempts += 1;
      if (attempts === 1) {
        return rawResult({
          pid: 844,
          bundle_id: "com.apple.Music",
          name: "Music",
          windows: [],
        });
      }
      return rawResult({
        pid: 844,
        bundle_id: "com.apple.Music",
        name: "Music",
        windows: [{ window_id: 10725, title: "Music" }],
      });
    });
    const provider = createMacosCuaProvider({
      platform: "darwin",
      command: "/tmp/cua-driver",
      runner,
      launchRetryDelayMs: 0,
    });

    const lease = await provider.createLease({}, { appId: "com.apple.Music" });

    expect(calls).toHaveLength(2);
    expect(lease).toMatchObject({
      appId: "com.apple.Music",
      windowId: "10725",
      providerState: { pid: 844, windowId: 10725 },
    });
  });

  it("prefers the visible titled app window returned by launch_app", async () => {
    const { runner } = makeRunner((_command, args) => {
      expect(args[0]).toBe("launch_app");
      return rawResult({
        pid: 844,
        bundle_id: "com.apple.Music",
        name: "Music",
        windows: [
          {
            window_id: 1,
            title: "",
            bounds: { x: 0, y: 0, width: 1470, height: 33 },
            is_on_screen: false,
            on_current_space: false,
          },
          {
            window_id: 2,
            title: "Music",
            bounds: { x: 320, y: 129, width: 980, height: 600 },
            is_on_screen: true,
            on_current_space: true,
          },
        ],
      });
    });
    const provider = createMacosCuaProvider({ platform: "darwin", command: "/tmp/cua-driver", runner });

    const lease = await provider.createLease({}, { appId: "com.apple.Music" });

    expect(lease).toMatchObject({
      windowId: "2",
      providerState: { windowId: 2 },
    });
  });

  it("normalizes a Cua window state response into a Hana snapshot", async () => {
    const { runner } = makeRunner((_command, args) => {
      expect(args[0]).toBe("get_window_state");
      return rawResult(
        {
          tree_markdown: [
            "- [3] AXRow actions=[AXShowDefaultUI]",
            "  - AXCell",
            "    - AXImage (搜索)",
            "    - AXStaticText = \"搜索\"",
            "- [14] AXButton \"Three\"",
          ].join("\n"),
          display: { width: 400, height: 300, scaleFactor: 2 },
        },
        [
          { type: "text", text: '✅ Calculator\n- [14] AXButton "Three"' },
          { type: "image", mimeType: "image/png", data: "abc" },
        ],
      );
    });
    const provider = createMacosCuaProvider({ platform: "darwin", command: "/tmp/cua-driver", runner });

    const snapshot = await provider.getAppState({}, {
      leaseId: "lease-1",
      appId: "com.apple.calculator",
      windowId: "10725",
      providerState: { pid: 844, windowId: 10725 },
    });

    expect(snapshot).toMatchObject({
      mode: "vision-native",
      appId: "com.apple.calculator",
      screenshot: { type: "image", mimeType: "image/png", data: "abc" },
      display: { width: 400, height: 300, scaleFactor: 2 },
      elements: [
        { elementId: "3", role: "AXRow", label: "搜索" },
        { elementId: "14", role: "AXButton", label: "Three" },
      ],
    });
  });

  it("maps coordinate clicks and text input to Cua CLI tools", async () => {
    const { runner, calls } = makeRunner(() => rawResult({ ok: true }));
    const provider = createMacosCuaProvider({ platform: "darwin", command: "/tmp/cua-driver", runner });
    const lease = {
      leaseId: "lease-1",
      appId: "com.apple.calculator",
      windowId: "10725",
      providerState: { pid: 844, windowId: 10725 },
    };

    await provider.performAction({}, lease, { type: "click_point", x: 20, y: 30 });
    await provider.performAction({}, lease, { type: "double_click", x: 40, y: 50 });
    await provider.performAction({}, lease, { type: "type_text", text: "hello" });
    await provider.performAction({}, lease, { type: "press_key", key: "return" });

    expect(calls.map((c) => c.args[0])).toEqual(["click", "double_click", "type_text", "press_key"]);
    expect(calls[0].args[1]).toBe(JSON.stringify({ pid: 844, window_id: 10725, x: 20, y: 30 }));
    expect(calls[1].args[1]).toBe(JSON.stringify({ pid: 844, window_id: 10725, x: 40, y: 50 }));
    expect(calls[2].args[1]).toBe(JSON.stringify({ pid: 844, text: "hello" }));
    expect(calls[3].args[1]).toBe(JSON.stringify({ pid: 844, key: "return" }));
  });

  it("rejects element-indexed actions with coordinate guidance", async () => {
    const { runner } = makeRunner(() => rawResult({ ok: true }));
    const provider = createMacosCuaProvider({ platform: "darwin", command: "/tmp/cua-driver", runner });
    const lease = {
      leaseId: "lease-1",
      appId: "com.apple.calculator",
      windowId: "10725",
      providerState: { pid: 844, windowId: 10725 },
    };

    await expect(provider.performAction({}, lease, { type: "double_click", elementId: "14" }))
      .rejects.toMatchObject({
        code: COMPUTER_USE_ERRORS.CAPABILITY_UNSUPPORTED,
        message: expect.stringContaining("Use screenshot coordinates"),
      });
  });

  it("converts Cua CLI failures into typed errors", async () => {
    const { runner } = makeRunner(() => ({
      stdout: "",
      stderr: "Accessibility permission denied",
      exitCode: 2,
    }));
    const provider = createMacosCuaProvider({ platform: "darwin", command: "/tmp/cua-driver", runner });

    await expect(provider.listApps()).rejects.toMatchObject({
      code: COMPUTER_USE_ERRORS.OS_PERMISSION_DENIED,
    });
  });

  it("preserves structured helper error text when the CLI exits non-zero", async () => {
    const { runner } = makeRunner(() => ({
      stdout: JSON.stringify({
        isError: true,
        content: [{ type: "text", text: "No cached AX state for pid 844. Call get_window_state first." }],
      }),
      stderr: "",
      exitCode: 1,
    }));
    const provider = createMacosCuaProvider({ platform: "darwin", command: "/tmp/cua-driver", runner });

    await expect(provider.listApps()).rejects.toMatchObject({
      code: COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
      message: expect.stringContaining("No cached AX state"),
    });
  });
});
