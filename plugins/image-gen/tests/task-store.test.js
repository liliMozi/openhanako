/**
 * image-gen/tests/task-store.test.js
 *
 * Tests for TaskStore: CRUD, batch queries, adapter queries, favoriting,
 * remove / removeUnfavorited, and persistence (flushSync + reload).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { TaskStore } from "../lib/task-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-store-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(dir) {
  return new TaskStore(dir ?? makeTmpDir());
}

function makeTask(overrides = {}) {
  return {
    taskId: "tid-1",
    adapterId: "dreamina",
    batchId: "batch-1",
    type: "image",
    prompt: "a cat in space",
    params: { width: 1024, height: 1024 },
    ...overrides,
  };
}

afterEach(() => {
  // Clean up all temp dirs created during each test
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

// ---------------------------------------------------------------------------
// add / get
// ---------------------------------------------------------------------------

describe("add / get", () => {
  it("add returns a task with the expected shape including adapterId", () => {
    const store = makeStore();
    const task = store.add(makeTask());

    expect(task.taskId).toBe("tid-1");
    expect(task.adapterId).toBe("dreamina");
    expect(task.batchId).toBe("batch-1");
    expect(task.type).toBe("image");
    expect(task.prompt).toBe("a cat in space");
    expect(task.params).toEqual({ width: 1024, height: 1024 });
    expect(task.status).toBe("pending");
    expect(task.failReason).toBeNull();
    expect(task.files).toEqual([]);
    expect(task.favorited).toBe(false);
    expect(typeof task.createdAt).toBe("string");
    expect(task.completedAt).toBeNull();
  });

  it("get returns a shallow copy of the stored task", () => {
    const store = makeStore();
    store.add(makeTask());
    const task = store.get("tid-1");
    expect(task).not.toBeNull();
    expect(task.taskId).toBe("tid-1");
    expect(task.adapterId).toBe("dreamina");
  });

  it("get returns null for an unknown taskId", () => {
    const store = makeStore();
    expect(store.get("nonexistent")).toBeNull();
  });

  it("add throws on duplicate taskId", () => {
    const store = makeStore();
    store.add(makeTask());
    expect(() => store.add(makeTask())).toThrow(/duplicate taskId/i);
  });

  it("returned object from add is a copy; mutations do not affect stored task", () => {
    const store = makeStore();
    const task = store.add(makeTask());
    task.status = "done"; // mutate the copy
    expect(store.get("tid-1").status).toBe("pending");
  });

  it("stores sessionPath when provided", () => {
    const store = makeStore();
    const task = store.add(makeTask({ sessionPath: "/path/to/session.jsonl" }));
    expect(task.sessionPath).toBe("/path/to/session.jsonl");
  });

  it("defaults sessionPath to null", () => {
    const store = makeStore();
    const task = store.add(makeTask({}));
    expect(task.sessionPath).toBeNull();
  });

  it("defaults imageWidth and imageHeight to null", () => {
    const store = makeStore();
    const task = store.add(makeTask({}));
    expect(task.imageWidth).toBeNull();
    expect(task.imageHeight).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("update", () => {
  it("merges patch fields into the task", () => {
    const store = makeStore();
    store.add(makeTask());
    const updated = store.update("tid-1", {
      status: "done",
      files: ["img1.png"],
      completedAt: "2025-01-01T00:00:00.000Z",
    });
    expect(updated.status).toBe("done");
    expect(updated.files).toEqual(["img1.png"]);
    expect(updated.completedAt).toBe("2025-01-01T00:00:00.000Z");
    // Unchanged fields survive
    expect(updated.prompt).toBe("a cat in space");
    expect(updated.adapterId).toBe("dreamina");
  });

  it("returns null for an unknown taskId", () => {
    const store = makeStore();
    expect(store.update("ghost", { status: "done" })).toBeNull();
  });

  it("returned object from update is a copy; mutations do not affect stored task", () => {
    const store = makeStore();
    store.add(makeTask());
    const updated = store.update("tid-1", { status: "done" });
    updated.files = ["x.png"];
    expect(store.get("tid-1").files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Batch queries
// ---------------------------------------------------------------------------

describe("getByBatch", () => {
  it("returns all tasks for a given batchId", () => {
    const store = makeStore();
    store.add(makeTask({ taskId: "t1", batchId: "b1" }));
    store.add(makeTask({ taskId: "t2", batchId: "b1" }));
    store.add(makeTask({ taskId: "t3", batchId: "b2" }));

    const b1 = store.getByBatch("b1");
    expect(b1).toHaveLength(2);
    expect(b1.map((t) => t.taskId).sort()).toEqual(["t1", "t2"]);
  });

  it("returns empty array when no tasks match batchId", () => {
    const store = makeStore();
    store.add(makeTask({ taskId: "t1", batchId: "b1" }));
    expect(store.getByBatch("b-other")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getByAdapter
// ---------------------------------------------------------------------------

describe("getByAdapter", () => {
  it("returns all tasks for a given adapterId", () => {
    const store = makeStore();
    store.add(makeTask({ taskId: "t1", adapterId: "dreamina" }));
    store.add(makeTask({ taskId: "t2", adapterId: "dreamina" }));
    store.add(makeTask({ taskId: "t3", adapterId: "midjourney" }));

    const dreamina = store.getByAdapter("dreamina");
    expect(dreamina).toHaveLength(2);
    expect(dreamina.map((t) => t.taskId).sort()).toEqual(["t1", "t2"]);
  });

  it("returns empty array when no tasks match adapterId", () => {
    const store = makeStore();
    store.add(makeTask({ taskId: "t1", adapterId: "dreamina" }));
    expect(store.getByAdapter("unknown-adapter")).toEqual([]);
  });

  it("tasks from different adapters are isolated", () => {
    const store = makeStore();
    store.add(makeTask({ taskId: "t1", adapterId: "a1" }));
    store.add(makeTask({ taskId: "t2", adapterId: "a2" }));

    expect(store.getByAdapter("a1")).toHaveLength(1);
    expect(store.getByAdapter("a2")).toHaveLength(1);
    expect(store.getByAdapter("a1")[0].taskId).toBe("t1");
    expect(store.getByAdapter("a2")[0].taskId).toBe("t2");
  });
});

// ---------------------------------------------------------------------------
// listAll / listPending / listFavorited
// ---------------------------------------------------------------------------

describe("listAll", () => {
  it("returns all tasks", () => {
    const store = makeStore();
    store.add(makeTask({ taskId: "t1" }));
    store.add(makeTask({ taskId: "t2" }));
    expect(store.listAll()).toHaveLength(2);
  });

  it("returns empty array when store is empty", () => {
    const store = makeStore();
    expect(store.listAll()).toEqual([]);
  });
});

describe("listPending", () => {
  it("returns only pending tasks", () => {
    const store = makeStore();
    store.add(makeTask({ taskId: "t1" }));
    store.add(makeTask({ taskId: "t2" }));
    store.update("t2", { status: "done" });

    const pending = store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].taskId).toBe("t1");
  });

  it("returns empty array when no tasks are pending", () => {
    const store = makeStore();
    store.add(makeTask({ taskId: "t1" }));
    store.update("t1", { status: "done" });
    expect(store.listPending()).toEqual([]);
  });
});

describe("listFavorited", () => {
  it("returns only favorited tasks", () => {
    const store = makeStore();
    store.add(makeTask({ taskId: "t1" }));
    store.add(makeTask({ taskId: "t2" }));
    store.update("t1", { favorited: true });

    const fav = store.listFavorited();
    expect(fav).toHaveLength(1);
    expect(fav[0].taskId).toBe("t1");
  });

  it("returns empty array when nothing is favorited", () => {
    const store = makeStore();
    store.add(makeTask({ taskId: "t1" }));
    expect(store.listFavorited()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe("remove", () => {
  it("removes a task and returns true", () => {
    const store = makeStore();
    store.add(makeTask());
    expect(store.remove("tid-1")).toBe(true);
    expect(store.get("tid-1")).toBeNull();
    expect(store.listAll()).toHaveLength(0);
  });

  it("returns false when taskId does not exist", () => {
    const store = makeStore();
    expect(store.remove("ghost")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// removeUnfavorited
// ---------------------------------------------------------------------------

describe("removeUnfavorited", () => {
  it("removes completed non-favorited tasks and returns them", () => {
    const store = makeStore();
    store.add(makeTask({ taskId: "t1" }));
    store.add(makeTask({ taskId: "t2" }));
    store.add(makeTask({ taskId: "t3" }));

    store.update("t1", { status: "done" });                    // non-fav, done → will be removed
    store.update("t2", { status: "done", favorited: true });   // fav → kept
    // t3 stays pending → kept

    const removed = store.removeUnfavorited();
    expect(removed).toHaveLength(1);
    expect(removed[0].taskId).toBe("t1");
    expect(store.listAll()).toHaveLength(2);
    expect(store.get("t2")).not.toBeNull();
    expect(store.get("t3")).not.toBeNull();
  });

  it("does not remove pending tasks even if not favorited", () => {
    const store = makeStore();
    store.add(makeTask({ taskId: "t1" })); // pending, not favorited
    const removed = store.removeUnfavorited();
    expect(removed).toHaveLength(0);
    expect(store.get("t1")).not.toBeNull();
  });

  it("returns empty array when nothing qualifies for removal", () => {
    const store = makeStore();
    store.add(makeTask({ taskId: "t1" }));
    store.update("t1", { status: "done", favorited: true });
    expect(store.removeUnfavorited()).toEqual([]);
  });

  it("returned removed tasks are copies; they include all task fields", () => {
    const store = makeStore();
    store.add(makeTask({ taskId: "t1" }));
    store.update("t1", { status: "failed", failReason: "timeout" });

    const [removed] = store.removeUnfavorited();
    expect(removed.failReason).toBe("timeout");
    expect(removed.files).toEqual([]);
    expect(removed.adapterId).toBe("dreamina");
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("persistence", () => {
  it("flushSync writes tasks.json and a new store reads it back", () => {
    const dir = makeTmpDir();
    const store1 = new TaskStore(dir);
    store1.add(makeTask({ taskId: "t1", adapterId: "dreamina" }));
    store1.update("t1", { status: "done", files: ["a.png"], completedAt: "2025-01-01T00:00:00.000Z" });
    store1.add(makeTask({ taskId: "t2", batchId: "b2", adapterId: "midjourney" }));
    store1.flushSync();

    const filePath = path.join(dir, "tasks.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const store2 = new TaskStore(dir);
    const all = store2.listAll();
    expect(all).toHaveLength(2);

    const t1 = store2.get("t1");
    expect(t1.status).toBe("done");
    expect(t1.files).toEqual(["a.png"]);
    expect(t1.adapterId).toBe("dreamina");

    const t2 = store2.get("t2");
    expect(t2.batchId).toBe("b2");
    expect(t2.adapterId).toBe("midjourney");
  });

  it("starts with empty store when tasks.json does not exist", () => {
    const dir = makeTmpDir();
    const store = new TaskStore(dir);
    expect(store.listAll()).toEqual([]);
  });

  it("starts with empty store when tasks.json is corrupted JSON", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "tasks.json"), "{{ not valid json }}");
    const store = new TaskStore(dir);
    expect(store.listAll()).toEqual([]);
  });

  it("starts with empty store when tasks.json contains non-array JSON", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify({ taskId: "t1" }));
    const store = new TaskStore(dir);
    expect(store.listAll()).toEqual([]);
  });

  it("destroy cancels pending debounce without writing", () => {
    const dir = makeTmpDir();
    const store = new TaskStore(dir);
    store.add(makeTask());
    // _scheduleSave is called inside add; destroy before it fires
    store.destroy();

    const filePath = path.join(dir, "tasks.json");
    // File should NOT be written yet (no flushSync, no debounce fired)
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
