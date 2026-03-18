#!/usr/bin/env node
/**
 * download-git-portable.js — CI 用，下载 MinGit 到 vendor/git-portable/
 *
 * Windows 打包前运行：node scripts/download-git-portable.js
 * electron-builder 的 extraResources 会把 vendor/git-portable/ 打进安装包的 resources/git/
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VENDOR_DIR = path.join(ROOT, "vendor", "git-portable");

// MinGit-busybox 版本和下载 URL（busybox 变体自带 sh.exe，不需要用户额外装 Git）
const MINGIT_VERSION = "2.47.1";
const MINGIT_URL = `https://github.com/git-for-windows/git/releases/download/v${MINGIT_VERSION}.windows.1/MinGit-${MINGIT_VERSION}-busybox-64-bit.zip`;
const ZIP_PATH = path.join(ROOT, "vendor", `mingit-${MINGIT_VERSION}.zip`);

async function main() {
  // 已存在则跳过
  if (fs.existsSync(path.join(VENDOR_DIR, "cmd", "git.exe"))) {
    console.log(`[download-git-portable] MinGit ${MINGIT_VERSION} already present, skipping.`);
    return;
  }

  fs.mkdirSync(path.join(ROOT, "vendor"), { recursive: true });

  // 下载
  console.log(`[download-git-portable] Downloading MinGit ${MINGIT_VERSION}...`);
  execFileSync("curl", ["-L", "-o", ZIP_PATH, MINGIT_URL], { stdio: "inherit" });

  // 解压
  console.log("[download-git-portable] Extracting...");
  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  if (process.platform === "win32") {
    execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -Path '${ZIP_PATH}' -DestinationPath '${VENDOR_DIR}' -Force`,
    ], { stdio: "inherit", windowsHide: true });
  } else {
    execFileSync("unzip", ["-o", "-q", ZIP_PATH, "-d", VENDOR_DIR], { stdio: "inherit" });
  }

  // 清理 zip
  fs.unlinkSync(ZIP_PATH);

  console.log(`[download-git-portable] MinGit ${MINGIT_VERSION} ready at ${VENDOR_DIR}`);
}

main().catch((err) => {
  console.error("[download-git-portable] Failed:", err.message);
  process.exit(1);
});
