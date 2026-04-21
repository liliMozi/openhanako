import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeferredResultStore } from "../lib/deferred-result-store.js";

function createMockBus() {
  const handlers = {};
  return {
    emit: vi.fn(),
    handle: (type, fn) => { handlers[type] = fn; return () => delete handlers[type]; },
    request: async (type, payload) => {
      const h = handlers[type];
      if (!h) throw new Error(`No handler for ${type}`);
      return h(payload);
    },
  };
}

describe("Deferred Result bus handlers", () => {
  let store, bus;

  function registerHandlers(store, bus) {
    bus.handle("deferred:register", ({ taskId, sessionPath, meta }) => {
      store.defer(taskId, sessionPath, meta);
      return { ok: true };
    });
    bus.handle("deferred:resolve", ({ taskId, result }) => {
      store.resolve(taskId, result);
      return { ok: true };
    });
    bus.handle("deferred:fail", ({ taskId, reason }) => {
      store.fail(taskId, reason);
      return { ok: true };
    });
    bus.handle("deferred:query", ({ taskId }) => {
      return store.query(taskId);
    });
    bus.handle("deferred:list-pending", ({ sessionPath }) => {
      return store.listPending(sessionPath);
    });
  }

  beforeEach(() => {
    bus = createMockBus();
    store = new DeferredResultStore(bus);
    registerHandlers(store, bus);
  });

  it("register + resolve via bus", async () => {
    await bus.request("deferred:register", { taskId: "t1", sessionPath: "/s/a", meta: { type: "img" } });
    const q1 = await bus.request("deferred:query", { taskId: "t1" });
    expect(q1.status).toBe("pending");

    await bus.request("deferred:resolve", { taskId: "t1", result: { files: ["a.png"] } });
    const q2 = await bus.request("deferred:query", { taskId: "t1" });
    expect(q2.status).toBe("resolved");
  });

  it("list-pending returns only pending tasks for session", async () => {
    await bus.request("deferred:register", { taskId: "t1", sessionPath: "/s/a", meta: {} });
    await bus.request("deferred:register", { taskId: "t2", sessionPath: "/s/b", meta: {} });
    const list = await bus.request("deferred:list-pending", { sessionPath: "/s/a" });
    expect(list).toHaveLength(1);
    expect(list[0].taskId).toBe("t1");
  });

  it("fail via bus", async () => {
    await bus.request("deferred:register", { taskId: "t1", sessionPath: "/s/a", meta: {} });
    await bus.request("deferred:fail", { taskId: "t1", reason: "timeout" });
    const q = await bus.request("deferred:query", { taskId: "t1" });
    expect(q.status).toBe("failed");
    expect(q.reason).toBe("timeout");
  });
});
