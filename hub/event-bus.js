/**
 * EventBus — 统一事件总线
 *
 * 通过 engine.setEventBus() 注入，Engine 的 _emitEvent / subscribe 委托到这里。
 * 支持带过滤的订阅：按 sessionPath / event type 过滤。
 * 支持 request/handle 请求响应模式，供 plugin 间通信使用。
 */

export class BusNoHandlerError extends Error {
  constructor(type) {
    super(`No handler registered for "${type}"`);
    this.name = "BusNoHandlerError";
    this.type = type;
  }
}

export class BusTimeoutError extends Error {
  constructor(type, ms) {
    super(`Request "${type}" timeout after ${ms}ms`);
    this.name = "BusTimeoutError";
    this.type = type;
  }
}

export class EventBus {
  constructor() {
    /** @type {Map<number, {callback: Function, filter: object}>} 全量订阅者表 */
    this._subscribers = new Map();
    this._nextId = 0;
    /** @type {Map<string, Function[]>} request/handle 模式 */
    this._handlers = new Map();

    // ── emit 索引 ──
    // 无 sessionPath 过滤的订阅者（"广播订阅者"），每次 emit 都要检查
    /** @type {Set<number>} */
    this._globalSubs = new Set();
    // 按 sessionPath 索引的订阅者
    /** @type {Map<string, Set<number>>} */
    this._sessionIndex = new Map();
  }

  /**
   * 订阅事件
   * @param {Function} callback  (event, sessionPath) => void
   * @param {object} [filter]
   * @param {string} [filter.sessionPath]  只接收该 session 的事件
   * @param {string[]} [filter.types]      只接收这些 event.type（内部转 Set）
   * @returns {Function} unsubscribe
   */
  subscribe(callback, filter = {}) {
    const id = ++this._nextId;
    // types 数组 → Set，加速 emit 时的类型匹配（O(1) vs O(n)）
    const normalizedFilter = { ...filter };
    if (Array.isArray(filter.types)) {
      normalizedFilter.types = new Set(filter.types);
    }
    this._subscribers.set(id, { callback, filter: normalizedFilter });

    // 维护索引
    if (normalizedFilter.sessionPath) {
      let set = this._sessionIndex.get(normalizedFilter.sessionPath);
      if (!set) { set = new Set(); this._sessionIndex.set(normalizedFilter.sessionPath, set); }
      set.add(id);
    } else {
      this._globalSubs.add(id);
    }

    return () => {
      const entry = this._subscribers.get(id);
      this._subscribers.delete(id);
      if (entry?.filter.sessionPath) {
        const set = this._sessionIndex.get(entry.filter.sessionPath);
        if (set) { set.delete(id); if (set.size === 0) this._sessionIndex.delete(entry.filter.sessionPath); }
      } else {
        this._globalSubs.delete(id);
      }
    };
  }

  /**
   * 发射事件（索引化：只遍历相关订阅者）
   * @param {object} event        事件对象，需有 type 字段
   * @param {string|null} sessionPath  关联的 session 路径
   */
  emit(event, sessionPath) {
    // 收集需要通知的订阅者 ID：广播订阅者 + 匹配 sessionPath 的订阅者
    const ids = this._globalSubs;
    const sessionIds = sessionPath ? this._sessionIndex.get(sessionPath) : null;

    const notify = (id) => {
      const entry = this._subscribers.get(id);
      if (!entry) return;
      if (entry.filter.types && !entry.filter.types.has(event.type)) return;
      try { entry.callback(event, sessionPath); } catch (err) {
        console.error("[EventBus] subscriber error:", err.message);
      }
    };

    for (const id of ids) notify(id);
    if (sessionIds) {
      for (const id of sessionIds) notify(id);
    }
  }

  /** 清理所有订阅和 handler */
  clear() {
    this._subscribers.clear();
    this._handlers.clear();
    this._globalSubs.clear();
    this._sessionIndex.clear();
  }

  static SKIP = Symbol("BUS_SKIP");

  /**
   * 注册请求处理器
   * @param {string} type           请求类型
   * @param {Function} handler      async (payload) => result | EventBus.SKIP
   * @returns {Function} unhandle
   */
  handle(type, handler) {
    if (!this._handlers.has(type)) this._handlers.set(type, []);
    this._handlers.get(type).push(handler);
    return () => {
      const arr = this._handlers.get(type);
      if (!arr) return;
      const idx = arr.indexOf(handler);
      if (idx !== -1) arr.splice(idx, 1);
      if (arr.length === 0) this._handlers.delete(type);
    };
  }

  /**
   * 发起请求，等待第一个不返回 SKIP 的 handler 响应
   * @param {string} type
   * @param {object} payload
   * @param {object} [options]
   * @param {number} [options.timeout=30000]
   * @returns {Promise<any>}
   */
  async request(type, payload, options = {}) {
    const handlers = this._handlers.get(type);
    if (!handlers || handlers.length === 0) throw new BusNoHandlerError(type);
    const timeout = options.timeout ?? 30000;

    let timerId;
    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new BusTimeoutError(type, timeout)), timeout);
    });

    try {
      return await Promise.race([
        this._tryHandlers(type, handlers, payload),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timerId);
    }
  }

  async _tryHandlers(type, handlers, payload) {
    for (const h of [...handlers]) {
      const result = await h(payload);
      if (result !== EventBus.SKIP) return result;
    }
    throw new BusNoHandlerError(type);
  }

  /**
   * 检查某个 type 是否有已注册的 handler
   * @param {string} type
   * @returns {boolean}
   */
  hasHandler(type) {
    const arr = this._handlers.get(type);
    return arr != null && arr.length > 0;
  }
}
