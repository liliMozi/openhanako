import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnAndStream = vi.fn(async () => ({ exitCode: 0 }));
const classifyWin32Command = vi.fn();
const existsSync = vi.fn(() => false);
const spawnSync = vi.fn(() => ({ status: 1, stdout: "", stderr: "" }));

vi.mock("../lib/sandbox/exec-helper.js", () => ({
  spawnAndStream,
}));

vi.mock("../lib/sandbox/win32-command-router.js", () => ({
  classifyWin32Command,
}));

vi.mock("fs", () => ({
  existsSync,
}));

vi.mock("child_process", () => ({
  spawnSync,
}));

async function loadExecFactory() {
  const mod = await import("../lib/sandbox/win32-exec.js");
  return mod.createWin32Exec;
}

describe("createWin32Exec", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    existsSync.mockReturnValue(false);
    spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" });
  });

  it("routes Windows native commands through cmd.exe", async () => {
    classifyWin32Command.mockReturnValue({ runner: "cmd", reason: "windows-system-executable" });
    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("ipconfig /all", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      "cmd.exe",
      ["/d", "/s", "/c", "ipconfig /all"],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });

  it("keeps bash-routed commands on the bash fallback path", async () => {
    classifyWin32Command.mockReturnValue({ runner: "bash", reason: "complex-shell" });
    existsSync.mockImplementation((p) => p === "C:\\mock\\bash.exe");
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === "where" && args?.[0] === "bash.exe") {
        return { status: 0, stdout: "C:\\mock\\bash.exe\r\n", stderr: "" };
      }
      if (cmd === "C:\\mock\\bash.exe" && args?.[0] === "-c") {
        return { status: 0, stdout: "__hana_probe_ok__\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    const createWin32Exec = await loadExecFactory();
    const exec = createWin32Exec();

    await exec("ls && pwd", "C:\\work", {
      onData: () => {},
      signal: undefined,
      timeout: 5,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(spawnAndStream).toHaveBeenCalledWith(
      "C:\\mock\\bash.exe",
      ["-c", "ls && pwd"],
      expect.objectContaining({ cwd: "C:\\work" })
    );
  });
});
