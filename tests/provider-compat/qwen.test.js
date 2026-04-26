import { describe, expect, it } from "vitest";
import * as qwen from "../../core/provider-compat/qwen.js";

describe("provider-compat/qwen 模块导出形态", () => {
  it("导出 matches 函数", () => {
    expect(typeof qwen.matches).toBe("function");
  });

  it("导出 apply 函数", () => {
    expect(typeof qwen.apply).toBe("function");
  });
});

describe("provider-compat/qwen — matches", () => {
  it("null/undefined/空对象 → false（不抛错）", () => {
    expect(qwen.matches(null)).toBe(false);
    expect(qwen.matches(undefined)).toBe(false);
    expect(qwen.matches({})).toBe(false);
  });

  it("dashscope provider + enable_thinking quirk → true", () => {
    expect(qwen.matches({
      provider: "dashscope",
      quirks: ["enable_thinking"],
    })).toBe(true);
  });

  it("dashscope provider 但无 enable_thinking quirk → false", () => {
    expect(qwen.matches({
      provider: "dashscope",
      quirks: ["other_quirk"],
    })).toBe(false);
    expect(qwen.matches({
      provider: "dashscope",
    })).toBe(false);
  });

  it("非 dashscope provider 即使带 enable_thinking quirk → false", () => {
    expect(qwen.matches({
      provider: "openai",
      quirks: ["enable_thinking"],
    })).toBe(false);
  });

  it("provider 大小写不敏感", () => {
    expect(qwen.matches({
      provider: "DashScope",
      quirks: ["enable_thinking"],
    })).toBe(true);
  });

  it("quirks 不是数组时 → false（不抛错）", () => {
    expect(qwen.matches({
      provider: "dashscope",
      quirks: "enable_thinking",  // 字符串而非数组
    })).toBe(false);
    expect(qwen.matches({
      provider: "dashscope",
      quirks: null,
    })).toBe(false);
  });
});

describe("provider-compat/qwen — apply", () => {
  const qwenModel = {
    id: "qwen3.5-plus",
    provider: "dashscope",
    reasoning: true,
    quirks: ["enable_thinking"],
  };

  it("utility mode → 注入 enable_thinking: false", () => {
    const payload = {
      model: "qwen3.5-plus",
      messages: [{ role: "user", content: "hi" }],
    };
    const result = qwen.apply(payload, qwenModel, { mode: "utility" });
    expect(result.enable_thinking).toBe(false);
  });

  it("chat mode → 不动 payload（Pi SDK 自己处理）", () => {
    const payload = {
      model: "qwen3.5-plus",
      messages: [{ role: "user", content: "hi" }],
    };
    const result = qwen.apply(payload, qwenModel, { mode: "chat" });
    expect(Object.prototype.hasOwnProperty.call(result, "enable_thinking")).toBe(false);
    expect(result).toBe(payload);
  });

  it("默认 mode（不传 options）当 chat 处理", () => {
    const payload = {
      model: "qwen3.5-plus",
      messages: [{ role: "user", content: "hi" }],
    };
    const result = qwen.apply(payload, qwenModel);
    expect(Object.prototype.hasOwnProperty.call(result, "enable_thinking")).toBe(false);
  });

  it("不 mutate 调用方传入的 payload", () => {
    const payload = {
      model: "qwen3.5-plus",
      messages: [{ role: "user", content: "hi" }],
    };
    qwen.apply(payload, qwenModel, { mode: "utility" });
    expect(Object.prototype.hasOwnProperty.call(payload, "enable_thinking")).toBe(false);
  });
});
