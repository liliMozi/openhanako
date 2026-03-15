/**
 * delegate-tool.js — Sub-agent 委派工具
 *
 * 将独立子任务委派给隔离的 agent session 执行。
 * 子任务在独立上下文中运行，只返回最终结果，
 * 不占用主对话的上下文窗口。
 *
 * 底层复用 executeIsolated，并行由 PI SDK 的
 * 多 tool_call 机制自然支持。
 */

import { Type } from "@sinclair/typebox";

/** sub-agent 可用的 custom tools（只读/研究类） */
const DELEGATE_CUSTOM_TOOLS = [
  "search_memory", "recall_experience",
  "web_search", "web_fetch",
];

const DELEGATE_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

/** 注入到子任务 prompt 前的前导指令 */
const DELEGATE_PREAMBLE =
  "你现在是一个调研子任务。要求：\n" +
  "- 不需要 MOOD 区块\n" +
  "- 不需要寒暄，直接给结论\n" +
  "- 输出简洁、结构化，附上关键证据和来源\n" +
  "- 如果信息不足，明确说明缺什么\n\n" +
  "任务：\n";

let activeCount = 0;
const MAX_CONCURRENT = 3;

/**
 * 创建 delegate 工具
 * @param {object} deps
 * @param {(prompt: string, opts: object) => Promise} deps.executeIsolated
 * @param {() => string|null} deps.resolveUtilityModel
 * @param {string[]} deps.readOnlyBuiltinTools
 * @returns {import('@mariozechner/pi-coding-agent').ToolDefinition}
 */
export function createDelegateTool(deps) {
  return {
    name: "delegate",
    label: "委派子任务",
    description:
      "将独立的子任务委派给后台 agent 执行。子任务在隔离的上下文中运行，只返回最终结果，不占用当前对话的上下文。\n" +
      "适用场景：\n" +
      "- 需要大量搜索、阅读后总结为简短结论的调研任务\n" +
      "- 可以和当前思路并行的独立子问题\n" +
      "- 需要在多个方向同时探索的任务（可同时发起多个 delegate 调用）\n" +
      "不适用：需要修改文件、执行命令等有副作用的操作\n\n" +
      "重要：task 参数要写清楚完整的指令和必要背景，子任务看不到当前对话历史。",
    parameters: Type.Object({
      task: Type.String({ description: "子任务的完整指令，包含必要的背景信息" }),
      model: Type.Optional(Type.String({ description: "指定模型（可选，默认使用 utility 模型）" })),
    }),

    execute: async (_toolCallId, params, signal) => {
      if (activeCount >= MAX_CONCURRENT) {
        return {
          content: [{ type: "text", text: `当前已有 ${MAX_CONCURRENT} 个子任务在运行，请等待完成后再发起新任务。` }],
        };
      }

      // 合并外部 signal 和超时 signal
      const timeoutSignal = AbortSignal.timeout(DELEGATE_TIMEOUT_MS);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      activeCount++;
      try {
        const result = await deps.executeIsolated(
          DELEGATE_PREAMBLE + params.task,
          {
            model: params.model || deps.resolveUtilityModel(),
            toolFilter: DELEGATE_CUSTOM_TOOLS,
            builtinFilter: deps.readOnlyBuiltinTools,
            signal: combinedSignal,
          },
        );

        if (result.error) {
          return {
            content: [{ type: "text", text: `子任务执行失败: ${result.error}` }],
          };
        }
        return {
          content: [{ type: "text", text: result.replyText || "(子任务未产生输出)" }],
        };
      } finally {
        activeCount--;
      }
    },
  };
}
