/**
 * channels.js — 频道 REST API
 *
 * Channel ID 化：文件名为 ch_{id}.md，frontmatter 含 id/name/description/members。
 *
 * 端点：
 * GET    /api/channels              — 列出所有频道 + 用户 bookmark + 未读数
 * POST   /api/channels              — 创建新频道
 * GET    /api/channels/:id          — 获取频道消息 + 成员列表
 * POST   /api/channels/:id/messages — 用户发送群聊消息
 * POST   /api/channels/:id/read     — 更新用户已读 bookmark
 * DELETE /api/channels/:id          — 删除频道
 */

import fs from "fs";
import path from "path";
import { debugLog } from "../../lib/debug-log.js";
import {
  parseChannel,
  createChannel,
  appendMessage,
  readBookmarks,
  updateBookmark,
  addBookmarkEntry,
  getChannelMeta,
} from "../../lib/channels/channel-store.js";

export default async function channelsRoute(app, { engine, hub }) {

  /** 用户 bookmark 文件路径 */
  function userBookmarkPath() {
    return path.join(engine.userDir, "channel-bookmarks.md");
  }

  /** 安全路径校验：id 不能穿越出 channelsDir */
  function safeChannelPath(id) {
    const filePath = path.join(engine.channelsDir, `${id}.md`);
    const resolved = path.resolve(filePath);
    const base = path.resolve(engine.channelsDir);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      return null;
    }
    return resolved;
  }

  // ── 列出所有频道 ──
  app.get("/api/channels", async (_req, reply) => {
    try {
      const channelsDir = engine.channelsDir;
      if (!channelsDir || !fs.existsSync(channelsDir)) {
        return { channels: [], bookmarks: {} };
      }

      const files = fs.readdirSync(channelsDir).filter(f => f.endsWith(".md"));
      const bookmarks = readBookmarks(userBookmarkPath());

      const channels = [];
      for (const f of files) {
        const channelId = f.replace(".md", "");
        const filePath = path.join(channelsDir, f);
        const content = fs.readFileSync(filePath, "utf-8");
        const { meta, messages } = parseChannel(content);
        const members = Array.isArray(meta.members) ? meta.members : [];

        const lastMsg = messages[messages.length - 1];
        const bookmark = bookmarks.get(channelId);

        let newMessageCount = 0;
        if (bookmark && bookmark !== "never") {
          newMessageCount = messages.filter(m => m.timestamp > bookmark).length;
        } else {
          newMessageCount = messages.length;
        }

        channels.push({
          id: channelId,
          name: meta.name || channelId,
          description: meta.description || "",
          members,
          messageCount: messages.length,
          newMessageCount,
          lastMessage: lastMsg?.body?.slice(0, 60) || "",
          lastSender: lastMsg?.sender || "",
          lastTimestamp: lastMsg?.timestamp || "",
        });
      }

      channels.sort((a, b) =>
        (b.lastTimestamp || "").localeCompare(a.lastTimestamp || "")
      );

      const bookmarksObj = {};
      for (const [k, v] of bookmarks) bookmarksObj[k] = v;

      return { channels, bookmarks: bookmarksObj };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 创建新频道 ──
  app.post("/api/channels", async (req, reply) => {
    try {
      const { name, description, members, intro } = req.body || {};

      if (!name || typeof name !== "string") {
        reply.code(400);
        return { error: "name is required" };
      }
      if (!Array.isArray(members) || members.length < 2) {
        reply.code(400);
        return { error: "members must be an array with at least 2 items" };
      }

      const channelsDir = engine.channelsDir;
      fs.mkdirSync(channelsDir, { recursive: true });

      const { id: channelId } = createChannel(channelsDir, {
        name,
        description: description || undefined,
        members,
        intro: intro || undefined,
      });

      // 给每个 agent 成员的 channels.md 添加 bookmark
      const agentsDir = engine.agentsDir;
      for (const memberId of members) {
        const memberDir = path.join(agentsDir, memberId);
        if (fs.existsSync(memberDir)) {
          const memberChannelsMd = path.join(memberDir, "channels.md");
          addBookmarkEntry(memberChannelsMd, channelId);
        }
      }

      // 也给用户添加 bookmark
      addBookmarkEntry(userBookmarkPath(), channelId);

      debugLog()?.log("api", `POST /channels — created "${channelId}" (${name}) members=[${members}]`);
      return { ok: true, id: channelId, name, members };
    } catch (err) {
      if (err.message?.includes("已存在")) {
        reply.code(409);
      } else {
        reply.code(500);
      }
      return { error: err.message };
    }
  });

  // ── 获取频道消息 ──
  app.get("/api/channels/:name", async (req, reply) => {
    try {
      const { name } = req.params;
      const filePath = safeChannelPath(name);
      if (!filePath) { reply.code(400); return { error: "Invalid channel id" }; }

      if (!fs.existsSync(filePath)) {
        reply.code(404);
        return { error: "Channel not found" };
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const { meta, messages } = parseChannel(content);
      const members = Array.isArray(meta.members) ? meta.members : [];

      return {
        id: meta.id || name,
        name: meta.name || name,
        description: meta.description || "",
        messages,
        members,
      };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 用户发送消息 ──
  app.post("/api/channels/:name/messages", async (req, reply) => {
    try {
      const { name } = req.params;
      const filePath = safeChannelPath(name);
      if (!filePath) { reply.code(400); return { error: "Invalid channel id" }; }

      const { body } = req.body || {};

      if (!body) {
        reply.code(400);
        return { error: "body is required" };
      }

      if (!fs.existsSync(filePath)) {
        reply.code(404);
        return { error: "Channel not found" };
      }

      const senderName = engine.userName || "user";
      const result = appendMessage(filePath, senderName, body);

      debugLog()?.log("api", `POST /channels/${name}/messages`);

      // 提取 @ 提及
      const atMatches = body.match(/@(\S+)/g) || [];
      const mentionedAgents = [];
      if (atMatches.length > 0) {
        const meta = getChannelMeta(filePath);
        const channelMembers = Array.isArray(meta.members) ? meta.members : [];
        const allAgents = engine.listAgents?.() || [];
        for (const at of atMatches) {
          const atName = at.slice(1);
          const matched = allAgents.find(a =>
            a.name === atName || a.id === atName
          );
          if (matched && channelMembers.includes(matched.id)) {
            mentionedAgents.push(matched.id);
          }
        }
      }

      hub.triggerChannelTriage(name, { mentionedAgents })?.catch(err =>
        console.error(`[channel] 触发立即 triage 失败: ${err.message}`)
      );

      return { ok: true, timestamp: result.timestamp };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 更新用户已读 bookmark ──
  app.post("/api/channels/:name/read", async (req, reply) => {
    try {
      const { name } = req.params;
      const filePath = safeChannelPath(name);
      if (!filePath) { reply.code(400); return { error: "Invalid channel id" }; }

      const { timestamp } = req.body || {};

      if (!timestamp) {
        reply.code(400);
        return { error: "timestamp is required" };
      }

      updateBookmark(userBookmarkPath(), name, timestamp);
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err.message };
    }
  });

  // ── 删除频道 ──
  app.delete("/api/channels/:name", async (req, reply) => {
    try {
      const { name } = req.params;
      const filePath = safeChannelPath(name);
      if (!filePath) { reply.code(400); return { error: "Invalid channel id" }; }

      engine.deleteChannelByName(name);
      debugLog()?.log("api", `DELETE /channels/${name}`);
      return { ok: true };
    } catch (err) {
      if (err.message?.includes("不存在")) {
        reply.code(404);
      } else {
        reply.code(500);
      }
      return { error: err.message };
    }
  });

  // ── 频道开关（启停 channelTicker）──
  app.post("/api/channels/toggle", async (req, _reply) => {
    const { enabled } = req.body || {};
    await hub.toggleChannels(!!enabled);
    debugLog()?.log("api", `POST /channels/toggle enabled=${!!enabled}`);
    return { ok: true, enabled: !!enabled };
  });
}
