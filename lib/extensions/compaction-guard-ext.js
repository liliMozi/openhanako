/**
 * Compaction Guard Pi SDK Extension
 *
 * 三层防护，防 session 因上下文超限而死锁（issue#437）：
 *
 *   L1 (tool_result hook)：
 *     单条 tool_result 的 text 内容超过 maxToolResultBytes 字节时，
 *     做 head+tail 截断，中间塞省略标记。
 *     防"一次工具调用返回 200KB 直接把 session 推过悬崖"。
 *
 *   L3 (session_before_compact hook)：
 *     pi SDK 进入压缩流程时，预判 LLM 摘要请求的输入是否已经超窗。
 *     若 messagesToSummarize 总量 > contextWindow * hardTruncateThreshold，
 *     LLM 摘要调用必然失败（issue#437 的根本死锁场景），直接走硬截断。
 *     否则 return undefined，让 pi SDK 跑正常的 LLM 摘要。
 *
 *   L2（非 hook，由 session-defaults.js 调大 reserveTokens 实现）：
 *     让 pi SDK 的原生 threshold 压缩更早触发，给 tool_result 累积留 buffer。
 *
 * 纪律：
 *   - 零 pi SDK 改动，全走官方 ExtensionAPI
 *   - 不调用任何私有方法（不碰 _overflowRecoveryAttempted / _runAutoCompaction）
 *   - 失败路径：hook 内部任何异常都 return undefined，让 pi SDK 走它原生路径
 */

import { computeHardTruncation, estimatePreparationTokens, truncateTextHeadTail } from "../../core/compaction-utils.js";
import { createModuleLogger } from "../debug-log.js";

const log = createModuleLogger("compaction-guard");

const DEFAULT_MAX_TOOL_RESULT_BYTES = 32 * 1024; // 32KB ≈ 8K token
const DEFAULT_HARD_TRUNCATE_THRESHOLD = 0.85;    // messagesToSummarize 超 85% 窗口 → 硬截断

/**
 * Factory。
 * @param {object} [opts]
 * @param {number} [opts.maxToolResultBytes=32768] - L1 单条 tool_result text 字节上限
 * @param {number} [opts.hardTruncateThreshold=0.85] - L3 触发硬截断的窗口占比
 * @returns {(pi: object) => void}
 */
export function createCompactionGuardExtension(opts = {}) {
  const maxToolResultBytes = opts.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES;
  const hardTruncateThreshold = opts.hardTruncateThreshold ?? DEFAULT_HARD_TRUNCATE_THRESHOLD;

  return function (pi) {
    // ── L1: tool_result 单条硬限 ──
    pi.on("tool_result", (event) => {
      try {
        // 错误返回保留完整，帮 debug
        if (event.isError) return undefined;
        if (!Array.isArray(event.content)) return undefined;

        let changed = false;
        const newContent = event.content.map((block) => {
          if (!block || block.type !== "text" || typeof block.text !== "string") return block;
          const res = truncateTextHeadTail(block.text, { maxBytes: maxToolResultBytes });
          if (!res.truncated) return block;
          changed = true;
          log.log(
            `[L1] tool_result text truncated: tool=${event.toolName || "?"} ` +
            `original=${res.originalBytes}B → ${Buffer.byteLength(res.text, "utf8")}B`
          );
          return { ...block, text: res.text };
        });

        if (changed) return { content: newContent };
        return undefined;
      } catch (err) {
        log.warn(`[L1] tool_result hook error (passthrough): ${err?.message || err}`);
        return undefined;
      }
    });

    // ── L3: 压缩前预判，必败时走硬截断 ──
    pi.on("session_before_compact", (event, ctx) => {
      try {
        const preparation = event?.preparation;
        const model = ctx?.model;
        if (!preparation || !model) return undefined;

        const contextWindow = model.contextWindow ?? 0;
        if (contextWindow <= 0) return undefined;

        const worstCaseLlmTokens = estimatePreparationTokens(preparation);
        const threshold = Math.floor(contextWindow * hardTruncateThreshold);

        if (worstCaseLlmTokens <= threshold) {
          // 正常 LLM 摘要不会超窗，让 pi SDK 跑原生路径
          return undefined;
        }

        // LLM 摘要请求必然超窗（issue#437 死锁根源），走硬截断
        if (event.signal?.aborted) return undefined;

        const sm = ctx.sessionManager;
        const pathEntries = sm?.getBranch?.() || [];
        const keepRecentTokens = preparation.settings?.keepRecentTokens ?? 20_000;

        const truncation = computeHardTruncation(pathEntries, keepRecentTokens, {
          summary: "[由于对话过长且 LLM 摘要请求本身会超限，早期对话历史已被硬截断（compaction-guard）]",
          reason: "compaction-guard-hard-truncate",
        });

        if (!truncation) {
          // 消息太少或切点落在开头，让 pi SDK 自己处理（多半会失败，但我们救不了）
          log.warn(
            `[L3] hard-truncate unavailable: worstCaseLlmTokens=${worstCaseLlmTokens} ` +
            `threshold=${threshold} contextWindow=${contextWindow}`
          );
          return undefined;
        }

        log.log(
          `[L3] preemptive hard-truncate: worstCaseLlmTokens=${worstCaseLlmTokens} ` +
          `> threshold=${threshold} (ctx=${contextWindow}), keep=${keepRecentTokens}`
        );

        return { compaction: truncation };
      } catch (err) {
        log.warn(`[L3] session_before_compact hook error (passthrough): ${err?.message || err}`);
        return undefined;
      }
    });
  };
}
