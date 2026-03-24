#!/usr/bin/env node
/**
 * build-server.mjs — 构建 server 独立分发包
 *
 * 策略：Vite bundle + 外部依赖 npm install + Node.js runtime
 * Vite 把 server/core/lib/shared/hub 源码打成几个 chunk，
 * 只有 native addon 和无法 bundle 的 SDK 作为 external 走 npm ci。
 *
 * 关键设计：用目标 Node.js runtime 来装依赖和编译 native addon，
 * 确保 better-sqlite3 的 ABI 跟运行时一致（系统 Node 版本可能不同）。
 * Vite build 用系统 Node 跑（构建时工具，不涉及 ABI）。
 *
 * 产出结构：
 *   dist-server/{platform}-{arch}/
 *     hana-server             ← shell wrapper（设置 HANA_ROOT 并启动）
 *     node                    ← Node.js runtime
 *     bundle/                 ← Vite bundle 产出
 *       index.js              ← 入口（~750KB）
 *       chunks/               ← 按模块拆分的 chunk
 *         shared-XXXX.js
 *         core-XXXX.js
 *         lib-XXXX.js
 *         hub-XXXX.js
 *     lib/                    ← 数据文件（非源码，运行时 fromRoot() 读取）
 *       known-models.json
 *       default-models.json
 *       config.example.yaml
 *       identity.example.md
 *       ishiki.example.md
 *       pinned.example.md
 *       identity-templates/
 *       ishiki-templates/
 *       public-ishiki-templates/
 *       yuan/
 *     desktop/src/locales/    ← i18n 资源
 *     skills2set/             ← 技能包
 *     package.json            ← external deps + version（node_modules 解析 + 运行时版本读取）
 *     package-lock.json       ← 锁定依赖版本
 *     node_modules/           ← 仅 external deps（~50 packages）
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
// 先拿到目标 Node，后续 npm ci 全用它跑，保证 ABI 一致
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

// ── 2. Vite bundle ──
// 用系统 Node 跑 Vite（构建时工具，不涉及 native addon ABI）
// 产出到 dist-server-bundle/，然后复制到 outDir/bundle/
console.log("[build-server] running Vite bundle...");
const viteBundleDir = path.join(ROOT, "dist-server-bundle");
execSync("npx vite build --config vite.config.server.js", {
  cwd: ROOT,
  stdio: "inherit",
});

// 复制 bundle 产出
const bundleOutDir = path.join(outDir, "bundle");
fs.cpSync(viteBundleDir, bundleOutDir, { recursive: true });
console.log("[build-server] Vite bundle copied to bundle/");

// ── 3. 复制运行时数据文件 ──
// 这些文件由 fromRoot() / fs.readFileSync() 在运行时读取，无法打进 bundle

// lib/ 下的数据文件（json, yaml, md）
const LIB_DATA_GLOBS = [
  "known-models.json",
  "default-models.json",
  "config.example.yaml",
  "identity.example.md",
  "ishiki.example.md",
  "pinned.example.md",
];
const libOutDir = path.join(outDir, "lib");
fs.mkdirSync(libOutDir, { recursive: true });
for (const file of LIB_DATA_GLOBS) {
  const src = path.join(ROOT, "lib", file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(libOutDir, file));
    console.log(`[build-server]   lib/${file}`);
  } else {
    console.warn(`[build-server] ⚠ lib/${file} not found, skipping`);
  }
}

// lib/ 下的模板目录（递归复制）
const LIB_TEMPLATE_DIRS = [
  "identity-templates",
  "ishiki-templates",
  "public-ishiki-templates",
  "yuan",
];
for (const dir of LIB_TEMPLATE_DIRS) {
  const src = path.join(ROOT, "lib", dir);
  if (fs.existsSync(src)) {
    fs.cpSync(src, path.join(libOutDir, dir), { recursive: true });
    console.log(`[build-server]   lib/${dir}/`);
  } else {
    console.warn(`[build-server] ⚠ lib/${dir}/ not found, skipping`);
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

console.log("[build-server] resource files copied");

// ── 4. External dependencies ──
// 只装 Vite config 中 external 的包（native addon + 无法 bundle 的 SDK）
// 比全量 npm ci 少很多（~50 packages vs ~500+）
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));

// 从根 package.json 动态读取版本，保持同步
const EXTERNAL_DEPS = [
  "better-sqlite3",
  "@mariozechner/pi-coding-agent",
  "@larksuiteoapi/node-sdk",
  "node-telegram-bot-api",
  "exceljs",
];
const externalDeps = {};
for (const dep of EXTERNAL_DEPS) {
  if (rootPkg.dependencies[dep]) externalDeps[dep] = rootPkg.dependencies[dep];
  else console.warn(`[build-server] ⚠ ${dep} not in root package.json`);
}

const externalPkg = {
  name: "hanako-server",
  version: rootPkg.version,
  type: "module",
  dependencies: externalDeps,
};

fs.writeFileSync(
  path.join(outDir, "package.json"),
  JSON.stringify(externalPkg, null, 2) + "\n",
);

// 不复制 lockfile：精简后的 package.json 只有 5 个依赖，
// 跟完整 lockfile 不匹配，npm ci 会报错。用 npm install 代替。

// ── 5. 用目标 Node 的 npm 安装 external deps ──
// 不加 --ignore-scripts：better-sqlite3 的 install 脚本需要跑
// （prebuild-install 下载正确 ABI 的预编译二进制）
// 用 npm install 而非 npm ci：lockfile 跟精简 package.json 不匹配
console.log("[build-server] installing external dependencies...");
runWithTargetNode(`"${cachedNpmCli}" install --omit=dev`);

// ── 6. PI SDK patch ──
// package.json 没有 postinstall，手动跑补丁
const patchScript = path.join(ROOT, "scripts", "patch-pi-sdk.cjs");
if (fs.existsSync(patchScript)) {
  fs.mkdirSync(path.join(outDir, "scripts"), { recursive: true });
  fs.copyFileSync(patchScript, path.join(outDir, "scripts", "patch-pi-sdk.cjs"));
  runWithTargetNode("scripts/patch-pi-sdk.cjs");
  fs.rmSync(path.join(outDir, "scripts"), { recursive: true });
}

// ── 7. 清理 node_modules/.bin ──
// 符号链接指向构建机器的绝对路径，codesign 会报错
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

// ── 8. 更新 package.json（加入 version 供运行时读取） ──
// npm ci 之后 package.json 仍在，确保它包含 version 字段
// fromRoot("package.json") 在运行时读取版本号
// 保留 dependencies 字段（node_modules 解析需要）
const installedPkg = JSON.parse(fs.readFileSync(path.join(outDir, "package.json"), "utf-8"));
installedPkg.version = rootPkg.version;
fs.writeFileSync(
  path.join(outDir, "package.json"),
  JSON.stringify(installedPkg, null, 2) + "\n",
);

// ── 9. Wrapper 脚本 ──
if (isWin) {
  fs.writeFileSync(
    path.join(outDir, "hana-server.cmd"),
    '@echo off\r\nset "HANA_ROOT=%~dp0"\r\n"%~dp0node.exe" "%~dp0bundle\\index.js" %*\r\n',
  );
} else {
  const wrapper = path.join(outDir, "hana-server");
  fs.writeFileSync(wrapper, [
    "#!/bin/sh",
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    'export HANA_ROOT="$DIR"',
    'exec "$DIR/node" "$DIR/bundle/index.js" "$@"',
    "",
  ].join("\n"));
  fs.chmodSync(wrapper, 0o755);
}
console.log("[build-server] wrapper created");

console.log("[build-server] Done!");
