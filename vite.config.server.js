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
        "mammoth",
        "fsevents",

        // qrcode: 有 browser/node 双入口，Vite 会选 browser 版（期望 DOM canvas）。
        // 服务端需要 Node.js 版（纯 JS 渲染），必须走 npm 原生解析。
        "qrcode",
      ],
      output: {
        // 所有源码模块全部合并到一个文件。
        // 这个项目 shared/core/lib/hub 之间交叉引用太多，
        // 任何 chunk 拆分都会导致循环依赖的 TDZ ReferenceError。
        inlineDynamicImports: true,
      },
    },
    target: "node22",
    // esbuild minify 只做标识符缩短和空白移除，不做 tree-shaking 变换，
    // 不会触发 inlineDynamicImports 场景下的 TDZ ReferenceError。
    minify: "esbuild",
    sourcemap: false,
  },
  logLevel: "info",
});
