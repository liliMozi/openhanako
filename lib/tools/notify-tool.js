/**
 * notify-tool.js — 桌面通知工具
 *
 * 让 agent 能主动向用户发送系统通知（macOS 桌面弹窗）。
 * 仅在用户明确要求提醒/通知时使用，普通任务完成不调用。
 */

import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";

/**
 * @param {{ onNotify: (title: string, body: string) => Promise<void> | void }} opts
 */
export function createNotifyTool({ onNotify }) {
  return {
    name: "notify",
    label: t("toolDef.notify.label"),
    description: t("toolDef.notify.description"),
    parameters: Type.Object({
      title: Type.String({ description: t("toolDef.notify.titleDesc") }),
      body: Type.String({ description: t("toolDef.notify.bodyDesc") }),
    }),
    execute: async (_toolCallId, params) => {
      const { title, body } = params;
      try {
        await onNotify?.(title, body);
        return {
          content: [{ type: "text", text: t("error.notifySent", { title }) }],
          details: { title, body, sent: true },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: t("error.notifyFailed", { msg: err.message }) }],
          details: { title, body, sent: false, error: err.message },
        };
      }
    },
  };
}
