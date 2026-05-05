import path from "path";

const MSYS_DRIVE_RE = /^\/([a-zA-Z])(?:\/(.*))?$/;
const CYGDRIVE_RE = /^\/cygdrive\/([a-zA-Z])(?:\/(.*))?$/i;
const WIN32_DRIVE_ABS_RE = /^[a-zA-Z]:[\\/]/;
const WIN32_UNC_RE = /^\\\\[^\\\/]+[\\\/][^\\\/]+/;
const POSIX_UNC_RE = /^\/\/[^/\\]+[/\\][^/\\]+/;

function trimQuotes(value) {
  const text = String(value || "").trim();
  if (text.length < 2) return text;
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return text.slice(1, -1);
  }
  return text;
}

function toWin32Separators(value) {
  return value.replace(/\//g, "\\");
}

function drivePath(drive, tail = "") {
  const normalizedTail = toWin32Separators(tail).replace(/^\\+/, "");
  const prefix = `${drive.toUpperCase()}:\\`;
  return normalizedTail ? path.win32.normalize(prefix + normalizedTail) : prefix;
}

function userHomeWin32(env = process.env) {
  if (env.USERPROFILE) return path.win32.normalize(env.USERPROFILE);
  if (env.HOMEDRIVE && env.HOMEPATH) return path.win32.normalize(`${env.HOMEDRIVE}${env.HOMEPATH}`);
  return null;
}

/**
 * Convert Windows shell path spellings into native absolute Windows paths.
 *
 * Git Bash/MSYS and Cygwin expose drive C: as /c or /cygdrive/c. PathGuard
 * must check the native object path, not the spelling used by a given shell.
 * Non-filesystem pseudo paths such as /dev/null return null.
 */
export function normalizeWin32ShellPath(rawPath, cwd, opts = {}) {
  const { allowRelative = true, env = process.env } = opts;
  const value = trimQuotes(rawPath);
  if (!value) return null;

  const msys = value.match(MSYS_DRIVE_RE);
  if (msys) return drivePath(msys[1], msys[2] || "");

  const cygdrive = value.match(CYGDRIVE_RE);
  if (cygdrive) return drivePath(cygdrive[1], cygdrive[2] || "");

  if (WIN32_DRIVE_ABS_RE.test(value)) {
    return drivePath(value[0], value.slice(3));
  }

  if (WIN32_UNC_RE.test(value)) {
    return path.win32.normalize(value);
  }

  if (POSIX_UNC_RE.test(value)) {
    return path.win32.normalize(`\\\\${toWin32Separators(value.slice(2))}`);
  }

  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    const home = userHomeWin32(env);
    if (!home) return null;
    const tail = value === "~" ? "" : value.slice(2);
    return path.win32.resolve(home, toWin32Separators(tail));
  }

  if (!allowRelative) return null;
  if (!cwd) return null;
  return path.win32.resolve(cwd, toWin32Separators(value));
}

export function isWin32AbsoluteShellPath(rawPath) {
  return normalizeWin32ShellPath(rawPath, null, { allowRelative: false }) !== null;
}
