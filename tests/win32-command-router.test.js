import { describe, expect, it } from "vitest";
import { classifyWin32Command } from "../lib/sandbox/win32-command-router.js";

describe("classifyWin32Command", () => {
  const resolveNativePath = (name) => {
    const table = {
      ipconfig: "C:\\Windows\\System32\\ipconfig.exe",
      reg: "C:\\Windows\\System32\\reg.exe",
      git: "C:\\Program Files\\Git\\cmd\\git.exe",
    };
    return table[name.toLowerCase()] || null;
  };

  it("routes Windows system executables to cmd", () => {
    expect(classifyWin32Command("ipconfig /all", { resolveNativePath }).runner).toBe("cmd");
    expect(classifyWin32Command("reg query HKCU\\Software", { resolveNativePath }).runner).toBe("cmd");
  });

  it("routes cmd builtins to cmd", () => {
    expect(classifyWin32Command("dir C:\\", { resolveNativePath }).runner).toBe("cmd");
  });

  it("keeps explicit shells on the bash path", () => {
    expect(classifyWin32Command("cmd /c dir", { resolveNativePath }).runner).toBe("bash");
    expect(classifyWin32Command('powershell -Command "ipconfig /all"', { resolveNativePath }).runner).toBe("bash");
  });

  it("keeps POSIX and Git commands on the bash path", () => {
    expect(classifyWin32Command("git status", { resolveNativePath }).runner).toBe("bash");
    expect(classifyWin32Command("ls && pwd", { resolveNativePath }).runner).toBe("bash");
  });
});
