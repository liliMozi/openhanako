/**
 * seatbelt.js — macOS Seatbelt (sandbox-exec) 沙盒
 *
 * 生成 SBPL profile，用 sandbox-exec -f 执行。
 * 返回符合 Pi SDK BashOperations.exec 接口的函数。
 */

import fs from "fs";
import { spawnAndStream } from "./exec-helper.js";
import { writeScript, writeProfile, cleanup } from "./script.js";

/**
 * 创建 macOS 沙盒化的 exec 函数
 * @param {object} policy  从 deriveSandboxPolicy() 得到
 * @returns {(command, cwd, opts) => Promise<{exitCode}>}
 */
export function createSeatbeltExec(policy) {
  return async (command, cwd, { onData, signal, timeout, env }) => {
    const { scriptPath } = writeScript(command, cwd);
    const profile = generateProfile(policy);
    const { profilePath } = writeProfile(profile);
    try {
      return await spawnAndStream(
        "sandbox-exec",
        ["-f", profilePath, "/bin/bash", scriptPath],
        { cwd, env, onData, signal, timeout },
      );
    } finally {
      cleanup(scriptPath, profilePath);
    }
  };
}

/**
 * 解析真实路径（符号链接 + macOS /var → /private/var）
 */
function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 生成 Seatbelt SBPL profile
 */
function generateProfile(policy) {
  const lines = [
    "(version 1)",
    "(deny default)",
    "",
    ";; 进程",
    "(allow process-exec* process-fork signal)",
    "(allow sysctl-read)",
    "(allow mach*)",
    "(allow ipc-posix*)",
    "",
    ";; 全局可读",
    "(allow file-read*)",
    "",
    ";; 可写路径",
  ];

  for (const p of policy.writablePaths) {
    lines.push(`(allow file-write* (subpath "${realpath(p)}"))`);
  }

  // /tmp（macOS 上是 /private/tmp 和 /private/var/folders/...）
  lines.push(
    `(allow file-write* (subpath "/private/tmp"))`,
    `(allow file-write* (subpath "${realpath(process.env.TMPDIR || "/tmp")}"))`
  );

  lines.push("");

  // 受保护路径（deny 覆盖 allow，SBPL last-match-wins）
  if (policy.protectedPaths.length) {
    lines.push(";; 写保护");
    for (const p of policy.protectedPaths) {
      lines.push(`(deny file-write* (subpath "${realpath(p)}"))`);
    }
    lines.push("");
  }

  // 读取拒绝（subpath 覆盖文件和目录及其内容）
  if (policy.denyReadPaths.length) {
    lines.push(";; 读取拒绝");
    for (const p of policy.denyReadPaths) {
      const rp = realpath(p);
      lines.push(`(deny file-read* (subpath "${rp}"))`);
      lines.push(`(deny file-write* (subpath "${rp}"))`);
    }
    lines.push("");
  }

  lines.push(
    ";; 终端 + PTY",
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (regex #"^/dev/ttys[0-9]+$"))',
    '(allow file-write* (literal "/dev/ptmx"))',
    "(allow pseudo-tty)",
    "",
    ";; 网络（封死，联网走 Engine 工具层）",
    "(deny network*)",
  );

  return lines.join("\n");
}
