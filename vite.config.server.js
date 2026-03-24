import { defineConfig } from "vite";
import { builtinModules } from "module";

// Node.js built-in modules (with and without node: prefix)
const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

export default defineConfig({
  build: {
    ssr: "server/index.js",
    outDir: "dist-server-bundle",
    rollupOptions: {
      external: [
        // Node.js built-in modules
        ...nodeBuiltins,

        // Native addons
        "better-sqlite3",

        // PI SDK ecosystem (jiti runtime loading + WASM photon-node)
        /^@mariozechner\//,
        "@silvia-odwyer/photon-node",

        // Lark/Feishu SDK (protobufjs dynamic require)
        "@larksuiteoapi/node-sdk",

        // Telegram bot (large CJS dep tree via @cypress/request)
        "node-telegram-bot-api",

        // ExcelJS (large dep tree, dynamically imported — preserve lazy load)
        "exceljs",

        // macOS native file watcher (optional, may not be installed)
        "fsevents",
      ],
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash:8].js",
        // Force shared source modules into dedicated chunks so that dynamic
        // import chunks never need to import back from the entry — this
        // prevents circular chunk references that cause runtime hangs.
        manualChunks(id) {
          if (id.includes("/node_modules/")) return undefined; // let Rollup decide
          if (id.includes("/shared/")) return "shared";
          if (id.includes("/core/")) return "core";
          if (id.includes("/lib/")) return "lib";
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
