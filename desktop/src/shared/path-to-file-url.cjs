/**
 * path-to-file-url.cjs — 本地文件路径 → file:// URL
 *
 * 纯字符串转换，无 IPC、无 fs，方便单测。被 preload.cjs 的 getFileUrl
 * 复用（preload 走 contextBridge，无法在 vitest 直接加载，故拆出）。
 *
 * ⚠️ 扩展名必须是 .cjs：根 package.json 有 "type": "module"，.js
 * 会被 Node 当成 ESM 解析，module.exports 失效 → preload require
 * 拿到空对象 → getFileUrl 调用时崩溃 → window.platform 挂不上
 * → splash 永远不关。参见 `main.cjs` 同样 require("./auto-updater.cjs")。
 *
 * 覆盖三类路径：
 *   - POSIX：/home/u/a.mp4                → file:///home/u/a.mp4
 *   - Windows 盘符：C:\Users\foo.mp4      → file:///C:/Users/foo.mp4
 *   - Windows UNC：\\server\share\a.mp4   → file://server/share/a.mp4 (RFC 8089)
 *
 * 编码策略：先 encodeURI（保留 `/`、编码空格/中文等），再手工替换
 * encodeURI 不会动的 URL 保留字符（`#`、`?`），避免 `<video src>` 被
 * 当成 fragment / query 截断。
 */

function encodePath(s) {
  // encodeURI 不编码 # 和 ?，对 file:// URL 而言这两个必须编码
  return encodeURI(s).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

function pathToFileUrl(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return "";
  const normalized = filePath.replace(/\\/g, "/");
  const encoded = encodePath(normalized);
  // UNC：//server/share/... → file://server/share/...
  if (normalized.startsWith("//")) {
    return `file:${encoded}`;
  }
  // Windows 盘符：C:/Users/... → file:///C:/Users/...
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${encoded}`;
  }
  // POSIX：/home/u/a.mp4 → file:///home/u/a.mp4
  return `file://${encoded}`;
}

module.exports = { pathToFileUrl };
