/**
 * memory-search.js — search_memory 工具（v2 标签检索）
 *
 * 替代 v1 的 embedding KNN + 混合排序 + 链接展开。
 * v2 用标签匹配 + 日期过滤 + FTS5 全文搜索兜底。
 *
 * 标签由 LLM 在元事实拆分时生成，也由 LLM 在搜索时生成查询标签，
 * 两边的"语言习惯"天然接近，一致性有保障。
 */

import { Type } from "@sinclair/typebox";

/**
 * 创建 search_memory 工具定义
 * @param {import('./fact-store.js').FactStore} factStore
 * @param {object} [opts]
 * @param {function} [opts.getMemoryMasterEnabled] - 返回 agent 级别记忆总开关状态
 * @returns {import('@mariozechner/pi-coding-agent').ToolDefinition}
 */
export function createMemorySearchTool(factStore, opts = {}) {
  return {
    name: "search_memory",
    label: "搜索记忆",
    description:
      "搜索记忆库。当你对某件事拿不准、觉得之前聊过但想不起细节、" +
      "或者需要更多上下文时使用。输入自然语言查询和可选的标签过滤。" +
      "结果包含匹配的元事实和对应时间。",
    parameters: Type.Object({
      query: Type.String({ description: "搜索查询，用自然语言描述你想找的内容" }),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "标签过滤，输入 2~5 个关键词标签来精确匹配。例如 [\"巧克力\", \"食物偏好\"]",
        }),
      ),
      date_from: Type.Optional(
        Type.String({ description: "起始日期，格式 YYYY-MM-DD" }),
      ),
      date_to: Type.Optional(
        Type.String({ description: "结束日期，格式 YYYY-MM-DD" }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const t0 = performance.now();

        if (factStore.size === 0) {
          return {
            content: [{ type: "text", text: "记忆库里没有找到相关内容。" }],
            details: {},
          };
        }

        const dateRange = {};
        if (params.date_from) dateRange.from = params.date_from;
        if (params.date_to) dateRange.to = params.date_to + "T23:59";

        let results = [];
        const seenIds = new Set();

        // 策略 1：标签匹配（优先）
        if (params.tags && params.tags.length > 0) {
          const tagResults = factStore.searchByTags(
            params.tags,
            Object.keys(dateRange).length > 0 ? dateRange : undefined,
            15,
          );
          for (const r of tagResults) {
            seenIds.add(r.id);
            results.push({ ...r, source: "tag" });
          }
        }

        // 策略 2：全文搜索补充（标签结果不足 3 条时）
        if (results.length < 3 && params.query) {
          const ftsResults = factStore.searchFullText(params.query, 10);
          for (const r of ftsResults) {
            if (seenIds.has(r.id)) continue;
            seenIds.add(r.id);
            results.push({ ...r, source: "fts" });
          }
        }

        // 日期过滤（对 FTS 结果也应用）
        if (dateRange.from || dateRange.to) {
          results = results.filter((r) => {
            if (!r.time) return true; // 无时间的不过滤
            if (dateRange.from && r.time < dateRange.from) return false;
            if (dateRange.to && r.time > dateRange.to) return false;
            return true;
          });
        }

        const elapsed = performance.now() - t0;
        console.log(
          `\x1b[90m[memory-search] ${elapsed.toFixed(0)}ms | ` +
          `hits: ${results.length} (tag: ${results.filter((r) => r.source === "tag").length}, ` +
          `fts: ${results.filter((r) => r.source === "fts").length})\x1b[0m`,
        );

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "记忆库里没有找到相关内容。" }],
            details: {},
          };
        }

        // 格式化输出
        const lines = results.map((r, i) => {
          const tagsStr = r.tags.length > 0 ? ` (${r.tags.join(", ")})` : "";
          const timeStr = r.time ? ` — ${r.time}` : "";
          return `${i + 1}. ${r.fact}${tagsStr}${timeStr}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { resultCount: results.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `记忆搜索出错: ${err.message}` }],
          details: {},
        };
      }
    },
  };
}
