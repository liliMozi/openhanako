/**
 * boot.cjs — ESM 启动包装器
 *
 * 用 CJS 包装 ESM 入口，捕获模块加载阶段的错误。
 * ESM 的 static import 失败时进程直接崩溃，无法输出任何诊断信息。
 * CJS 的 dynamic import() 可以 catch，让错误信息通过 stderr 传回 main 进程。
 */
(async () => {
  try {
    await import("./index.js");
  } catch (err) {
    console.error(`[server] 启动失败: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
})();
