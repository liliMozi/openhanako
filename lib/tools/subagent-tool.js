/**
 * subagent-tool.js — Sub-agent 工具（非阻塞）
 *
 * 将独立子任务派给隔离的 agent session 执行，支持通过 agent 参数指定目标 agent。
 * 任务在后台运行，完成后通过 DeferredResultStore 持久化结果，
 * deferred-result-ext 以 steer 消息注入对话。
 * 调用方无需等待，可继续与用户对话。
 *
 * agent="?" 时列出所有可用 agent（同步返回）。
 */

import { Type } from "@sinclair/typebox";
import { t, getLocale } from "../../server/i18n.js";

const SUBAGENT_CUSTOM_TOOLS = "*";
const SUBAGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

// 并发限制在 createSubagentTool 闭包内（per-agent），不再全局共享

function getSubagentPreamble() {
  const isZh = getLocale().startsWith("zh");
  if (isZh) {
    return "你现在是一个调研子任务。要求：\n" +
      "- 不需要 MOOD 区块\n" +
      "- 不需要寒暄，直接给结论\n" +
      "- 输出简洁、结构化，附上关键证据和来源\n" +
      "- 如果信息不足，明确说明缺什么\n\n" +
      "任务：\n";
  }
  return "You are a research sub-task. Requirements:\n" +
    "- No MOOD block\n" +
    "- No pleasantries — go straight to conclusions\n" +
    "- Output should be concise, structured, with key evidence and sources\n" +
    "- If information is insufficient, state clearly what is missing\n\n" +
    "Task:\n";
}

function formatAgentEntry(a) {
  const label = a.name && a.name !== a.id ? `${a.id} (${a.name})` : a.id;
  const parts = [label];
  if (a.model) parts.push(`[${a.model}]`);
  if (a.summary) parts.push(a.summary);
  return parts.join(" — ");
}

/**
 * @param {object} deps
 * @param {(opts: object) => Promise<{ sessionPath: string|null, run: (prompt: string) => Promise }>} deps.prepareIsolatedSession
 * @param {() => string|null} deps.resolveUtilityModel
 * @param {() => import("../deferred-result-store.js").DeferredResultStore|null} deps.getDeferredStore
 * @param {() => string|null} deps.getSessionPath
 * @param {() => Array} [deps.listAgents]
 * @param {string} [deps.currentAgentId]
 * @param {(event: object, sessionPath?: string|null) => void} [deps.emitEvent]
 */
export function createSubagentTool(deps) {
  let activeCount = 0;
  const MAX_CONCURRENT = 5;

  return {
    name: "subagent",
    label: t("toolDef.subagent.label"),
    description: t("toolDef.subagent.description"),
    parameters: Type.Object({
      task: Type.String({ description: t("toolDef.subagent.taskDesc") }),
      model: Type.Optional(Type.String({ description: t("toolDef.subagent.modelDesc") })),
      agent: Type.Optional(Type.String({
        description: "目标 agent ID。不填 = 当前 agent 自己执行。传 \"?\" 列出所有可用 agent。",
      })),
    }),

    execute: async (_toolCallId, params) => {
      // discovery 模式
      if (params.agent === "?" || params.agent === "list") {
        const listAgents = deps.listAgents;
        if (!listAgents) {
          return { content: [{ type: "text", text: t("error.noOtherAgents") }] };
        }
        const agents = listAgents().filter(a => a.id !== deps.currentAgentId);
        if (!agents.length) {
          return { content: [{ type: "text", text: t("error.noOtherAgents") }] };
        }
        return { content: [{ type: "text", text: agents.map(a => "- " + formatAgentEntry(a)).join("\n") }] };
      }

      // self-check：传入的 agent 就是自己，视为未指定
      const targetAgentId = (params.agent && params.agent !== deps.currentAgentId)
        ? params.agent
        : undefined;

      // agent resolution
      let targetAgentName = targetAgentId;
      if (targetAgentId) {
        const listAgents = deps.listAgents;
        const agents = listAgents ? listAgents() : [];
        const target = agents.find(a => a.id === targetAgentId);
        if (!target) {
          const lines = agents
            .filter(a => a.id !== deps.currentAgentId)
            .map(a => formatAgentEntry(a));
          return {
            content: [{
              type: "text",
              text: t("error.agentNotFoundAvailable", {
                id: targetAgentId,
                ids: lines.join("\n") || "(none)",
              }),
            }],
          };
        }
        targetAgentName = target.name || target.id;
      }

      if (activeCount >= MAX_CONCURRENT) {
        return {
          content: [{ type: "text", text: t("error.subagentMaxConcurrent", { max: MAX_CONCURRENT }) }],
        };
      }

      const store = deps.getDeferredStore?.();
      const parentSessionPath = deps.getSessionPath?.();

      if (!store || !parentSessionPath) {
        // deferred 基础设施不可用时同步 fallback
        return _syncFallback(deps, params, targetAgentId, { inc: () => activeCount++, dec: () => activeCount-- });
      }

      const taskId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const taskSummary = params.task.length > 80
        ? params.task.slice(0, 80) + "…"
        : params.task;

      store.defer(taskId, parentSessionPath, { type: "subagent", summary: taskSummary });

      activeCount++;
      const timeoutSignal = AbortSignal.timeout(SUBAGENT_TIMEOUT_MS);

      // await prepare 拿到 sessionPath，然后 run 在后台执行不 await
      const { sessionPath: childSessionPath, run } = await deps.prepareIsolatedSession({
        agentId: targetAgentId,
        emitEvents: true,
        persist: true,
        model: params.model || deps.resolveUtilityModel(),
        toolFilter: SUBAGENT_CUSTOM_TOOLS,
        signal: timeoutSignal,
      });

      // 后台执行，不 await
      run(getSubagentPreamble() + params.task).then(result => {
        if (result.error) {
          store.fail(taskId, result.error);
        } else {
          store.resolve(taskId, result.replyText || t("error.subagentNoOutput"));
        }
        deps.emitEvent?.({
          type: "block_update",
          taskId,
          patch: {
            streamStatus: result.error ? "failed" : "done",
            summary: (result.replyText || result.error || "").slice(0, 200),
          },
        }, parentSessionPath);
      }).catch(err => {
        const isTimeout = err.name === "AbortError" || err.name === "TimeoutError";
        const msg = isTimeout
          ? t("error.subagentTimeout", { minutes: SUBAGENT_TIMEOUT_MS / 60000 })
          : err.message || String(err);
        store.fail(taskId, msg);
        deps.emitEvent?.({
          type: "block_update",
          taskId,
          patch: { streamStatus: "failed", summary: msg },
        }, parentSessionPath);
      }).finally(() => activeCount--);

      return {
        content: [{ type: "text", text: t("error.subagentDispatched", { taskId }) }],
        details: {
          taskId,
          task: taskSummary,
          agentId: targetAgentId,
          agentName: targetAgentName,
          sessionPath: childSessionPath,
          streamStatus: "running",
        },
      };
    },
  };
}

/** deferred 不可用时的同步 fallback */
async function _syncFallback(deps, params, targetAgentId, counter) {
  const timeoutSignal = AbortSignal.timeout(SUBAGENT_TIMEOUT_MS);
  counter.inc();
  try {
    const { run } = await deps.prepareIsolatedSession({
      agentId: targetAgentId,
      emitEvents: false,
      persist: false,
      model: params.model || deps.resolveUtilityModel(),
      toolFilter: SUBAGENT_CUSTOM_TOOLS,
      signal: timeoutSignal,
    });
    const result = await run(getSubagentPreamble() + params.task);
    if (result.error) {
      return { content: [{ type: "text", text: t("error.subagentFailed", { msg: result.error }) }] };
    }
    return { content: [{ type: "text", text: result.replyText || t("error.subagentNoOutput") }] };
  } catch (err) {
    return { content: [{ type: "text", text: t("error.subagentFailed", { msg: err.message }) }] };
  } finally {
    counter.dec();
  }
}
