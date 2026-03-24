#!/usr/bin/env node
/**
 * build-server.mjs — 构建 server 独立分发包
 *
 * 产出结构：
 *   dist-server/{platform}-{arch}/
 *     hana-server           ← shell wrapper
 *     hana-server.mjs       ← esbuild bundle
 *     node_modules/         ← external deps (native addon + PI SDK)
 *     desktop/src/locales/  ← i18n 资源
 *     lib/                  ← JSON 资源文件
 *     skills2set/           ← 技能包
 */
import { build } from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;
const outDir = path.join(ROOT, "dist-server", `${platform}-${arch}`);

console.log(`[build-server] Building for ${platform}-${arch}...`);

// 清理
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// ── 1. esbuild bundle ──
await build({
  entryPoints: [path.join(ROOT, "server", "index.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: path.join(outDir, "hana-server.mjs"),
  external: [
    "better-sqlite3",
    "@mariozechner/*",
  ],
  banner: {
    js: `import { createRequire } from "module"; const require = createRequire(import.meta.url);`,
  },
  sourcemap: false,
  minify: false,
});
console.log("[build-server] esbuild bundle done");

// ── 2. 复制 external 依赖 ──
// Copy the @mariozechner scope (PI SDK + all its deps)
const scopeSrc = path.join(ROOT, "node_modules", "@mariozechner");
const scopeDst = path.join(outDir, "node_modules", "@mariozechner");
if (fs.existsSync(scopeSrc)) {
  fs.cpSync(scopeSrc, scopeDst, { recursive: true });
}

// Copy better-sqlite3 (native addon)
const betterSqlite3Src = path.join(ROOT, "node_modules", "better-sqlite3");
const betterSqlite3Dst = path.join(outDir, "node_modules", "better-sqlite3");
if (fs.existsSync(betterSqlite3Src)) {
  fs.cpSync(betterSqlite3Src, betterSqlite3Dst, { recursive: true });
}

// Copy any transitive deps that PI SDK needs but aren't bundled
// List common ones that are likely native or have specific file structures
const piSdkDeps = ["bindings", "file-uri-to-path", "prebuild-install", "node-addon-api"];
for (const dep of piSdkDeps) {
  const src = path.join(ROOT, "node_modules", dep);
  const dst = path.join(outDir, "node_modules", dep);
  if (fs.existsSync(src) && !fs.existsSync(dst)) {
    fs.cpSync(src, dst, { recursive: true });
  }
}

console.log("[build-server] external deps copied");

// ── 3. 复制资源文件 ──
// i18n locales
const localesSrc = path.join(ROOT, "desktop", "src", "locales");
const localesDst = path.join(outDir, "desktop", "src", "locales");
fs.mkdirSync(localesDst, { recursive: true });
fs.cpSync(localesSrc, localesDst, { recursive: true });

// JSON 配置文件
for (const file of ["known-models.json", "default-models.json"]) {
  const src = path.join(ROOT, "lib", file);
  if (fs.existsSync(src)) {
    const dst = path.join(outDir, "lib", file);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

// skills2set
const skillsSrc = path.join(ROOT, "skills2set");
if (fs.existsSync(skillsSrc)) {
  fs.cpSync(skillsSrc, path.join(outDir, "skills2set"), { recursive: true });
}

console.log("[build-server] resources copied");

// ── 4. 创建 wrapper 脚本 ──
if (platform === "win32") {
  fs.writeFileSync(
    path.join(outDir, "hana-server.cmd"),
    `@echo off\r\n"%~dp0node.exe" "%~dp0hana-server.mjs" %*\r\n`,
  );
} else {
  const wrapper = path.join(outDir, "hana-server");
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/hana-server.mjs" "$@"\n`,
  );
  fs.chmodSync(wrapper, 0o755);
}
console.log("[build-server] wrapper created");

// ── 5. Node.js runtime ──
console.log(`[build-server] ⚠ 请手动将 Node.js ${platform}-${arch} runtime 放到 ${outDir}/node`);
console.log("[build-server] 下载地址: https://nodejs.org/dist/latest-v22.x/");
console.log("[build-server] Done!");
