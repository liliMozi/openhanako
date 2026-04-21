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
import { StringEnum } from "../pi-sdk/index.js";
import { t } from "../../server/i18n.js";
import {
  appendMessage,
  createChannel,
  addChannelMember,
  addBookmarkEntry,
  getRecentMessages,
  getChannelMembers,
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
 * @returns {import('../pi-sdk/index.js').ToolDefinition}
 */
export function createChannelTool({ channelsDir, agentsDir, agentId, listAgents, onPost }) {
  return {
    name: "channel",
    label: t("toolDef.channel.label"),
    description: t("toolDef.channel.description"),
    parameters: Type.Object({
      action: StringEnum(
        ["read", "post", "create", "list"],
        { description: t("toolDef.channel.actionDesc") },
      ),
      channel: Type.Optional(Type.String({
        description: t("toolDef.channel.channelDesc")
      })),
      content: Type.Optional(Type.String({
        description: t("toolDef.channel.contentDesc")
      })),
      name: Type.Optional(Type.String({
        description: t("toolDef.channel.nameDesc")
      })),
      members: Type.Optional(Type.Array(Type.String(), {
        description: t("toolDef.channel.membersDesc")
      })),
      intro: Type.Optional(Type.String({
        description: t("toolDef.channel.introDesc")
      })),
      count: Type.Optional(Type.Number({
        description: t("toolDef.channel.countDesc")
      })),
    }),

    execute: async (_toolCallId, params) => {
      switch (params.action) {
        case "read": {
          if (!params.channel) {
            return {
              content: [{ type: "text", text: t("error.channelReadNeedChannel") }],
              details: { action: "read", error: "missing params" },
            };
          }

          const channelFile = path.join(channelsDir, `${params.channel}.md`);
          if (!fs.existsSync(channelFile)) {
            return {
              content: [{ type: "text", text: t("error.channelNotExists", { channel: params.channel }) }],
              details: { action: "read", error: "channel not found" },
            };
          }

          const count = params.count || 20;
          const messages = getRecentMessages(channelFile, count);
          const text = messages.length > 0
            ? formatMessagesForLLM(messages)
            : t("error.channelNoMessages");

          return {
            content: [{ type: "text", text }],
            details: { action: "read", channel: params.channel, messageCount: messages.length },
          };
        }

        case "post": {
          if (!params.channel || !params.content) {
            return {
              content: [{ type: "text", text: t("error.channelPostNeedParams") }],
              details: { action: "post", error: "missing params" },
            };
          }

          const channelFile = path.join(channelsDir, `${params.channel}.md`);
          if (!fs.existsSync(channelFile)) {
            return {
              content: [{ type: "text", text: t("error.channelNotExists", { channel: params.channel }) }],
              details: { action: "post", error: "channel not found" },
            };
          }

          const members = getChannelMembers(channelFile);
          if (!members.includes(agentId)) {
            return {
              content: [{ type: "text", text: t("error.agentNotChannelMember", { channel: params.channel }) }],
              details: { action: "post", error: "not a member" },
            };
          }

          const { timestamp } = appendMessage(channelFile, agentId, params.content);

          // 触发频道 triage，让其他 agent 看到并回复
          if (onPost) {
            try { onPost(params.channel, agentId); } catch {}
          }

          return {
            content: [{ type: "text", text: t("error.channelPosted", { channel: params.channel }) }],
            details: { action: "post", channel: params.channel, timestamp },
          };
        }

        case "create": {
          if (!params.name || !params.members) {
            return {
              content: [{ type: "text", text: t("error.channelCreateNeedParams") }],
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
              content: [{ type: "text", text: t("error.channelCreated", { name: params.name, id: channelId, members: params.members.join(", ") }) }],
              details: { action: "create", channel: channelId, members: params.members },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: t("error.channelCreateFailed", { msg: err.message }) }],
              details: { action: "create", error: err.message },
            };
          }
        }

        case "list": {
          const channelsMdPath = path.join(agentsDir, agentId, "channels.md");
          if (!fs.existsSync(channelsMdPath)) {
            return {
              content: [{ type: "text", text: t("error.channelNoJoined") }],
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
            content: [{ type: "text", text: t("error.unknownAction", { action: params.action }) }],
            details: { action: params.action },
          };
      }
    },
  };
}
