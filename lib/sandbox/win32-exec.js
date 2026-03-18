/**
 * win32-exec.js — Windows 平台的 bash 执行函数
 *
 * Windows 没有 OS 级沙盒（seatbelt/bwrap），bash 走 Pi SDK 默认实现。
 * 但默认实现的 detached: true 在 Windows 上会设 DETACHED_PROCESS 标志，
 * 导致 MSYS2/Git Bash 的 stdout/stderr pipe 可能收不到数据。
 *
 * 这个模块提供替代的 exec 函数，使用 spawnAndStream（已去掉 Windows detached）。
 * 返回值契约匹配 Pi SDK BashOperations.exec。
 *
 * Shell 降级策略：
 *   1. getAllShellCandidates() 收集磁盘上所有可用的 shell（不缓存）
 *   2. findAndCacheShell() 对候选列表做 probe（spawnSync echo），首个成功的缓存
 *   3. createWin32Exec() 运行时如果 spawn 失败，清缓存并降级到下一个 shell
 */

import { existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { spawnAndStream } from "./exec-helper.js";

// ── Shell 查找 ──

let _cachedShell = null; // { shell, args, label }

const PROBE_TOKEN = "__hana_probe_ok__";

/**
 * 对候选 shell 做 probe：用 spawnSync 跑 echo，确认 shell 可正常启动
 */
function probeShell(shell, args) {
  try {
    const result = spawnSync(shell, [...args, `echo ${PROBE_TOKEN}`], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return result.status === 0 && (result.stdout || "").includes(PROBE_TOKEN);
  } catch {
    return false;
  }
}

/**
 * 收集所有磁盘上存在的 shell 候选（不缓存、不 probe）
 *
 * 只收集 bash 兼容 shell（PI SDK 生成 POSIX shell 命令，PowerShell 语法不兼容）。
 *
 * 查找顺序：
 * 1. 系统 Git Bash（标准 + 常见安装位置）
 * 2. 注册表查询 Git 安装路径
 * 3. 内嵌 MinGit-busybox 的 sh.exe（打包进 resources/git/）
 * 4. PATH 上的 bash.exe / sh.exe
 * 5. MSYS2 / Cygwin
 */
function getAllShellCandidates() {
  const found = [];

  // ── 1. 系统 Git Bash 标准 + 常见安装位置 ──
  const gitBashPaths = [];
  if (process.env.ProgramFiles) {
    gitBashPaths.push(`${process.env.ProgramFiles}\\Git\\bin\\bash.exe`);
  }
  if (process.env["ProgramFiles(x86)"]) {
    gitBashPaths.push(`${process.env["ProgramFiles(x86)"]}\\Git\\bin\\bash.exe`);
  }
  if (process.env.LOCALAPPDATA) {
    gitBashPaths.push(`${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`);
  }
  if (process.env.USERPROFILE) {
    gitBashPaths.push(`${process.env.USERPROFILE}\\scoop\\apps\\git\\current\\bin\\bash.exe`);
  }
  gitBashPaths.push("C:\\Git\\bin\\bash.exe", "D:\\Git\\bin\\bash.exe");

  for (const p of gitBashPaths) {
    if (existsSync(p)) {
      found.push({ shell: p, args: ["-c"], label: `Git Bash (${p})` });
    }
  }

  // ── 2. 注册表查询 Git 安装路径 ──
  for (const regKey of [
    "HKLM\\SOFTWARE\\GitForWindows",
    "HKCU\\SOFTWARE\\GitForWindows",
    "HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows",
  ]) {
    try {
      const result = spawnSync("reg", ["query", regKey, "/v", "InstallPath"], {
        encoding: "utf-8",
        timeout: 5000,
        windowsHide: true,
      });
      if (result.status === 0 && result.stdout) {
        const match = result.stdout.match(/InstallPath\s+REG_SZ\s+(.+)/i);
        if (match) {
          const gitBash = join(match[1].trim(), "bin", "bash.exe");
          if (existsSync(gitBash) && !found.some(c => c.shell === gitBash)) {
            found.push({ shell: gitBash, args: ["-c"], label: `Git Bash via registry ${regKey} (${gitBash})` });
          }
        }
      }
    } catch {}
  }

  // ── 3. 内嵌 MinGit-busybox 的 sh.exe ──
  if (process.resourcesPath) {
    const bundledSh = join(process.resourcesPath, "git", "mingw64", "bin", "sh.exe");
    if (existsSync(bundledSh)) {
      found.push({ shell: bundledSh, args: ["-c"], label: `Bundled MinGit (${bundledSh})` });
    }
  }

  // ── 4. PATH 上的 bash.exe / sh.exe ──
  for (const name of ["bash.exe", "sh.exe"]) {
    try {
      const result = spawnSync("where", [name], { encoding: "utf-8", timeout: 5000, windowsHide: true });
      if (result.status === 0 && result.stdout) {
        for (const line of result.stdout.trim().split(/\r?\n/)) {
          const candidate = line.trim();
          if (!candidate || !existsSync(candidate)) continue;
          if (found.some(c => c.shell === candidate)) continue;
          // System32/SysWOW64 下的 bash.exe 是 WSL launcher，不是真正的 bash shell
          // WSL 进入不同的文件系统命名空间，cwd/PATH/编码全对不上
          const lower = candidate.toLowerCase();
          if (lower.includes("\\windows\\system32\\") || lower.includes("\\windows\\syswow64\\")) continue;
          found.push({ shell: candidate, args: ["-c"], label: `PATH ${name} (${candidate})` });
          break;
        }
      }
    } catch {}
  }

  // ── 5. MSYS2 / Cygwin ──
  for (const p of [
    "C:\\msys64\\usr\\bin\\bash.exe",
    "C:\\cygwin64\\bin\\bash.exe",
    "C:\\cygwin\\bin\\bash.exe",
  ]) {
    if (existsSync(p) && !found.some(c => c.shell === p)) {
      found.push({ shell: p, args: ["-c"], label: `MSYS2/Cygwin (${p})` });
    }
  }

  // PowerShell 不在候选列表中：PI SDK 生成 bash 语法（&&、管道、command substitution 等），
  // PowerShell 语法完全不兼容，静默降级只会让每条命令以莫名方式失败。
  // 如果所有 bash 兼容 shell 都不可用，应该 fail fast 并给出明确的安装指引。

  return found;
}

/**
 * 从候选列表中找到第一个 probe 成功的 shell 并缓存
 * @param {string} [startAfter] - 跳过此路径及之前的所有候选（用于降级重试）
 */
function findAndCacheShell(startAfter) {
  // 有缓存且不是降级重试 → 直接返回
  if (_cachedShell && !startAfter) return _cachedShell;

  const candidates = getAllShellCandidates();

  // 降级重试：跳过 startAfter 及之前的候选
  let startIdx = 0;
  if (startAfter) {
    const idx = candidates.findIndex(c => c.shell === startAfter);
    if (idx >= 0) startIdx = idx + 1;
  }

  const failures = [];

  for (let i = startIdx; i < candidates.length; i++) {
    const c = candidates[i];
    if (probeShell(c.shell, c.args)) {
      _cachedShell = c;
      return c;
    }
    failures.push(c.label);
  }

  // 全部失败
  const allLabels = startAfter
    ? [`(前序已跳过)`, ...failures]
    : candidates.map(c => c.label);
  throw new Error(
    `[win32-exec] 找不到可用的 bash 兼容 shell。\n` +
    `已尝试（probe 失败）:\n${allLabels.map(s => `  - ${s}`).join("\n")}\n\n` +
    `建议:\n` +
    `  1. 安装 Git for Windows: https://git-scm.com/download/win\n` +
    `  2. 确认 bash.exe 有执行权限\n` +
    `  3. 如果使用杀毒软件，检查是否拦截了 bash.exe`
  );
}

// ── Spawn 错误判断 ──

const SPAWN_ERROR_CODES = new Set(["ENOENT", "EACCES", "EPERM", "UNKNOWN"]);

/**
 * 判断是否为 shell 启动失败的 spawn 级错误
 * 区分于：命令级错误（shell 启动了但命令返回非零）、abort/timeout、cwd 不存在等
 *
 * Node.js spawn 在 shell 可执行文件不存在时：err.code="ENOENT", err.path=shellPath
 * 在 cwd 不存在时也抛 ENOENT，但 err.path 不等于 shell 路径
 * 只有确认是 shell 本身的问题才触发降级重试
 */
function isShellSpawnError(err, shellPath) {
  if (!err || typeof err.code !== "string") return false;
  if (!SPAWN_ERROR_CODES.has(err.code)) return false;
  // ENOENT 特殊处理：只有 err.path 指向 shell 可执行文件时才算 shell 问题
  // cwd 不存在也会 ENOENT，但 err.path 会是 undefined 或其他值
  if (err.code === "ENOENT" && err.path && err.path !== shellPath) return false;
  return true;
}

/**
 * 包装错误信息，附带完整诊断
 */
function enrichError(retryErr, primaryShell, originalErr) {
  const msg = [
    `[win32-exec] 无法执行 shell 命令。`,
    ``,
    `首选 shell: ${primaryShell.label}`,
    `  错误: ${originalErr.message} (${originalErr.code || "unknown"})`,
    ``,
    `降级也失败: ${retryErr.message}`,
    ``,
    `建议:`,
    `  1. 重新安装 Git for Windows: https://git-scm.com/download/win`,
    `  2. 确认 bash.exe 有执行权限`,
    `  3. 如果使用杀毒软件，检查是否拦截了 bash.exe`,
  ].join("\n");

  const enriched = new Error(msg);
  enriched.code = originalErr.code;
  return enriched;
}

// ── Shell 环境 ──

/**
 * 构建干净的 shell 执行环境
 * 移除 ELECTRON_RUN_AS_NODE（不应泄漏到用户命令子进程）
 */
function cleanShellEnv(baseEnv) {
  const env = { ...baseEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function getShellEnv() {
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  return cleanShellEnv({ ...process.env, [pathKey]: process.env[pathKey] ?? "" });
}

// ── 导出 ──

/**
 * 创建 Windows 平台的 bash exec 函数
 *
 * spawn 失败时自动降级到下一个可用 shell（清缓存 + 重试）。
 * 只对 spawn 级错误（ENOENT/EACCES/EPERM）降级，abort/timeout/命令错误原样抛出。
 *
 * @returns {(command: string, cwd: string, opts: object) => Promise<{exitCode: number|null}>}
 */
export function createWin32Exec() {
  return async (command, cwd, { onData, signal, timeout, env }) => {
    const shellInfo = findAndCacheShell();
    const shellEnv = cleanShellEnv(env ?? getShellEnv());

    try {
      return await spawnAndStream(shellInfo.shell, [...shellInfo.args, command], {
        cwd, env: shellEnv, onData, signal, timeout,
      });
    } catch (err) {
      // 只对 shell 启动失败降级（ENOENT 指向 shell 二进制、EACCES、EPERM）
      // abort / timeout / 命令本身报错 / cwd 不存在 → 原样抛出
      if (!isShellSpawnError(err, shellInfo.shell)) throw err;

      console.warn(`[win32-exec] Shell 执行失败 (${shellInfo.label}): ${err.code} ${err.message}，尝试降级…`);
      _cachedShell = null;

      try {
        const fallback = findAndCacheShell(shellInfo.shell);
        console.warn(`[win32-exec] 降级到: ${fallback.label}`);
        return await spawnAndStream(fallback.shell, [...fallback.args, command], {
          cwd, env: shellEnv, onData, signal, timeout,
        });
      } catch (retryErr) {
        // 降级也失败：抛出富化的错误信息
        if (isShellSpawnError(retryErr, fallback.shell)) {
          throw enrichError(retryErr, shellInfo, err);
        }
        throw retryErr;
      }
    }
  };
}
