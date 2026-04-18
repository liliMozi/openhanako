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
 * 多实例支持：
 * - 内部状态通过 Map 管理，每个 sessionPath 独立维护 running/url/headless
 * - 最多 MAX_INSTANCES 个并发浏览器，超出时 LRU 淘汰最久未用的
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

// 冷保存文件：重启后恢复浏览器状态（由 setHanakoHome 注入路径）
let _hanakoHome = null;
const _coldStatePath = () => path.join(_hanakoHome, "user", "browser-sessions.json");

// 最大并发浏览器实例数
const MAX_INSTANCES = 5;

export class BrowserManager {
  constructor() {
    this._sessions = new Map(); // sessionPath → { running, url, headless }
    this._lruOrder = [];        // sessionPath[], 最近使用的在末尾
    this._headless = false;     // 全局后台模式标记
    this._pending = new Map();  // id → { resolve, reject, timer }

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
   * 注入用户数据根目录（由入口在启动时调用）
   * @param {string} home - engine.hanakoHome
   */
  static setHanakoHome(home) {
    _hanakoHome = home;
  }

  // ════════════════════════════
  //  per-session 状态查询
  // ════════════════════════════

  /**
   * 指定 session 是否正在运行
   * @param {string} sessionPath
   * @returns {boolean}
   */
  isRunning(sessionPath) {
    const entry = this._sessions.get(sessionPath);
    return !!(entry && entry.running);
  }

  /**
   * 指定 session 当前页面 URL
   * @param {string} sessionPath
   * @returns {string|null}
   */
  currentUrl(sessionPath) {
    const entry = this._sessions.get(sessionPath);
    return entry?.url || null;
  }

  /** 任意 session 是否在运行 */
  get hasAnyRunning() {
    for (const entry of this._sessions.values()) {
      if (entry.running) return true;
    }
    return false;
  }

  /** 返回所有 running session 的 sessionPath 数组 */
  get runningSessions() {
    const result = [];
    for (const [sp, entry] of this._sessions) {
      if (entry.running) result.push(sp);
    }
    return result;
  }

  /** 是否后台模式 */
  get isHeadless() {
    return this._headless;
  }

  /** 设置后台模式（后台任务调用前设 true，结束后设 false） */
  setHeadless(val) {
    this._headless = !!val;
  }

  // ════════════════════════════
  //  LRU 管理
  // ════════════════════════════

  /** 将 sessionPath 移到 LRU 末尾（最近使用） */
  _touchLru(sessionPath) {
    const idx = this._lruOrder.indexOf(sessionPath);
    if (idx !== -1) this._lruOrder.splice(idx, 1);
    this._lruOrder.push(sessionPath);
  }

  /** 移除 sessionPath 从 LRU 列表 */
  _removeLru(sessionPath) {
    const idx = this._lruOrder.indexOf(sessionPath);
    if (idx !== -1) this._lruOrder.splice(idx, 1);
  }

  /** 淘汰最久未用的 running session（挂起它），返回是否成功 */
  async _evictLru() {
    // 从 LRU 头部找第一个 running 的 session 淘汰
    for (const sp of this._lruOrder) {
      const entry = this._sessions.get(sp);
      if (entry && entry.running) {
        console.log("[browser] LRU 淘汰:", sp);
        await this.suspendForSession(sp);
        return true;
      }
    }
    console.warn("[browser] LRU eviction found no running session to evict");
    return false;
  }

  // ════════════════════════════
  //  冷保存（磁盘持久化）
  // ════════════════════════════

  _loadColdState() {
    try {
      return JSON.parse(fs.readFileSync(_coldStatePath(), "utf-8"));
    } catch {
      return {};
    }
  }

  _saveColdState(state) {
    try {
      fs.writeFileSync(_coldStatePath(), JSON.stringify(state, null, 2) + "\n");
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
    // 合入所有活跃且有 URL 的 session
    for (const [sp, entry] of this._sessions) {
      if (entry.running && entry.url) {
        state[sp] = entry.url;
      }
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

  async launch(sessionPath) {
    // 已在运行 → 直接返回
    const existing = this._sessions.get(sessionPath);
    if (existing && existing.running) {
      this._touchLru(sessionPath);
      return;
    }

    // 并发数检查：running 数量 ≥ MAX_INSTANCES → LRU 淘汰
    if (this.runningSessions.length >= MAX_INSTANCES) {
      const evicted = await this._evictLru();
      if (!evicted && this.runningSessions.length >= MAX_INSTANCES) {
        throw new Error(`Browser limit reached: max ${MAX_INSTANCES} concurrent instances`);
      }
    }

    await this._sendCmd("launch", { sessionPath, headless: this._headless });

    // 更新 Map
    this._sessions.set(sessionPath, {
      running: true,
      url: existing?.url || null,
      headless: this._headless,
    });
    this._touchLru(sessionPath);

    console.log("[browser] 浏览器已启动", sessionPath, this._headless ? "(headless)" : "");
  }

  async close(sessionPath) {
    const entry = this._sessions.get(sessionPath);
    if (!entry || !entry.running) return;

    try { await this._sendCmd("close", { sessionPath }); } catch {}

    // 从 Map 和 LRU 中移除
    this._sessions.delete(sessionPath);
    this._removeLru(sessionPath);
    // 从冷保存中移除
    this._removeColdUrl(sessionPath);

    console.log("[browser] 浏览器已关闭", sessionPath);
  }

  /**
   * 挂起浏览器：从窗口上摘下来，但不销毁（页面状态完全保留）
   * 同时写入冷保存，确保重启后也能恢复
   * @param {string} sessionPath - 目标 session 路径
   */
  async suspendForSession(sessionPath) {
    const entry = this._sessions.get(sessionPath);
    if (!entry || !entry.running) return;

    // 冷保存 URL
    this._saveColdUrl(sessionPath, entry.url);
    console.log("[browser] 挂起浏览器", sessionPath);
    try { await this._sendCmd("suspend", { sessionPath }); } catch {}

    // 挂起完成，冷状态已写磁盘，从 Map 中移除避免僵尸条目累积
    this._sessions.delete(sessionPath);
    this._removeLru(sessionPath);
  }

  /**
   * 恢复浏览器：先尝试热恢复（view 还活着），失败则冷恢复（launch + navigate）
   * @param {string} sessionPath - 目标 session 路径
   */
  async resumeForSession(sessionPath) {
    if (!sessionPath) return;

    // 已经在运行 → 刷新 LRU 即可
    const existing = this._sessions.get(sessionPath);
    if (existing && existing.running) {
      this._touchLru(sessionPath);
      return;
    }

    // 没有运行中的浏览器时，检查冷状态；无冷状态则跳过
    const coldState = this._loadColdState();
    if (!existing && !coldState[sessionPath]) return;

    // 并发数检查
    const runningCount = this.runningSessions.length;
    if (runningCount >= MAX_INSTANCES) {
      await this._evictLru();
    }

    // 1. 热恢复：view 还在内存中
    const result = await this._sendCmd("resume", { sessionPath });
    if (result.found) {
      this._sessions.set(sessionPath, {
        running: true,
        url: result.url || null,
        headless: this._headless,
      });
      this._touchLru(sessionPath);
      console.log("[browser] 热恢复成功", sessionPath);
      return;
    }

    // 2. 冷恢复：从磁盘读 URL，重新 launch + navigate
    const savedUrl = coldState[sessionPath];
    if (!savedUrl) return;

    console.log("[browser] 冷恢复", sessionPath);
    await this._sendCmd("launch", { sessionPath });
    const entry = { running: true, url: savedUrl, headless: this._headless };
    this._sessions.set(sessionPath, entry);
    this._touchLru(sessionPath);
    try {
      const nav = await this._sendCmd("navigate", { url: savedUrl, sessionPath });
      entry.url = nav.url;
    } catch {
      // 保留 savedUrl
    }
  }

  /**
   * 关闭指定 session 的浏览器（从卡片上的关闭按钮调用）
   * @param {string} sessionPath - 目标 session 路径
   */
  async closeBrowserForSession(sessionPath) {
    const entry = this._sessions.get(sessionPath);

    // 如果是当前活跃的浏览器
    if (entry && entry.running) {
      await this.close(sessionPath);
      return;
    }

    // 销毁挂起的 view
    try { await this._sendCmd("destroyView", { sessionPath }); } catch {}
    // 从 Map 和 LRU 中清理
    this._sessions.delete(sessionPath);
    this._removeLru(sessionPath);
    // 从冷保存中移除
    this._removeColdUrl(sessionPath);
    console.log("[browser] 已关闭 session 浏览器", sessionPath);
  }

  // ════════════════════════════
  //  导航
  // ════════════════════════════

  /**
   * @param {string} url
   * @param {string} sessionPath
   * @returns {Promise<{ url: string, title: string, snapshot: string }>}
   */
  async navigate(url, sessionPath) {
    const result = await this._sendCmd("navigate", { url, sessionPath });
    // 更新对应 session 的 URL
    const entry = this._sessions.get(sessionPath);
    if (entry) entry.url = result.url;
    // 更新冷保存
    this._saveColdUrl(sessionPath, result.url);
    this._touchLru(sessionPath);
    return result; // { url, title, snapshot }
  }

  // ════════════════════════════
  //  感知
  // ════════════════════════════

  /**
   * @param {string} sessionPath
   * @returns {Promise<string>} 文本格式的页面树
   */
  async snapshot(sessionPath) {
    this._touchLru(sessionPath);
    const result = await this._sendCmd("snapshot", { sessionPath });
    const entry = this._sessions.get(sessionPath);
    if (entry) entry.url = result.currentUrl;
    return result.text;
  }

  /**
   * @param {string} sessionPath
   * @returns {Promise<{ base64: string, mimeType: string }>}
   */
  async screenshot(sessionPath) {
    const result = await this._sendCmd("screenshot", { sessionPath });
    return { base64: result.base64, mimeType: "image/jpeg" };
  }

  /**
   * @param {string} sessionPath
   * @returns {Promise<string|null>} 缩略图 base64
   */
  async thumbnail(sessionPath) {
    try {
      const result = await this._sendCmd("thumbnail", { sessionPath });
      return result.base64;
    } catch {
      return null;
    }
  }

  // ════════════════════════════
  //  交互（每个操作后自动 snapshot）
  // ════════════════════════════

  /**
   * @param {number} ref
   * @param {string} sessionPath
   * @returns {Promise<string>} 新的 snapshot
   */
  async click(ref, sessionPath) {
    const result = await this._sendCmd("click", { ref, sessionPath });
    const entry = this._sessions.get(sessionPath);
    if (entry) entry.url = result.currentUrl;
    return result.text;
  }

  /**
   * @param {string} text
   * @param {number} ref
   * @param {{ pressEnter?: boolean }} opts
   * @param {string} sessionPath
   * @returns {Promise<string>} 新的 snapshot
   */
  async type(text, ref, { pressEnter = false } = {}, sessionPath) {
    const result = await this._sendCmd("type", { text, ref, pressEnter, sessionPath });
    const entry = this._sessions.get(sessionPath);
    if (entry) entry.url = result.currentUrl;
    return result.text;
  }

  /**
   * @param {string} direction
   * @param {number} amount
   * @param {string} sessionPath
   * @returns {Promise<string>} 新的 snapshot
   */
  async scroll(direction, amount = 3, sessionPath) {
    const result = await this._sendCmd("scroll", { direction, amount, sessionPath });
    const entry = this._sessions.get(sessionPath);
    if (entry) entry.url = result.currentUrl || entry.url;
    return result.text;
  }

  /**
   * @param {number} ref
   * @param {string} value
   * @param {string} sessionPath
   * @returns {Promise<string>} 新的 snapshot
   */
  async select(ref, value, sessionPath) {
    const result = await this._sendCmd("select", { ref, value, sessionPath });
    const entry = this._sessions.get(sessionPath);
    if (entry) entry.url = result.currentUrl || entry.url;
    return result.text;
  }

  /**
   * @param {string} key
   * @param {string} sessionPath
   * @returns {Promise<string>} 新的 snapshot
   */
  async pressKey(key, sessionPath) {
    const result = await this._sendCmd("pressKey", { key, sessionPath });
    const entry = this._sessions.get(sessionPath);
    if (entry) entry.url = result.currentUrl || entry.url;
    return result.text;
  }

  // ════════════════════════════
  //  辅助
  // ════════════════════════════

  /**
   * @param {object} opts
   * @param {string} sessionPath
   * @returns {Promise<string>} 新的 snapshot
   */
  async wait(opts = {}, sessionPath) {
    const result = await this._sendCmd("wait", { ...opts, sessionPath });
    const entry = this._sessions.get(sessionPath);
    if (entry) entry.url = result.currentUrl || entry.url;
    return result.text;
  }

  /**
   * @param {string} expression
   * @param {string} sessionPath
   * @returns {Promise<string>} 序列化的执行结果
   */
  async evaluate(expression, sessionPath) {
    const result = await this._sendCmd("evaluate", { expression, sessionPath });
    return result.value;
  }

  /**
   * 将浏览器 viewer 窗口置前
   * @param {string} sessionPath
   */
  async show(sessionPath) {
    await this._sendCmd("show", { sessionPath });
  }
}
