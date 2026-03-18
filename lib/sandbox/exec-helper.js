/**
 * exec-helper.js — 共用的 spawn + stream + timeout 逻辑
 *
 * seatbelt.js 和 bwrap.js 都通过这个函数执行沙盒化的命令。
 * 返回值契约严格匹配 Pi SDK defaultBashOperations.exec：
 *   - 正常退出 → resolve({ exitCode })
 *   - abort    → reject(new Error("aborted"))
 *   - timeout  → reject(new Error("timeout:X"))
 */

import { spawn } from "child_process";

/**
 * @param {string} cmd  可执行文件路径（sandbox-exec / bwrap）
 * @param {string[]} args  argv 数组
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {object} [opts.env]
 * @param {(data: Buffer) => void} opts.onData
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeout]  秒
 * @returns {Promise<{exitCode: number|null}>}
 */
export function spawnAndStream(cmd, args, { cwd, env, onData, signal, timeout }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      // Windows: detached 设 DETACHED_PROCESS，会移除控制台，
      // MSYS2/Git Bash 在无控制台环境下可能无法正确初始化导致空输出。
      // Windows 的 killTree 用 taskkill，不依赖进程组，所以不需要 detached。
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    let timedOut = false;

    // timeout：标记 + 杀进程，close 里再 reject
    let timer;
    if (timeout != null && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeout * 1000);
    }

    // abort signal：杀进程，close 里再 reject
    const onAbort = () => killTree(child.pid);
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);

      // 匹配 Pi SDK 契约：abort 和 timeout 必须 reject
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      if (timedOut) {
        reject(new Error(`timeout:${timeout}`));
        return;
      }
      resolve({ exitCode: code });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {}
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}
