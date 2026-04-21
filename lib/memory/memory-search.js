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
import { t } from "../../server/i18n.js";

/**
 * 创建 search_memory 工具定义
 * @param {import('./fact-store.js').FactStore} factStore
 * @param {object} [opts]
 * @param {function} [opts.getMemoryMasterEnabled] - 返回 agent 级别记忆总开关状态
 * @returns {import('../pi-sdk/index.js').ToolDefinition}
 */
export function createMemorySearchTool(factStore, opts = {}) {
  return {
    name: "search_memory",
    label: t("error.memorySearchLabel"),
    description: t("error.memorySearchDesc"),
    parameters: Type.Object({
      query: Type.String({ description: t("error.memorySearchQueryDesc") }),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: t("error.memorySearchTagsDesc"),
        }),
      ),
      date_from: Type.Optional(
        Type.String({ description: t("error.memorySearchDateFromDesc") }),
      ),
      date_to: Type.Optional(
        Type.String({ description: t("error.memorySearchDateToDesc") }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const t0 = performance.now();

        if (factStore.size === 0) {
          return {
            content: [{ type: "text", text: t("error.memorySearchEmpty") }],
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
            content: [{ type: "text", text: t("error.memorySearchEmpty") }],
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
          content: [{ type: "text", text: t("error.memorySearchError", { msg: err.message }) }],
          details: {},
        };
      }
    },
  };
}
