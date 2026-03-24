/**
 * internal-browser.js — Electron↔Server 浏览器控制 WS 通道
 *
 * Electron main 进程连接此 endpoint 后，server 的 BrowserManager
 * 通过此 WS 发送 browser-cmd，Electron 执行后回传 browser-result。
 *
 * 认证由 server/index.js 的全局 onRequest hook 统一处理，
 * WS 升级请求同样经过该 hook（通过 URL 参数 ?token=xxx）。
 */
import { BrowserManager } from "../../lib/browser/browser-manager.js";

export default async function internalBrowserRoute(app) {
  app.get("/internal/browser", { websocket: true }, (socket) => {
    console.log("[server] Electron browser control WS connected");

    const bm = BrowserManager.instance();
    bm.setWsTransport(socket);

    socket.on("close", () => {
      console.log("[server] Electron browser control WS disconnected");
      bm.setWsTransport(null);
    });
  });
}
