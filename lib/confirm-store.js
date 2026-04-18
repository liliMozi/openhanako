/**
 * ConfirmStore — 阻塞式确认存储
 *
 * 工具调用时创建 pending confirmation，阻塞 tool.execute() 的 Promise。
 * 前端渲染确认卡片，用户操作后通过 REST API resolve Promise。
 * 支持超时自动 resolve、session 终止时批量清理。
 */

import crypto from "crypto";

const DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 分钟

export class ConfirmStore {
  constructor() {
    /** @type {Map<string, { resolve, timer, sessionPath, kind, payload }>} */
    this._pending = new Map();
    /** @type {((confirmId: string, action: string) => void) | null} */
    this.onResolved = null;
  }

  /**
   * 创建一个 pending confirmation，返回 confirmId 和阻塞 Promise
   *
   * @param {string} kind - 确认类型（'settings' | 'cron'）
   * @param {object} payload - 确认内容（传给前端渲染卡片）
   * @param {string|null} sessionPath - 所属 session（用于批量清理）
   * @param {number} [timeoutMs] - 超时毫秒数
   * @returns {{ confirmId: string, promise: Promise<{ action: string, value?: any }> }}
   */
  create(kind, payload, sessionPath, timeoutMs = DEFAULT_TIMEOUT) {
    const confirmId = crypto.randomUUID();
    let resolve;
    const promise = new Promise(r => { resolve = r; });

    const timer = setTimeout(() => {
      if (this._pending.has(confirmId)) {
        this._pending.delete(confirmId);
        resolve({ action: "timeout" });
        this.onResolved?.(confirmId, "timeout");
      }
    }, timeoutMs);

    this._pending.set(confirmId, { resolve, timer, sessionPath, kind, payload });
    return { confirmId, promise };
  }

  /**
   * resolve 一个 pending confirmation
   *
   * @param {string} confirmId
   * @param {string} action - 'confirmed' | 'rejected'
   * @param {*} [value] - 用户可能编辑后的值
   * @returns {boolean} 是否找到并 resolve 了
   */
  resolve(confirmId, action, value) {
    const entry = this._pending.get(confirmId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this._pending.delete(confirmId);
    entry.resolve({ action, value });
    return true;
  }

  /**
   * session 终止时，清理该 session 的所有 pending confirmation
   * @param {string} sessionPath
   */
  abortBySession(sessionPath) {
    for (const [id, entry] of this._pending) {
      if (entry.sessionPath === sessionPath) {
        clearTimeout(entry.timer);
        this._pending.delete(id);
        entry.resolve({ action: "aborted" });
        this.onResolved?.(id, "aborted");
      }
    }
  }

  /** 获取 pending 数量（调试用） */
  get size() { return this._pending.size; }
}
