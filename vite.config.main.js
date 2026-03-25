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

        // mammoth / exceljs: large CJS deps with deep dependency trees.
        // Kept external — electron-builder includes them from node_modules.
        "mammoth",
        "exceljs",
      ],
    },
    target: "node22",
    minify: false,
    sourcemap: false,
  },

  // Force Node.js resolution for ws and similar packages that ship browser stubs.
  // Vite defaults include "browser" condition which resolves ws → ws/browser.js
  // (a stub that throws). Override to use only Node-appropriate conditions.
  resolve: {
    conditions: ["node", "require"],
    mainFields: ["main", "module"],
  },
});
