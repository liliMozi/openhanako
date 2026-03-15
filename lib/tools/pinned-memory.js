/**
 * pinned-memory.js — pin_memory / unpin_memory 自定义工具
 *
 * 让 agent 通过工具调用来管理置顶记忆，替代之前在 yuan.md 中
 * 指导 agent 手动 read→append→write pinned.md 的方式。
 */

import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import { scrubPII } from "../pii-guard.js";

/**
 * 创建 pin_memory + unpin_memory 工具
 * @param {string} agentDir - agent 数据目录（pinned.md 在这里）
 * @returns {[import('@mariozechner/pi-coding-agent').ToolDefinition, import('@mariozechner/pi-coding-agent').ToolDefinition]}
 */
export function createPinnedMemoryTools(agentDir) {
  const pinnedPath = path.join(agentDir, "pinned.md");

  const readPinned = () => {
    try { return fs.readFileSync(pinnedPath, "utf-8"); } catch { return ""; }
  };

  const writePinned = (content) => {
    fs.writeFileSync(pinnedPath, content, "utf-8");
  };

  const pinTool = {
    name: "pin_memory",
    label: "置顶记忆",
    description:
      "将一条内容存入置顶记忆。当用户说「记住这个」「帮我记一下」「以后别忘了」时使用。" +
      "置顶记忆始终保留在上下文中。",
    parameters: Type.Object({
      content: Type.String({ description: "要记住的内容" }),
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
          content: [{ type: "text", text: "这条已经在置顶记忆里了。" }],
          details: {},
        };
      }

      const updated = existing.trimEnd()
        ? existing.trimEnd() + "\n" + newLine + "\n"
        : newLine + "\n";
      writePinned(updated);

      return {
        content: [{ type: "text", text: `已记住：${content}` }],
        details: {},
      };
    },
  };

  const unpinTool = {
    name: "unpin_memory",
    label: "移除置顶记忆",
    description:
      "从置顶记忆中移除一条内容。当用户说「忘掉 xxx」「删掉这条记忆」时使用。" +
      "支持模糊匹配：只要某行包含你提供的关键词就会被移除。",
    parameters: Type.Object({
      keyword: Type.String({ description: "要移除的记忆的关键词，会模糊匹配" }),
    }),
    execute: async (_toolCallId, params) => {
      const existing = readPinned();
      if (!existing.trim()) {
        return {
          content: [{ type: "text", text: "置顶记忆是空的，没有可移除的内容。" }],
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
          content: [{ type: "text", text: `没找到包含「${params.keyword}」的置顶记忆。` }],
          details: {},
        };
      }

      writePinned(remaining.join("\n"));

      return {
        content: [{ type: "text", text: `已移除 ${removed.length} 条：${removed.join("、")}` }],
        details: { removedCount: removed.length },
      };
    },
  };

  return [pinTool, unpinTool];
}
