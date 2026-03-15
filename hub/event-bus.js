/**
 * EventBus — 统一事件总线
 *
 * 通过 engine.setEventBus() 注入，Engine 的 _emitEvent / subscribe 委托到这里。
 * 支持带过滤的订阅：按 sessionPath / event type 过滤。
 */

export class EventBus {
  constructor() {
    /** @type {Map<number, {callback: Function, filter: object}>} */
    this._subscribers = new Map();
    this._nextId = 0;
  }

  /**
   * 订阅事件
   * @param {Function} callback  (event, sessionPath) => void
   * @param {object} [filter]
   * @param {string} [filter.sessionPath]  只接收该 session 的事件
   * @param {string[]} [filter.types]      只接收这些 event.type
   * @returns {Function} unsubscribe
   */
  subscribe(callback, filter = {}) {
    const id = ++this._nextId;
    this._subscribers.set(id, { callback, filter });
    return () => this._subscribers.delete(id);
  }

  /**
   * 发射事件
   * @param {object} event        事件对象，需有 type 字段
   * @param {string|null} sessionPath  关联的 session 路径
   */
  emit(event, sessionPath) {
    for (const [, { callback, filter }] of this._subscribers) {
      if (filter.sessionPath && filter.sessionPath !== sessionPath) continue;
      if (filter.types && !filter.types.includes(event.type)) continue;
      try { callback(event, sessionPath); } catch (err) {
        console.error("[EventBus] subscriber error:", err.message);
      }
    }
  }

  /** 清理所有订阅 */
  clear() {
    this._subscribers.clear();
  }
}
