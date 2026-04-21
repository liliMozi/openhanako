/**
 * pinned-memory.js — pin_memory / unpin_memory 自定义工具
 *
 * 让 agent 通过工具调用来管理置顶记忆，替代之前在 yuan.md 中
 * 指导 agent 手动 read→append→write pinned.md 的方式。
 */

import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";
import fs from "node:fs";
import path from "node:path";
import { scrubPII } from "../pii-guard.js";
import { atomicWriteSync } from "../../shared/safe-fs.js";

/**
 * 创建 pin_memory + unpin_memory 工具
 * @param {string} agentDir - agent 数据目录（pinned.md 在这里）
 * @returns {[import('../pi-sdk/index.js').ToolDefinition, import('../pi-sdk/index.js').ToolDefinition]}
 */
export function createPinnedMemoryTools(agentDir) {
  const pinnedPath = path.join(agentDir, "pinned.md");

  const readPinned = () => {
    try { return fs.readFileSync(pinnedPath, "utf-8"); } catch { return ""; }
  };

  const writePinned = (content) => {
    atomicWriteSync(pinnedPath, content);
  };

  const pinTool = {
    name: "pin_memory",
    label: t("toolDef.pinnedMemory.pinLabel"),
    description: t("toolDef.pinnedMemory.pinDescription"),
    parameters: Type.Object({
      content: Type.String({ description: t("toolDef.pinnedMemory.pinContentDesc") }),
    }),
    execute: async (_toolCallId, params) => {
      const { cleaned, detected } = scrubPII(params.content);
      if (detected.length > 0) {
        console.warn(`[pin_memory] PII detected (${detected.join(", ")}), redacted before storage`);
      }

      const existing = readPinned();
      const content = cleaned;
      const newLine = `- ${content}`;

      // 检查是否已存在相同内容
      if (existing.includes(content)) {
        return {
          content: [{ type: "text", text: t("error.pinnedAlreadyExists") }],
          details: {},
        };
      }

      const updated = existing.trimEnd()
        ? existing.trimEnd() + "\n" + newLine + "\n"
        : newLine + "\n";
      writePinned(updated);

      return {
        content: [{ type: "text", text: t("error.pinnedAdded", { content }) }],
        details: {},
      };
    },
  };

  const unpinTool = {
    name: "unpin_memory",
    label: t("toolDef.pinnedMemory.unpinLabel"),
    description: t("toolDef.pinnedMemory.unpinDescription"),
    parameters: Type.Object({
      keyword: Type.String({ description: t("toolDef.pinnedMemory.unpinKeywordDesc") }),
    }),
    execute: async (_toolCallId, params) => {
      const existing = readPinned();
      if (!existing.trim()) {
        return {
          content: [{ type: "text", text: t("error.pinnedEmpty") }],
          details: {},
        };
      }

      const lines = existing.split("\n");
      const remaining = [];
      const removed = [];

      for (const line of lines) {
        if (line.trim() && line.toLowerCase().includes(params.keyword.toLowerCase())) {
          removed.push(line.replace(/^- /, "").trim());
        } else {
          remaining.push(line);
        }
      }

      if (removed.length === 0) {
        return {
          content: [{ type: "text", text: t("error.pinnedNotFound", { keyword: params.keyword }) }],
          details: {},
        };
      }

      writePinned(remaining.join("\n"));

      return {
        content: [{ type: "text", text: t("error.pinnedRemoved", { count: removed.length, items: removed.join(", ") }) }],
        details: { removedCount: removed.length },
      };
    },
  };

  return [pinTool, unpinTool];
}
