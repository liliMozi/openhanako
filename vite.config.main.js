import { defineConfig } from "vite";
import { builtinModules } from "module";

const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

export default defineConfig({
  build: {
    lib: {
      entry: "desktop/main.cjs",
      formats: ["cjs"],
      fileName: () => "main.bundle.cjs",
    },
    // Output to the same directory as source — preserves __dirname semantics
    // (main.cjs uses __dirname extensively for preload, assets, locales, etc.)
    outDir: "desktop",
    emptyOutDir: false,
    rollupOptions: {
      external: [
        "electron",
        ...nodeBuiltins,

        // ws: CJS native addon (bufferutil/utf-8-validate) breaks when bundled.
        // Keep external — Electron runtime resolves from node_modules.
        "ws",

        // mammoth / exceljs: large CJS deps with deep dependency trees.
        // Kept external — electron-builder includes them from node_modules.
        "mammoth",
        "exceljs",
      ],
    },
    target: "node22",
    minify: "esbuild",
    sourcemap: false,
  },

  // Force Node.js resolution: include "node" condition and exclude "browser"
  // to prevent ws and similar packages from resolving to browser stubs.
  resolve: {
    conditions: ["node", "import", "module", "require", "default"],
    mainFields: ["main", "module"],
  },
});
