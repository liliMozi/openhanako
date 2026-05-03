/**
 * image-gen/lib/poller.js
 *
 * Background poller with age-based smart intervals.
 * Every 5 s the poller ticks; how often each task is actually queried
 * depends on how old the submission is.
 *
 * Key difference from the dreamina poller: instead of calling runCli("query_result")
 * directly, this routes through the adapter registry — adapter.query(taskId, ctx).
 * Also supports "fake-async" detection: if the task already has files when polled
 * (e.g. a synchronous adapter populated files at submit time), it skips the query
 * and marks the task successful immediately.
 */

import { join as pathJoin } from "node:path";
import { readImageSize } from "./image-size.js";

const TICK_MS = 5_000;
const TWO_MINUTES = 2 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;
const MAX_CONSECUTIVE_ERRORS = 5;

/**
 * Decide whether this tick should trigger a real adapter query for a task.
 *
 * @param {number} ageMs     Milliseconds since task was created
 * @param {number} tickCount Monotonically-increasing tick counter (starts at 1)
 * @returns {boolean}
 */
export function shouldCheckThisTick(ageMs, tickCount) {
  if (ageMs < TWO_MINUTES) return true;               // < 2 min: every tick
  if (ageMs < TEN_MINUTES) return tickCount % 3 === 0; // 2-10 min: every 3rd
  return tickCount % 6 === 0;                           // 10 min+: every 6th
}

export class Poller {
  /**
   * @param {{
   *   store: import("./task-store.js").TaskStore,
   *   registry: import("./adapter-registry.js").AdapterRegistry,
 *   bus: object,
 *   generatedDir: string,
 *   log: object,
 *   registerSessionFile?: Function,
 * }} opts
 */
  constructor({ store, registry, bus, generatedDir, log, registerSessionFile }) {
    this._store        = store;
    this._registry     = registry;
    this._bus          = bus;
    this._generatedDir = generatedDir;
    this._log          = log;
    this._registerSessionFile = registerSessionFile || null;

    /** @type {Set<string>} taskIds being tracked */
    this._active    = new Set();
    this._timer     = null;
    this._tickCount = 0;
    /** @type {Map<string, number>} consecutive query error counts per taskId */
    this._errorCounts = new Map();
    /** @type {Set<string>} taskIds cancelled — fence against in-flight queries */
    this._cancelled = new Set();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get running() {
    return this._timer !== null;
  }

  /**
   * Add a taskId to the active polling set.
   * @param {string} taskId
   */
  add(taskId) {
    this._active.add(taskId);
  }

  /**
   * Check whether a taskId is in the active set.
   * @param {string} taskId
   * @returns {boolean}
   */
  hasPending(taskId) {
    return this._active.has(taskId);
  }

  /**
   * Cancel a task. Adds to cancellation fence so in-flight queries are ignored.
   * @param {string} taskId
   */
  cancel(taskId) {
    if (!this._active.has(taskId)) return;
    this._cancelled.add(taskId);
    this._active.delete(taskId);
    this._errorCounts.delete(taskId);
    this._store.update(taskId, {
      status: "cancelled",
      failReason: "user cancelled",
      completedAt: new Date().toISOString(),
    });
    this._bus.request("deferred:abort", { taskId, reason: "user cancelled" }).catch(() => {});
    this._bus.request("task:remove", { taskId }).catch(() => {});
    this._log.info(`[image-gen] task ${taskId} cancelled by user`);
  }

  /**
   * Recover pending tasks from the store and start the polling interval.
   */
  start() {
    const pending = this._store.listPending();
    for (const task of pending) {
      this._active.add(task.taskId);
      // Re-register in DeferredResultStore so resolve/fail notifications work after restart
      this._bus.request("deferred:register", {
        taskId: task.taskId,
        sessionPath: task.sessionPath,
        meta: { type: task.type === "video" ? "video-generation" : "image-generation", prompt: task.prompt },
      }).catch(() => {}); // ignore if no active session yet
      // Re-register in TaskRegistry so the task is visible and cancellable
      this._bus.request("task:register", {
        taskId: task.taskId,
        type: "media-generation",
        parentSessionPath: task.sessionPath,
        meta: { type: task.type === "video" ? "video-generation" : "image-generation" },
      }).catch(() => {});
    }
    if (pending.length > 0) {
      this._log.info(`[image-gen] poller recovered ${pending.length} pending task(s)`);
    }

    this._timer = setInterval(() => this._tick(), TICK_MS);
  }

  /**
   * Stop the polling interval.
   */
  stop() {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  async _readImageDimensions(files) {
    if (!files?.length) return { imageWidth: null, imageHeight: null };
    const filePath = pathJoin(this._generatedDir, files[0]);
    const size = await readImageSize(filePath).catch(() => null);
    return size
      ? { imageWidth: size.width, imageHeight: size.height }
      : { imageWidth: null, imageHeight: null };
  }

  _registerGeneratedFiles(task, files) {
    if (!this._registerSessionFile || !task?.sessionPath || !files?.length) return [];
    const sessionFiles = [];
    for (const file of files) {
      const filePath = pathJoin(this._generatedDir, file);
      try {
        const sessionFile = this._registerSessionFile({
          sessionPath: task.sessionPath,
          filePath,
          label: file,
          origin: "plugin_output",
          storageKind: "plugin_data",
        });
        if (sessionFile) sessionFiles.push(sessionFile);
      } catch (err) {
        this._log.error(`[image-gen] register generated file failed for ${file}:`, err?.message || err);
      }
    }
    return sessionFiles;
  }

  _tick() {
    this._tickCount += 1;
    const tick = this._tickCount;

    for (const taskId of [...this._active]) {
      const task = this._store.get(taskId);

      // Task disappeared from store or was already resolved — drop it.
      if (!task || task.status !== "pending") {
        this._active.delete(taskId);
        this._errorCounts.delete(taskId);
        continue;
      }

      const ageMs = Date.now() - new Date(task.createdAt).getTime();
      if (!shouldCheckThisTick(ageMs, tick)) continue;

      // Fire-and-forget; errors are caught inside _checkTask.
      this._checkTask(taskId, task).catch((err) => {
        this._log.error(`[image-gen] _checkTask unexpected error for ${taskId}:`, err);
      });
    }
  }

  /**
   * Check a single task. If the task already has files (fake-async / synchronous
   * adapter), mark it done immediately without querying the adapter. Otherwise
   * route through the adapter registry.
   *
   * @param {string} taskId
   * @param {object} task   Shallow copy from store.get()
   */
  async _checkTask(taskId, task) {
    // Cancellation fence: if cancel() was called while a query was in-flight, bail out.
    if (this._cancelled.has(taskId)) return;

    // Fake-async: adapter populated files synchronously during submit.
    if (task.files && task.files.length > 0) {
      const dims = await this._readImageDimensions(task.files);
      const sessionFiles = this._registerGeneratedFiles(task, task.files);
      this._store.update(taskId, {
        status: "done",
        ...dims,
        ...(sessionFiles.length ? { sessionFiles } : {}),
        completedAt: new Date().toISOString(),
      });
      this._active.delete(taskId);
      this._bus.request("task:remove", { taskId }).catch(() => {});
      await this._bus.request("deferred:resolve", {
        taskId,
        files: task.files,
        ...(sessionFiles.length ? { sessionFiles } : {}),
      });
      return;
    }

    // Real async: delegate to the adapter.
    const adapter = this._registry.get(task.adapterId);
    if (!adapter) {
      const err = new Error(`[image-gen] no adapter registered for "${task.adapterId}"`);
      this._store.update(taskId, {
        status: "failed",
        failReason: err.message,
        completedAt: new Date().toISOString(),
      });
      this._active.delete(taskId);
      this._bus.request("task:remove", { taskId }).catch(() => {});
      await this._bus.request("deferred:fail", { taskId, error: err });
      return;
    }

    const ctx = {
      generatedDir: this._generatedDir,
      bus: this._bus,
      log: this._log,
    };

    let result;
    try {
      result = await adapter.query(taskId, ctx);
      // Re-check cancellation fence after await — cancel() may have fired while query was in-flight
      if (this._cancelled.has(taskId)) return;
    } catch (err) {
      const count = (this._errorCounts.get(taskId) || 0) + 1;
      this._errorCounts.set(taskId, count);
      if (count < MAX_CONSECUTIVE_ERRORS) {
        this._log.warn(`[image-gen] query ${taskId} failed (${count}/${MAX_CONSECUTIVE_ERRORS}), will retry: ${err?.message ?? err}`);
        return;
      }
      this._log.error(`[image-gen] query ${taskId} failed ${count} times, giving up`);
      this._errorCounts.delete(taskId);
      this._store.update(taskId, {
        status: "failed",
        failReason: err?.message ?? String(err),
        completedAt: new Date().toISOString(),
      });
      this._active.delete(taskId);
      this._bus.request("task:remove", { taskId }).catch(() => {});
      await this._bus.request("deferred:fail", { taskId, error: err });
      return;
    }

    // Query succeeded — reset consecutive error counter
    this._errorCounts.delete(taskId);

    const { status } = result ?? {};

    if (status === "success") {
      const files = result.files ?? [];
      const dims = await this._readImageDimensions(files);
      const sessionFiles = this._registerGeneratedFiles(task, files);
      this._store.update(taskId, {
        status: "done",
        files,
        ...(sessionFiles.length ? { sessionFiles } : {}),
        ...dims,
        completedAt: new Date().toISOString(),
      });
      this._active.delete(taskId);
      this._bus.request("task:remove", { taskId }).catch(() => {});
      await this._bus.request("deferred:resolve", {
        taskId,
        files,
        ...(sessionFiles.length ? { sessionFiles } : {}),
      });
      return;
    }

    if (status === "failed") {
      const failReason = result.failReason ?? result.error?.message ?? "generation failed";
      this._store.update(taskId, {
        status: "failed",
        failReason,
        completedAt: new Date().toISOString(),
      });
      this._active.delete(taskId);
      this._bus.request("task:remove", { taskId }).catch(() => {});
      await this._bus.request("deferred:fail", {
        taskId,
        error: result.error ?? { code: "GEN_FAILED", message: failReason },
      });
      return;
    }

    // status === "pending" or anything else — leave in active set, retry next tick.
  }
}
