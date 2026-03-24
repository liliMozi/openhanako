/**
 * browser-transport.js — BrowserManager 通信传输层
 *
 * 抽象 IPC 和 WS 两种传输方式，BrowserManager 只依赖 transport 接口。
 *
 * @typedef {Object} BrowserTransport
 * @property {(msg: object) => void} send
 * @property {(handler: (msg: object) => void) => void} onMessage
 * @property {boolean} connected
 */

/** 基于 Node IPC 的传输（fork 模式，现有行为） */
export class IpcTransport {
  get connected() {
    return typeof process.send === "function";
  }

  send(msg) {
    process.send(msg);
  }

  onMessage(handler) {
    process.on("message", (msg) => {
      if (msg?.type === "browser-result") handler(msg);
    });
  }
}

/** 基于 WebSocket 的传输（spawn 模式） */
export class WsTransport {
  constructor() {
    this._ws = null;
    this._handler = null;
    this._boundListener = null;
  }

  get connected() {
    return this._ws?.readyState === 1; // WebSocket.OPEN
  }

  /** 由 server 启动时注入 ws 实例 */
  attach(ws) {
    // 先清理旧 listener
    if (this._ws && this._boundListener) {
      this._ws.off("message", this._boundListener);
    }
    this._ws = ws;
    if (this._handler && ws) {
      this._boundListener = (data) => {
        try { this._handler(JSON.parse(data)); } catch {}
      };
      ws.on("message", this._boundListener);
    }
  }

  detach() {
    if (this._ws && this._boundListener) {
      this._ws.off("message", this._boundListener);
    }
    this._ws = null;
    this._boundListener = null;
  }

  send(msg) {
    if (!this._ws) throw new Error("Browser WS transport not connected");
    this._ws.send(JSON.stringify(msg));
  }

  onMessage(handler) {
    this._handler = handler;
    // 如果 ws 已存在，立即绑定
    if (this._ws) {
      this.attach(this._ws);
    }
  }
}
