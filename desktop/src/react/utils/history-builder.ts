/**
 * history-builder.ts — 将 /api/sessions/messages 的 API 响应转换为 ChatListItem[]
 *
 * 替代 app-messages-shim.ts loadMessages() 中的 DOM 构建循环。
 */

import type { ChatMessage, ChatListItem, ContentBlock } from '../stores/chat-types';
import { parseMoodFromContent, parseXingFromContent, parseUserAttachments } from './message-parser';
import { renderMarkdown } from './markdown';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── API 响应类型 ──

export interface HistoryApiResponse {
  messages: Array<{
    id?: string;
    role: string;
    content: string;
    thinking?: string;
    toolCalls?: Array<{ name: string; args?: Record<string, unknown> }>;
  }>;
  fileOutputs?: Array<{
    afterIndex: number;
    files: Array<{ filePath: string; label: string; ext: string }>;
  }>;
  artifacts?: Array<{
    afterIndex: number;
    artifactId: string;
    artifactType: string;
    title: string;
    content: string;
    language?: string;
  }>;
  todos?: any[];
  hasMore?: boolean;
}

// ── 构建 ──

export function buildItemsFromHistory(data: HistoryApiResponse): ChatListItem[] {
  const items: ChatListItem[] = [];

  // 按 afterIndex 分组 fileOutputs 和 artifacts
  const fileMap: Record<number, Array<{ filePath: string; label: string; ext: string }>> = {};
  const artMap: Record<number, Array<{ artifactId: string; artifactType: string; title: string; content: string; language?: string }>> = {};

  for (const fo of (data.fileOutputs || [])) {
    (fileMap[fo.afterIndex] ??= []).push(...fo.files);
  }
  for (const ar of (data.artifacts || [])) {
    (artMap[ar.afterIndex] ??= []).push(ar);
  }

  for (let i = 0; i < data.messages.length; i++) {
    const m = data.messages[i];
    const id = m.id || `hist-${i}`;

    if (m.role === 'user') {
      const { text, files, deskContext } = parseUserAttachments(m.content);
      const msg: ChatMessage = {
        id,
        role: 'user',
        text,
        textHtml: text ? renderMarkdown(text) : undefined,
        attachments: files.length ? files.map(f => ({
          path: f.path,
          name: f.name,
          isDir: f.isDirectory,
        })) : undefined,
        deskContext: deskContext || undefined,
      };
      items.push({ type: 'message', data: msg });
    } else if (m.role === 'assistant') {
      const blocks: ContentBlock[] = [];

      // 1. Thinking
      if (m.thinking) {
        blocks.push({ type: 'thinking', content: m.thinking, sealed: true });
      }

      // 2. Mood + 主文本
      const { mood, yuan, text: afterMood } = parseMoodFromContent(m.content);
      if (mood && yuan) {
        blocks.push({ type: 'mood', yuan, text: mood });
      }

      // 3. Tool calls
      if (m.toolCalls?.length) {
        blocks.push({
          type: 'tool_group',
          tools: m.toolCalls.map(tc => ({
            name: tc.name,
            args: tc.args,
            done: true,
            success: true,
          })),
          collapsed: m.toolCalls.length > 1,
        });
      }

      // 4. 主文本（去掉 mood 和 xing 后的内容）
      const { xingBlocks, text: mainText } = parseXingFromContent(afterMood);
      if (mainText) {
        blocks.push({ type: 'text', html: renderMarkdown(mainText) });
      }

      // 5. Xing
      for (const xb of xingBlocks) {
        blocks.push({ type: 'xing', title: xb.title, content: xb.content, sealed: true });
      }

      // 6. 跟在这条消息后面的 file outputs
      const files = fileMap[i];
      if (files) {
        for (const f of files) {
          blocks.push({ type: 'file_output', filePath: f.filePath, label: f.label, ext: f.ext });
        }
      }

      // 7. 跟在这条消息后面的 artifacts
      const arts = artMap[i];
      if (arts) {
        for (const a of arts) {
          blocks.push({
            type: 'artifact',
            artifactId: a.artifactId,
            artifactType: a.artifactType,
            title: a.title,
            content: a.content,
            language: a.language,
          });
        }
      }

      const msg: ChatMessage = { id, role: 'assistant', blocks };
      items.push({ type: 'message', data: msg });
    }
  }

  return items;
}
