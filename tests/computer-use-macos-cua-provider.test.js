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
      run: vi.fn(async (command, args, options = {}) => {
        calls.push({ command, args, options });
        return handler(command, args, options);
      }),
      spawn: vi.fn((command, args, options = {}) => {
        calls.push({ command, args, options, spawned: true });
        return { unref: vi.fn() };
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
        expect(args).toEqual(["status", "--socket", "/tmp/hana.sock"]);
        return { stdout: "hana-computer-use-helper running", stderr: "", exitCode: 0 };
      }
      expect(args[0]).toBe("check_permissions");
      return rawResult(null, [{ type: "text", text: "✅ Accessibility: granted.\n❌ Screen Recording: NOT granted." }]);
    });
    const provider = createMacosCuaProvider({
      platform: "darwin",
      command: "/tmp/hana-computer-use-helper",
      runner,
      socketPath: "/tmp/hana.sock",
    });

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
    const provider = createMacosCuaProvider({
      platform: "darwin",
      command: "/tmp/cua-driver",
      runner,
      socketPath: "/tmp/hana.sock",
    });

    const lease = await provider.createLease({}, { appId: "com.apple.calculator" });

    expect(calls[0].args).toEqual([
      "launch_app",
      JSON.stringify({ bundle_id: "com.apple.calculator" }),
      "--raw",
      "--compact",
      "--socket",
      "/tmp/hana.sock",
    ]);
    expect(lease).toMatchObject({
      appId: "com.apple.calculator",
      windowId: "10725",
      providerState: { pid: 844, windowId: 10725, bundleId: "com.apple.calculator" },
    });
    expect(lease.allowedActions).toContain("click_point");
    expect(lease.allowedActions).toContain("double_click");
    expect(lease.allowedActions).toContain("click_element");
  });

  it("configures Hana's native cursor before controlling an app", async () => {
    const { runner, calls } = makeRunner((_command, args) => {
      if (args[0] === "set_agent_cursor_style") {
        expect(JSON.parse(args[1])).toEqual({
          gradient_colors: ["#FFFDF8", "#8FAABD", "#2F4A56"],
          bloom_color: "#537D96",
          image_path: "",
        });
        return rawResult({ ok: true });
      }
      if (args[0] === "set_agent_cursor_motion") {
        expect(JSON.parse(args[1])).toMatchObject({
          start_handle: expect.any(Number),
          end_handle: expect.any(Number),
          arc_size: expect.any(Number),
          spring: expect.any(Number),
        });
        return rawResult({ ok: true });
      }
      if (args[0] === "set_agent_cursor_enabled") {
        expect(JSON.parse(args[1])).toEqual({ enabled: true });
        return rawResult({ ok: true });
      }
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
      command: "/tmp/hana-computer-use-helper",
      runner,
      autoStartDaemon: false,
    });

    expect(provider.capabilities.nativeCursor).toBe(true);

    const lease = await provider.createLease({}, { appId: "com.apple.calculator" });
    await provider.getAppState({}, {
      ...lease,
      leaseId: "lease-1",
    });

    expect(calls.slice(0, 4).map((call) => call.args[0])).toEqual([
      "set_agent_cursor_style",
      "set_agent_cursor_motion",
      "set_agent_cursor_enabled",
      "launch_app",
    ]);
    expect(calls.filter((call) => call.args[0] === "set_agent_cursor_enabled")).toHaveLength(1);
    expect(calls.filter((call) => call.args[0] === "set_agent_cursor_style")).toHaveLength(1);
    expect(calls.filter((call) => call.args[0] === "set_agent_cursor_motion")).toHaveLength(1);
  });

  it("starts the bundled helper daemon before using cached element-index tools", async () => {
    let statusChecks = 0;
    const { runner, calls } = makeRunner((_command, args) => {
      if (args[0] === "status") {
        statusChecks += 1;
        return statusChecks === 1
          ? { stdout: "", stderr: "not running", exitCode: 1 }
          : { stdout: "running", stderr: "", exitCode: 0 };
      }
      if (args[0] === "launch_app") {
        return rawResult({
          pid: 844,
          bundle_id: "com.apple.calculator",
          name: "Calculator",
          windows: [{ window_id: 10725, title: "Calculator" }],
        });
      }
      return rawResult({ ok: true });
    });
    const provider = createMacosCuaProvider({
      platform: "darwin",
      command: "/tmp/hana-computer-use-helper",
      runner,
      socketPath: "/tmp/hana.sock",
      daemonStartupTimeoutMs: 1000,
    });

    await provider.createLease({}, { appId: "com.apple.calculator" });

    const serveCall = calls.find((call) => call.spawned === true);
    expect(serveCall).toMatchObject({
      command: "/tmp/hana-computer-use-helper",
      args: ["serve", "--socket", "/tmp/hana.sock"],
      options: { detached: true, stdio: "ignore" },
    });
    expect(calls.map((call) => call.args[0])).toEqual([
      "status",
      "serve",
      "status",
      "set_agent_cursor_style",
      "set_agent_cursor_motion",
      "set_agent_cursor_enabled",
      "launch_app",
    ]);
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
          screenshot_width: 400,
          screenshot_height: 300,
          screenshot_original_width: 800,
          screenshot_original_height: 600,
          screenshot_scale_factor: 2,
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
      display: {
        width: 400,
        height: 300,
        x: 0,
        y: 0,
        originalWidth: 800,
        originalHeight: 600,
        scaleFactor: 2,
      },
      elements: [
        { elementId: "3", role: "AXRow", label: "搜索" },
        { elementId: "14", role: "AXButton", label: "Three" },
      ],
    });
  });

  it("maps point clicks and text input to Cua CLI tools", async () => {
    const { runner, calls } = makeRunner(() => rawResult({ ok: true }));
    const provider = createMacosCuaProvider({ platform: "darwin", command: "/tmp/cua-driver", runner });
    const lease = {
      leaseId: "lease-1",
      appId: "com.apple.calculator",
      windowId: "10725",
      providerState: { pid: 844, windowId: 10725 },
    };

    await provider.performAction({}, lease, { type: "click_point", x: 20, y: 30 });
    await provider.performAction({}, lease, { type: "type_text", text: "hello" });
    await provider.performAction({}, lease, { type: "press_key", key: "return" });

    const helperCalls = calls.filter((c) => c.command === "/tmp/cua-driver");
    expect(calls.filter((c) => c.command === "osascript")).toHaveLength(0);
    expect(helperCalls.map((c) => c.args[0])).toEqual(["click", "type_text", "press_key"]);
    expect(helperCalls[0].args[1]).toBe(JSON.stringify({ pid: 844, window_id: 10725, x: 20, y: 30 }));
    expect(helperCalls[1].args[1]).toBe(JSON.stringify({ pid: 844, text: "hello" }));
    expect(helperCalls[2].args[1]).toBe(JSON.stringify({ pid: 844, key: "return" }));
  });

  it("passes model screenshot coordinates through unchanged to Cua", async () => {
    const { runner, calls } = makeRunner(() => rawResult({ ok: true }));
    const provider = createMacosCuaProvider({ platform: "darwin", command: "/tmp/cua-driver", runner });
    const lease = {
      leaseId: "lease-1",
      appId: "com.apple.calculator",
      windowId: "10725",
      providerState: { pid: 844, windowId: 10725 },
    };
    const snapshotDisplay = {
      width: 1000,
      height: 500,
      originalWidth: 2000,
      originalHeight: 1000,
      scaleFactor: 2,
    };

    await provider.performAction({}, lease, { type: "click_point", x: 125, y: 80, snapshotDisplay });
    await provider.performAction({}, lease, {
      type: "drag",
      fromX: 10,
      fromY: 20,
      toX: 300,
      toY: 120,
      snapshotDisplay,
    });

    const helperCalls = calls.filter((c) => c.command === "/tmp/cua-driver");
    expect(helperCalls.map((c) => c.args[0])).toEqual(["click", "drag"]);
    expect(helperCalls[0].args[1]).toBe(JSON.stringify({ pid: 844, window_id: 10725, x: 125, y: 80 }));
    expect(helperCalls[1].args[1]).toBe(JSON.stringify({
      pid: 844,
      window_id: 10725,
      from_x: 10,
      from_y: 20,
      to_x: 300,
      to_y: 120,
    }));
  });

  it("declares raw coordinate input as approval-gated without foreground activation", async () => {
    const { runner, calls } = makeRunner((command, args) => {
      if (args[0] === "click") return rawResult({ ok: true });
      throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
    });
    const provider = createMacosCuaProvider({ platform: "darwin", command: "/tmp/cua-driver", runner });
    const lease = {
      leaseId: "lease-1",
      appId: "com.apple.calculator",
      windowId: "10725",
      providerState: { pid: 844, windowId: 10725, bundleId: "com.apple.calculator" },
    };

    expect(provider.capabilities.pointClick).toBe("requiresApproval");
    expect(provider.capabilities.drag).toBe("requiresApproval");
    expect(provider.capabilities.requiresForegroundForInput).toBe(false);

    await provider.performAction({}, lease, { type: "click_point", x: 20, y: 30 });

    expect(calls.map((c) => c.command)).toEqual(["/tmp/cua-driver"]);
  });

  it("passes Hana cursor runtime config to each bundled helper process", async () => {
    const { runner, calls } = makeRunner((_command, args) => {
      return rawResult({ ok: true });
    });
    const provider = createMacosCuaProvider({
      platform: "darwin",
      command: "/tmp/hana-computer-use-helper",
      runner,
    });
    const lease = {
      leaseId: "lease-1",
      appId: "com.apple.calculator",
      windowId: "10725",
      providerState: { pid: 844, windowId: 10725, bundleId: "com.apple.calculator" },
    };

    await provider.performAction({}, lease, { type: "click_point", x: 20, y: 30 });

    const clickCall = calls.find((call) => call.command === "/tmp/hana-computer-use-helper" && call.args[0] === "click");
    expect(clickCall?.options?.env?.HANA_AGENT_CURSOR_CONFIG_JSON).toBeTruthy();
    const cursorConfig = JSON.parse(clickCall.options.env.HANA_AGENT_CURSOR_CONFIG_JSON);
    expect(cursorConfig).toMatchObject({
      enabled: true,
      style: {
        gradient_colors: ["#FFFDF8", "#8FAABD", "#2F4A56"],
        bloom_color: "#537D96",
        image_path: "",
      },
      motion: {
        start_handle: 0.38,
        end_handle: 0.28,
        arc_size: 0.08,
        arc_flow: 0,
        spring: 1,
        glide_duration_ms: 520,
        dwell_after_click_ms: 160,
        idle_hide_ms: 2600,
      },
    });
  });

  it("maps element-indexed actions to Cua element_index calls", async () => {
    const { runner, calls } = makeRunner(() => rawResult({ ok: true }));
    const provider = createMacosCuaProvider({ platform: "darwin", command: "/tmp/cua-driver", runner });
    const lease = {
      leaseId: "lease-1",
      appId: "com.apple.calculator",
      windowId: "10725",
      providerState: { pid: 844, windowId: 10725 },
    };

    await provider.performAction({}, lease, { type: "click_element", elementId: "14" });
    await provider.performAction({}, lease, { type: "double_click", elementId: "14" });
    await provider.performAction({}, lease, { type: "perform_secondary_action", elementId: "14" });

    expect(calls.map((c) => c.args[0])).toEqual(["click", "double_click", "right_click"]);
    expect(calls.map((c) => JSON.parse(c.args[1]))).toEqual([
      { pid: 844, window_id: 10725, element_index: 14 },
      { pid: 844, window_id: 10725, element_index: 14 },
      { pid: 844, window_id: 10725, element_index: 14 },
    ]);
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
