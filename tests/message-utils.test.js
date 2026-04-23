import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("../core/llm-utils.js", () => ({
  isToolCallBlock: (b) => (b.type === "tool_use" || b.type === "toolCall") && !!b.name,
  getToolArgs: (b) => b.input || b.arguments,
}));

import {
  TOOL_ARG_SUMMARY_KEYS,
  stripThinkTags,
  extractTextContent,
  loadSessionHistoryMessages,
  loadLatestAssistantSummaryFromSessionFile,
  isValidSessionPath,
} from "../core/message-utils.js";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-message-utils-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("TOOL_ARG_SUMMARY_KEYS", () => {
  it("存在并包含常用字段", () => {
    expect(Array.isArray(TOOL_ARG_SUMMARY_KEYS)).toBe(true);
    expect(TOOL_ARG_SUMMARY_KEYS).toContain("file_path");
    expect(TOOL_ARG_SUMMARY_KEYS).toContain("command");
    expect(TOOL_ARG_SUMMARY_KEYS).toContain("url");
  });
});

describe("stripThinkTags", () => {
  it("提取并剥离 think 标签", () => {
    const input = "<think>inner thought</think>\nactual text";
    const { text, thinkContent } = stripThinkTags(input);
    expect(text.trim()).toBe("actual text");
    expect(thinkContent).toBe("inner thought");
  });

  it("无 think 标签时原样返回", () => {
    const { text, thinkContent } = stripThinkTags("plain text");
    expect(text).toBe("plain text");
    expect(thinkContent).toBe("");
  });

  it("多个 think 块合并", () => {
    const input = "<think>A</think>\n<think>B</think>\nresult";
    const { text, thinkContent } = stripThinkTags(input);
    expect(text.trim()).toBe("result");
    expect(thinkContent).toBe("A\nB");
  });
});

describe("extractTextContent", () => {
  it("字符串输入直接返回", () => {
    const result = extractTextContent("hello world");
    expect(result.text).toBe("hello world");
    expect(result.thinking).toBe("");
    expect(result.toolUses).toEqual([]);
    expect(result.images).toEqual([]);
  });

  it("字符串输入 + stripThink 剥离 think 标签", () => {
    const result = extractTextContent("<think>inner</think>\nresult", { stripThink: true });
    expect(result.text.trim()).toBe("result");
    expect(result.thinking).toBe("inner");
  });

  it("null/undefined 输入返回空结构", () => {
    const nullResult = extractTextContent(null);
    expect(nullResult).toEqual({ text: "", thinking: "", toolUses: [], images: [] });

    const undefinedResult = extractTextContent(undefined);
    expect(undefinedResult).toEqual({ text: "", thinking: "", toolUses: [], images: [] });
  });

  it("content block 数组提取文本", () => {
    const content = [
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ];
    const result = extractTextContent(content);
    expect(result.text).toBe("hello world");
    expect(result.toolUses).toEqual([]);
    expect(result.images).toEqual([]);
  });

  it("content block 数组提取 thinking block", () => {
    const content = [
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "my thoughts" },
    ];
    const result = extractTextContent(content);
    expect(result.text).toBe("answer");
    expect(result.thinking).toBe("my thoughts");
  });

  it("content block 数组提取 tool_use block", () => {
    const content = [
      { type: "tool_use", name: "read_file", input: { file_path: "/tmp/test.txt", extra: "ignored" } },
    ];
    const result = extractTextContent(content);
    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0].name).toBe("read_file");
    expect(result.toolUses[0].args).toEqual({ file_path: "/tmp/test.txt" });
  });

  it("tool_use block 无摘要字段时 args 为 undefined", () => {
    const content = [
      { type: "tool_use", name: "some_tool", input: { nonSummaryKey: "value" } },
    ];
    const result = extractTextContent(content);
    expect(result.toolUses[0].args).toBeUndefined();
  });

  it("content block 数组提取 image block（source.data 格式）", () => {
    const content = [
      {
        type: "image",
        source: { data: "base64data", media_type: "image/jpeg" },
      },
    ];
    const result = extractTextContent(content);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].data).toBe("base64data");
    expect(result.images[0].mimeType).toBe("image/jpeg");
  });
});

describe("isValidSessionPath", () => {
  it("合法子路径通过校验", () => {
    expect(isValidSessionPath("/tmp/agents/agent1/sessions/abc.jsonl", "/tmp/agents")).toBe(true);
  });

  it("恰好等于 baseDir 时通过校验", () => {
    expect(isValidSessionPath("/tmp/agents", "/tmp/agents")).toBe(true);
  });

  it("路径穿越被拒绝", () => {
    expect(isValidSessionPath("/tmp/agents/../etc/passwd", "/tmp/agents")).toBe(false);
  });

  it("完全不同的路径被拒绝", () => {
    expect(isValidSessionPath("/etc/shadow", "/tmp/agents")).toBe(false);
  });

  it("前缀相似但不是子路径时被拒绝", () => {
    // /tmp/agents-evil 不是 /tmp/agents 的子路径
    expect(isValidSessionPath("/tmp/agents-evil/session.jsonl", "/tmp/agents")).toBe(false);
  });
});

describe("loadSessionHistoryMessages", () => {
  it("无 sessionPath 时返回空数组", async () => {
    const engine = { messages: [{ role: "user", content: "hi" }] };
    const result = await loadSessionHistoryMessages(engine, null);
    expect(result).toEqual([]);
  });

  it("explicitPath 为 undefined 时返回空数组", async () => {
    const engine = { messages: [{ role: "user", content: "hi" }] };
    const result = await loadSessionHistoryMessages(engine, undefined);
    expect(result).toEqual([]);
  });
});

describe("loadLatestAssistantSummaryFromSessionFile", () => {
  it("从小 session 文件里提取最后 assistant 摘要", async () => {
    const sessionPath = path.join(tmpDir, "child.jsonl");
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done summary" }] } }),
      "",
    ].join("\n"), "utf-8");

    await expect(loadLatestAssistantSummaryFromSessionFile(sessionPath)).resolves.toBe("done summary");
  });

  it("大 session 文件只读尾部，也能跳过首个截断半行拿到最后 assistant 摘要", async () => {
    const sessionPath = path.join(tmpDir, "large-child.jsonl");
    const hugeUserText = "x".repeat(300 * 1024);
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: hugeUserText }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "tail summary" }] } }),
      "",
    ].join("\n"), "utf-8");

    const readFileSpy = vi.spyOn(fsp, "readFile");
    try {
      await expect(loadLatestAssistantSummaryFromSessionFile(sessionPath)).resolves.toBe("tail summary");
      expect(readFileSpy).not.toHaveBeenCalledWith(sessionPath, "utf-8");
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("最近 assistant 没有文本时返回 null，不继续向前找更早 assistant", async () => {
    const sessionPath = path.join(tmpDir, "empty-last-assistant.jsonl");
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "older summary" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "tool_use", name: "read" }] } }),
      "",
    ].join("\n"), "utf-8");

    await expect(loadLatestAssistantSummaryFromSessionFile(sessionPath)).resolves.toBeNull();
  });
});
