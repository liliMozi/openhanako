/**
 * bwrap.js — Linux bubblewrap 沙盒
 *
 * 构造 bwrap 参数，用 argv 数组直接 spawn。
 * 返回符合 Pi SDK BashOperations.exec 接口的函数。
 */

import fs from "fs";
import path from "path";
import os from "os";
import { spawnAndStream } from "./exec-helper.js";
import { writeScript, cleanup } from "./script.js";

/**
 * 创建 Linux 沙盒化的 exec 函数
 * @param {object} policy  从 deriveSandboxPolicy() 得到
 * @returns {(command, cwd, opts) => Promise<{exitCode}>}
 */
export function createBwrapExec(policy) {
  return async (command, cwd, { onData, signal, timeout, env }) => {
    const { scriptPath } = writeScript(command, cwd);
    const args = buildArgs(policy, env);
    try {
      return await spawnAndStream(
        "bwrap",
        [...args, "--", "/bin/bash", scriptPath],
        { cwd, env, onData, signal, timeout },
      );
    } finally {
      cleanup(scriptPath);
    }
  };
}

/**
 * 构造 bwrap 参数
 */
function buildArgs(policy, env) {
  const args = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--unshare-pid",
    "--unshare-net",
    "--new-session",
    "--die-with-parent",
  ];

  // 可写路径：覆盖为可写绑定
  for (const p of policy.writablePaths) {
    if (fs.existsSync(p)) {
      args.push("--bind", p, p);
    }
  }

  // 受保护路径：在可写范围内再覆盖为只读
  for (const p of policy.protectedPaths) {
    if (fs.existsSync(p)) {
      args.push("--ro-bind", p, p);
    }
  }

  // 读取拒绝：文件绑 /dev/null，目录绑 tmpfs
  for (const p of policy.denyReadPaths) {
    if (!fs.existsSync(p)) continue;
    try {
      if (fs.statSync(p).isDirectory()) {
        args.push("--tmpfs", p);
      } else {
        args.push("--ro-bind", "/dev/null", p);
      }
    } catch {}
  }

  // 缓存目录：确保 npm/pip 等能正常写缓存（临时可写，进程结束即丢弃）
  const home = env?.HOME || os.homedir();
  const cacheDirs = [
    path.join(home, ".cache"),
    path.join(home, ".npm"),
  ];
  for (const d of cacheDirs) {
    const isWritable = policy.writablePaths.some(
      (w) => d === w || d.startsWith(w + path.sep),
    );
    if (!isWritable && fs.existsSync(d)) {
      args.push("--tmpfs", d);
    }
  }

  return args;
}
