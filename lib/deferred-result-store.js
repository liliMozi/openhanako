/**
 * DeferredResultStore — 异步后台任务结果通知存储（带磁盘持久化）
 *
 * 工具调用触发异步任务时通过 defer() 注册占位，任务完成后调用
 * resolve() 或 fail()，通知所有订阅方并向 EventBus 广播事件。
 *
 * 所有状态变更自动持久化到 JSON 文件，app 重启后能恢复。
 */

import fs from "node:fs";
import path from "node:path";

const CLEANUP_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 天

export class DeferredResultStore {
  /**
   * @param {object} [bus] - EventBus 实例
   * @param {string} [persistPath] - 持久化文件路径。不传则纯内存（兼容测试）。
   */
  constructor(bus, persistPath) {
    this._bus = bus || null;
    this._persistPath = persistPath || null;
    /** @type {Map<string, { status: string, sessionPath: string, meta: object, deferredAt: number, result: any, reason: any, delivered: boolean }>} */
    this._tasks = new Map();
    this._resultCbs = [];
    this._failCbs = [];
    if (this._persistPath) this._load();

    // 启动时立即清理一次 + 每 24 小时自动清理
    this.cleanup();
    this._cleanupTimer = setInterval(() => this.cleanup(), 24 * 60 * 60 * 1000);
    this._cleanupTimer.unref(); // 不阻止进程退出
  }

  dispose() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    // flush 残余脏数据
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._flushToDisk();
  }

  // ── 核心操作 ──

  defer(taskId, sessionPath, meta = {}) {
    if (this._tasks.has(taskId)) return;
    this._tasks.set(taskId, {
      status: "pending",
      sessionPath,
      meta,
      deferredAt: Date.now(),
      result: null,
      reason: null,
      delivered: false,
    });
    this._save();
  }

  resolve(taskId, result) {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== "pending") return;
    task.status = "resolved";
    task.result = result;
    this._save();

    for (const cb of this._resultCbs) {
      try { cb(taskId, task.sessionPath, result, task.meta); } catch {}
    }
    this._bus?.emit({
      type: "deferred_result", taskId, status: "success", result, meta: task.meta,
    }, task.sessionPath);
  }

  fail(taskId, reason) {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== "pending") return;
    task.status = "failed";
    task.reason = reason;
    this._save();

    for (const cb of this._failCbs) {
      try { cb(taskId, task.sessionPath, reason, task.meta); } catch {}
    }
    this._bus?.emit({
      type: "deferred_result", taskId, status: "failed", reason, meta: task.meta,
    }, task.sessionPath);
  }

  abort(taskId, reason) {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== "pending") return;
    task.status = "aborted";
    task.reason = reason || "user aborted";
    this._save();

    // Reuse failCbs to notify subscribers (deferred-result-ext handles delivery)
    for (const cb of this._failCbs) {
      try { cb(taskId, task.sessionPath, task.reason, task.meta); } catch {}
    }
    this._bus?.emit({
      type: "deferred_result", taskId, status: "aborted", reason: task.reason, meta: task.meta,
    }, task.sessionPath);
  }

  /** 标记任务结果已成功送达（steer 成功后调用） */
  markDelivered(taskId) {
    const task = this._tasks.get(taskId);
    if (task) {
      task.delivered = true;
      this._save();
    }
  }

  // ── 查询 ──

  query(taskId) {
    const task = this._tasks.get(taskId);
    return task ? { ...task } : null;
  }

  listPending(sessionPath) {
    const result = [];
    for (const [taskId, task] of this._tasks) {
      if (task.sessionPath === sessionPath && task.status === "pending") {
        result.push({ taskId, meta: task.meta, deferredAt: task.deferredAt });
      }
    }
    return result;
  }

  listBySession(sessionPath) {
    const result = [];
    for (const [taskId, task] of this._tasks) {
      if (task.sessionPath === sessionPath) {
        result.push({ taskId, ...task });
      }
    }
    return result;
  }

  /** 列出指定 session 下已完成但未送达的任务 */
  listUndelivered(sessionPath) {
    const result = [];
    for (const [taskId, task] of this._tasks) {
      if (task.sessionPath === sessionPath && !task.delivered &&
          (task.status === "resolved" || task.status === "failed" || task.status === "aborted")) {
        result.push({ taskId, ...task });
      }
    }
    return result;
  }

  // ── 订阅 ──

  onResult(callback) {
    this._resultCbs.push(callback);
    return () => {
      const idx = this._resultCbs.indexOf(callback);
      if (idx !== -1) this._resultCbs.splice(idx, 1);
    };
  }

  onFail(callback) {
    this._failCbs.push(callback);
    return () => {
      const idx = this._failCbs.indexOf(callback);
      if (idx !== -1) this._failCbs.splice(idx, 1);
    };
  }

  // ── 清理 ──

  clearBySession(sessionPath) {
    for (const [taskId, task] of this._tasks) {
      if (task.sessionPath === sessionPath && task.status === "pending") {
        this._tasks.delete(taskId);
      }
    }
    this._save();
  }

  /** 清理已送达且超过 maxAge 的任务 */
  cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [taskId, task] of this._tasks) {
      if (task.delivered && (now - task.deferredAt > CLEANUP_MAX_AGE)) {
        this._tasks.delete(taskId);
        changed = true;
      }
    }
    if (changed) this._save();
  }

  get size() { return this._tasks.size; }

  // ── 持久化 ──

  /** 标记脏数据，延迟 1 秒批量写盘（合并高频状态变更） */
  _save() {
    if (!this._persistPath) return;
    this._dirty = true;
    if (!this._saveTimer) {
      this._saveTimer = setTimeout(() => this._flushToDisk(), 1000);
      this._saveTimer.unref();
    }
  }

  _flushToDisk() {
    this._saveTimer = null;
    if (!this._dirty) return;
    this._dirty = false;
    try {
      const obj = {};
      for (const [k, v] of this._tasks) obj[k] = v;
      fs.mkdirSync(path.dirname(this._persistPath), { recursive: true });
      fs.writeFileSync(this._persistPath, JSON.stringify(obj, null, 2) + "\n", "utf-8");
    } catch { /* best effort */ }
  }

  _load() {
    if (!this._persistPath) return;
    try {
      if (!fs.existsSync(this._persistPath)) return;
      const raw = JSON.parse(fs.readFileSync(this._persistPath, "utf-8"));
      for (const [k, v] of Object.entries(raw)) {
        this._tasks.set(k, { delivered: false, ...v });
      }
    } catch { /* best effort */ }
  }
}
