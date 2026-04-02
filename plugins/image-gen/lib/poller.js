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
   * }} opts
   */
  constructor({ store, registry, bus, generatedDir, log }) {
    this._store        = store;
    this._registry     = registry;
    this._bus          = bus;
    this._generatedDir = generatedDir;
    this._log          = log;

    /** @type {Set<string>} taskIds being tracked */
    this._active    = new Set();
    this._timer     = null;
    this._tickCount = 0;
    /** @type {Map<string, number>} consecutive query error counts per taskId */
    this._errorCounts = new Map();
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
   * Recover pending tasks from the store and start the polling interval.
   */
  start() {
    const pending = this._store.listPending();
    for (const task of pending) {
      this._active.add(task.taskId);
      // Re-register in DeferredResultStore so resolve/fail notifications work after restart
      this._bus.request("deferred:register", {
        taskId: task.taskId,
        meta: { type: task.type === "video" ? "video-generation" : "image-generation", prompt: task.prompt },
      }).catch(() => {}); // ignore if no active session yet
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
    // Fake-async: adapter populated files synchronously during submit.
    if (task.files && task.files.length > 0) {
      this._store.update(taskId, {
        status: "done",
        completedAt: new Date().toISOString(),
      });
      this._active.delete(taskId);
      await this._bus.request("deferred:resolve", { taskId, files: task.files });
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
      await this._bus.request("deferred:fail", { taskId, error: err });
      return;
    }

    // Query succeeded — reset consecutive error counter
    this._errorCounts.delete(taskId);

    const { status } = result ?? {};

    if (status === "success") {
      const files = result.files ?? [];
      this._store.update(taskId, {
        status: "done",
        files,
        completedAt: new Date().toISOString(),
      });
      this._active.delete(taskId);
      await this._bus.request("deferred:resolve", { taskId, files });
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
      await this._bus.request("deferred:fail", {
        taskId,
        error: result.error ?? { code: "GEN_FAILED", message: failReason },
      });
      return;
    }

    // status === "pending" or anything else — leave in active set, retry next tick.
  }
}
