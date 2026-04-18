/**
 * patch-pi-sdk.cjs — postinstall 补丁
 *
 * Patch 1: createAgentSession() → baseToolsOverride 透传（sdk.js）
 *
 * 注：空 tools 数组剥离（原 patch 2）已迁移至 engine.js 的
 *     before_provider_request extension，不再需要源码补丁。
 *
 * 安全机制：
 *   - 版本白名单守卫：未验证版本直接中断 npm install
 *   - 结构验证：patch 后回读确认生效
 *   - 直接引用扫描：检测绕过 adapter 的 SDK 导入
 *
 * See: https://github.com/anthropics/openhanako/issues/221
 */

const fs = require("fs");
const path = require("path");

const sdkRoot = path.join(__dirname, "..", "node_modules", "@mariozechner", "pi-coding-agent");

// ── 版本守卫 ──

const VERIFIED_VERSIONS = ["0.64.0", "0.66.1"];

if (!fs.existsSync(sdkRoot)) {
  console.log("[patch-pi-sdk] SDK not installed, skipping");
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"));
if (!VERIFIED_VERSIONS.includes(pkg.version)) {
  console.error(
    `[patch-pi-sdk] SDK 版本 ${pkg.version} 未经验证。\n` +
    `已验证版本：${VERIFIED_VERSIONS.join(", ")}。\n` +
    `请先测试 patch 兼容性再添加到 VERIFIED_VERSIONS。`
  );
  process.exit(1);
}

// ── Patch 1: baseToolsOverride 透传 ──

const sdkTarget = path.join(sdkRoot, "dist", "core", "sdk.js");
let sdkCode = fs.readFileSync(sdkTarget, "utf8");

if (sdkCode.includes("baseToolsOverride")) {
  console.log("[patch-pi-sdk] patch 1 already applied, skipping");
} else {
  const needle = "        initialActiveToolNames,\n        extensionRunnerRef,";
  const replacement =
    "        initialActiveToolNames,\n" +
    "        baseToolsOverride: options.tools\n" +
    "            ? Object.fromEntries(options.tools.map(t => [t.name, t]))\n" +
    "            : undefined,\n" +
    "        extensionRunnerRef,";

  if (!sdkCode.includes(needle)) {
    console.error("[patch-pi-sdk] patch 1 needle not found — sdk.js structure changed");
    process.exit(1);
  }

  sdkCode = sdkCode.replace(needle, replacement);
  fs.writeFileSync(sdkTarget, sdkCode, "utf8");
  console.log("[patch-pi-sdk] patch 1 applied: baseToolsOverride wired through");
}

// 验证 patch 1
const verifiedSdk = fs.readFileSync(sdkTarget, "utf8");
if (!verifiedSdk.includes("baseToolsOverride")) {
  console.error("[patch-pi-sdk] patch 1 verification failed: baseToolsOverride not found after patching");
  process.exit(1);
}

// ── 直接引用扫描 ──
// 检测 lib/pi-sdk/ 之外是否有文件直接 import "@mariozechner/"

const SCAN_DIRS = ["core", "server", "lib", "hub"].map(d => path.join(__dirname, "..", d));
const ADAPTER_DIR = path.join(__dirname, "..", "lib", "pi-sdk");
const SDK_PATTERN = /@mariozechner\//;
let leaks = 0;

function scanDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === ADAPTER_DIR || entry.name === "node_modules") continue;
      scanDir(full);
    } else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) {
      const content = fs.readFileSync(full, "utf8");
      if (SDK_PATTERN.test(content)) {
        console.warn(`[patch-pi-sdk] WARN: direct SDK reference in ${path.relative(path.join(__dirname, ".."), full)}`);
        leaks++;
      }
    }
  }
}

for (const d of SCAN_DIRS) scanDir(d);
if (leaks > 0) {
  console.warn(`[patch-pi-sdk] ${leaks} file(s) bypass adapter — migrate to lib/pi-sdk/index.js`);
}

console.log("[patch-pi-sdk] all patches verified ✓");
