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
import { builtinModules } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;
// electron-builder 的 ${os} 变量：darwin→"mac"、win32→"win"、linux→"linux"
const osDirName = platform === "darwin" ? "mac" : platform === "win32" ? "win" : platform;
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
// Windows 上改名为 hana-server.exe，让 main.cjs 的 bundled server 检测能命中，
// 同时在任务管理器中显示为 hana-server.exe 而非 node.exe（便于 NSIS 安装脚本按名杀进程）
const destNode = path.join(outDir, isWin ? "hana-server.exe" : "node");
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

// Theme CSS（server/routes/plugins.js theme.css 端点通过 fromRoot("desktop","src","themes") 引用）
const themesSrc = path.join(ROOT, "desktop", "src", "themes");
if (fs.existsSync(themesSrc)) {
  fs.mkdirSync(path.join(outDir, "desktop", "src", "themes"), { recursive: true });
  fs.cpSync(themesSrc, path.join(outDir, "desktop", "src", "themes"), { recursive: true });
  console.log("[build-server]   desktop/src/themes/");
}

// 系统插件（内嵌到 app，运行时 fromRoot("plugins") 读取）
const pluginsSrc = path.join(ROOT, "plugins");
if (fs.existsSync(pluginsSrc)) {
  fs.cpSync(pluginsSrc, path.join(outDir, "plugins"), { recursive: true });
  console.log("[build-server]   plugins/");
}

console.log("[build-server] resource files copied");

// ── 4. External dependencies ──
// 从 vite.config.server.js 的 external 列表自动派生需要安装的包。
// 规则：external ∩ rootPkg.dependencies = 需要安装的包。
// 这消除了手动维护两个列表导致的遗漏（如 #242 ws 缺失）。
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));

// defineConfig 是纯 identity 函数，import 安全无副作用
const viteConfig = (await import("../vite.config.server.js")).default;
const viteExternals = viteConfig.build?.rollupOptions?.external;
if (!Array.isArray(viteExternals)) {
  throw new Error("[build-server] vite.config.server.js external must be an array");
}

const builtinSet = new Set(builtinModules.flatMap(m => [m, `node:${m}`]));
const deps = rootPkg.dependencies || {};
const externalDeps = {};

for (const ext of viteExternals) {
  if (typeof ext === "string") {
    if (builtinSet.has(ext)) continue;
    if (deps[ext]) externalDeps[ext] = deps[ext];
    // 不在 dependencies 中的（如 fsevents、photon-node）由 transitive 或 optional 提供
  } else if (ext instanceof RegExp) {
    for (const dep of Object.keys(deps)) {
      if (ext.test(dep)) externalDeps[dep] = deps[dep];
    }
  }
}

console.log(`[build-server] derived external deps: ${Object.keys(externalDeps).join(", ")}`);

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

// 不复制 lockfile：精简后的 package.json 依赖数量少，
// 跟完整 lockfile 不匹配，npm ci 会报错。用 npm install 代替。

// ── 5. 用目标 Node 的 npm 安装 external deps ──
// 不加 --ignore-scripts：better-sqlite3 的 install 脚本需要跑
// （prebuild-install 下载正确 ABI 的预编译二进制）
// 用 npm install 而非 npm ci：lockfile 跟精简 package.json 不匹配
console.log("[build-server] installing external dependencies...");
runWithTargetNode(`"${cachedNpmCli}" install --omit=dev`);

// ── 5b. 验证所有 Vite external 在 node_modules 中可达 ──
// 遍历 string 类型的 external，检查 node_modules 中是否存在。
// RegExp external（如 /^@mariozechner\//）不在此检查范围内，
// 因为匹配的包已通过派生逻辑显式安装或作为 transitive dep 存在。
// platform-optional（fsevents）允许缺失，其余缺失说明 transitive 链断了。
const OPTIONAL_EXTERNALS = new Set(["fsevents"]);
const missing = [];
for (const ext of viteExternals) {
  if (typeof ext !== "string" || builtinSet.has(ext)) continue;
  if (!fs.existsSync(path.join(outDir, "node_modules", ext))) {
    if (OPTIONAL_EXTERNALS.has(ext)) continue;
    missing.push(ext);
  }
}
if (missing.length > 0) {
  console.error(`[build-server] ❌ Vite externals missing from node_modules: ${missing.join(", ")}`);
  console.error(`[build-server]   These packages are external in the bundle but not installed.`);
  console.error(`[build-server]   Fix: add them to root package.json dependencies, or check transitive dep chains.`);
  process.exit(1);
}

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

console.log("[build-server] dependencies installed");

// ── 8. @vercel/nft 追踪：只保留运行时实际需要的文件 ──
// 从 bundle 入口出发，静态分析所有 import/require 链，
// 删除 node_modules 里没被追踪到的文件（.d.ts、.map、多余平台二进制等）
console.log("[build-server] running nft trace...");

// nft 是 ESM，用动态 import
const { nodeFileTrace } = await import("@vercel/nft");
let fileList;
try {
  ({ fileList } = await nodeFileTrace(
    [path.join(outDir, "bundle", "index.js")],
    { base: outDir, conditions: ["node", "import"] },
  ));
} catch (e) {
  // Windows CI 上 nft 可能因用户目录不存在而报错，跳过裁剪
  console.warn(`[build-server] nft trace failed (${e.message}), skipping prune`);
  fileList = null;
}

const nmDir = path.join(outDir, "node_modules");

if (fileList) {
// 把追踪结果转成绝对路径 Set
const tracedFiles = new Set();
for (const f of fileList) {
  tracedFiles.add(path.resolve(outDir, f));
}

// Vite externals 是显式标记为运行时必须的包，nft 不一定能正确追踪
// （CJS/ESM 交叉解析在 Windows 上有边缘情况），整个包目录跳过裁剪。
const protectedDirs = new Set();
for (const ext of viteExternals) {
  if (typeof ext === "string" && !builtinSet.has(ext)) {
    // path.join 自动处理 scoped 包（@scope/pkg → node_modules/@scope/pkg）
    const pkgDir = path.resolve(nmDir, ext);
    if (fs.existsSync(pkgDir)) protectedDirs.add(pkgDir);
  }
}

if (protectedDirs.size > 0) {
  const names = [...protectedDirs].map(d => path.relative(nmDir, d));
  console.log(`[build-server] nft: protecting ${protectedDirs.size} Vite externals from pruning: ${names.join(", ")}`);
}

// 遍历 node_modules，删除未追踪的文件（跳过受保护的包）
let removedFiles = 0;
let removedSize = 0;

function pruneDir(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (protectedDirs.has(path.resolve(full))) continue;
      pruneDir(full);
      // 删完子文件后如果目录空了，也删掉
      try {
        const remaining = fs.readdirSync(full);
        if (remaining.length === 0) fs.rmdirSync(full);
      } catch {}
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      if (!tracedFiles.has(full)) {
        const size = entry.isFile() ? (fs.statSync(full).size || 0) : 0;
        fs.unlinkSync(full);
        removedFiles++;
        removedSize += size;
      }
    }
  }
}

pruneDir(nmDir);

const keptFiles = fileList.size;
const MB = (n) => (n / 1024 / 1024).toFixed(0);
console.log(`[build-server] nft: kept ${keptFiles} files, removed ${removedFiles} files (${MB(removedSize)}MB)`);
} // end if (fileList)

// ── 8b. 删除 koffi 多余平台二进制 ──
// koffi 带了 18 个平台的 .node 文件，nft 全部追踪到了（因为 require 路径指向包根）。
// 非当前平台的二进制在 macOS 上无法被 codesign 签名（ELF/PE 格式），会导致签名卡死。
const koffiBuilds = path.join(nmDir, "koffi", "build", "koffi");
if (fs.existsSync(koffiBuilds)) {
  const target = `${platform === "darwin" ? "darwin" : platform === "win32" ? "win32" : "linux"}_${arch}`;
  let koffiRemoved = 0;
  for (const entry of fs.readdirSync(koffiBuilds)) {
    if (entry !== target) {
      fs.rmSync(path.join(koffiBuilds, entry), { recursive: true, force: true });
      koffiRemoved++;
    }
  }
  if (koffiRemoved > 0) {
    console.log(`[build-server] koffi: kept ${target}, removed ${koffiRemoved} other platform binaries`);
  }
}

// ── 9. 更新 package.json ──
// npm ci 之后 package.json 仍在，确保它包含 version 字段
// fromRoot("package.json") 在运行时读取版本号
// 保留 dependencies 字段（node_modules 解析需要）
const installedPkg = JSON.parse(fs.readFileSync(path.join(outDir, "package.json"), "utf-8"));
installedPkg.version = rootPkg.version;
fs.writeFileSync(
  path.join(outDir, "package.json"),
  JSON.stringify(installedPkg, null, 2) + "\n",
);

// ── 10. Wrapper 脚本 ──
if (isWin) {
  fs.writeFileSync(
    path.join(outDir, "hana-server.cmd"),
    '@echo off\r\nset "HANA_ROOT=%~dp0"\r\n"%~dp0hana-server.exe" "%~dp0bundle\\index.js" %*\r\n',
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
