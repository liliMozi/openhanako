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
      ],
    },
    target: "node22",
    minify: false,
    sourcemap: false,
  },
});
