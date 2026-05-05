import { describe, expect, it } from "vitest";
import { normalizeWin32ShellPath } from "../lib/sandbox/win32-path.js";

describe("normalizeWin32ShellPath", () => {
  it("normalizes MSYS and Cygwin drive paths to native Windows paths", () => {
    expect(normalizeWin32ShellPath("/c/Program Files/GitHub CLI/gh.exe", "D:\\work")).toBe(
      "C:\\Program Files\\GitHub CLI\\gh.exe",
    );
    expect(normalizeWin32ShellPath("/cygdrive/d/project/src/index.js", "C:\\work")).toBe(
      "D:\\project\\src\\index.js",
    );
  });

  it("normalizes drive, UNC, home, and relative paths", () => {
    expect(normalizeWin32ShellPath("c:/Users/alice/.ssh/config", "D:\\work")).toBe(
      "C:\\Users\\alice\\.ssh\\config",
    );
    expect(normalizeWin32ShellPath("//server/share/a file.txt", "D:\\work")).toBe(
      "\\\\server\\share\\a file.txt",
    );
    expect(normalizeWin32ShellPath("~/notes.md", "D:\\work", {
      env: { USERPROFILE: "C:\\Users\\alice" },
    })).toBe("C:\\Users\\alice\\notes.md");
    expect(normalizeWin32ShellPath("notes/today.md", "D:\\work")).toBe("D:\\work\\notes\\today.md");
  });

  it("does not treat non-drive POSIX pseudo paths as Windows files", () => {
    expect(normalizeWin32ShellPath("/dev/null", "D:\\work", { allowRelative: false })).toBeNull();
    expect(normalizeWin32ShellPath("/tmp/file", "D:\\work", { allowRelative: false })).toBeNull();
  });
});
