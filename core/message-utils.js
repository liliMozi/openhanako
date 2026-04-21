/**
 * 消息工具函数 — 跨模块共享的消息处理工具
 *
 * 从 sessions route 提取，供 route 层与 plugin 系统共用。
 */
import fs from "fs/promises";
import path from "path";
import { isToolCallBlock, getToolArgs } from "./llm-utils.js";

/**
 * 工具调用参数摘要键列表
 * 提取工具调用时只保留这些键作为摘要信息
 */
export const TOOL_ARG_SUMMARY_KEYS = [
  "file_path", "path", "command", "pattern", "url", "query",
  "key", "value", "action", "type", "schedule", "prompt", "label",
];

/** 从文本中提取并剥离 <think>/<thinking> 标签 */
export function stripThinkTags(raw) {
  const thinkParts = [];
  const text = raw.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>\n*/g, (_, inner) => {
    thinkParts.push(inner.trim());
    return "";
  });
  return { text, thinkContent: thinkParts.join("\n") };
}

/**
 * 从 Pi SDK 的 content 块数组中提取纯文本 + thinking + tool_use 调用
 * content 可能是 string 或 [{type: "text", text: "..."}, {type: "thinking", thinking: "..."}, ...]
 * 返回 { text, thinking, toolUses, images }
 */
export function extractTextContent(content, { stripThink = false } = {}) {
  if (typeof content === "string") {
    if (stripThink) {
      const { text, thinkContent } = stripThinkTags(content);
      return { text, thinking: thinkContent, toolUses: [], images: [] };
    }
    return { text: content, thinking: "", toolUses: [], images: [] };
  }
  if (!Array.isArray(content)) return { text: "", thinking: "", toolUses: [], images: [] };
  const rawText = content
    .filter(block => block.type === "text" && block.text)
    .map(block => block.text)
    .join("");
  const images = content
    .filter(block => block.type === "image" && (block.data || block.source?.data))
    .map(block => ({ data: block.data || block.source.data, mimeType: block.mimeType || block.source?.media_type || "image/png" }));
  const { text, thinkContent } = stripThink ? stripThinkTags(rawText) : { text: rawText, thinkContent: "" };
  const thinking = [
    thinkContent,
    ...content
      .filter(block => block.type === "thinking" && block.thinking)
      .map(block => block.thinking),
  ].filter(Boolean).join("\n");
  const toolUses = content
    .filter(isToolCallBlock)
    .map(block => {
      const args = {};
      const params = getToolArgs(block);
      if (params && typeof params === "object") {
        for (const k of TOOL_ARG_SUMMARY_KEYS) {
          if (params[k] !== undefined) args[k] = params[k];
        }
      }
      return { name: block.name, args: Object.keys(args).length ? args : undefined };
    });
  return { text, thinking, toolUses, images };
}

/**
 * 优先从 session JSONL 读取完整历史。
 * engine.messages 可能只是当前上下文窗口，切回页面时会导致旧消息缺失。
 * 读文件失败时再退回内存态，避免历史接口直接空白。
 */
export async function loadSessionHistoryMessages(engine, explicitPath) {
  const sessionPath = explicitPath;
  if (!sessionPath) return [];

  try {
    const raw = await fs.readFile(sessionPath, "utf-8");
    const messages = [];

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) {
          messages.push(entry.message);
        }
      } catch {
        // 跳过损坏行
      }
    }

    if (messages.length > 0) return messages;
  } catch {
    // 文件读取失败
  }

  return [];
}

/**
 * 校验 sessionPath 是否在合法范围内，防止路径穿越
 * baseDir 可以是 sessionDir（单 agent）或 agentsDir（跨 agent）
 */
export function isValidSessionPath(sessionPath, baseDir) {
  const resolved = path.resolve(sessionPath);
  const base = path.resolve(baseDir);
  return resolved.startsWith(base + path.sep) || resolved === base;
}
