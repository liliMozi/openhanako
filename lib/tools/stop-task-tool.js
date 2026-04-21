/**
 * stop-task-tool.js — 终止后台任务
 *
 * 通过 TaskRegistry 终止任何类型的后台任务（子代理、生图、生视频等）。
 */

import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";

export function createStopTaskTool(deps) {
  return {
    name: "stop_task",
    label: t("toolDef.stopTask.label"),
    description: t("toolDef.stopTask.description"),
    parameters: Type.Object({
      task_id: Type.String({ description: t("toolDef.stopTask.taskIdDesc") }),
    }),
    execute: async (_toolCallId, params) => {
      const taskId = params.task_id?.trim();
      if (!taskId) {
        return { content: [{ type: "text", text: "task_id is required" }] };
      }

      const registry = deps.getTaskRegistry?.();
      if (!registry) {
        return { content: [{ type: "text", text: "task registry unavailable" }] };
      }

      const result = registry.abort(taskId);

      if (result === "not_found") {
        return { content: [{ type: "text", text: t("error.stopTaskNotFound", { taskId }) }] };
      }
      if (result === "already_aborted") {
        return { content: [{ type: "text", text: t("error.stopTaskAlready", { taskId }) }] };
      }
      if (result === "no_handler") {
        return { content: [{ type: "text", text: t("error.stopTaskNoHandler", { taskId }) }] };
      }

      return { content: [{ type: "text", text: t("error.stopTaskDone", { taskId }) }] };
    },
  };
}
