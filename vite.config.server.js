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
        // 所有源码模块全部合并到一个文件。
        // 这个项目 shared/core/lib/hub 之间交叉引用太多，
        // 任何 chunk 拆分都会导致循环依赖的 TDZ ReferenceError。
        inlineDynamicImports: true,
      },
    },
    target: "node22",
    minify: false,
    sourcemap: false,
  },
  logLevel: "info",
});
