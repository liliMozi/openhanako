/**
 * win32-exec.js — Windows 平台的 bash 执行函数
 *
 * Windows 没有 OS 级沙盒（seatbelt/bwrap），bash 走 Pi SDK 默认实现。
 * 但默认实现的 detached: true 在 Windows 上会设 DETACHED_PROCESS 标志，
 * 导致 MSYS2/Git Bash 的 stdout/stderr pipe 可能收不到数据。
 *
 * 这个模块提供替代的 exec 函数，使用 spawnAndStream（已去掉 Windows detached）。
 * 返回值契约匹配 Pi SDK BashOperations.exec。
 */

import { existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { spawnAndStream } from "./exec-helper.js";

// ── Shell 查找（轻量版，只在 Windows 上用） ──

let _cachedShell = null;

/**
 * 查找顺序：
 * 1. 系统 Git Bash（用户自己装的）
 * 2. 内嵌 MinGit-busybox 的 sh.exe（打包进 resources/git/）
 * 3. PATH 上的 bash.exe / sh.exe
 * 4. 抛错，提示安装 Git
 */
function findShell() {
  if (_cachedShell) return _cachedShell;

  // 1. 系统 Git Bash 标准位置
  const candidates = [];
  if (process.env.ProgramFiles) {
    candidates.push(`${process.env.ProgramFiles}\\Git\\bin\\bash.exe`);
  }
  if (process.env["ProgramFiles(x86)"]) {
    candidates.push(`${process.env["ProgramFiles(x86)"]}\\Git\\bin\\bash.exe`);
  }
  for (const p of candidates) {
    if (existsSync(p)) {
      _cachedShell = { shell: p, args: ["-c"] };
      return _cachedShell;
    }
  }

  // 2. 内嵌 MinGit-busybox 的 sh.exe（Electron 打包后在 resources/git/ 下）
  if (process.resourcesPath) {
    const bundledSh = join(process.resourcesPath, "git", "mingw64", "bin", "sh.exe");
    if (existsSync(bundledSh)) {
      _cachedShell = { shell: bundledSh, args: ["-c"] };
      return _cachedShell;
    }
  }

  // 3. PATH 上找 bash.exe 或 sh.exe
  for (const name of ["bash.exe", "sh.exe"]) {
    try {
      const result = spawnSync("where", [name], { encoding: "utf-8", timeout: 5000 });
      if (result.status === 0 && result.stdout) {
        const first = result.stdout.trim().split(/\r?\n/)[0];
        if (first && existsSync(first)) {
          _cachedShell = { shell: first, args: ["-c"] };
          return _cachedShell;
        }
      }
    } catch {}
  }

  // 4. 找不到任何 shell，抛出明确错误
  throw new Error(
    `[win32-exec] 找不到可用的 shell（bash / sh）。\n` +
    `请安装 Git for Windows: https://git-scm.com/download/win`
  );
}

function getShellEnv() {
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  return { ...process.env, [pathKey]: process.env[pathKey] ?? "" };
}

/**
 * 创建 Windows 平台的 bash exec 函数
 * @returns {(command: string, cwd: string, opts: object) => Promise<{exitCode: number|null}>}
 */
export function createWin32Exec() {
  return (command, cwd, { onData, signal, timeout, env }) => {
    const { shell, args } = findShell();
    return spawnAndStream(shell, [...args, command], {
      cwd,
      env: env ?? getShellEnv(),
      onData,
      signal,
      timeout,
    });
  };
}
