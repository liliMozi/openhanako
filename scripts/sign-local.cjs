/**
 * sign-local.cjs — 本地安装后的 ad-hoc 重签
 *
 * electron-builder 的 ad-hoc 签名和 Electron Framework 原始签名 Team ID 不同，
 * macOS 拒绝加载。这个脚本统一重签所有二进制，确保 Team ID 一致。
 *
 * 关键：server/node_modules 里的 .node 文件（native addon）也要签，
 * codesign --deep 不会递归进 node_modules 目录。
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const APP = "/Applications/Hanako.app";
const ENT = path.join(__dirname, "..", "desktop", "entitlements.mac.plist");

function sign(target, opts = "") {
  execSync(`codesign --sign - --force ${opts} "${target}"`, { stdio: "inherit" });
}

// 1. 签 server 里的所有 Mach-O 文件（node binary + .node addons）
const serverDir = path.join(APP, "Contents", "Resources", "server");
if (fs.existsSync(serverDir)) {
  // node binary
  const nodeBin = path.join(serverDir, "node");
  if (fs.existsSync(nodeBin)) sign(nodeBin);

  // .node files（native addons）
  function findNodeFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        findNodeFiles(full);
      } else if (entry.name.endsWith(".node")) {
        sign(full);
      }
    }
  }
  findNodeFiles(path.join(serverDir, "node_modules"));
}

// 2. 签 frameworks + helpers（--deep 处理内部结构）
const frameworks = path.join(APP, "Contents", "Frameworks");
for (const entry of fs.readdirSync(frameworks)) {
  const full = path.join(frameworks, entry);
  if (entry.endsWith(".framework")) {
    sign(full, "--deep");
  } else if (entry.endsWith(".app")) {
    sign(full, `--entitlements "${ENT}"`);
  }
}

// 3. 签主 app（带 entitlements，V8 需要 JIT 权限）
sign(APP, `--entitlements "${ENT}"`);

// 4. 验证
execSync(`codesign --verify --deep --strict "${APP}"`, { stdio: "inherit" });
console.log("✓ Signed and verified");
