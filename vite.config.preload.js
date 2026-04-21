import { defineConfig } from "vite";

/**
 * Preload 打包配置 — 业界标准做法。
 *
 * Electron 20+ 默认开启 preload sandbox，sandboxed preload 的 require
 * 只允许 Electron 内置模块（electron/events 等），任何用户文件（无论
 * .js/.cjs/.mjs）都会抛 "module not found"。
 *
 * 解决方案：把 preload 也经过 bundler，所有依赖内联成自给自足的单文件，
 * Electron 运行时只看到一个文件，sandbox 限制自然绕过。
 *
 * 源：desktop/preload.cjs（可自由 require 相对路径、import 外部模块）
 * 出：desktop/preload.bundle.cjs（所有业务代码内联，仅 electron external）
 *
 * main.cjs 里所有 BrowserWindow 的 webPreferences.preload 必须指向
 * preload.bundle.cjs（而不是 preload.cjs 源文件）。
 */
export default defineConfig({
  build: {
    lib: {
      entry: "desktop/preload.cjs",
      formats: ["cjs"],
      fileName: () => "preload.bundle.cjs",
    },
    // Output into desktop/ alongside main.bundle.cjs — keeps __dirname semantics
    // and aligns with electron-builder files[] config.
    outDir: "desktop",
    emptyOutDir: false,
    rollupOptions: {
      // Only electron is external — sandboxed preload can't require anything else.
      // All user files (e.g. src/shared/path-to-file-url.cjs) MUST be inlined.
      external: ["electron"],
    },
    target: "node22",
    minify: "esbuild",
    sourcemap: false,
  },

  resolve: {
    conditions: ["node", "import", "module", "require", "default"],
    mainFields: ["main", "module"],
  },
});
