# 打包架构

> v0.67.1，Hono + Vite bundle + @vercel/nft 追踪

## HTTP 框架

- **Hono**：纯 ESM、零依赖、14KB，可被 Vite bundle
- 路由模式：`export function createXxxRoute(engine) { const route = new Hono(); ... return route; }`，index.js 用 `app.route("/api", route)` 注册
- WebSocket：chat.js 拆分为 `restRoute`（挂 `/api`）+ `wsRoute`（挂根路径 `/ws`）；internal-browser 用原生 `ws.WebSocketServer`（WsTransport 需要 `.on()/.off()` 事件方法）
- Body 解析：`safeJson(c)` 工具函数（`server/hono-helpers.js`），替代 Fastify 的自动 `req.body`

## 三条构建管线

| 管线 | 配置文件 | 入口 | 输出 | 格式 |
|------|----------|------|------|------|
| Server | `vite.config.server.js` | `server/index.js` | `dist-server-bundle/index.js` | ES module 单文件 |
| Main | `vite.config.main.js` | `desktop/main.cjs` | `desktop/main.bundle.cjs` | CJS 单文件 |
| Renderer | `vite.config.ts` | `desktop/src/` | `dist-renderer/` | 多文件 SPA |

### Server bundle

`vite.config.server.js`，lib mode + `inlineDynamicImports: true`，输出单文件 `index.js`（~1.2MB）。

不用 `manualChunks`（shared↔core 循环依赖导致 TDZ）；不用 SSR 模式（默认 externalize 所有 npm 包）。三个有问题的动态 import 已改为静态 import（engine.js、model-manager.js、bridge.js）。

### Electron main bundle

`vite.config.main.js`，lib mode CJS，输出到 `desktop/` 同级目录保持 `__dirname` 正确。

`resolve.conditions: ["node", "require"]` + `mainFields: ["main", "module"]`，防止 ws 等包被解析到 browser stub。ws 被**打进 bundle**（不是 external），mammoth 和 exceljs 保持 external（electron-builder 从 node_modules 包含）。

asar 内零 node_modules（`files` 配置排除 `!**/node_modules/**`）。

### build-server.mjs 流程

1. 下载/缓存 Node.js v22 runtime（ABI 匹配 better-sqlite3）
2. Vite bundle server 源码 → `dist-server-bundle/`
3. 复制资源文件（`lib/*.json`、`lib/*.yaml`、`lib/*.md`、模板目录、locales、skills2set）
4. npm install external 依赖（从 `package.json` 的 `serverExternalDeps` 字段读取）
5. PI SDK patch
6. 清理 .bin 目录
7. **@vercel/nft 追踪**：从 bundle 入口分析运行时需要的文件，删除未追踪的（24,000 → 3,400 文件）
8. **koffi 多平台清理**：只保留当前构建目标平台的 .node 二进制，删除其余 17 个平台的
9. 更新 `bundle/package.json` 版本号
10. 生成 wrapper 脚本（入口指向 `bundle/index.js`）

`electron-builder` 配置：`extraMetadata.main` 覆盖为 `desktop/main.bundle.cjs`（开发时 `main` 仍指向源码 `desktop/main.cjs`）。

## Server external 依赖

| 包 | 原因 |
|---|------|
| better-sqlite3 | native addon（.node 二进制）|
| ws | CJS 包，Rollup 打包后丢失 WebSocketServer named export |
| @mariozechner/* | jiti 动态加载 + WASM |
| @silvia-odwyer/photon-node | WASM native 模块 |
| @larksuiteoapi/node-sdk | protobufjs 动态 require |
| node-telegram-bot-api | 大型 CJS 依赖树（@cypress/request）|
| exceljs | 大型依赖树，动态 import 保留懒加载 |
| fsevents | macOS 可选 native 模块 |

## Main external 依赖

| 包 | 原因 |
|---|------|
| electron | Electron 运行时提供 |
| mammoth | 大型 CJS 依赖树 |
| exceljs | 大型依赖树 |

## @vercel/nft 注意事项

- 项目源码全部使用固定字符串路径的 import/require，nft 能完整追踪
- PI SDK 的 jiti 和飞书 SDK 的 protobufjs 是第三方包行为，作为 external 保留完整 node_modules，不受 nft 影响
- Windows CI 上 nft 可能因用户目录不存在而报错，已加 try/catch 降级为跳过裁剪
- **新增 npm 依赖时**：纯 JS 包 → Vite 自动 bundle，无需配置；native/不可 bundle 的包 → 加到 `vite.config.server.js` external 列表 + `package.json` 的 `serverExternalDeps`
- **如果新包使用动态路径加载**（`require(variable)`），需加入 external 或为 nft 添加 hint

## macOS 签名须知

- `@electron/osx-sign` 会对 .app 内所有二进制文件**逐个**调用 `codesign --timestamp`（每次网络往返 ~0.4s）
- Electron 38 有 ~300 个 locale.pak + 框架二进制需要签名，总计约 **3-5 分钟**。签名过程中 electron-builder **不输出任何进度日志**，看起来像卡死，但实际在正常工作
- koffi 包自带 18 个平台的 .node 二进制。非当前平台的 ELF/PE 格式文件会导致 codesign 报错。`build-server.mjs` 已在构建时清理
- CI 上使用手动 keychain 配置 + `set-key-partition-list` 防止 codesign 弹 UI 确认框挂起
- 本地 ad-hoc 签名（`install:local`）会弹 Keychain 确认框，点"始终允许"即可
