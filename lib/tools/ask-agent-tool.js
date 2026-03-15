/**
 * ask-agent-tool.js — 跨 Agent 调用
 *
 * 借用另一个 agent 的身份视角和模型能力做单次回复。
 * 被调用方带 personality（yuan + ishiki + 用户信息），但不带记忆和工具。
 * Session 不保留，不进记忆系统。
 */

import { Type } from "@sinclair/typebox";
import { runAgentSession } from "../../hub/agent-executor.js";

/**
 * @param {object} opts
 * @param {string} opts.agentId - 当前 agent ID
 * @param {() => Array<{id: string, name: string}>} opts.listAgents
 * @param {import('../../core/engine.js').HanaEngine} opts.engine
 */
export function createAskAgentTool({ agentId, listAgents, engine }) {
  return {
    name: "ask_agent",
    label: "跨 Agent 调用",
    description:
      "派任务给另一个 agent，立即拿到结果。对方会当场处理并回复，你可以直接把结果告诉用户。\n" +
      "适用场景：让对方 review 代码、翻译一段文字、从对方的专业视角分析问题等需要即时反馈的任务。\n" +
      "对方以自己的人格和模型回复，有只读工具（读文件、搜索、web fetch），不能写文件或调用其他 agent。",
    parameters: Type.Object({
      agent: Type.String({ description: "目标 agent 的 ID" }),
      task: Type.String({ description: "任务描述（对方看到的完整 prompt）" }),
    }),

    execute: async (_toolCallId, params, signal) => {
      if (params.agent === agentId) {
        return { content: [{ type: "text", text: "不能调用自己" }] };
      }

      const agents = listAgents();
      const target = agents.find(a => a.id === params.agent);
      if (!target) {
        const ids = agents.map(a => `${a.id} (${a.name})`).join(", ");
        return {
          content: [{ type: "text", text: `找不到 agent "${params.agent}"。可用：${ids || "（无）"}` }],
        };
      }

      try {
        const reply = await runAgentSession(
          params.agent,
          [{ text: params.task, capture: true }],
          {
            engine,
            signal,
            sessionSuffix: "ask-temp",
            keepSession: false,
            noMemory: true,
            readOnly: true,
          },
        );

        return {
          content: [{ type: "text", text: reply || `（${target.name} 没有回复）` }],
          details: { from: agentId, to: params.agent, agentName: target.name },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `调用 ${target.name} 失败: ${err.message}` }],
        };
      }
    },
  };
}
