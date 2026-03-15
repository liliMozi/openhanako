/**
 * notify-tool.js — 桌面通知工具
 *
 * 让 agent 能主动向用户发送系统通知（macOS 桌面弹窗）。
 * 仅在用户明确要求提醒/通知时使用，普通任务完成不调用。
 */

import { Type } from "@sinclair/typebox";

/**
 * @param {{ onNotify: (title: string, body: string) => Promise<void> | void }} opts
 */
export function createNotifyTool({ onNotify }) {
  return {
    name: "notify",
    label: "通知",
    description:
      "向用户发送系统通知（桌面弹窗）。\n" +
      "使用场景：\n" +
      "- 用户说「提醒我 xxx」「到时候通知我」「记得叫我 xxx」\n" +
      "- 定时任务的 prompt 中明确包含「通知」「提醒」等意图\n" +
      "- 巡检/定时任务中发现需要用户关注的事项\n" +
      "如果一切正常、无异常，不要调用此工具。",
    parameters: Type.Object({
      title: Type.String({ description: "通知标题（简短）" }),
      body: Type.String({ description: "通知内容" }),
    }),
    execute: async (_toolCallId, params) => {
      const { title, body } = params;
      try {
        await onNotify?.(title, body);
        return {
          content: [{ type: "text", text: `已发送通知: ${title}` }],
          details: { title, body, sent: true },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `通知发送失败: ${err.message}` }],
          details: { title, body, sent: false, error: err.message },
        };
      }
    },
  };
}
