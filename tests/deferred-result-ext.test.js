import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDeferredResultExtension } from "../lib/extensions/deferred-result-ext.js";
import { DeferredResultStore } from "../lib/deferred-result-store.js";

function createMockPi() {
  const handlers = {};
  return {
    on: vi.fn((event, handler) => {
      handlers[event] = handler;
    }),
    sendMessage: vi.fn(),
    _trigger(event, ...args) {
      handlers[event]?.(...args);
    },
  };
}

describe("DeferredResultExtension", () => {
  let store, pi, factory;

  beforeEach(() => {
    store = new DeferredResultStore();
    factory = createDeferredResultExtension(store);
    pi = createMockPi();
    factory(pi);
  });

  it("subscribes to session_start and session_shutdown", () => {
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("sends notification when task resolves for matching session", () => {
    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    store.defer("t1", "/s/a", { type: "image-generation" });
    store.resolve("t1", { files: ["img.png"] });

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = pi.sendMessage.mock.calls[0];
    expect(msg.customType).toBe("hana-background-result");
    expect(msg.content).toContain("task-id=\"t1\"");
    expect(msg.content).toContain("status=\"success\"");
    expect(opts.deliverAs).toBe("steer");
    expect(opts.triggerTurn).toBe(true);
  });

  it("does NOT send notification for a different session", () => {
    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    store.defer("t1", "/s/b", { type: "image-generation" });
    store.resolve("t1", { files: [] });
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("sends failure notification", () => {
    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    store.defer("t1", "/s/a", { type: "image-generation" });
    store.fail("t1", "credit exhausted");

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.content).toContain("status=\"failed\"");
    expect(msg.content).toContain("credit exhausted");
  });

  it("unsubscribes on session_shutdown", () => {
    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    pi._trigger("session_shutdown");

    store.defer("t2", "/s/a", {});
    store.resolve("t2", {});
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("catches sendMessage errors without breaking", () => {
    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    pi.sendMessage.mockImplementation(() => {
      throw new Error("boom");
    });

    store.defer("t1", "/s/a", {});
    expect(() => store.resolve("t1", {})).not.toThrow();
  });

  it("escapes XML special characters in content", () => {
    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    store.defer("t1", "/s/a", { type: "test" });
    store.resolve("t1", { message: "a < b & c > d" });

    const [msg] = pi.sendMessage.mock.calls[0];
    expect(msg.content).not.toContain("< b");
    expect(msg.content).toContain("&lt;");
    expect(msg.content).toContain("&amp;");
  });
});
