import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus } from "../hub/event-bus.js";

describe("plugin route → session bus integration", () => {
  let bus;

  beforeEach(() => {
    bus = new EventBus();

    // Register a mock session:send handler that simulates agent behavior
    bus.handle("session:send", async ({ text, sessionPath }) => {
      const sp = sessionPath || "/default.jsonl";
      // Simulate async events (like the real engine would emit)
      setTimeout(() => {
        bus.emit({ type: "text_delta", delta: "Hello " }, sp);
        bus.emit({ type: "text_delta", delta: "world" }, sp);
        bus.emit({ type: "turn_end" }, sp);
      }, 10);
      return { sessionPath: sp, accepted: true };
    });
  });

  it("plugin can send message and receive streaming events", async () => {
    const sessionPath = "/test/session.jsonl";
    const events = [];

    // Simulate what a plugin route handler would do:
    // 1. Subscribe to events for this session
    const unsub = bus.subscribe((event, sp) => {
      if (sp === sessionPath) events.push(event);
    });

    // 2. Trigger send
    const result = await bus.request("session:send", {
      text: "hello",
      sessionPath,
    });
    expect(result.accepted).toBe(true);
    expect(result.sessionPath).toBe(sessionPath);

    // 3. Wait for events to arrive
    await new Promise(r => setTimeout(r, 50));
    unsub();

    // 4. Verify complete event sequence
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "text_delta", delta: "Hello " });
    expect(events[1]).toEqual({ type: "text_delta", delta: "world" });
    expect(events[2]).toEqual({ type: "turn_end" });
  });

  it("events are filtered by sessionPath", async () => {
    const targetPath = "/test/target.jsonl";
    const otherPath = "/test/other.jsonl";
    const targetEvents = [];

    // Subscribe only to target session
    const unsub = bus.subscribe((event, sp) => {
      if (sp === targetPath) targetEvents.push(event);
    });

    // Emit events for both sessions
    bus.emit({ type: "text_delta", delta: "for target" }, targetPath);
    bus.emit({ type: "text_delta", delta: "for other" }, otherPath);
    bus.emit({ type: "turn_end" }, targetPath);

    unsub();

    // Only target session events received
    expect(targetEvents).toHaveLength(2);
    expect(targetEvents[0].delta).toBe("for target");
  });

  it("unsubscribe stops event delivery", async () => {
    const events = [];
    const unsub = bus.subscribe((event) => events.push(event));

    bus.emit({ type: "text_delta", delta: "before" }, "/s");
    unsub();
    bus.emit({ type: "text_delta", delta: "after" }, "/s");

    expect(events).toHaveLength(1);
    expect(events[0].delta).toBe("before");
  });
});
