import { afterEach, describe, expect, it, vi } from "vitest";

const originalPlatform = process.platform;

async function importToolWrapperAsWin32() {
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.resetModules();
  return import("../lib/sandbox/tool-wrapper.js");
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("wrapBashTool Windows PathGuard preflight", () => {
  it("normalizes MSYS drive paths before checking restricted reads", async () => {
    const { wrapBashTool } = await importToolWrapperAsWin32();
    const tool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
    const guard = {
      check: vi.fn(() => ({ allowed: false, reason: "blocked" })),
    };

    const wrapped = wrapBashTool(tool, guard, "D:\\workspace");
    const result = await wrapped.execute("call-1", {
      command: 'ls "/c/Program Files/GitHub CLI/gh.exe"',
    });

    expect(guard.check).toHaveBeenCalledWith("C:\\Program Files\\GitHub CLI\\gh.exe", "read");
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.content[0].text).toBeTruthy();
  });

  it("checks bash redirection targets as writes", async () => {
    const { wrapBashTool } = await importToolWrapperAsWin32();
    const tool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
    const guard = {
      check: vi.fn(() => ({ allowed: false, reason: "blocked" })),
    };

    const wrapped = wrapBashTool(tool, guard, "D:\\workspace");
    const result = await wrapped.execute("call-2", {
      command: 'printf secret > "/c/Users/alice/.ssh/config"',
    });

    expect(guard.check).toHaveBeenCalledWith("C:\\Users\\alice\\.ssh\\config", "write");
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.content[0].text).toBeTruthy();
  });

  it("checks mutating shell command operands with their operation intent", async () => {
    const { wrapBashTool } = await importToolWrapperAsWin32();
    const tool = { execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) };
    const guard = {
      check: vi.fn(() => ({ allowed: false, reason: "blocked" })),
    };

    const wrapped = wrapBashTool(tool, guard, "D:\\workspace");
    await wrapped.execute("call-3", {
      command: "rm -rf /c/Users/alice/.ssh",
    });

    expect(guard.check).toHaveBeenCalledWith("C:\\Users\\alice\\.ssh", "delete");
    expect(tool.execute).not.toHaveBeenCalled();
  });
});
