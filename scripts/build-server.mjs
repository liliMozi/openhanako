#!/usr/bin/env node
/**
 * build-server.mjs — 构建 server 独立分发包
 *
 * 策略：直接复制源码 + production npm install + Node.js runtime
 * 不使用 esbuild（ESM+CJS 混用项目无法 bundle，见 memory 记录）
 *
 * 关键设计：用目标 Node.js runtime 来装依赖和编译 native addon，
 * 确保 better-sqlite3 的 ABI 跟运行时一致（系统 Node 版本可能不同）。
 *
 * 产出结构：
 *   dist-server/{platform}-{arch}/
 *     hana-server             ← shell wrapper（设置 HANA_ROOT 并启动）
 *     node                    ← Node.js runtime
 *     package.json            ← "type": "module" + dependencies
 *     package-lock.json       ← 锁定依赖版本
 *     server/                 ← HTTP / WS / CLI
 *     core/                   ← engine / agent / session
 *     lib/                    ← 工具、provider、数据文件
 *     shared/                 ← 跨平台工具
 *     hub/                    ← 多 agent 编排
 *     skills2set/             ← 技能包
 *     desktop/src/locales/    ← i18n 资源
 *     node_modules/           ← production dependencies
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;
// electron-builder 的 ${os} 变量用 "mac" 而非 "darwin"
const osDirName = platform === "darwin" ? "mac" : platform;
const outDir = path.join(ROOT, "dist-server", `${osDirName}-${arch}`);

console.log(`[build-server] Building for ${platform}-${arch}...`);

// ── 0. 清理 ──
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// ── 1. 下载 / 缓存 Node.js runtime ──
// 先拿到目标 Node，后续 npm ci + rebuild 全用它跑，保证 ABI 一致
const NODE_VERSION = "v22.16.0";
const cacheDir = path.join(ROOT, ".cache", "node-runtime");
fs.mkdirSync(cacheDir, { recursive: true });

const nodeMap = {
  "darwin-arm64": `node-${NODE_VERSION}-darwin-arm64`,
  "darwin-x64": `node-${NODE_VERSION}-darwin-x64`,
  "linux-x64": `node-${NODE_VERSION}-linux-x64`,
  "linux-arm64": `node-${NODE_VERSION}-linux-arm64`,
  "win32-x64": `node-${NODE_VERSION}-win-x64`,
};

const nodeDirName = nodeMap[`${platform}-${arch}`];
if (!nodeDirName) {
  console.error(`[build-server] ⚠ 不支持的平台: ${platform}-${arch}`);
  process.exit(1);
}

const isWin = platform === "win32";
const ext = isWin ? "zip" : "tar.gz";
const filename = `${nodeDirName}.${ext}`;
const cachedArchive = path.join(cacheDir, filename);
const cachedNodeBin = isWin
  ? path.join(cacheDir, nodeDirName, "node.exe")
  : path.join(cacheDir, nodeDirName, "bin", "node");
const cachedNpmCli = isWin
  ? path.join(cacheDir, nodeDirName, "node_modules", "npm", "bin", "npm-cli.js")
  : path.join(cacheDir, nodeDirName, "lib", "node_modules", "npm", "bin", "npm-cli.js");

if (!fs.existsSync(cachedNodeBin)) {
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${filename}`;
  console.log(`[build-server] downloading Node.js ${NODE_VERSION} for ${platform}-${arch}...`);
  execSync(`curl -L -o "${cachedArchive}" "${url}"`, { stdio: "inherit" });

  if (isWin) {
    execSync(`powershell -command "Expand-Archive -Path '${cachedArchive}' -DestinationPath '${cacheDir}' -Force"`, { stdio: "inherit" });
  } else {
    execSync(`tar xzf "${cachedArchive}" -C "${cacheDir}"`, { stdio: "inherit" });
  }

  try { fs.unlinkSync(cachedArchive); } catch {}
  console.log("[build-server] Node.js runtime cached");
} else {
  console.log(`[build-server] using cached Node.js ${NODE_VERSION}`);
}

// 复制 node 二进制到 dist
const destNode = path.join(outDir, isWin ? "node.exe" : "node");
fs.copyFileSync(cachedNodeBin, destNode);
if (!isWin) fs.chmodSync(destNode, 0o755);
console.log("[build-server] Node.js runtime ready");

// helper: 用目标 Node 跑命令
// PATH 前置目标 Node 的 bin 目录，确保 lifecycle scripts（如 prebuild-install）
// 也用目标 Node 而非系统 Node（两者 ABI 可能不同）
const targetNodeDir = path.dirname(cachedNodeBin);
const targetEnv = {
  ...process.env,
  NODE_ENV: "production",
  PATH: `${targetNodeDir}${path.delimiter}${process.env.PATH}`,
};
function runWithTargetNode(cmd, opts = {}) {
  execSync(`"${cachedNodeBin}" ${cmd}`, {
    cwd: outDir,
    stdio: "inherit",
    env: targetEnv,
    ...opts,
  });
}

// ── 2. 复制源码 ──
const SOURCE_DIRS = ["server", "core", "lib", "shared", "hub"];
for (const dir of SOURCE_DIRS) {
  const src = path.join(ROOT, dir);
  if (fs.existsSync(src)) {
    fs.cpSync(src, path.join(outDir, dir), { recursive: true });
    console.log(`[build-server]   ${dir}/`);
  } else {
    console.warn(`[build-server] ⚠ ${dir}/ not found, skipping`);
  }
}

// skills2set（运行时复制到用户数据目录）
const skillsSrc = path.join(ROOT, "skills2set");
if (fs.existsSync(skillsSrc)) {
  fs.cpSync(skillsSrc, path.join(outDir, "skills2set"), { recursive: true });
  console.log("[build-server]   skills2set/");
}

// i18n locales（server/i18n.js 通过 fromRoot("desktop","src","locales") 引用）
const localesSrc = path.join(ROOT, "desktop", "src", "locales");
fs.mkdirSync(path.join(outDir, "desktop", "src", "locales"), { recursive: true });
fs.cpSync(localesSrc, path.join(outDir, "desktop", "src", "locales"), { recursive: true });
console.log("[build-server]   desktop/src/locales/");

console.log("[build-server] source files copied");

// ── 3. Production dependencies（用目标 Node 的 npm） ──
for (const f of ["package.json", "package-lock.json"]) {
  fs.copyFileSync(path.join(ROOT, f), path.join(outDir, f));
}

// 精简 package.json
const pkg = JSON.parse(fs.readFileSync(path.join(outDir, "package.json"), "utf-8"));
delete pkg.devDependencies;
delete pkg.build;
delete pkg.main;
pkg.scripts = {};
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

// 用目标 Node 的 npm 安装依赖
// 不加 --ignore-scripts：better-sqlite3 的 install 脚本需要跑（prebuild-install 下载正确 ABI 的预编译）
// 我们的 postinstall（patch-pi-sdk）已被 pkg.scripts={} 清空，不会误触
console.log("[build-server] installing production dependencies...");
runWithTargetNode(`"${cachedNpmCli}" ci --omit=dev`);

// PI SDK patch（package.json 的 postinstall 被清空，手动补跑）
const patchScript = path.join(ROOT, "scripts", "patch-pi-sdk.cjs");
if (fs.existsSync(patchScript)) {
  fs.mkdirSync(path.join(outDir, "scripts"), { recursive: true });
  fs.copyFileSync(patchScript, path.join(outDir, "scripts", "patch-pi-sdk.cjs"));
  runWithTargetNode("scripts/patch-pi-sdk.cjs");
  fs.rmSync(path.join(outDir, "scripts"), { recursive: true });
}

// 清理 node_modules/.bin（符号链接指向构建机器的绝对路径，codesign 会报错）
// server 运行时不需要这些 CLI 工具
function removeBinDirs(nmDir) {
  const topBin = path.join(nmDir, ".bin");
  if (fs.existsSync(topBin)) fs.rmSync(topBin, { recursive: true });
  // 嵌套的 node_modules/.bin
  for (const entry of fs.readdirSync(nmDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const nested = path.join(nmDir, entry.name, "node_modules", ".bin");
    if (fs.existsSync(nested)) fs.rmSync(nested, { recursive: true });
  }
}
removeBinDirs(path.join(outDir, "node_modules"));

console.log("[build-server] dependencies ready");

// ── 4. Wrapper 脚本 ──
if (isWin) {
  fs.writeFileSync(
    path.join(outDir, "hana-server.cmd"),
    '@echo off\r\nset "HANA_ROOT=%~dp0"\r\n"%~dp0node.exe" "%~dp0server\\index.js" %*\r\n',
  );
} else {
  const wrapper = path.join(outDir, "hana-server");
  fs.writeFileSync(wrapper, [
    "#!/bin/sh",
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    'export HANA_ROOT="$DIR"',
    'exec "$DIR/node" "$DIR/server/index.js" "$@"',
    "",
  ].join("\n"));
  fs.chmodSync(wrapper, 0o755);
}
console.log("[build-server] wrapper created");

console.log("[build-server] Done!");
