/**
 * wait-tool.js — 等待指定秒数
 *
 * 让 agent 在等待后台任务（subagent、图像生成等）时
 * 能主动"等一会"再继续。工具执行期间 turn 保持活跃，UI 不阻塞。
 */

import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";

const MAX_WAIT_SECONDS = 300; // 5 分钟上限

export function createWaitTool() {
  return {
    name: "wait",
    label: t("toolDef.wait.label"),
    description: t("toolDef.wait.description"),
    parameters: Type.Object({
      seconds: Type.Number({
        description: t("toolDef.wait.secondsDesc"),
        minimum: 1,
        maximum: MAX_WAIT_SECONDS,
      }),
    }),
    execute: async (_toolCallId, params) => {
      const seconds = Math.min(Math.max(Math.round(params.seconds), 1), MAX_WAIT_SECONDS);
      await new Promise(r => setTimeout(r, seconds * 1000));
      return {
        content: [{ type: "text", text: `${seconds}s` }],
      };
    },
  };
}
