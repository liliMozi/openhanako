import { describe, it, expect } from "vitest";
import {
  createSessionStreamState,
  beginSessionStream,
  finishSessionStream,
  appendSessionStreamEvent,
  resumeSessionStream,
} from "../server/session-stream-store.js";

describe("session-stream-store", () => {
  it("按 seq 返回缺失事件", () => {
    const ss = createSessionStreamState();
    const streamId = beginSessionStream(ss, "stream_a");

    const e1 = appendSessionStreamEvent(ss, { type: "text_delta", delta: "Hello" });
    const e2 = appendSessionStreamEvent(ss, { type: "tool_start", name: "search" });
    const e3 = appendSessionStreamEvent(ss, { type: "mood_text", delta: "vibe1" });

    expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);

    const resumed = resumeSessionStream(ss, { streamId, sinceSeq: 1 });
    expect(resumed.streamId).toBe("stream_a");
    expect(resumed.events.map(x => x.seq)).toEqual([2, 3]);
    expect(resumed.events.map(x => x.event.type)).toEqual(["tool_start", "mood_text"]);
  });

  it("旧 streamId 恢复时，要求客户端重建为当前流", () => {
    const ss = createSessionStreamState();
    beginSessionStream(ss, "stream_a");
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "old" });
    finishSessionStream(ss);

    beginSessionStream(ss, "stream_b");
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "new" });

    const resumed = resumeSessionStream(ss, { streamId: "stream_a", sinceSeq: 99 });
    expect(resumed.reset).toBe(true);
    expect(resumed.streamId).toBe("stream_b");
    expect(resumed.events.map(x => x.seq)).toEqual([1]);
  });

  it("容量截断时会标记 truncated", () => {
    const ss = createSessionStreamState({ maxEvents: 3 });
    beginSessionStream(ss, "stream_a");
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "1" });
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "2" });
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "3" });
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "4" });

    const resumed = resumeSessionStream(ss, { streamId: "stream_a", sinceSeq: 0 });
    expect(resumed.truncated).toBe(true);
    expect(resumed.sinceSeq).toBe(1);
    expect(resumed.events.map(x => x.seq)).toEqual([2, 3, 4]);
  });

  it("开始新流时会重置旧状态", () => {
    const ss = createSessionStreamState();
    beginSessionStream(ss, "stream_a");
    appendSessionStreamEvent(ss, { type: "text_delta", delta: "old" });
    beginSessionStream(ss, "stream_b");

    expect(ss.streamId).toBe("stream_b");
    expect(ss.nextSeq).toBe(1);
    expect(ss.events).toEqual([]);
    expect(ss.isStreaming).toBe(true);
  });

  it("无活跃流时返回空恢复结果", () => {
    const ss = createSessionStreamState();
    const resumed = resumeSessionStream(ss, { sinceSeq: 12 });

    expect(resumed).toMatchObject({
      streamId: null,
      sinceSeq: 12,
      nextSeq: 1,
      isStreaming: false,
      reset: false,
      truncated: false,
      events: [],
    });
  });
});
