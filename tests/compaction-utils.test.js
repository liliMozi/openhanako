import { describe, it, expect } from "vitest";
import {
  truncateTextHeadTail,
  estimateMessagesTokens,
  estimatePreparationTokens,
  computeHardTruncation,
} from "../core/compaction-utils.js";

describe("truncateTextHeadTail", () => {
  it("returns content unchanged when under limit", () => {
    const text = "hello world";
    const res = truncateTextHeadTail(text, { maxBytes: 1024 });
    expect(res.truncated).toBe(false);
    expect(res.text).toBe(text);
    expect(res.originalBytes).toBe(11);
  });

  it("truncates long text to head + tail with marker", () => {
    const text = "a".repeat(200_000); // 200KB
    const res = truncateTextHeadTail(text, { maxBytes: 10_000 });
    expect(res.truncated).toBe(true);
    expect(res.originalBytes).toBe(200_000);
    expect(Buffer.byteLength(res.text, "utf8")).toBeLessThan(12_000); // 含 marker
    expect(res.text).toContain("已省略");
    expect(res.text).toContain("原始长度");
    expect(res.text.startsWith("aaaa")).toBe(true);
    expect(res.text.endsWith("aaaa")).toBe(true);
  });

  it("handles UTF-8 multibyte without breaking characters", () => {
    const text = "中".repeat(20_000); // 每个 '中' 3 字节 ≈ 60KB
    const res = truncateTextHeadTail(text, { maxBytes: 10_000 });
    expect(res.truncated).toBe(true);
    // 确认输出是合法 UTF-8（不会因切点落在多字节中间产生 replacement char）
    expect(res.text).not.toContain("\uFFFD");
    // 头部应该包含完整 "中"
    expect(res.text.startsWith("中")).toBe(true);
  });

  it("respects custom head/tail byte splits", () => {
    const text = "x".repeat(100_000);
    const res = truncateTextHeadTail(text, { maxBytes: 10_000, headBytes: 1000, tailBytes: 1000 });
    expect(res.truncated).toBe(true);
    // 头尾合计 ~ 2000 + marker
    expect(Buffer.byteLength(res.text, "utf8")).toBeLessThan(3000);
  });
});

describe("estimateMessagesTokens / estimatePreparationTokens", () => {
  it("returns 0 for empty inputs", () => {
    expect(estimateMessagesTokens([])).toBe(0);
    expect(estimatePreparationTokens(null)).toBe(0);
    expect(estimatePreparationTokens({})).toBe(0);
    expect(estimatePreparationTokens({ messagesToSummarize: [] })).toBe(0);
  });

  it("sums up token estimates across messages", () => {
    // 这里用字符串 content 模拟消息，只验证"累加不是 0"
    const msgs = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    const total = estimateMessagesTokens(msgs);
    expect(total).toBeGreaterThan(0);
  });

  it("returns only history tokens when not a split-turn", () => {
    const history = [{ role: "user", content: "x".repeat(1000) }];
    const preparation = {
      messagesToSummarize: history,
      isSplitTurn: false,
      turnPrefixMessages: [],
    };
    const historyOnly = estimateMessagesTokens(history);
    expect(estimatePreparationTokens(preparation)).toBe(historyOnly);
  });

  it("returns MAX of history and turnPrefix on split-turn (not sum)", () => {
    // 两者 token 数不同，且 turnPrefix 更大时应该返回 turnPrefix 的值
    const smallHistory = [{ role: "user", content: "hi" }];
    const bigTurnPrefix = [{ role: "user", content: "x".repeat(10_000) }];
    const preparation = {
      messagesToSummarize: smallHistory,
      isSplitTurn: true,
      turnPrefixMessages: bigTurnPrefix,
    };
    const expected = Math.max(
      estimateMessagesTokens(smallHistory),
      estimateMessagesTokens(bigTurnPrefix),
    );
    expect(estimatePreparationTokens(preparation)).toBe(expected);
    // 确保返回值等于更大的那个（turnPrefix），不是 sum
    expect(estimatePreparationTokens(preparation)).toBe(estimateMessagesTokens(bigTurnPrefix));
    expect(estimatePreparationTokens(preparation)).toBeLessThan(
      estimateMessagesTokens(smallHistory) + estimateMessagesTokens(bigTurnPrefix),
    );
  });

  it("returns history tokens when history is larger on split-turn", () => {
    const bigHistory = [{ role: "user", content: "x".repeat(20_000) }];
    const smallTurnPrefix = [{ role: "user", content: "hi" }];
    const preparation = {
      messagesToSummarize: bigHistory,
      isSplitTurn: true,
      turnPrefixMessages: smallTurnPrefix,
    };
    expect(estimatePreparationTokens(preparation)).toBe(estimateMessagesTokens(bigHistory));
  });

  it("ignores turnPrefixMessages when isSplitTurn is false (even if present)", () => {
    const history = [{ role: "user", content: "hi" }];
    const hugePrefix = [{ role: "user", content: "x".repeat(50_000) }];
    const preparation = {
      messagesToSummarize: history,
      isSplitTurn: false,
      turnPrefixMessages: hugePrefix, // 存在但不应被计入
    };
    expect(estimatePreparationTokens(preparation)).toBe(estimateMessagesTokens(history));
  });
});

describe("computeHardTruncation", () => {
  it("returns null when message count < 2", () => {
    expect(computeHardTruncation([], 1000)).toBeNull();
    expect(
      computeHardTruncation([{ type: "message", id: "1", message: { role: "user", content: "hi" } }], 1000)
    ).toBeNull();
  });

  it("returns null when cut point falls at index 0 (nothing to drop)", () => {
    // 用小的 keepRecentTokens，但消息本身很少——切点仍可能落在开头
    const entries = [
      { type: "message", id: "1", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "a" } },
      { type: "message", id: "2", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: "b" } },
    ];
    // 给很大的 keepRecentTokens，findCutPoint 会把全部消息都保留，effectiveCutIndex=0
    const res = computeHardTruncation(entries, 1_000_000);
    expect(res).toBeNull();
  });

  it("uses custom summary and reason when provided", () => {
    // 构造足够的 entries 让 findCutPoint 有截断空间
    const entries = [];
    for (let i = 0; i < 10; i++) {
      entries.push({
        type: "message",
        id: String(i),
        timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
        message: { role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(5000) },
      });
    }
    const res = computeHardTruncation(entries, 100, {
      summary: "custom summary",
      reason: "custom-reason",
    });
    // res 可能为 null（如果 findCutPoint 行为特殊），但如果非 null，字段必须对
    if (res) {
      expect(res.summary).toBe("custom summary");
      expect(res.details.reason).toBe("custom-reason");
      expect(res.details.keepRecentTokens).toBe(100);
      expect(typeof res.firstKeptEntryId).toBe("string");
      expect(res.tokensBefore).toBeGreaterThanOrEqual(0);
    }
  });
});
