import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock compaction-utils 以便精准控制 L3 判断和硬截断结果
vi.mock("../core/compaction-utils.js", () => ({
  computeHardTruncation: vi.fn(),
  estimatePreparationTokens: vi.fn(),
  truncateTextHeadTail: vi.fn(),
}));

import { createCompactionGuardExtension } from "../lib/extensions/compaction-guard-ext.js";
import {
  computeHardTruncation,
  estimatePreparationTokens,
  truncateTextHeadTail,
} from "../core/compaction-utils.js";

function createMockPi() {
  const handlers = {};
  return {
    on: vi.fn((event, handler) => {
      handlers[event] = handler;
    }),
    trigger(event, ...args) {
      return handlers[event]?.(...args);
    },
    getHandler(event) {
      return handlers[event];
    },
  };
}

describe("CompactionGuardExtension", () => {
  let pi;

  beforeEach(() => {
    vi.clearAllMocks();
    pi = createMockPi();
    createCompactionGuardExtension()(pi);
  });

  it("registers tool_result and session_before_compact handlers", () => {
    expect(pi.on).toHaveBeenCalledWith("tool_result", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_before_compact", expect.any(Function));
  });

  describe("L1: tool_result truncation", () => {
    it("leaves short text unchanged", async () => {
      truncateTextHeadTail.mockReturnValue({ text: "short", truncated: false, originalBytes: 5 });
      const res = await pi.trigger("tool_result", {
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "short" }],
      });
      expect(res).toBeUndefined();
    });

    it("replaces long text content with truncated version", async () => {
      truncateTextHeadTail.mockReturnValue({
        text: "HEAD...[省略]...TAIL",
        truncated: true,
        originalBytes: 200_000,
      });
      const res = await pi.trigger("tool_result", {
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "x".repeat(200_000) }],
      });
      expect(res).toEqual({ content: [{ type: "text", text: "HEAD...[省略]...TAIL" }] });
    });

    it("does NOT truncate error results (preserves diagnostic info)", async () => {
      const res = await pi.trigger("tool_result", {
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "x".repeat(100_000) }],
      });
      expect(res).toBeUndefined();
      expect(truncateTextHeadTail).not.toHaveBeenCalled();
    });

    it("does NOT touch image blocks", async () => {
      truncateTextHeadTail.mockReturnValue({ text: "", truncated: false, originalBytes: 0 });
      const res = await pi.trigger("tool_result", {
        toolName: "read",
        isError: false,
        content: [{ type: "image", source: { data: "..." } }],
      });
      expect(res).toBeUndefined();
      expect(truncateTextHeadTail).not.toHaveBeenCalled();
    });

    it("mixes truncated text blocks with untouched image blocks", async () => {
      truncateTextHeadTail.mockReturnValueOnce({
        text: "TRUNCATED",
        truncated: true,
        originalBytes: 100_000,
      });
      const res = await pi.trigger("tool_result", {
        toolName: "read",
        isError: false,
        content: [
          { type: "text", text: "x".repeat(100_000) },
          { type: "image", source: { data: "..." } },
        ],
      });
      expect(res).toEqual({
        content: [
          { type: "text", text: "TRUNCATED" },
          { type: "image", source: { data: "..." } },
        ],
      });
    });

    it("swallows hook exceptions and returns undefined (passthrough)", async () => {
      truncateTextHeadTail.mockImplementation(() => {
        throw new Error("boom");
      });
      const res = await pi.trigger("tool_result", {
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "x".repeat(100_000) }],
      });
      expect(res).toBeUndefined();
    });

    it("returns undefined when content is not an array", async () => {
      const res = await pi.trigger("tool_result", { toolName: "custom", isError: false, content: null });
      expect(res).toBeUndefined();
    });
  });

  describe("L3: session_before_compact preemptive hard truncate", () => {
    const model = { contextWindow: 128_000 };
    const preparation = {
      messagesToSummarize: [{ role: "user", content: "..." }],
      settings: { keepRecentTokens: 20_000 },
    };

    it("returns undefined when summarize tokens within threshold (let pi SDK LLM summarize)", async () => {
      estimatePreparationTokens.mockReturnValue(50_000); // < 128K * 0.85 = 108,800
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        { model, sessionManager: { getBranch: () => [] } },
      );
      expect(res).toBeUndefined();
      expect(computeHardTruncation).not.toHaveBeenCalled();
    });

    it("returns hard truncation when summarize tokens exceed threshold", async () => {
      estimatePreparationTokens.mockReturnValue(120_000); // > 108,800
      computeHardTruncation.mockReturnValue({
        summary: "[hard truncated]",
        firstKeptEntryId: "uuid-42",
        tokensBefore: 90_000,
        details: { reason: "compaction-guard-hard-truncate" },
      });
      const branch = [{ type: "message", id: "a" }, { type: "message", id: "b" }];
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        { model, sessionManager: { getBranch: () => branch } },
      );
      expect(res).toEqual({
        compaction: {
          summary: "[hard truncated]",
          firstKeptEntryId: "uuid-42",
          tokensBefore: 90_000,
          details: { reason: "compaction-guard-hard-truncate" },
        },
      });
      expect(computeHardTruncation).toHaveBeenCalledWith(branch, 20_000, expect.objectContaining({
        reason: "compaction-guard-hard-truncate",
      }));
    });

    it("returns undefined when hard truncate itself fails (let pi SDK try its own path)", async () => {
      estimatePreparationTokens.mockReturnValue(120_000);
      computeHardTruncation.mockReturnValue(null); // 无法截断
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        { model, sessionManager: { getBranch: () => [] } },
      );
      expect(res).toBeUndefined();
    });

    it("returns undefined when signal already aborted", async () => {
      estimatePreparationTokens.mockReturnValue(120_000);
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: true } },
        { model, sessionManager: { getBranch: () => [] } },
      );
      expect(res).toBeUndefined();
      expect(computeHardTruncation).not.toHaveBeenCalled();
    });

    it("returns undefined when model is missing", async () => {
      estimatePreparationTokens.mockReturnValue(120_000);
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        { model: undefined, sessionManager: { getBranch: () => [] } },
      );
      expect(res).toBeUndefined();
    });

    it("returns undefined when contextWindow is 0", async () => {
      estimatePreparationTokens.mockReturnValue(120_000);
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        { model: { contextWindow: 0 }, sessionManager: { getBranch: () => [] } },
      );
      expect(res).toBeUndefined();
    });

    it("swallows hook exceptions and returns undefined", async () => {
      estimatePreparationTokens.mockImplementation(() => {
        throw new Error("boom");
      });
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        { model, sessionManager: { getBranch: () => [] } },
      );
      expect(res).toBeUndefined();
    });

    it("honors custom hardTruncateThreshold option", async () => {
      pi = createMockPi();
      createCompactionGuardExtension({ hardTruncateThreshold: 0.5 })(pi);
      // 50% * 128K = 64K
      estimatePreparationTokens.mockReturnValue(70_000); // > 64K 应触发
      computeHardTruncation.mockReturnValue({
        summary: "s", firstKeptEntryId: "id", tokensBefore: 0, details: {},
      });
      const res = await pi.trigger(
        "session_before_compact",
        { preparation, signal: { aborted: false } },
        { model, sessionManager: { getBranch: () => [] } },
      );
      expect(res).toMatchObject({ compaction: expect.any(Object) });
    });
  });
});
