/**
 * channel-tool.js — Agent 使用的频道工具
 *
 * 操作：
 * - read：读取频道最近消息
 * - post：往频道发送消息
 * - create：创建新频道
 * - list：查看加入的频道列表
 */

import { Type } from "@sinclair/typebox";
import {
  appendMessage,
  createChannel,
  addChannelMember,
  addBookmarkEntry,
  getRecentMessages,
  formatMessagesForLLM,
} from "../channels/channel-store.js";
import fs from "fs";
import path from "path";

/**
 * 创建频道工具
 * @param {object} opts
 * @param {string} opts.channelsDir - 频道目录路径
 * @param {string} opts.agentsDir - agents 父目录
 * @param {string} opts.agentId - 当前 agent ID
 * @param {() => Array<{id: string, name: string}>} opts.listAgents - 列出所有 agent
 * @returns {import('@mariozechner/pi-coding-agent').ToolDefinition}
 */
export function createChannelTool({ channelsDir, agentsDir, agentId, listAgents, onPost }) {
  return {
    name: "channel",
    label: "频道",
    description:
      "管理频道消息（适合多人广播、群组讨论）。\n" +
      "操作：\n" +
      "- read(channel, count?)：查看频道最近消息\n" +
      "- post(channel, content)：往频道发送消息\n" +
      "- create(name, members, intro?)：创建新频道\n" +
      "- list：查看自己加入的频道\n" +
      "注意：如需与某个 agent 一对一私信，请用 dm 工具，不要用频道模拟私聊。",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("read"),
        Type.Literal("post"),
        Type.Literal("create"),
        Type.Literal("list"),
      ], { description: "操作类型" }),
      channel: Type.Optional(Type.String({
        description: "频道名称（read/post 时必填）"
      })),
      content: Type.Optional(Type.String({
        description: "消息内容（post 时必填）"
      })),
      name: Type.Optional(Type.String({
        description: "新频道名称（create 时必填）"
      })),
      members: Type.Optional(Type.Array(Type.String(), {
        description: "成员列表（create 时必填），如 [\"hana\", \"butter\"]"
      })),
      intro: Type.Optional(Type.String({
        description: "频道介绍（create 时可选）"
      })),
      count: Type.Optional(Type.Number({
        description: "读取消息条数（read 时可选，默认 20）"
      })),
    }),

    execute: async (_toolCallId, params) => {
      switch (params.action) {
        case "read": {
          if (!params.channel) {
            return {
              content: [{ type: "text", text: "错误：read 需要 channel 参数" }],
              details: { action: "read", error: "missing params" },
            };
          }

          const channelFile = path.join(channelsDir, `${params.channel}.md`);
          if (!fs.existsSync(channelFile)) {
            return {
              content: [{ type: "text", text: `频道 "${params.channel}" 不存在` }],
              details: { action: "read", error: "channel not found" },
            };
          }

          const count = params.count || 20;
          const messages = getRecentMessages(channelFile, count);
          const text = messages.length > 0
            ? formatMessagesForLLM(messages)
            : "(频道暂无消息)";

          return {
            content: [{ type: "text", text }],
            details: { action: "read", channel: params.channel, messageCount: messages.length },
          };
        }

        case "post": {
          if (!params.channel || !params.content) {
            return {
              content: [{ type: "text", text: "错误：post 需要 channel 和 content 参数" }],
              details: { action: "post", error: "missing params" },
            };
          }

          const channelFile = path.join(channelsDir, `${params.channel}.md`);
          if (!fs.existsSync(channelFile)) {
            return {
              content: [{ type: "text", text: `频道 "${params.channel}" 不存在` }],
              details: { action: "post", error: "channel not found" },
            };
          }

          const { timestamp } = appendMessage(channelFile, agentId, params.content);

          // 触发频道 triage，让其他 agent 看到并回复
          if (onPost) {
            try { onPost(params.channel, agentId); } catch {}
          }

          return {
            content: [{ type: "text", text: `已发送到 #${params.channel}` }],
            details: { action: "post", channel: params.channel, timestamp },
          };
        }

        case "create": {
          if (!params.name || !params.members) {
            return {
              content: [{ type: "text", text: "错误：create 需要 name 和 members 参数" }],
              details: { action: "create", error: "missing params" },
            };
          }

          try {
            const { id: channelId } = createChannel(channelsDir, {
              name: params.name,
              members: params.members,
              intro: params.intro,
            });

            // 给每个 member 的 channels.md 添加条目
            for (const memberId of params.members) {
              const memberChannelsMd = path.join(agentsDir, memberId, "channels.md");
              if (fs.existsSync(path.join(agentsDir, memberId))) {
                addBookmarkEntry(memberChannelsMd, channelId);
              }
            }

            return {
              content: [{ type: "text", text: `频道 #${params.name} (${channelId}) 已创建，成员：${params.members.join(", ")}` }],
              details: { action: "create", channel: channelId, members: params.members },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `创建失败：${err.message}` }],
              details: { action: "create", error: err.message },
            };
          }
        }

        case "list": {
          const channelsMdPath = path.join(agentsDir, agentId, "channels.md");
          if (!fs.existsSync(channelsMdPath)) {
            return {
              content: [{ type: "text", text: "还没有加入任何频道" }],
              details: { action: "list", channels: [] },
            };
          }

          const content = fs.readFileSync(channelsMdPath, "utf-8");
          return {
            content: [{ type: "text", text: content }],
            details: { action: "list" },
          };
        }

        default:
          return {
            content: [{ type: "text", text: `未知操作: ${params.action}` }],
            details: { action: params.action },
          };
      }
    },
  };
}
