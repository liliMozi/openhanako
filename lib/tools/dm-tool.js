/**
 * dm-tool.js — Agent 私信工具
 *
 * 向另一个 agent 发送私信。消息写入双方的 dm/ 目录，
 * 通过 DM Router 异步通知对方回复。
 *
 * 和 ask_agent 的区别：
 * - ask_agent：同步、单次、无记忆、借用对方模型做任务
 * - dm：异步、有聊天记录、对方以频道模式回复、像发微信
 */

import { Type } from "@sinclair/typebox";
import fs from "fs";
import path from "path";
import { appendMessage } from "../channels/channel-store.js";

/**
 * 确保 DM 文件存在，不存在则创建（含 frontmatter）
 */
function ensureDmFile(dmDir, peerId) {
  fs.mkdirSync(dmDir, { recursive: true });
  const filePath = path.join(dmDir, `${peerId}.md`);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `---\npeer: ${peerId}\n---\n`, "utf-8");
  }
  return filePath;
}

/**
 * @param {object} opts
 * @param {string} opts.agentId - 当前 agent ID
 * @param {string} opts.agentsDir - agents 根目录
 * @param {() => Array<{id: string, name: string}>} opts.listAgents
 * @param {(fromId: string, toId: string) => void} [opts.onDmSent] - 发送后回调（触发 DM Router）
 */
export function createDmTool({ agentId, agentsDir, listAgents, onDmSent }) {
  return {
    name: "dm",
    label: "私信",
    description:
      "给另一个 agent 发一条私信。对方不会立即回复，但看到后会回复，像发微信一样。\n" +
      "消息会保存在聊天记录中，用户可以在频道面板查看。\n" +
      "适用场景：打招呼、闲聊、传话、分享想法等不需要即时结果的沟通。\n" +
      "如果需要对方当场处理任务并返回结果，请用 ask_agent。",
    parameters: Type.Object({
      to: Type.String({ description: "目标 agent 的 ID" }),
      message: Type.String({ description: "消息内容" }),
    }),

    execute: async (_toolCallId, params) => {
      if (params.to === agentId) {
        return { content: [{ type: "text", text: "不能给自己发私信" }] };
      }

      const agents = listAgents();
      const target = agents.find(a => a.id === params.to);
      if (!target) {
        const ids = agents.map(a => `${a.id} (${a.name})`).join(", ");
        return {
          content: [{ type: "text", text: `找不到 agent "${params.to}"。可用：${ids || "（无）"}` }],
        };
      }

      // 写入自己的 dm/{toId}.md
      const myDmDir = path.join(agentsDir, agentId, "dm");
      const myDmFile = ensureDmFile(myDmDir, params.to);
      appendMessage(myDmFile, agentId, params.message);

      // 写入对方的 dm/{myId}.md
      const peerDmDir = path.join(agentsDir, params.to, "dm");
      const peerDmFile = ensureDmFile(peerDmDir, agentId);
      appendMessage(peerDmFile, agentId, params.message);

      // 通知 DM Router
      if (onDmSent) {
        try { onDmSent(agentId, params.to); } catch {}
      }

      return {
        content: [{ type: "text", text: `已发送私信给 ${target.name}` }],
        details: { from: agentId, to: params.to },
      };
    },
  };
}
