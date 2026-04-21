/**
 * image-gen/lib/task-store.js
 *
 * In-memory task metadata store with debounced atomic write to disk.
 * Memory is the authority; disk is a snapshot for restart recovery.
 *
 * Extracted from the dreamina plugin with two key changes:
 *   - submitId renamed to taskId throughout
 *   - adapterId added as a required field
 */

import fs from "node:fs";
import path from "node:path";

const DEBOUNCE_MS = 300;

export class TaskStore {
  /**
   * @param {string} dataDir  Directory where tasks.json lives (created if absent)
   */
  constructor(dataDir) {
    this._dataDir = dataDir;
    this._filePath = path.join(dataDir, "tasks.json");
    /** @type {Map<string, object>} keyed by taskId */
    this._tasks = new Map();
    this._debounceTimer = null;
    this._load();
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  /**
   * Add a new task. Throws if taskId already exists.
   *
   * @param {{ taskId: string, adapterId: string, batchId: string, type: string, prompt: string, params: object, sessionPath?: string }} opts
   */
  add({ taskId, adapterId, batchId, type, prompt, params, sessionPath }) {
    if (this._tasks.has(taskId)) {
      throw new Error(`TaskStore: duplicate taskId "${taskId}"`);
    }
    const task = {
      taskId,
      adapterId,
      batchId,
      type,
      prompt,
      params,
      sessionPath: sessionPath || null,
      status: "pending",
      failReason: null,
      files: [],
      favorited: false,
      imageWidth: null,
      imageHeight: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    this._tasks.set(taskId, task);
    this._scheduleSave();
    return { ...task };
  }

  /**
   * Merge partial fields into an existing task.
   * Returns the updated shallow copy, or null if not found.
   *
   * @param {string} taskId
   * @param {object} patch
   */
  update(taskId, patch) {
    const task = this._tasks.get(taskId);
    if (!task) return null;
    Object.assign(task, patch);
    this._scheduleSave();
    return { ...task };
  }

  /**
   * Delete a task by taskId.
   * Returns true if removed, false if not found.
   *
   * @param {string} taskId
   */
  remove(taskId) {
    const existed = this._tasks.delete(taskId);
    if (existed) this._scheduleSave();
    return existed;
  }

  /**
   * Remove all non-pending, non-favorited tasks.
   * Returns an array of the removed task shallow copies so the caller
   * can clean up associated files on disk.
   *
   * @returns {object[]}
   */
  removeUnfavorited() {
    const removed = [];
    for (const [taskId, task] of this._tasks) {
      if (!task.favorited && task.status !== "pending") {
        removed.push({ ...task });
        this._tasks.delete(taskId);
      }
    }
    if (removed.length > 0) this._scheduleSave();
    return removed;
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * @param {string} taskId
   * @returns {object|null} shallow copy or null
   */
  get(taskId) {
    const task = this._tasks.get(taskId);
    return task ? { ...task } : null;
  }

  /**
   * All tasks belonging to a batchId, as shallow copies.
   *
   * @param {string} batchId
   * @returns {object[]}
   */
  getByBatch(batchId) {
    return this._filter((t) => t.batchId === batchId);
  }

  /**
   * All tasks belonging to a given adapterId, as shallow copies.
   *
   * @param {string} adapterId
   * @returns {object[]}
   */
  getByAdapter(adapterId) {
    return this._filter((t) => t.adapterId === adapterId);
  }

  /**
   * All tasks as shallow copies, insertion order.
   *
   * @returns {object[]}
   */
  listAll() {
    return this._filter(() => true);
  }

  /**
   * Tasks with status === "pending" as shallow copies.
   *
   * @returns {object[]}
   */
  listPending() {
    return this._filter((t) => t.status === "pending");
  }

  /**
   * Tasks with favorited === true as shallow copies.
   *
   * @returns {object[]}
   */
  listFavorited() {
    return this._filter((t) => t.favorited === true);
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * Flush pending write immediately (synchronous).
   * Useful before process exit or in tests.
   */
  flushSync() {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._writeSync();
  }

  /**
   * Cancel any pending debounce timer. Call on plugin unload.
   */
  destroy() {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /** @param {(task: object) => boolean} predicate */
  _filter(predicate) {
    const result = [];
    for (const task of this._tasks.values()) {
      if (predicate(task)) result.push({ ...task });
    }
    return result;
  }

  _load() {
    try {
      if (fs.existsSync(this._filePath)) {
        const raw = fs.readFileSync(this._filePath, "utf8");
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          for (const task of arr) {
            if (task && typeof task.taskId === "string") {
              this._tasks.set(task.taskId, task);
            }
          }
        }
      }
    } catch {
      // Corrupted or missing file: start with empty store.
    }
  }

  _scheduleSave() {
    if (this._debounceTimer !== null) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._writeSync();
    }, DEBOUNCE_MS);
  }

  _writeSync() {
    try {
      fs.mkdirSync(this._dataDir, { recursive: true });
      const tmp = this._filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify([...this._tasks.values()]), "utf8");
      fs.renameSync(tmp, this._filePath);
    } catch (err) {
      // Non-fatal: log to stderr but do not throw — memory remains authoritative.
      process.stderr.write(`TaskStore: write failed: ${err.message}\n`);
    }
  }
}
