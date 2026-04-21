import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeferredResultStore } from "../lib/deferred-result-store.js";

describe("DeferredResultStore", () => {
  let store;
  let mockBus;

  beforeEach(() => {
    mockBus = { emit: vi.fn() };
    store = new DeferredResultStore(mockBus);
  });

  describe("defer + resolve", () => {
    it("registers a task and resolves it", () => {
      store.defer("t1", "/session/a", { type: "image" });
      expect(store.query("t1")).toMatchObject({ status: "pending", sessionPath: "/session/a" });
      store.resolve("t1", { files: ["img.png"] });
      expect(store.query("t1")).toMatchObject({ status: "resolved" });
    });

    it("triggers onResult callback with taskId, sessionPath, result, meta", () => {
      const cb = vi.fn();
      store.onResult(cb);
      store.defer("t1", "/s/a", { type: "img" });
      store.resolve("t1", { files: ["x.png"] });
      expect(cb).toHaveBeenCalledWith("t1", "/s/a", { files: ["x.png"] }, { type: "img" });
    });

    it("emits deferred_result event on EventBus", () => {
      store.defer("t1", "/s/a", { type: "img" });
      store.resolve("t1", { files: ["x.png"] });
      expect(mockBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "deferred_result", taskId: "t1", status: "success" }),
        "/s/a"
      );
    });

    it("ignores duplicate resolve (no-op)", () => {
      const cb = vi.fn();
      store.onResult(cb);
      store.defer("t1", "/s/a", {});
      store.resolve("t1", { a: 1 });
      store.resolve("t1", { a: 2 });
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe("defer + fail", () => {
    it("records failure reason", () => {
      store.defer("t1", "/s/a", { type: "img" });
      store.fail("t1", "credit exhausted");
      expect(store.query("t1")).toMatchObject({ status: "failed", reason: "credit exhausted" });
    });

    it("triggers onFail callback", () => {
      const cb = vi.fn();
      store.onFail(cb);
      store.defer("t1", "/s/a", { type: "img" });
      store.fail("t1", "boom");
      expect(cb).toHaveBeenCalledWith("t1", "/s/a", "boom", { type: "img" });
    });
  });

  describe("listPending", () => {
    it("returns only pending tasks for the given session", () => {
      store.defer("t1", "/s/a", {});
      store.defer("t2", "/s/b", {});
      store.defer("t3", "/s/a", {});
      store.resolve("t3", {});
      const pending = store.listPending("/s/a");
      expect(pending).toHaveLength(1);
      expect(pending[0].taskId).toBe("t1");
    });
  });

  describe("clearBySession", () => {
    it("removes all pending tasks for a session", () => {
      store.defer("t1", "/s/a", {});
      store.defer("t2", "/s/a", {});
      store.defer("t3", "/s/b", {});
      store.clearBySession("/s/a");
      expect(store.query("t1")).toBeNull();
      expect(store.query("t2")).toBeNull();
      expect(store.query("t3")).not.toBeNull();
    });
  });

  describe("unsubscribe", () => {
    it("onResult returns unsubscribe function", () => {
      const cb = vi.fn();
      const unsub = store.onResult(cb);
      store.defer("t1", "/s/a", {});
      unsub();
      store.resolve("t1", {});
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("query unknown task", () => {
    it("returns null for unknown taskId", () => {
      expect(store.query("nonexistent")).toBeNull();
    });
  });
});
