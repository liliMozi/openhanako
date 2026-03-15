/**
 * platform.js — 平台检测 + 沙盒工具可用性
 */

import { execFileSync } from "child_process";

export function detectPlatform() {
  if (process.platform === "darwin") return "seatbelt";
  if (process.platform === "linux") return "bwrap";
  return "unsupported";
}

export function checkAvailability(platform) {
  try {
    if (platform === "seatbelt") {
      execFileSync("which", ["sandbox-exec"], { stdio: "ignore" });
      return true;
    }
    if (platform === "bwrap") {
      execFileSync("which", ["bwrap"], { stdio: "ignore" });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
