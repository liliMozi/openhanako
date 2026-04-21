import { describe, it, expect, beforeEach } from "vitest";
import { EventBus } from "../hub/event-bus.js";

let bus;
beforeEach(() => { bus = new EventBus(); });

describe("handle + request", () => {
  it("request routes to registered handler and returns result", async () => {
    bus.handle("math:add", async ({ a, b }) => a + b);
    const result = await bus.request("math:add", { a: 2, b: 3 });
    expect(result).toBe(5);
  });

  it("request throws BusNoHandlerError when no handler registered", async () => {
    await expect(bus.request("unknown:type", {}))
      .rejects.toThrow(/no handler/i);
  });

  it("SKIP passes to next handler in chain", async () => {
    bus.handle("bridge:send", async (p) => {
      if (p.platform !== "telegram") return EventBus.SKIP;
      return { sent: "telegram" };
    });
    bus.handle("bridge:send", async (p) => {
      if (p.platform !== "feishu") return EventBus.SKIP;
      return { sent: "feishu" };
    });
    const r = await bus.request("bridge:send", { platform: "feishu" });
    expect(r).toEqual({ sent: "feishu" });
  });

  it("all handlers SKIP throws BusNoHandlerError", async () => {
    bus.handle("x:y", async () => EventBus.SKIP);
    await expect(bus.request("x:y", {})).rejects.toThrow(/no handler/i);
  });

  it("handler business error propagates to caller", async () => {
    bus.handle("fail:hard", async () => { throw new Error("db down"); });
    await expect(bus.request("fail:hard", {})).rejects.toThrow("db down");
  });

  it("request times out after specified duration", async () => {
    bus.handle("slow:op", () => new Promise(r => setTimeout(r, 5000)));
    await expect(bus.request("slow:op", {}, { timeout: 50 }))
      .rejects.toThrow(/timeout/i);
  }, 10000);

  it("unhandle removes handler", async () => {
    const off = bus.handle("temp:h", async () => 42);
    expect(await bus.request("temp:h", {})).toBe(42);
    off();
    await expect(bus.request("temp:h", {})).rejects.toThrow(/no handler/i);
  });
});

describe("hasHandler", () => {
  it("returns false when no handler registered", () => {
    expect(bus.hasHandler("nope")).toBe(false);
  });
  it("returns true after handle, false after unhandle", () => {
    const off = bus.handle("test:h", async () => {});
    expect(bus.hasHandler("test:h")).toBe(true);
    off();
    expect(bus.hasHandler("test:h")).toBe(false);
  });
});

describe("existing emit/subscribe unchanged", () => {
  it("emit still broadcasts to subscribers", () => {
    const events = [];
    bus.subscribe((e) => events.push(e), { types: ["ping"] });
    bus.emit({ type: "ping", data: 1 });
    expect(events).toHaveLength(1);
  });
});

describe("clear", () => {
  it("clear() removes all handlers", () => {
    bus.handle("a:b", async () => 1);
    expect(bus.hasHandler("a:b")).toBe(true);
    bus.clear();
    expect(bus.hasHandler("a:b")).toBe(false);
  });
});

describe("error type identity", () => {
  it("BusNoHandlerError has correct name and type", async () => {
    try {
      await bus.request("missing:type", {});
    } catch (err) {
      expect(err.name).toBe("BusNoHandlerError");
      expect(err.type).toBe("missing:type");
      return;
    }
    throw new Error("should have thrown");
  });

  it("BusTimeoutError has correct name and type", async () => {
    bus.handle("slow:op2", () => new Promise(() => {}));
    try {
      await bus.request("slow:op2", {}, { timeout: 50 });
    } catch (err) {
      expect(err.name).toBe("BusTimeoutError");
      expect(err.type).toBe("slow:op2");
      return;
    }
    throw new Error("should have thrown");
  }, 5000);
});
