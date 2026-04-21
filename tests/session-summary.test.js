import { describe, it, expect, vi } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

vi.mock("../server/i18n.js", () => ({
  getLocale: () => "zh-CN",
}));

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn(),
}));

vi.mock("../lib/pii-guard.js", () => ({
  scrubPII: (text) => ({ cleaned: text, detected: [] }),
}));

import { SessionSummaryManager } from "../lib/memory/session-summary.js";

describe("SessionSummaryManager._buildConversationText", () => {
  function createManager() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-summary-"));
    return {
      manager: new SessionSummaryManager(tmpDir),
      cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    };
  }

  it("assistant 普通文本全文保留，不再按 300 字截断", () => {
    const { manager, cleanup } = createManager();
    try {
      const longText = "甲".repeat(360);
      const text = manager._buildConversationText([
        {
          role: "assistant",
          content: [{ type: "text", text: longText }],
          timestamp: "2026-04-15T10:00:00.000Z",
        },
      ]);

      expect(text).toContain(`【助手】${longText}`);
      expect(text).not.toContain("长回复已截断");
    } finally {
      cleanup();
    }
  });

  it("assistant 的工具调用只保留简短标题", () => {
    const { manager, cleanup } = createManager();
    try {
      const text = manager._buildConversationText([
        {
          role: "assistant",
          content: [
            { type: "text", text: "我先看看实现。" },
            { type: "tool_use", name: "read", input: { file_path: "/tmp/demo.js" } },
            { type: "tool_use", name: "web_search", input: { query: "notifyTurn" } },
          ],
          timestamp: "2026-04-15T10:00:00.000Z",
        },
      ]);

      expect(text).toContain("【助手】我先看看实现。");
      expect(text).toContain("【助手】读取了 /tmp/demo.js");
      expect(text).toContain("【助手】搜索了 notifyTurn");
      expect(text).not.toContain("tool_use");
    } finally {
      cleanup();
    }
  });
});
