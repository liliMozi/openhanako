import { describe, expect, it } from "vitest";
import * as deepseek from "../../core/provider-compat/deepseek.js";

describe("provider-compat/deepseek — matches", () => {
  it("导出 matches 函数", () => {
    expect(typeof deepseek.matches).toBe("function");
  });

  it("导出 apply 函数", () => {
    expect(typeof deepseek.apply).toBe("function");
  });

  it("matches 对 null/undefined 返回 false（不抛错）", () => {
    expect(deepseek.matches(null)).toBe(false);
    expect(deepseek.matches(undefined)).toBe(false);
    expect(deepseek.matches({})).toBe(false);
  });

  it("matches 识别 deepseek provider", () => {
    expect(deepseek.matches({ provider: "deepseek" })).toBe(true);
  });

  it("matches 识别官方 baseUrl", () => {
    expect(deepseek.matches({ baseUrl: "https://api.deepseek.com/v1" })).toBe(true);
  });

  it("matches 识别 snake_case base_url 别名", () => {
    expect(deepseek.matches({ base_url: "https://api.deepseek.com" })).toBe(true);
  });

  it("matches 不把 openrouter 上的 deepseek 视为 deepseek", () => {
    expect(deepseek.matches({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      id: "deepseek/deepseek-v3.2",
    })).toBe(false);
  });
});

describe("provider-compat/deepseek — extractReasoningFromContent", () => {
  it("从被 transform-messages 降级为 text 的 content 里恢复原文", () => {
    // pi-ai transform-messages.js:38-48 跨模型时把 thinking block 转为
    // { type: "text", text: <思考原文> }，放在 content 数组首位
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "思考原文：先调用 date 工具" },
      ],
      tool_calls: [{ id: "call_1", type: "function", function: { name: "date", arguments: "{}" } }],
    };
    expect(deepseek.extractReasoningFromContent(message)).toBe("思考原文：先调用 date 工具");
  });

  it("已有 thinking block（同模型路径）时也能取出 thinking 字段", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "原始思考内容", thinkingSignature: "reasoning_content" },
        { type: "toolCall", id: "call_1", name: "date" },
      ],
    };
    expect(deepseek.extractReasoningFromContent(message)).toBe("原始思考内容");
  });

  it("多个 thinking block 时返回第一个的 thinking 内容", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "第一段思考" },
        { type: "text", text: "中间正文" },
        { type: "thinking", thinking: "第二段思考" },
      ],
    };
    expect(deepseek.extractReasoningFromContent(message)).toBe("第一段思考");
  });

  it("thinking 字段为空字符串时返回空字符串（Path 1 优先于 Path 2 fallback）", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: "正文，不应被当作 reasoning" },
      ],
    };
    expect(deepseek.extractReasoningFromContent(message)).toBe("");
  });

  it("content 为字符串（真实 SDK 转换后的 assistantMsg.content）时返回字符串内容", () => {
    const message = {
      role: "assistant",
      content: "已经转换成 string 的思考原文",
      tool_calls: [{ id: "call_1" }],
    };
    expect(deepseek.extractReasoningFromContent(message)).toBe("已经转换成 string 的思考原文");
  });

  it("无 content 字段时返回空字符串", () => {
    expect(deepseek.extractReasoningFromContent({ role: "assistant", tool_calls: [{}] })).toBe("");
  });

  it("content 是空数组时返回空字符串", () => {
    expect(deepseek.extractReasoningFromContent({ role: "assistant", content: [] })).toBe("");
  });

  it("null/undefined message 返回空字符串（不抛错）", () => {
    expect(deepseek.extractReasoningFromContent(null)).toBe("");
    expect(deepseek.extractReasoningFromContent(undefined)).toBe("");
  });
});

describe("provider-compat/deepseek — ensureReasoningContentForToolCalls", () => {
  it("已有 reasoning_content 时不动（档 1）", () => {
    const messages = [
      { role: "user", content: "what time" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "我应该调用 date 工具",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "date", arguments: "{}" } }],
      },
    ];
    const result = deepseek.ensureReasoningContentForToolCalls(messages);
    expect(result[1].reasoning_content).toBe("我应该调用 date 工具");
  });

  it("reasoning_content 已存在但为空字符串/null 时不再视为合规", () => {
    const messages = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "从 thinking 恢复", thinkingSignature: "reasoning_content" }],
        reasoning_content: "",
        tool_calls: [{ id: "call_1" }],
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "也从 thinking 恢复", thinkingSignature: "reasoning_content" }],
        reasoning_content: null,
        tool_calls: [{ id: "call_2" }],
      },
    ];
    const result = deepseek.ensureReasoningContentForToolCalls(messages);
    expect(result[1].reasoning_content).toBe("从 thinking 恢复");
    expect(result[2].reasoning_content).toBe("也从 thinking 恢复");
    expect(result).not.toBe(messages);
  });

  it("档 1 命中时被检查的 assistant message 保持对象引用相等", () => {
    const compliantAssistant = {
      role: "assistant",
      reasoning_content: "已经合规",
      tool_calls: [{ id: "call_1" }],
    };
    const messages = [{ role: "user", content: "y" }, compliantAssistant];
    const result = deepseek.ensureReasoningContentForToolCalls(messages);
    expect(result).toBe(messages); // 数组引用
    expect(result[1]).toBe(compliantAssistant); // 单条 assistant 对象引用
  });

  it("从 thinking block 恢复 reasoning_content（档 2，同模型路径）", () => {
    const messages = [
      { role: "user", content: "what time" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "调用 date 工具", thinkingSignature: "reasoning_content" },
          { type: "toolCall", id: "call_1", name: "date" },
        ],
        tool_calls: [{ id: "call_1", type: "function", function: { name: "date", arguments: "{}" } }],
      },
    ];
    const result = deepseek.ensureReasoningContentForToolCalls(messages);
    expect(result[1].reasoning_content).toBe("调用 date 工具");
  });

  it("从降级 text block 恢复 reasoning_content（档 2，跨 V4 子版本路径）", () => {
    // 模拟 transform-messages 跨 V4-Pro 切 V4-Flash 后的状态
    const messages = [
      { role: "user", content: "what time" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "用 date 工具查时间" },
        ],
        tool_calls: [{ id: "call_1", type: "function", function: { name: "date", arguments: "{}" } }],
      },
    ];
    const result = deepseek.ensureReasoningContentForToolCalls(messages);
    expect(result[1].reasoning_content).toBe("用 date 工具查时间");
  });

  it("从真实 SDK 转换后的 content 字符串恢复 reasoning_content（档 2，跨 V4 子版本路径）", () => {
    const messages = [
      { role: "user", content: "what time" },
      {
        role: "assistant",
        content: "用 date 工具查时间",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "date", arguments: "{}" } }],
      },
    ];
    const result = deepseek.ensureReasoningContentForToolCalls(messages);
    expect(result[1].reasoning_content).toBe("用 date 工具查时间");
  });

  it("既无 reasoning_content 也无可恢复原文 → fail closed，不再注入空字符串占位", () => {
    const messages = [
      { role: "user", content: "what time" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "date", arguments: "{}" } }],
      },
    ];
    expect(() => deepseek.ensureReasoningContentForToolCalls(messages))
      .toThrow(/DeepSeek.*reasoning_content.*tool_calls/);
  });

  it("无 tool_calls 的 assistant message 不动（不属于硬约束）", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "hello",
      },
    ];
    const result = deepseek.ensureReasoningContentForToolCalls(messages);
    expect(Object.prototype.hasOwnProperty.call(result[1], "reasoning_content")).toBe(false);
  });

  it("user / tool / system message 不动", () => {
    const messages = [
      { role: "system", content: "you are an agent" },
      { role: "user", content: "what time" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "调用 date", thinkingSignature: "reasoning_content" },
          { type: "toolCall", id: "call_1", name: "date" },
        ],
        tool_calls: [{ id: "call_1", type: "function", function: { name: "date", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "2026-04-26" },
    ];
    const result = deepseek.ensureReasoningContentForToolCalls(messages);
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
    expect(result[3]).toBe(messages[3]);
  });

  it("全部 message 都已合规时返回原数组（不浪费分配）", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(deepseek.ensureReasoningContentForToolCalls(messages)).toBe(messages);
  });

  it("fail closed 也不 mutate 调用方传入的 message", () => {
    const original = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1" }],
    };
    const messages = [{ role: "user", content: "x" }, original];
    expect(() => deepseek.ensureReasoningContentForToolCalls(messages)).toThrow(/reasoning_content/);
    expect(Object.prototype.hasOwnProperty.call(original, "reasoning_content")).toBe(false);
  });

  it("messages 不是数组时原样返回", () => {
    expect(deepseek.ensureReasoningContentForToolCalls(null)).toBe(null);
    expect(deepseek.ensureReasoningContentForToolCalls(undefined)).toBe(undefined);
    expect(deepseek.ensureReasoningContentForToolCalls("not an array")).toBe("not an array");
  });

  it("tool_calls 是空数组也视为无工具调用，不注入", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", tool_calls: [] },
    ];
    const result = deepseek.ensureReasoningContentForToolCalls(messages);
    expect(Object.prototype.hasOwnProperty.call(result[1], "reasoning_content")).toBe(false);
  });
});

describe("provider-compat/deepseek — apply 主流程接入 reasoning_content 恢复/校验", () => {
  const deepseekModel = {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    reasoning: true,
    maxTokens: 384000,
  };

  it("chat mode + 思考开启：tool_calls 历史补 reasoning_content（覆盖跨 V4 切换）", () => {
    const payload = {
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "what time" },
        {
          role: "assistant",
          content: [{ type: "text", text: "调用 date" }],  // 模拟降级
          tool_calls: [{ id: "call_1", type: "function", function: { name: "date", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "2026-04-26" },
      ],
      tools: [{ type: "function", function: { name: "date" } }],
      reasoning_effort: "high",
    };
    const result = deepseek.apply(payload, deepseekModel, { mode: "chat", reasoningLevel: "high" });
    expect(result.messages[1].reasoning_content).toBe("调用 date");
    expect(result.thinking).toEqual({ type: "enabled" });
  });

  it("chat mode + 思考开启：tool_calls 历史无可恢复原文 → fail closed", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "what time" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "date", arguments: "{}" } }],
        },
      ],
      tools: [{ type: "function", function: { name: "date" } }],
    };
    expect(() => deepseek.apply(payload, deepseekModel, { mode: "chat", reasoningLevel: "high" }))
      .toThrow(/DeepSeek.*reasoning_content.*tool_calls/);
  });

  it("chat mode + reasoningLevel='off'（disableThinking 路径）不强制 reasoning_content", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "what time" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "应该调 date",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "date", arguments: "{}" } }],
        },
      ],
    };
    const result = deepseek.apply(payload, deepseekModel, { mode: "chat", reasoningLevel: "off" });
    expect(result.thinking).toEqual({ type: "disabled" });
    expect(result.messages[1]).not.toHaveProperty("reasoning_content");
  });

  it("utility mode（disableThinking 路径）历史含 tool_calls 不注入 reasoning_content", () => {
    const payload = {
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "之前的思考",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "x", arguments: "{}" } }],
        },
      ],
      max_tokens: 50,
    };
    const result = deepseek.apply(payload, deepseekModel, { mode: "utility" });
    expect(result.thinking).toEqual({ type: "disabled" });
    expect(result.messages[1]).not.toHaveProperty("reasoning_content");
  });

  it("无 tool_calls 历史时 ensure 不引入新字段（不污染）", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    };
    const result = deepseek.apply(payload, deepseekModel, { mode: "chat" });
    expect(Object.prototype.hasOwnProperty.call(result.messages[1], "reasoning_content")).toBe(false);
  });

  it("chat mode + 思考开启：多轮工具调用混合状态各自命中正确档位", () => {
    const payload = {
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "round 1" },
        // 档 1：已有 reasoning_content（上一轮保留下来的）
        {
          role: "assistant",
          content: null,
          reasoning_content: "上轮思考",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "x", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok1" },
        { role: "user", content: "round 2" },
        // 档 2：无 reasoning_content 但 content 是降级 text（跨 V4 子版本切换后的状态）
        {
          role: "assistant",
          content: [{ type: "text", text: "本轮思考被降级" }],
          tool_calls: [{ id: "call_2", type: "function", function: { name: "y", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_2", content: "ok2" },
        { role: "user", content: "round 3" },
        // 坏历史：无 reasoning_content 也无原文可恢复
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_3", type: "function", function: { name: "z", arguments: "{}" } }],
        },
      ],
      tools: [{ type: "function", function: { name: "x" } }],
    };
    expect(() => deepseek.apply(payload, deepseekModel, { mode: "chat", reasoningLevel: "high" }))
      .toThrow(/DeepSeek.*reasoning_content.*tool_calls/);
  });
});

describe("provider-compat/deepseek — apply 不可变性（防止 mutate 输入 payload）", () => {
  it("apply 不 mutate 输入 payload（chat mode + 思考开启）", () => {
    const original = {
      model: "deepseek-reasoner",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "low",
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    deepseek.apply(original, { provider: "deepseek", id: "deepseek-reasoner", reasoning: true }, { mode: "chat", reasoningLevel: "high" });
    expect(original).toEqual(snapshot);
  });

  it("apply 不 mutate 输入 payload（utility mode 关思考）", () => {
    const original = {
      model: "deepseek-reasoner",
      messages: [{ role: "user", content: "hi" }],
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    deepseek.apply(original, { provider: "deepseek", id: "deepseek-reasoner", reasoning: true }, { mode: "utility" });
    expect(original).toEqual(snapshot);
  });

  it("apply 不 mutate 输入 payload（reasoningLevel='off' 强制 disable）", () => {
    const original = {
      model: "deepseek-reasoner",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "x", reasoning_content: "thought" },
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    deepseek.apply(original, { provider: "deepseek", id: "deepseek-reasoner", reasoning: true }, { mode: "chat", reasoningLevel: "off" });
    expect(original).toEqual(snapshot);
  });

  it("apply 不 mutate 输入 payload（chat mode + 非 thinking 模型，走 no-op 早退）", () => {
    const original = {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hi" }],
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    deepseek.apply(original, { provider: "deepseek", id: "deepseek-chat" }, { mode: "chat" });
    expect(original).toEqual(snapshot);
  });
});
