/**
 * 压缩相关共享纯函数。
 *
 * 两个消费点：
 *   1. session-coordinator._hardTruncate（模型切换时的硬截断降级）
 *   2. compaction-guard-ext（自动压缩时的硬截断兜底）
 *
 * 纪律：
 *   - 纯函数，不碰 session/agent 状态
 *   - 不做 I/O，不做 LLM 调用
 *   - 调用方自行负责 appendCompaction + replaceMessages
 */

import { findCutPoint, estimateTokens } from "../lib/pi-sdk/index.js";

/**
 * 计算硬截断结果（不调 LLM，无外部依赖）。
 *
 * @param {Array} pathEntries - sessionManager.getBranch() 的结果
 * @param {number} keepRecentTokens - 保留最近多少 token 的消息
 * @param {object} [options]
 * @param {string} [options.summary="[由于上下文超限，早期对话历史已被截断]"] - 占位摘要文案
 * @param {string} [options.reason="hard-truncation"] - 记录在 details.reason 里，便于排查
 * @returns {null | { summary: string, firstKeptEntryId: string, tokensBefore: number, details: object }}
 *   返回 null 表示无法截断（消息太少 / 切点落在开头）
 */
export function computeHardTruncation(pathEntries, keepRecentTokens, options = {}) {
  const {
    summary = "[由于上下文超限，早期对话历史已被截断]",
    reason = "hard-truncation",
  } = options;

  const messageEntries = pathEntries.filter((e) => e.type === "message");
  if (messageEntries.length < 2) return null;

  const cutResult = findCutPoint(pathEntries, 0, pathEntries.length, keepRecentTokens);
  const { firstKeptEntryIndex, turnStartIndex, isSplitTurn } = cutResult;
  const effectiveCutIndex = isSplitTurn ? turnStartIndex : firstKeptEntryIndex;
  if (effectiveCutIndex <= 0) return null;

  let tokensBefore = 0;
  for (let i = 0; i < effectiveCutIndex; i++) {
    if (pathEntries[i].type === "message" && pathEntries[i].message) {
      tokensBefore += estimateTokens(pathEntries[i].message);
    }
  }

  return {
    summary,
    firstKeptEntryId: pathEntries[effectiveCutIndex].id,
    tokensBefore,
    details: { reason, keepRecentTokens },
  };
}

/**
 * 估算一批消息的总 token 数。薄封装，便于单测。
 * @param {Array} messages
 * @returns {number}
 */
export function estimateMessagesTokens(messages) {
  let sum = 0;
  for (const m of messages) sum += estimateTokens(m);
  return sum;
}

/**
 * 估算"LLM 摘要调用的最坏情况输入 token 数"。
 *
 * 背景：pi SDK 的 compact() 在 split-turn 时会并行跑两次 LLM：
 *   1. generateSummary(messagesToSummarize)
 *   2. generateTurnPrefixSummary(turnPrefixMessages)
 * 见 node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js:557-568
 *
 * 两个调用互相独立，任一输入超窗都会让整个 compact() 抛错，
 * 导致 issue#437 的死锁场景。所以 guard 判断必须取两者最大值，
 * 不能只看 messagesToSummarize。
 *
 * @param {object} preparation - pi SDK prepareCompaction 的返回
 * @returns {number} 最坏情况下单次 LLM 调用的输入 token 数
 */
export function estimatePreparationTokens(preparation) {
  if (!preparation) return 0;
  const historyTokens = preparation.messagesToSummarize
    ? estimateMessagesTokens(preparation.messagesToSummarize)
    : 0;
  const turnPrefixTokens = preparation.isSplitTurn && preparation.turnPrefixMessages
    ? estimateMessagesTokens(preparation.turnPrefixMessages)
    : 0;
  return Math.max(historyTokens, turnPrefixTokens);
}

/**
 * 对单条 TextContent 做 head+tail 硬截断。
 * 保留头尾各 headBytes/tailBytes，中间塞占位。
 *
 * @param {string} text
 * @param {object} opts
 * @param {number} opts.maxBytes - 超过此值才触发截断（基于 UTF-8 字节）
 * @param {number} [opts.headBytes] - 保留头部字节数（默认 maxBytes 的 40%）
 * @param {number} [opts.tailBytes] - 保留尾部字节数（默认 maxBytes 的 40%）
 * @returns {{ text: string, truncated: boolean, originalBytes: number }}
 */
export function truncateTextHeadTail(text, opts) {
  const { maxBytes } = opts;
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes };
  }
  const headBytes = opts.headBytes ?? Math.floor(maxBytes * 0.4);
  const tailBytes = opts.tailBytes ?? Math.floor(maxBytes * 0.4);

  const buf = Buffer.from(text, "utf8");
  const head = safeSliceUtf8(buf, 0, headBytes);
  const tail = safeSliceUtf8(buf, buf.length - tailBytes, buf.length);
  const omittedBytes = originalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");

  const marker = `\n\n[... ${formatBytes(omittedBytes)} 已省略 (原始长度 ${formatBytes(originalBytes)}) ...]\n\n`;
  return {
    text: head + marker + tail,
    truncated: true,
    originalBytes,
  };
}

/**
 * UTF-8 安全切片：避免切到多字节字符中间。
 * 在切点往前走到 UTF-8 字符边界（非 0b10xxxxxx）。
 */
function safeSliceUtf8(buf, start, end) {
  let s = Math.max(0, start);
  let e = Math.min(buf.length, end);
  while (s < buf.length && (buf[s] & 0xc0) === 0x80) s++;
  while (e < buf.length && (buf[e] & 0xc0) === 0x80) e++;
  return buf.slice(s, e).toString("utf8");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
