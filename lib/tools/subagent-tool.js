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
import path from "node:path";
import { t } from "../../server/i18n.js";
import { getToolSessionPath } from "./tool-session.js";
import {
  mergeExecutorMetadata,
  normalizeExecutorMetadata,
} from "../subagent-executor-metadata.js";

const SUBAGENT_CUSTOM_TOOLS = "*";
const SUBAGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

// 并发限制在 createSubagentTool 闭包内（per-agent），不再全局共享

function extractTaskTitle(task) {
  return String(task || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || "";
}

function formatAgentEntry(a) {
  const label = a.name && a.name !== a.id ? `${a.id} (${a.name})` : a.id;
  const parts = [label];
  if (a.model) parts.push(`[${a.model}]`);
  if (a.summary) parts.push(a.summary);
  return parts.join(" — ");
}

function resolveAgentIdentity(listAgents, currentAgentId, agentId) {
  const actualAgentId = agentId || currentAgentId || null;
  if (!actualAgentId) {
    return normalizeExecutorMetadata({});
  }

  const agents = listAgents ? listAgents() : [];
  const target = agents.find(a => a.id === actualAgentId);
  return normalizeExecutorMetadata({
    agentId: actualAgentId,
    agentName: target?.name || target?.agentName || actualAgentId,
  });
}

function applyRequestedAgentMetadata(target, requestedIdentity) {
  if (!target || !requestedIdentity) return target;
  target.requestedAgentId = requestedIdentity.executorAgentId;
  target.requestedAgentNameSnapshot = requestedIdentity.executorAgentNameSnapshot;
  return target;
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
  const activeBySession = new Map(); // sessionPath → count
  const MAX_PER_SESSION = 8;
  const MAX_GLOBAL = 20;

  function getActive(sp) { return activeBySession.get(sp) || 0; }
  function incActive(sp) { activeBySession.set(sp, getActive(sp) + 1); }
  function decActive(sp) {
    const n = getActive(sp) - 1;
    if (n <= 0) activeBySession.delete(sp);
    else activeBySession.set(sp, n);
  }
  function totalActive() {
    let sum = 0;
    for (const v of activeBySession.values()) sum += v;
    return sum;
  }

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

    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
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
      }
      const requestedIdentity = resolveAgentIdentity(deps.listAgents, deps.currentAgentId, targetAgentId);

      const parentSessionPath = getToolSessionPath(ctx);

      // 检查并发限制：per-session + global
      if (parentSessionPath && getActive(parentSessionPath) >= MAX_PER_SESSION) {
        return {
          content: [{ type: "text", text: t("error.subagentMaxConcurrent", { max: MAX_PER_SESSION }) }],
        };
      }
      if (totalActive() >= MAX_GLOBAL) {
        return {
          content: [{ type: "text", text: t("error.subagentMaxConcurrent", { max: MAX_GLOBAL }) }],
        };
      }

      const store = deps.getDeferredStore?.();

      if (!store || !parentSessionPath) {
        // deferred 基础设施不可用时同步 fallback
        return _syncFallback(deps, params, targetAgentId, parentSessionPath, { inc: () => incActive(parentSessionPath), dec: () => decActive(parentSessionPath) });
      }

      const taskId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const taskTitle = extractTaskTitle(params.task);
      const taskSummary = taskTitle.length > 80
        ? taskTitle.slice(0, 80) + "…"
        : taskTitle;

      store.defer(
        taskId,
        parentSessionPath,
        applyRequestedAgentMetadata(
          mergeExecutorMetadata({
            type: "subagent",
            summary: taskSummary,
          }, requestedIdentity),
          requestedIdentity,
        ),
      );

      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), SUBAGENT_TIMEOUT_MS);
      if (timeoutTimer.unref) timeoutTimer.unref();

      const registry = deps.getTaskRegistry?.();
      registry?.register(taskId, {
        type: "subagent",
        parentSessionPath,
        meta: applyRequestedAgentMetadata(
          mergeExecutorMetadata({ summary: taskSummary }, requestedIdentity),
          requestedIdentity,
        ),
      });
      deps.setSubagentController?.(taskId, controller);

      incActive(parentSessionPath);

      // 原子执行，fire-and-forget。sessionPath 通过 onSessionReady 回调后补到前端。
      const executeForAgent = (agentId) => {
        const executorIdentity = resolveAgentIdentity(deps.listAgents, deps.currentAgentId, agentId);
        return deps.executeIsolated(
          params.task,
          {
            agentId,
            emitEvents: true,
            persist: path.join(deps.agentDir, "subagent-sessions"),
            model: params.model,
            toolFilter: SUBAGENT_CUSTOM_TOOLS,
            signal: controller.signal,
            onSessionReady: (sp) => {
              // session 创建后立即后补 streamKey + 实际执行者身份
              deps.emitEvent?.({
                type: "block_update", taskId,
                patch: {
                  streamKey: sp,
                  agentId: executorIdentity?.executorAgentId || null,
                  agentName: executorIdentity?.executorAgentNameSnapshot || null,
                  executorAgentId: executorIdentity?.executorAgentId || null,
                  executorAgentNameSnapshot: executorIdentity?.executorAgentNameSnapshot || null,
                  requestedAgentId: requestedIdentity?.executorAgentId || null,
                  requestedAgentNameSnapshot: requestedIdentity?.executorAgentNameSnapshot || null,
                },
              }, parentSessionPath);
              // 持久化子代理 sessionPath + 实际执行者身份到 deferred store meta（历史加载用）
              const task = store.query(taskId);
              if (task?.meta) {
                task.meta.sessionPath = sp;
                mergeExecutorMetadata(task.meta, executorIdentity);
                applyRequestedAgentMetadata(task.meta, requestedIdentity);
              }
              store._save?.();
              void deps.persistSubagentSessionMeta?.(sp, executorIdentity)?.catch?.(() => {});
            },
          },
        );
      };

      executeForAgent(targetAgentId).then(result => {
        const wasUserAborted = registry?.query(taskId)?.aborted;
        if (wasUserAborted) {
          store.abort(taskId, t("error.subagentAborted"));
          deps.emitEvent?.({
            type: "block_update", taskId,
            patch: { streamStatus: "aborted", summary: t("error.subagentAborted") },
          }, parentSessionPath);
          return;
        }
        const text = result.replyText || t("error.subagentNoOutput");
        if (result.error) {
          store.fail(taskId, result.error);
        } else {
          store.resolve(taskId, text);
        }
        deps.emitEvent?.({
          type: "block_update", taskId,
          patch: {
            streamStatus: result.error ? "failed" : "done",
            summary: (text || result.error || "").slice(0, 200),
          },
        }, parentSessionPath);
      }).catch(err => {
        const wasUserAborted = registry?.query(taskId)?.aborted;
        const isTimeout = err.name === "AbortError" || err.name === "TimeoutError";
        const reason = wasUserAborted
          ? t("error.subagentAborted")
          : isTimeout
            ? t("error.subagentTimeout", { minutes: SUBAGENT_TIMEOUT_MS / 60000 })
            : err.message || String(err);

        if (wasUserAborted) {
          store.abort(taskId, reason);
        } else {
          store.fail(taskId, reason);
        }

        deps.emitEvent?.({
          type: "block_update", taskId,
          patch: { streamStatus: wasUserAborted ? "aborted" : "failed", summary: reason },
        }, parentSessionPath);
      }).finally(() => {
        clearTimeout(timeoutTimer);
        deps.removeSubagentController?.(taskId);
        registry?.remove(taskId);
        decActive(parentSessionPath);
      });

      return {
        content: [{ type: "text", text: t("error.subagentDispatched", { taskId }) }],
        details: {
          taskId,
          task: params.task,
          taskTitle,
          agentId: requestedIdentity?.executorAgentId || null,
          agentName: requestedIdentity?.executorAgentNameSnapshot || null,
          requestedAgentId: requestedIdentity?.executorAgentId || null,
          requestedAgentNameSnapshot: requestedIdentity?.executorAgentNameSnapshot || null,
          executorAgentId: requestedIdentity?.executorAgentId || null,
          executorAgentNameSnapshot: requestedIdentity?.executorAgentNameSnapshot || null,
          executorMetaVersion: requestedIdentity?.executorMetaVersion || null,
          sessionPath: null,  // 通过 block_update 后补 streamKey
          streamStatus: "running",
        },
      };
    },
  };
}

/** deferred 不可用时的同步 fallback */
async function _syncFallback(deps, params, targetAgentId, _sessionPath, counter) {
  const timeoutSignal = AbortSignal.timeout(SUBAGENT_TIMEOUT_MS);
  counter.inc();
  try {
    const result = await deps.executeIsolated(
      params.task,
      {
        agentId: targetAgentId,
        model: params.model,
        toolFilter: SUBAGENT_CUSTOM_TOOLS,
        signal: timeoutSignal,
      },
    );
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
