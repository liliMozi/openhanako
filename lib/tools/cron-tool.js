/**
 * cron-tool.js — Agent 使用的定时任务工具
 *
 * 让 agent 能通过对话创建、管理定时任务。
 * Agent 读取 jian.md 上的自然语言任务后，
 * 可以翻译成 cron job 来执行。
 *
 * 支持三种调度类型：
 * - at：一次性（"2026-02-24T09:00:00"）
 * - every：间隔（毫秒数，如 3600000 = 1小时）
 * - cron：标准 cron 表达式（"0 7 * * *" = 每天早上7点）
 */

import { Type } from "@sinclair/typebox";
import { StringEnum } from "../pi-sdk/index.js";
import { t, getLocale } from "../../server/i18n.js";
import { getToolSessionPath } from "./tool-session.js";

/**
 * 创建 cron 工具
 * @param {import('../desk/cron-store.js').CronStore} cronStore
 * @returns {import('../pi-sdk/index.js').ToolDefinition}
 */
export function createCronTool(cronStore, { autoApprove = false, getAutoApprove, confirmStore, emitEvent, getSessionPath } = {}) {
  return {
    name: "cron",
    label: t("toolDef.cron.label"),
    description: t("toolDef.cron.description"),
    parameters: Type.Object({
      action: StringEnum(
        ["list", "add", "remove", "toggle"],
        { description: t("toolDef.cron.actionDesc") },
      ),
      scheduleType: Type.Optional(StringEnum(
        ["at", "every", "cron"],
        { description: t("toolDef.cron.scheduleTypeDesc") },
      )),
      schedule: Type.Optional(Type.String({
        description: t("toolDef.cron.scheduleDesc")
      })),
      prompt: Type.Optional(Type.String({
        description: t("toolDef.cron.promptDesc")
      })),
      label: Type.Optional(Type.String({
        description: t("toolDef.cron.labelDesc")
      })),
      model: Type.Optional(Type.String({
        description: t("toolDef.cron.modelDesc")
      })),
      id: Type.Optional(Type.String({
        description: t("toolDef.cron.idDesc")
      })),
    }),

    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      switch (params.action) {
        case "list": {
          const jobs = cronStore.listJobs();
          if (jobs.length === 0) {
            return {
              content: [{ type: "text", text: t("error.cronNoJobs") }],
              details: { action: "list", jobs: [] },
            };
          }
          const lines = jobs.map(j => {
            const status = j.enabled ? "✓" : "✗";
            const locale = getLocale() || "zh";
            const localeTag = locale === "zh-TW" ? "zh-TW" : locale.startsWith("zh") ? "zh-CN" : locale.startsWith("ja") ? "ja-JP" : locale.startsWith("ko") ? "ko-KR" : "en-US";
            const isZh = locale.startsWith("zh");
            const noNext = isZh ? "无" : "none";
            const nextLabel = isZh ? "下次" : "next";
            const next = j.nextRunAt
              ? new Date(j.nextRunAt).toLocaleString(localeTag, { hour12: false })
              : noNext;
            return `[${status}] ${j.id}: ${j.label} (${j.type}, ${nextLabel}: ${next})`;
          });
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { action: "list", jobs },
          };
        }

        case "add": {
          if (!params.scheduleType || !params.schedule || !params.prompt) {
            return {
              content: [{ type: "text", text: t("error.cronAddNeedParams") }],
              details: { action: "add", jobs: cronStore.listJobs(), error: "missing params" },
            };
          }

          // every 类型：schedule 为分钟数，转为毫秒
          const type = params.scheduleType;
          let schedule = params.schedule;
          if (type === "every") {
            const minutes = parseInt(schedule, 10);
            if (isNaN(minutes) || minutes <= 0) {
              return {
                content: [{ type: "text", text: t("error.cronEveryMustBeNumber") }],
                details: { action: "add", jobs: cronStore.listJobs(), error: "invalid schedule" },
              };
            }
            schedule = minutes * 60_000; // 分钟转毫秒
          }

          const label = params.label || params.prompt.slice(0, 30);

          // jobData 提前构建，让所有分支都能携带它进 details
          const jobData = { type, schedule, prompt: params.prompt, label: params.label, model: params.model };

          if (getAutoApprove ? getAutoApprove() : autoApprove) {
            const job = cronStore.addJob(jobData);
            return {
              content: [{ type: "text", text: t("error.cronCreated", { label: job.label, id: job.id }) }],
              details: { action: "added", job, jobs: cronStore.listJobs(), jobData, confirmed: true },
            };
          }

          // 阻塞式确认
          if (confirmStore) {
            const sessionPath = getToolSessionPath(ctx) || null;
            const { confirmId, promise } = confirmStore.create("cron", { jobData }, sessionPath);
            emitEvent?.({ type: "cron_confirmation", confirmId, jobData }, sessionPath);
            const result = await promise;

            if (result.action === "confirmed") {
              const job = cronStore.addJob(jobData);
              return {
                content: [{ type: "text", text: t("error.cronConfirmed", { label: job.label, id: job.id }) }],
                details: { action: "added", job, jobs: cronStore.listJobs(), jobData, confirmed: true },
              };
            }
            return {
              content: [{ type: "text", text: result.action === "rejected" ? t("error.cronRejected", { label }) : t("error.cronTimeout", { label }) }],
              details: { action: "cancelled", jobs: cronStore.listJobs(), jobData, confirmed: false },
            };
          }

          // fallback：无 confirmStore 时走旧逻辑
          return {
            content: [{ type: "text", text: t("error.cronPendingConfirm", { label }) }],
            details: {
              action: "pending_add",
              jobData,
            },
          };
        }

        case "remove": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: t("error.cronRemoveNeedId") }],
              details: { action: "remove", jobs: cronStore.listJobs(), error: "id required" },
            };
          }
          const ok = cronStore.removeJob(params.id);
          if (!ok) {
            return {
              content: [{ type: "text", text: t("error.cronJobNotFound", { id: params.id }) }],
              details: { action: "remove", jobs: cronStore.listJobs(), error: "not found" },
            };
          }
          return {
            content: [{ type: "text", text: t("error.cronRemoved", { id: params.id }) }],
            details: { action: "remove", jobs: cronStore.listJobs() },
          };
        }

        case "toggle": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: t("error.cronToggleNeedId") }],
              details: { action: "toggle", jobs: cronStore.listJobs(), error: "id required" },
            };
          }
          const job = cronStore.toggleJob(params.id);
          if (!job) {
            return {
              content: [{ type: "text", text: t("error.cronJobNotFound", { id: params.id }) }],
              details: { action: "toggle", jobs: cronStore.listJobs(), error: "not found" },
            };
          }
          return {
            content: [{ type: "text", text: t("error.cronToggled", { id: job.id, state: job.enabled ? t("error.cronEnabled") : t("error.cronDisabled") }) }],
            details: { action: "toggle", jobs: cronStore.listJobs() },
          };
        }

        default:
          return {
            content: [{ type: "text", text: t("error.unknownAction", { action: params.action }) }],
            details: { action: params.action, jobs: cronStore.listJobs() },
          };
      }
    },
  };
}
