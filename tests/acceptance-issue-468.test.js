/**
 * 验收测试 — Provider 兼容层架构统一 plan 收尾
 *
 * 对应 issue #468 (https://github.com/liliMozi/openhanako/issues/468)：
 *   "使用 DeepSeek 推理模型时出现 400 错误：reasoning_content in the thinking mode must be passed back to the api"
 *
 * 这套测试把 DeepSeek 思考模式协议的硬约束翻译成可执行断言，模拟 plan §Task 11 列举的 3 个
 * 真实触发场景的 payload 形态，并在场景 B 覆盖 pi-ai convertMessages 后的实际出站形态，
 * 验证 hana 经过 normalizeProviderPayload 全链路后输出的
 * payload 满足 DeepSeek server 端校验：
 *
 *   场景 A — V4-Pro 多轮 + 工具调用：assistant 历史每条带 tool_calls 的消息都必须有
 *           reasoning_content 字段
 *   场景 B — V4-Pro 切 V4-Flash 多轮：跨子版本切换后 transform-messages 把 thinking
 *           block 降级为 text，hana 必须从 content 恢复 reasoning_content
 *   场景 C — 切 thinking off：disable 路径不再强制 reasoning_content，避免关思考用户受影响
 *
 * 这套测试不依赖真实 DeepSeek API key，跑 npm test 即可验证 #468 不再 400。
 */

import { describe, expect, it } from "vitest";
import { convertMessages } from "../node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js";
import { normalizeProviderPayload } from "../core/provider-compat.js";

const v4ProModel = {
  id: "deepseek-v4-pro",
  provider: "deepseek",
  reasoning: true,
  maxTokens: 384000,
};

const v4FlashModel = {
  id: "deepseek-v4-flash",
  provider: "deepseek",
  reasoning: true,
  maxTokens: 384000,
};

/**
 * 协议铁律断言：扫 payload.messages，每条带 tool_calls 的 assistant message 必须有
 * reasoning_content 字段且值必须是非空字符串。
 */
function assertDeepSeekProtocolCompliant(payload) {
  expect(Array.isArray(payload.messages)).toBe(true);
  for (const [idx, msg] of payload.messages.entries()) {
    if (msg?.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      expect(
        Object.prototype.hasOwnProperty.call(msg, "reasoning_content"),
        `messages[${idx}] 是 assistant + tool_calls 但缺 reasoning_content 字段（DeepSeek 会 400）`
      ).toBe(true);
      expect(
        typeof msg.reasoning_content === "string" && msg.reasoning_content.trim().length > 0,
        `messages[${idx}] 是 assistant + tool_calls 但 reasoning_content 不是非空字符串（DeepSeek 会 400）`
      ).toBe(true);
    }
  }
}

describe("issue #468 验收 — DeepSeek 思考模式协议铁律", () => {
  describe("场景 A：V4-Pro 多轮 + 工具调用（issue 主体复现）", () => {
    it("第 2 轮请求：assistant 历史带 tool_calls + reasoning_content → 通过协议校验", () => {
      // 第 1 轮：用户问问题；DeepSeek 返回 reasoning_content + tool_calls
      // 第 2 轮：用户继续追问；hana 把第 1 轮 assistant 历史拼回去
      const payload = {
        model: "deepseek-v4-pro",
        messages: [
          { role: "user", content: "查询当前时间" },
          {
            role: "assistant",
            content: null,
            reasoning_content: "用户要查时间，我应该调用 date 工具",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "date", arguments: "{}" },
            }],
          },
          { role: "tool", tool_call_id: "call_1", content: "2026-04-26 12:00:00" },
          { role: "user", content: "再帮我算一下还有多少天到下个月" },
        ],
        tools: [{ type: "function", function: { name: "date" } }],
      };
      const result = normalizeProviderPayload(payload, v4ProModel, {
        mode: "chat",
        reasoningLevel: "high",
      });
      assertDeepSeekProtocolCompliant(result);
      expect(result.thinking).toEqual({ type: "enabled" });
    });

    it("3 轮工具调用混合状态里出现坏历史 → fail closed", () => {
      const payload = {
        model: "deepseek-v4-pro",
        messages: [
          { role: "user", content: "round 1" },
          // 档 1：第 1 轮 assistant 已有 reasoning_content（最近一轮，pi-ai 翻译成功）
          {
            role: "assistant",
            content: null,
            reasoning_content: "上轮思考",
            tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "c1", content: "ok1" },
          { role: "user", content: "round 2" },
          // 档 2：第 2 轮被 transform-messages 降级（content 数组只剩 text block）
          {
            role: "assistant",
            content: [{ type: "text", text: "上轮思考被降级保留" }],
            tool_calls: [{ id: "c2", type: "function", function: { name: "y", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "c2", content: "ok2" },
          { role: "user", content: "round 3" },
          // 坏历史：第 3 轮 content 完全为 null（compaction 后或极端情况）
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c3", type: "function", function: { name: "z", arguments: "{}" } }],
          },
        ],
        tools: [{ type: "function", function: { name: "x" } }],
      };
      expect(() => normalizeProviderPayload(payload, v4ProModel, {
        mode: "chat",
        reasoningLevel: "high",
      })).toThrow(/DeepSeek.*reasoning_content.*tool_calls/);
    });
  });

  describe("场景 B：V4-Pro 切 V4-Flash 多轮（跨 V4 子版本切换 — issue #468 最易触发路径）", () => {
    it("用 V4-Flash 发请求，历史含 V4-Pro 时代降级的 thinking block → 全员补 reasoning_content", () => {
      // 模拟用户开了 V4-Pro 跑了一轮工具调用，切到 V4-Flash 继续。
      // pi-ai transform-messages 跨模型保护把 thinking block 降级为 text。
      // 没有 hana 恢复逻辑的话，新请求历史里有 tool_calls 但缺 reasoning_content，DeepSeek 拒收。
      const payload = {
        model: "deepseek-v4-flash",
        messages: [
          { role: "user", content: "之前用 V4-Pro 问的" },
          {
            role: "assistant",
            content: [{ type: "text", text: "V4-Pro 时代的思考" }],  // 降级形态
            tool_calls: [{ id: "c1", type: "function", function: { name: "search", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "c1", content: "search ok" },
          { role: "user", content: "切到 V4-Flash 继续" },
        ],
        tools: [{ type: "function", function: { name: "search" } }],
      };
      const result = normalizeProviderPayload(payload, v4FlashModel, {
        mode: "chat",
        reasoningLevel: "high",
      });
      assertDeepSeekProtocolCompliant(result);
      expect(result.messages[1].reasoning_content).toBe("V4-Pro 时代的思考");  // 档 2 恢复
    });

    it("真实 SDK 转换后仍从 assistant.content 字符串恢复 reasoning_content", () => {
      const context = {
        messages: [
          { role: "user", content: "之前用 V4-Pro 问的" },
          {
            role: "assistant",
            provider: "deepseek",
            api: "openai-completions",
            model: "deepseek-v4-pro",
            content: [
              { type: "thinking", thinking: "V4-Pro 时代的思考", thinkingSignature: "reasoning_content" },
              { type: "toolCall", id: "c1", name: "search", arguments: {} },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "search",
            content: [{ type: "text", text: "search ok" }],
            isError: false,
          },
          { role: "user", content: "切到 V4-Flash 继续" },
        ],
      };
      const sdkModel = {
        ...v4FlashModel,
        api: "openai-completions",
        input: ["text"],
      };
      const payload = {
        model: "deepseek-v4-flash",
        messages: convertMessages(sdkModel, context, {}),
        tools: [{ type: "function", function: { name: "search" } }],
      };
      const result = normalizeProviderPayload(payload, v4FlashModel, {
        mode: "chat",
        reasoningLevel: "high",
      });
      assertDeepSeekProtocolCompliant(result);
      expect(result.messages[1].content).toBe("V4-Pro 时代的思考");
      expect(result.messages[1].reasoning_content).toBe("V4-Pro 时代的思考");
    });
  });

  describe("场景 C：thinking off / utility 不受 thinking-tool 回传约束影响", () => {
    it("用户切 thinking off，历史含 tool_calls + reasoning_content → strip 后不补占位", () => {
      const payload = {
        model: "deepseek-v4-pro",
        messages: [
          { role: "user", content: "之前开思考的对话" },
          {
            role: "assistant",
            content: null,
            reasoning_content: "之前开思考时的思考",
            tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "c1", content: "ok" },
          { role: "user", content: "现在我要关思考继续聊" },
        ],
      };
      const result = normalizeProviderPayload(payload, v4ProModel, {
        mode: "chat",
        reasoningLevel: "off",
      });
      expect(result.thinking).toEqual({ type: "disabled" });
      expect(result.messages[1]).not.toHaveProperty("reasoning_content");
    });

    it("utility mode + tool_calls 历史 → 不注入 reasoning_content", () => {
      const payload = {
        model: "deepseek-v4-flash",
        messages: [
          { role: "user", content: "短摘要任务" },
          {
            role: "assistant",
            content: null,
            reasoning_content: "之前的思考",
            tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }],
          },
        ],
        max_tokens: 50,
      };
      const result = normalizeProviderPayload(payload, v4FlashModel, { mode: "utility" });
      expect(result.thinking).toEqual({ type: "disabled" });
      expect(result.messages[1]).not.toHaveProperty("reasoning_content");
    });
  });

  describe("非工具调用消息不被污染（不引入额外字段）", () => {
    it("普通对话（无 tool_calls）的 assistant 消息不被注入 reasoning_content 字段", () => {
      const payload = {
        model: "deepseek-v4-pro",
        messages: [
          { role: "user", content: "你好" },
          { role: "assistant", content: "你好！有什么可以帮你的？" },
          { role: "user", content: "再说一遍" },
        ],
      };
      const result = normalizeProviderPayload(payload, v4ProModel, {
        mode: "chat",
        reasoningLevel: "high",
      });
      assertDeepSeekProtocolCompliant(result);
      expect(Object.prototype.hasOwnProperty.call(result.messages[1], "reasoning_content"))
        .toBe(false);  // 没 tool_calls 的 assistant 不该被注入
    });
  });

  describe("非 DeepSeek model 完全不被本套补丁影响", () => {
    it("OpenAI model + tool_calls 历史 → reasoning_content 字段不被注入", () => {
      const openaiModel = {
        id: "gpt-4o",
        provider: "openai",
      };
      const payload = {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "x" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }],
          },
        ],
      };
      const result = normalizeProviderPayload(payload, openaiModel, { mode: "chat" });
      // 非 DeepSeek 不会被注入 reasoning_content
      expect(Object.prototype.hasOwnProperty.call(result.messages[1], "reasoning_content"))
        .toBe(false);
      // 也不会被加 thinking 字段
      expect(result.thinking).toBeUndefined();
    });
  });
});
