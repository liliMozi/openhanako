/**
 * message-agent-tool.js — Agent 私信工具
 *
 * 让 agent 向其他 agent 发起直达私信，等待回复。
 * 底层走 Hub.send({ from, to }) → AgentMessenger，不经过频道。
 */

import { Type } from "@sinclair/typebox";

/**
 * @param {object} opts
 * @param {string} opts.agentId - 当前 agent ID
 * @param {() => Array<{id: string}>} opts.listAgents - 列出可用 agent
 * @param {(toId: string, text: string, opts?: object) => Promise<string|null>} opts.onMessage - 实际发送实现（由 Hub 注入）
 */
export function createMessageAgentTool({ agentId, listAgents, onMessage }) {
  return {
    name: "message_agent",
    label: "私信 Agent",
    description:
      "向其他 agent 发送私信并等待回复。适合需要咨询或协调另一个 agent 时使用。\n" +
      "对方会根据自己的人设和配置作答，对话在私信空间内进行，不经过频道。\n" +
      "重要：message 内容以你自己的身份发出，不要代替用户说话。例如用户说「去找 ming 聊聊天」，你应该用自己的口吻写消息（如「ming，最近怎么样？」），而不是「用户想和你聊聊」。",
    parameters: Type.Object({
      to: Type.String({ description: "目标 agent 的 ID（如 \"butter\"）" }),
      message: Type.String({ description: "要发送的消息内容" }),
      max_rounds: Type.Optional(Type.Number({
        description: "最多来回轮数，默认 3。对方用 <done/> 可提前结束。",
      })),
    }),
    execute: async (_toolCallId, params) => {
      if (params.to === agentId) {
        return { content: [{ type: "text", text: "不能给自己发私信" }] };
      }

      const agents = listAgents();
      if (!agents.find(a => a.id === params.to)) {
        const ids = agents.map(a => a.id).join(", ");
        return {
          content: [{ type: "text", text: `找不到 agent "${params.to}"。当前可用：${ids || "（无）"}` }],
        };
      }

      const reply = await onMessage(params.to, params.message, {
        maxRounds: params.max_rounds,
      });

      return {
        content: [{ type: "text", text: reply || `（${params.to} 没有回复）` }],
        details: { from: agentId, to: params.to },
      };
    },
  };
}
