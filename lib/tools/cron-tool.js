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

/**
 * 创建 cron 工具
 * @param {import('../desk/cron-store.js').CronStore} cronStore
 * @returns {import('@mariozechner/pi-coding-agent').ToolDefinition}
 */
export function createCronTool(cronStore, { autoApprove = false, getAutoApprove } = {}) {
  return {
    name: "cron",
    label: "定时任务",
    description:
      "创建和管理定时任务。定时任务在后台自动执行，到时间时会开一个独立 session 运行指定的 prompt。\n" +
      "操作：\n" +
      "- list：查看所有任务\n" +
      "- add(type, schedule, prompt, label?, model?)：创建任务\n" +
      "  - type \"at\"：一次性，schedule 为 ISO 时间字符串\n" +
      "  - type \"every\"：间隔，schedule 为毫秒数（如 3600000 = 1 小时）\n" +
      "  - type \"cron\"：cron 表达式（如 \"0 7 * * *\" = 每天早上 7 点）\n" +
      "  - model：可选，指定执行任务使用的模型（不填则使用默认对话模型）\n" +
      "- remove(id)：删除任务\n" +
      "- toggle(id)：启用/禁用任务",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("add"),
        Type.Literal("remove"),
        Type.Literal("toggle"),
      ], { description: "操作类型" }),
      type: Type.Optional(Type.Union([
        Type.Literal("at"),
        Type.Literal("every"),
        Type.Literal("cron"),
      ], { description: "调度类型（add 时必填）" })),
      schedule: Type.Optional(Type.String({
        description: "调度参数：ISO 时间(at), 毫秒数(every), cron 表达式(cron)"
      })),
      prompt: Type.Optional(Type.String({
        description: "到时间时执行的 prompt（add 时必填）"
      })),
      label: Type.Optional(Type.String({
        description: "任务显示标签（可选）"
      })),
      model: Type.Optional(Type.String({
        description: "指定执行模型（可选，不填则使用默认对话模型）"
      })),
      id: Type.Optional(Type.String({
        description: "任务 ID（remove/toggle 时必填）"
      })),
    }),

    execute: async (_toolCallId, params) => {
      switch (params.action) {
        case "list": {
          const jobs = cronStore.listJobs();
          if (jobs.length === 0) {
            return {
              content: [{ type: "text", text: "没有定时任务" }],
              details: { action: "list", jobs: [] },
            };
          }
          const lines = jobs.map(j => {
            const status = j.enabled ? "✓" : "✗";
            const next = j.nextRunAt
              ? new Date(j.nextRunAt).toLocaleString("zh-CN", { hour12: false })
              : "无";
            return `[${status}] ${j.id}: ${j.label} (${j.type}, 下次: ${next})`;
          });
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { action: "list", jobs },
          };
        }

        case "add": {
          if (!params.type || !params.schedule || !params.prompt) {
            return {
              content: [{ type: "text", text: "错误：add 需要 type, schedule, prompt 参数" }],
              details: { action: "add", jobs: cronStore.listJobs(), error: "missing params" },
            };
          }

          // every 类型：尝试将 schedule 转为数字
          let schedule = params.schedule;
          if (params.type === "every") {
            const ms = parseInt(schedule, 10);
            if (isNaN(ms) || ms <= 0) {
              return {
                content: [{ type: "text", text: "错误：every 类型的 schedule 必须是正整数（毫秒）" }],
                details: { action: "add", jobs: cronStore.listJobs(), error: "invalid schedule" },
              };
            }
            schedule = ms;
          }

          const label = params.label || params.prompt.slice(0, 30);

          if (getAutoApprove ? getAutoApprove() : autoApprove) {
            const job = cronStore.addJob({
              type: params.type, schedule, prompt: params.prompt,
              label: params.label, model: params.model,
            });
            return {
              content: [{ type: "text", text: `已创建定时任务: ${job.label} (${job.id})` }],
              details: { action: "added", job, jobs: cronStore.listJobs() },
            };
          }

          // 返回 pending 等待用户确认
          return {
            content: [{ type: "text", text: `准备创建定时任务: ${label}，等待确认` }],
            details: {
              action: "pending_add",
              jobData: { type: params.type, schedule, prompt: params.prompt, label: params.label, model: params.model },
            },
          };
        }

        case "remove": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: "错误：remove 需要 id 参数" }],
              details: { action: "remove", jobs: cronStore.listJobs(), error: "id required" },
            };
          }
          const ok = cronStore.removeJob(params.id);
          if (!ok) {
            return {
              content: [{ type: "text", text: `任务 ${params.id} 不存在` }],
              details: { action: "remove", jobs: cronStore.listJobs(), error: "not found" },
            };
          }
          return {
            content: [{ type: "text", text: `已删除任务 ${params.id}` }],
            details: { action: "remove", jobs: cronStore.listJobs() },
          };
        }

        case "toggle": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: "错误：toggle 需要 id 参数" }],
              details: { action: "toggle", jobs: cronStore.listJobs(), error: "id required" },
            };
          }
          const job = cronStore.toggleJob(params.id);
          if (!job) {
            return {
              content: [{ type: "text", text: `任务 ${params.id} 不存在` }],
              details: { action: "toggle", jobs: cronStore.listJobs(), error: "not found" },
            };
          }
          return {
            content: [{ type: "text", text: `任务 ${job.id} ${job.enabled ? "已启用" : "已禁用"}` }],
            details: { action: "toggle", jobs: cronStore.listJobs() },
          };
        }

        default:
          return {
            content: [{ type: "text", text: `未知操作: ${params.action}` }],
            details: { action: params.action, jobs: cronStore.listJobs() },
          };
      }
    },
  };
}
