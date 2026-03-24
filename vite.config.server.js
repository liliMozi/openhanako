import { defineConfig } from "vite";
import { builtinModules } from "module";

const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

export default defineConfig({
  build: {
    lib: {
      entry: "server/index.js",
      formats: ["es"],
      fileName: () => "index.js",
    },
    outDir: "dist-server-bundle",
    rollupOptions: {
      external: [
        ...nodeBuiltins,
        "better-sqlite3",

        // ws: CJS package, Rollup's CJS→ESM interop loses WebSocketServer
        // named export. Keep external — available as PI SDK transitive dep.
        "ws",
        /^@mariozechner\//,
        "@silvia-odwyer/photon-node",
        "@larksuiteoapi/node-sdk",
        "node-telegram-bot-api",
        "exceljs",
        "fsevents",
      ],
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash:8].js",
        // Provider plugins (lib/providers/) must be in the same chunk as
        // provider-registry (core/) to avoid TDZ from circular init order.
        // shared/ gets its own chunk since it has no circular deps with others.
        manualChunks(id) {
          if (id.includes("/node_modules/")) return undefined;
          if (id.includes("/shared/")) return "shared";
          // core + lib (including providers) in one chunk to avoid TDZ
          if (id.includes("/core/") || id.includes("/lib/")) return "core";
          if (id.includes("/hub/")) return "hub";
        },
      },
    },
    target: "node22",
    minify: false,
    sourcemap: false,
  },
  logLevel: "info",
});
