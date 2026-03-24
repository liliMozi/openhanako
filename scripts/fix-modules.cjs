/**
 * fix-modules.cjs — electron-builder afterPack 钩子
 *
 * electron-builder 的依赖分析有时会漏掉新的子依赖。
 * 这个脚本在打包后检查 dist node_modules，把缺失的
 * 生产依赖从本地 node_modules 拷贝过去。
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

exports.default = async function (context) {
  const platformName = context.packager.platform.name;
  const appDir = platformName === "mac"
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + ".app",
        "Contents", "Resources", "app")
    : path.join(context.appOutDir, "resources", "app");
  const distModules = path.join(appDir, "node_modules");
  const localModules = path.resolve(__dirname, "..", "node_modules");

  if (!fs.existsSync(distModules)) return;

  // 获取生产依赖树
  let prodDeps;
  try {
    const raw = execSync("npm ls --all --json --omit=dev", {
      cwd: path.resolve(__dirname, ".."),
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    prodDeps = JSON.parse(raw);
  } catch (e) {
    // npm ls 在有 peer dep 警告时也会 exit 1，但 stdout 仍有数据
    try {
      prodDeps = JSON.parse(e.stdout?.toString() || "{}");
    } catch {
      console.log("[fix-modules] 无法解析依赖树，跳过");
      return;
    }
  }

  function collectDeps(obj, set = new Set()) {
    if (!obj || !obj.dependencies) return set;
    for (const [name, info] of Object.entries(obj.dependencies)) {
      set.add(name);
      collectDeps(info, set);
    }
    return set;
  }

  const allProd = collectDeps(prodDeps);
  let copied = 0;

  // 含 native binding 的包（需要平台匹配编译），补全时额外警告
  const NATIVE_PACKAGES = new Set(["bufferutil", "utf-8-validate"]);

  for (const dep of allProd) {
    const distPath = path.join(distModules, dep);
    const localPath = path.join(localModules, dep);
    if (!fs.existsSync(distPath) && fs.existsSync(localPath)) {
      if (NATIVE_PACKAGES.has(dep)) {
        console.warn(`[fix-modules] ⚠ 补全 native 包 "${dep}"（确保已针对当前平台编译）`);
      }
      fs.cpSync(localPath, distPath, { recursive: true });
      copied++;
    }
  }

  if (copied > 0) {
    console.log(`[fix-modules] 补全了 ${copied} 个缺失的生产依赖`);
  }

  // 清理 node_modules 中指向 bundle 外部的 .bin 符号链接（codesign 会报错）
  let removedLinks = 0;
  function cleanBinLinks(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        if (path.isAbsolute(target) && !target.startsWith(appDir)) {
          fs.unlinkSync(full);
          removedLinks++;
        }
      } else if (entry.isDirectory() && entry.name !== ".bin") {
        // 递归进 node_modules 子目录，但跳过非 node_modules 的深层目录
        const binDir = path.join(full, "node_modules", ".bin");
        if (fs.existsSync(binDir)) cleanBinLinks(binDir);
      }
    }
  }

  // 扫描顶层和嵌套的 .bin 目录
  const topBin = path.join(distModules, ".bin");
  if (fs.existsSync(topBin)) cleanBinLinks(topBin);
  for (const entry of fs.readdirSync(distModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(distModules, entry.name, "node_modules", ".bin");
    if (fs.existsSync(nested)) cleanBinLinks(nested);
  }

  if (removedLinks > 0) {
    console.log(`[fix-modules] 清理了 ${removedLinks} 个指向 bundle 外部的 .bin 符号链接`);
  }
};
