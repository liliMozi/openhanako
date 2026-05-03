import { describe, it, expect, vi, beforeEach } from "vitest";
import { promptAttachedDesktopSession } from "../../core/slash-commands/rc-router.js";

function makeFakeSession({ model = null, deltas = ["hel", "lo"], toolMediaOnEnd = [], toolMediaDetails = null } = {}) {
  const subscribers = [];
  return {
    model,
    subscribe: (fn) => {
      subscribers.push(fn);
      return () => {
        const idx = subscribers.indexOf(fn);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    },
    prompt: vi.fn(async () => {
      // 模拟 session 在 prompt 期间 emit 一串 text_delta 事件
      for (const d of deltas) {
        for (const fn of subscribers) {
          fn({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: d } });
        }
      }
      if (toolMediaOnEnd.length > 0) {
        for (const fn of subscribers) {
          fn({ type: "tool_execution_end", isError: false, result: { details: { media: { mediaUrls: toolMediaOnEnd } } } });
        }
      }
      if (toolMediaDetails) {
        for (const fn of subscribers) {
          fn({ type: "tool_execution_end", isError: false, result: { details: { media: toolMediaDetails } } });
        }
      }
    }),
    _subscribers: subscribers,
  };
}

function makeEngine(session) {
  return {
    ensureSessionLoaded: vi.fn(async () => session),
  };
}

describe("promptAttachedDesktopSession", () => {
  it("ensures session loaded, prompts, returns accumulated text", async () => {
    const session = makeFakeSession({ deltas: ["hello ", "world"] });
    const engine = makeEngine(session);
    const r = await promptAttachedDesktopSession(engine, "/path/s.jsonl", "hi");
    expect(engine.ensureSessionLoaded).toHaveBeenCalledWith("/path/s.jsonl");
    expect(session.prompt).toHaveBeenCalledWith("hi", undefined);
    expect(r.text).toBe("hello world");
    expect(r.toolMedia).toEqual([]);
  });

  it("invokes onDelta with each delta and accumulated text", async () => {
    const session = makeFakeSession({ deltas: ["a", "b", "c"] });
    const engine = makeEngine(session);
    const onDelta = vi.fn();
    await promptAttachedDesktopSession(engine, "/p.jsonl", "q", { onDelta });
    expect(onDelta).toHaveBeenCalledTimes(3);
    expect(onDelta.mock.calls[0]).toEqual(["a", "a"]);
    expect(onDelta.mock.calls[1]).toEqual(["b", "ab"]);
    expect(onDelta.mock.calls[2]).toEqual(["c", "abc"]);
  });

  it("unsubscribes after prompt completes (no lingering listener)", async () => {
    const session = makeFakeSession({ deltas: ["x"] });
    const engine = makeEngine(session);
    await promptAttachedDesktopSession(engine, "/p.jsonl", "q");
    expect(session._subscribers).toHaveLength(0);
  });

  it("unsubscribes even when prompt throws", async () => {
    const session = makeFakeSession({ deltas: [] });
    session.prompt.mockRejectedValueOnce(new Error("boom"));
    const engine = makeEngine(session);
    await expect(promptAttachedDesktopSession(engine, "/p.jsonl", "q")).rejects.toThrow(/boom/);
    expect(session._subscribers).toHaveLength(0);
  });

  it("collects tool media URLs from tool_execution_end events", async () => {
    const session = makeFakeSession({ deltas: ["r"], toolMediaOnEnd: ["https://a.png", "https://b.png"] });
    const engine = makeEngine(session);
    const r = await promptAttachedDesktopSession(engine, "/p.jsonl", "q");
    expect(r.toolMedia).toEqual([
      { type: "remote_url", url: "https://a.png" },
      { type: "remote_url", url: "https://b.png" },
    ]);
  });

  it("prefers structured tool media items over legacy mediaUrls", async () => {
    const item = { type: "session_file", fileId: "sf_1", filePath: "/tmp/a.png" };
    const session = makeFakeSession({
      deltas: ["r"],
      toolMediaDetails: { items: [item], mediaUrls: ["/tmp/a.png"] },
    });
    const engine = makeEngine(session);
    const r = await promptAttachedDesktopSession(engine, "/p.jsonl", "q");
    expect(r.toolMedia).toEqual([item]);
  });

  it("passes images opts when session model supports image input", async () => {
    const session = makeFakeSession({ deltas: ["ok"], model: { input: ["text", "image"] } });
    const engine = makeEngine(session);
    await promptAttachedDesktopSession(engine, "/p.jsonl", "q", {
      images: [{ type: "image", data: "AAA", mimeType: "image/png" }],
    });
    expect(session.prompt).toHaveBeenCalledWith("q", { images: [expect.objectContaining({ mimeType: "image/png" })] });
  });

  it("strips images when session model does not support image input", async () => {
    const session = makeFakeSession({ deltas: ["ok"], model: { input: ["text"] } });
    const engine = makeEngine(session);
    await promptAttachedDesktopSession(engine, "/p.jsonl", "q", {
      images: [{ type: "image", data: "AAA", mimeType: "image/png" }],
    });
    expect(session.prompt).toHaveBeenCalledWith("q", undefined);
  });

  it("returns null text when session produced no output", async () => {
    const session = makeFakeSession({ deltas: [] });
    const engine = makeEngine(session);
    const r = await promptAttachedDesktopSession(engine, "/p.jsonl", "q");
    expect(r.text).toBeNull();
  });

  it("throws cleanly when engine lacks ensureSessionLoaded", async () => {
    await expect(promptAttachedDesktopSession({}, "/p.jsonl", "q"))
      .rejects.toThrow(/ensureSessionLoaded/);
  });

  it("throws cleanly when ensureSessionLoaded returns null", async () => {
    const engine = { ensureSessionLoaded: vi.fn(async () => null) };
    await expect(promptAttachedDesktopSession(engine, "/p.jsonl", "q"))
      .rejects.toThrow(/failed to load/);
  });

  it("appends tool card.description into captured text", async () => {
    const session = {
      subscribe: (fn) => {
        setTimeout(() => {
          fn({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "text" } });
          fn({ type: "tool_execution_end", isError: false, result: { details: { card: { description: "card note" } } } });
        }, 0);
        return () => {};
      },
      prompt: vi.fn(async () => {
        // 让上面 setTimeout 跑完
        await new Promise(r => setTimeout(r, 5));
      }),
      model: null,
    };
    const engine = { ensureSessionLoaded: async () => session };
    const r = await promptAttachedDesktopSession(engine, "/p.jsonl", "q");
    expect(r.text).toContain("text");
    expect(r.text).toContain("card note");
  });
});
