/**
 * browser-manager.js — 浏览器生命周期管理
 *
 * 单例模式。运行在 server 进程中，通过可插拔的 transport 层与
 * 浏览器宿主通信（IPC for fork 模式 / WS for spawn 模式）。
 *
 * 好处：
 * - 浏览器直接嵌在 Electron 窗口里，用户可以实时看到并交互
 * - Cookies / localStorage 由 Electron session 持久化
 * - 不依赖 Playwright（不需要下载 Chromium 二进制）
 *
 * session 绑定：
 * - 每个 chat session 可以独立拥有自己的浏览器实例
 * - 切换 session 时，浏览器被挂起（不销毁），切回来直接恢复
 * - 页面状态（表单、滚动位置等）完全保留
 * - 重启后通过冷保存的 URL 自动恢复浏览器
 *
 * snapshot 实现：主进程通过 webContents.executeJavaScript() 遍历 DOM，
 * 给交互元素注入 data-hana-ref 属性。
 */
import crypto from "crypto";
import os from "os";
import path from "path";
import fs from "fs";
import { t } from "../../server/i18n.js";
import { IpcTransport, WsTransport } from "./browser-transport.js";

// ── 单例 ──
let _instance = null;
let _sessionResolver = null; // () => string — 返回当前 sessionPath

// 冷保存文件：重启后恢复浏览器状态
const _browserHome = process.env.HANA_HOME
  ? path.resolve(process.env.HANA_HOME.replace(/^~/, os.homedir()))
  : path.join(os.homedir(), ".hanako");
const COLD_STATE_PATH = path.join(_browserHome, "user", "browser-sessions.json");

export class BrowserManager {
  constructor() {
    this._running = false;
    this._url = null;
    this._headless = false; // 后台模式：浏览器运行但不弹窗
    this._pending = new Map(); // id → { resolve, reject, timer }

    // 根据环境选择 transport：fork 模式用 IPC，spawn 模式用 WS
    this._transport = process.send ? new IpcTransport() : new WsTransport();

    // 注册消息处理器（IPC 立即生效，WS 在 attach 时生效）
    this._transport.onMessage((msg) => {
      if (msg?.type === "browser-result" && this._pending.has(msg.id)) {
        const entry = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error));
        else entry.resolve(msg.result);
      }
    });
  }

  /** 获取单例 */
  static instance() {
    if (!_instance) _instance = new BrowserManager();
    return _instance;
  }

  /**
   * 注入 session 路径解析器（避免循环依赖）
   * @param {() => string} fn - 返回当前 engine.currentSessionPath
   */
  static setSessionResolver(fn) {
    _sessionResolver = fn;
  }

  /** 浏览器是否正在运行 */
  get isRunning() {
    return this._running;
  }

  /** 是否后台模式 */
  get isHeadless() {
    return this._headless;
  }

  /** 设置后台模式（后台任务调用前设 true，结束后设 false） */
  setHeadless(val) {
    this._headless = !!val;
  }

  /** 当前页面 URL */
  get currentUrl() {
    return this._url;
  }

  /** 获取当前 session 路径 */
  _getCurrentSession() {
    return _sessionResolver ? _sessionResolver() : null;
  }

  // ════════════════════════════
  //  冷保存（磁盘持久化）
  // ════════════════════════════

  _loadColdState() {
    try {
      return JSON.parse(fs.readFileSync(COLD_STATE_PATH, "utf-8"));
    } catch {
      return {};
    }
  }

  _saveColdState(state) {
    try {
      fs.writeFileSync(COLD_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
    } catch {}
  }

  _saveColdUrl(sessionPath, url) {
    if (!sessionPath || !url) return;
    const state = this._loadColdState();
    state[sessionPath] = url;
    this._saveColdState(state);
  }

  _removeColdUrl(sessionPath) {
    if (!sessionPath) return;
    const state = this._loadColdState();
    delete state[sessionPath];
    this._saveColdState(state);
  }

  /**
   * 获取所有有浏览器的 session（活跃 + 冷保存）
   * @returns {{ [sessionPath: string]: string }} sessionPath → url
   */
  getBrowserSessions() {
    const state = this._loadColdState();
    // 合入当前活跃的
    const session = this._getCurrentSession();
    if (this._running && session && this._url) {
      state[session] = this._url;
    }
    return state;
  }

  // ════════════════════════════
  //  Transport
  // ════════════════════════════

  /**
   * 注入 WS transport（server 启动时调用）
   * @param {import("ws").WebSocket|null} ws
   */
  setWsTransport(ws) {
    const transport = this._transport;
    if (transport instanceof WsTransport) {
      if (ws) {
        transport.attach(ws);
        // handler 已在构造函数中通过 onMessage 注册，attach 会自动绑定
      } else {
        transport.detach();
      }
    }
  }

  /**
   * 向浏览器宿主发送命令并等待结果
   * @param {string} cmd - 命令名
   * @param {object} params - 参数
   * @param {number} timeoutMs - 超时（默认 30s）
   * @returns {Promise<any>}
   */
  _sendCmd(cmd, params = {}, timeoutMs = 30000) {
    if (!this._transport.connected) {
      throw new Error(t("error.browserDesktopOnly"));
    }
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(t("error.browserCmdTimeout", { cmd })));
        }
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._transport.send({ type: "browser-cmd", id, cmd, params });
    });
  }

  // ════════════════════════════
  //  生命周期
  // ════════════════════════════

  async launch() {
    if (this._running) return;
    const sessionPath = this._getCurrentSession();
    await this._sendCmd("launch", { sessionPath, headless: this._headless });
    this._running = true;
    console.log("[browser] 浏览器已启动", this._headless ? "(headless)" : "");
  }

  async close() {
    if (!this._running) return;
    const session = this._getCurrentSession();
    try { await this._sendCmd("close"); } catch {}
    this._running = false;
    this._url = null;
    // 从冷保存中移除
    this._removeColdUrl(session);
    console.log("[browser] 浏览器已关闭");
  }

  /**
   * 挂起浏览器：从窗口上摘下来，但不销毁（页面状态完全保留）
   * 同时写入冷保存，确保重启后也能恢复
   * @param {string} sessionPath - 当前 session 路径
   */
  async suspendForSession(sessionPath) {
    if (!this._running) return;
    // 冷保存 URL
    this._saveColdUrl(sessionPath, this._url);
    console.log("[browser] 挂起浏览器");
    try { await this._sendCmd("suspend", { sessionPath }); } catch {}
    this._running = false;
    this._url = null;
  }

  /**
   * 恢复浏览器：先尝试热恢复（view 还活着），失败则冷恢复（launch + navigate）
   * @param {string} sessionPath - 目标 session 路径
   */
  async resumeForSession(sessionPath) {
    if (!sessionPath) return;

    // 1. 热恢复：view 还在内存中
    const result = await this._sendCmd("resume", { sessionPath });
    if (result.found) {
      this._running = true;
      this._url = result.url || null;
      console.log("[browser] 热恢复成功");
      return;
    }

    // 2. 冷恢复：从磁盘读 URL，重新 launch + navigate
    const coldState = this._loadColdState();
    const savedUrl = coldState[sessionPath];
    if (!savedUrl) return; // 该 session 没有浏览器状态，跳过

    console.log("[browser] 冷恢复");
    await this._sendCmd("launch", { sessionPath });
    this._running = true;
    try {
      const nav = await this._sendCmd("navigate", { url: savedUrl });
      this._url = nav.url;
    } catch {
      this._url = savedUrl;
    }
  }

  /**
   * 关闭指定 session 的浏览器（从卡片上的关闭按钮调用）
   * @param {string} sessionPath - 目标 session 路径
   */
  async closeBrowserForSession(sessionPath) {
    const currentSession = this._getCurrentSession();
    // 如果是当前活跃的浏览器
    if (this._running && currentSession === sessionPath) {
      await this.close();
      return;
    }
    // 销毁挂起的 view
    try { await this._sendCmd("destroyView", { sessionPath }); } catch {}
    // 从冷保存中移除
    this._removeColdUrl(sessionPath);
    console.log("[browser] 已关闭 session 浏览器");
  }

  // ════════════════════════════
  //  导航
  // ════════════════════════════

  /**
   * @param {string} url
   * @returns {Promise<{ url: string, title: string, snapshot: string }>}
   */
  async navigate(url) {
    const result = await this._sendCmd("navigate", { url });
    this._url = result.url;
    // 更新冷保存
    const session = this._getCurrentSession();
    this._saveColdUrl(session, this._url);
    return result; // { url, title, snapshot }
  }

  // ════════════════════════════
  //  感知
  // ════════════════════════════

  /** @returns {Promise<string>} 文本格式的页面树 */
  async snapshot() {
    const result = await this._sendCmd("snapshot");
    this._url = result.currentUrl;
    return result.text;
  }

  /** @returns {Promise<{ base64: string, mimeType: string }>} */
  async screenshot() {
    const result = await this._sendCmd("screenshot");
    return { base64: result.base64, mimeType: "image/jpeg" };
  }

  /** @returns {Promise<string|null>} 缩略图 base64 */
  async thumbnail() {
    try {
      const result = await this._sendCmd("thumbnail");
      return result.base64;
    } catch {
      return null;
    }
  }

  // ════════════════════════════
  //  交互（每个操作后自动 snapshot）
  // ════════════════════════════

  /** @returns {Promise<string>} 新的 snapshot */
  async click(ref) {
    const result = await this._sendCmd("click", { ref });
    this._url = result.currentUrl;
    return result.text;
  }

  /** @returns {Promise<string>} 新的 snapshot */
  async type(text, ref, { pressEnter = false } = {}) {
    const result = await this._sendCmd("type", { text, ref, pressEnter });
    this._url = result.currentUrl;
    return result.text;
  }

  /** @returns {Promise<string>} 新的 snapshot */
  async scroll(direction, amount = 3) {
    const result = await this._sendCmd("scroll", { direction, amount });
    return result.text;
  }

  /** @returns {Promise<string>} 新的 snapshot */
  async select(ref, value) {
    const result = await this._sendCmd("select", { ref, value });
    return result.text;
  }

  /** @returns {Promise<string>} 新的 snapshot */
  async pressKey(key) {
    const result = await this._sendCmd("pressKey", { key });
    return result.text;
  }

  // ════════════════════════════
  //  辅助
  // ════════════════════════════

  /** @returns {Promise<string>} 新的 snapshot */
  async wait(opts = {}) {
    const result = await this._sendCmd("wait", opts);
    return result.text;
  }

  /** @returns {Promise<string>} 序列化的执行结果 */
  async evaluate(expression) {
    const result = await this._sendCmd("evaluate", { expression });
    return result.value;
  }

  /** 将浏览器 viewer 窗口置前 */
  async show() {
    await this._sendCmd("show");
  }
}
