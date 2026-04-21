import { spawnSync } from "child_process";

const EXPLICIT_SHELLS = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "bash",
  "bash.exe",
  "sh",
  "sh.exe",
]);

const CMD_BUILTINS = new Set([
  "assoc",
  "break",
  "call",
  "cd",
  "chdir",
  "cls",
  "copy",
  "date",
  "del",
  "dir",
  "echo",
  "endlocal",
  "erase",
  "exit",
  "for",
  "ftype",
  "goto",
  "if",
  "md",
  "mklink",
  "move",
  "path",
  "pause",
  "popd",
  "prompt",
  "pushd",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "set",
  "setlocal",
  "shift",
  "start",
  "time",
  "title",
  "type",
  "ver",
  "verify",
  "vol",
]);

const COMPLEX_SHELL_PATTERN = /(&&|\|\||\$\(|`|<[<(]?|>[>]?|\|)/;
const SYSTEM_PATH_PATTERN = /\\windows\\(system32|sysnative|syswow64)\\/i;
const nativePathCache = new Map();

function getFirstToken(command) {
  const trimmed = String(command || "").trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^"([^"]+)"|^'([^']+)'|^([^\s]+)/);
  return (match?.[1] || match?.[2] || match?.[3] || "").trim();
}

function defaultResolveNativePath(name) {
  const key = String(name || "").toLowerCase();
  if (!key) return null;
  if (nativePathCache.has(key)) return nativePathCache.get(key);

  try {
    const result = spawnSync("where.exe", [key], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 3000,
    });
    const resolved = result.status === 0
      ? (result.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) || null
      : null;
    nativePathCache.set(key, resolved);
    return resolved;
  } catch {
    nativePathCache.set(key, null);
    return null;
  }
}

export function classifyWin32Command(command, { resolveNativePath = defaultResolveNativePath } = {}) {
  const token = getFirstToken(command);
  const lower = token.toLowerCase();

  if (!token) return { runner: "bash", reason: "empty" };
  if (EXPLICIT_SHELLS.has(lower)) return { runner: "bash", reason: "explicit-shell" };
  if (COMPLEX_SHELL_PATTERN.test(command)) return { runner: "bash", reason: "complex-shell" };
  if (CMD_BUILTINS.has(lower)) return { runner: "cmd", reason: "cmd-builtin" };

  const resolved = resolveNativePath(lower);
  if (resolved && SYSTEM_PATH_PATTERN.test(resolved)) {
    return { runner: "cmd", reason: "windows-system-executable", path: resolved };
  }

  return { runner: "bash", reason: "default-bash" };
}
