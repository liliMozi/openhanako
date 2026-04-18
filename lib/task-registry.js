/**
 * TaskRegistry — 通用后台任务注册表
 *
 * 类型处理器模式：启动时注册 handler（按 type），运行时注册任务实例。
 * abort 按 type 分发到对应 handler。运行时临时状态，不做持久化。
 */

export class TaskRegistry {
  constructor() {
    /** @type {Map<string, { abort: (taskId: string) => void }>} */
    this._handlers = new Map();
    /** @type {Map<string, { type: string, parentSessionPath: string, meta: object, aborted: boolean }>} */
    this._tasks = new Map();
  }

  // ── 类型处理器注册（启动时调用） ──

  registerHandler(type, handler) {
    if (!handler?.abort || typeof handler.abort !== "function") {
      throw new Error(`TaskRegistry: handler for "${type}" must have an abort(taskId) method`);
    }
    this._handlers.set(type, handler);
  }

  unregisterHandler(type) {
    this._handlers.delete(type);
  }

  // ── 任务实例生命周期 ──

  register(taskId, { type, parentSessionPath, meta }) {
    if (!this._handlers.has(type)) {
      console.warn(`[task-registry] no handler for type "${type}", task ${taskId} registered without abort support`);
    }
    this._tasks.set(taskId, { type, parentSessionPath, meta: meta || {}, aborted: false });
  }

  abort(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) return "not_found";
    if (task.aborted) return "already_aborted";

    const handler = this._handlers.get(task.type);
    if (!handler) return "no_handler";

    task.aborted = true;
    try { handler.abort(taskId); } catch (err) {
      console.error(`[task-registry] abort handler error for ${taskId}:`, err.message);
    }
    return "aborted";
  }

  remove(taskId) {
    this._tasks.delete(taskId);
  }

  query(taskId) {
    return this._tasks.get(taskId) || null;
  }

  listByType(type) {
    const result = [];
    for (const [taskId, task] of this._tasks) {
      if (task.type === type) result.push({ taskId, ...task });
    }
    return result;
  }

  listAll() {
    return [...this._tasks.entries()].map(([taskId, t]) => ({ taskId, ...t }));
  }
}
