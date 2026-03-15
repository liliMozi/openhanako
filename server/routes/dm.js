/**
 * dm.js — DM 私信 REST API
 *
 * DM 文件存在 agents/{agentId}/dm/{peerId}.md
 *
 * 端点：
 * GET  /api/dm           — 列出当前 focus agent 的所有 DM 对话
 * GET  /api/dm/:peerId   — 获取与某个 agent 的 DM 消息
 */

import fs from "fs";
import path from "path";
import { parseChannel } from "../../lib/channels/channel-store.js";

export default async function dmRoute(app, { engine }) {

  // ── 列出所有 DM 对话（包含未聊过的 agent 作为占位） ──
  app.get("/api/dm", async (_req, reply) => {
    try {
      const agent = engine.agent;
      if (!agent) {
        return { dms: [] };
      }

      const currentAgentId = engine.currentAgentId;
      const dmDir = path.join(agent.agentDir, "dm");

      // 已有 DM 文件 → 读取消息摘要
      const existingDms = new Map();
      if (fs.existsSync(dmDir)) {
        for (const f of fs.readdirSync(dmDir).filter(f => f.endsWith(".md"))) {
          const peerId = f.replace(".md", "");
          const filePath = path.join(dmDir, f);
          const content = fs.readFileSync(filePath, "utf-8");
          const { messages } = parseChannel(content);
          const lastMsg = messages[messages.length - 1];

          existingDms.set(peerId, {
            lastMessage: lastMsg?.body?.slice(0, 60) || "",
            lastSender: lastMsg?.sender || "",
            lastTimestamp: lastMsg?.timestamp || "",
            messageCount: messages.length,
          });
        }
      }

      // 所有其他 agent 都作为 DM 条目（没聊过的也显示）
      const allAgents = engine.listAgents?.() || [];
      const dms = allAgents
        .filter(a => a.id !== currentAgentId)
        .map(a => {
          const existing = existingDms.get(a.id);
          return {
            peerId: a.id,
            peerName: a.name || a.id,
            lastMessage: existing?.lastMessage || "",
            lastSender: existing?.lastSender || "",
            lastTimestamp: existing?.lastTimestamp || "",
            messageCount: existing?.messageCount || 0,
          };
        });

      // 有消息的排前面（按最后消息时间倒序），没消息的按名字排
      dms.sort((a, b) => {
        if (a.lastTimestamp && !b.lastTimestamp) return -1;
        if (!a.lastTimestamp && b.lastTimestamp) return 1;
        if (a.lastTimestamp && b.lastTimestamp) return b.lastTimestamp.localeCompare(a.lastTimestamp);
        return a.peerName.localeCompare(b.peerName);
      });

      return { dms };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 获取 DM 消息 ──
  app.get("/api/dm/:peerId", async (req, reply) => {
    try {
      const { peerId } = req.params;
      const agent = engine.agent;
      if (!agent) {
        reply.code(400);
        return { error: "No active agent" };
      }

      // 安全校验
      if (/[\/\\]|\.\./.test(peerId)) {
        reply.code(400);
        return { error: "Invalid peerId" };
      }

      const dmFile = path.join(agent.agentDir, "dm", `${peerId}.md`);
      if (!fs.existsSync(dmFile)) {
        reply.code(404);
        return { error: "DM not found" };
      }

      const content = fs.readFileSync(dmFile, "utf-8");
      const { meta, messages } = parseChannel(content);

      const peerAgent = engine.getAgent(peerId);
      const peerName = peerAgent?.agentName || peerId;

      return {
        peerId,
        peerName,
        messages,
      };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });
}
