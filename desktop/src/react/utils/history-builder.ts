/**
 * history-builder.ts — 将 /api/sessions/messages 的 API 响应转换为 ChatListItem[]
 *
 * 替代 app-messages-shim.ts loadMessages() 中的 DOM 构建循环。
 */

import type { ChatMessage, ChatListItem, ContentBlock } from '../stores/chat-types';
import type { TodoItem } from '../types';
import { parseMoodFromContent, parseCardFromContent, parseUserAttachments } from './message-parser';
import { renderMarkdown } from './markdown';

/* eslint-disable @typescript-eslint/no-explicit-any -- API 历史消息 JSON 结构动态，难以静态收窄 */

// ── API 响应类型 ──

export interface HistoryApiResponse {
  messages: Array<{
    id?: string;
    role: string;
    content: string;
    thinking?: string;
    toolCalls?: Array<{ name: string; args?: Record<string, unknown> }>;
    images?: Array<{ data: string; mimeType: string }>;
  }>;
  blocks?: Array<any>;
  // COMPAT(v0.98): 以下三个老字段在新服务端不再返回，v0.98 后可删
  fileOutputs?: Array<{
    afterIndex: number;
    files: Array<{ fileId?: string; filePath: string; label: string; ext: string; mime?: string; kind?: string; storageKind?: string; status?: string; missingAt?: number | null }>;
  }>;
  artifacts?: Array<{
    afterIndex: number;
    artifactId: string;
    artifactType: string;
    title: string;
    content: string;
    language?: string;
    fileId?: string;
    filePath?: string;
    label?: string;
    ext?: string;
    mime?: string;
    kind?: string;
    storageKind?: string;
    status?: string;
    missingAt?: number | null;
  }>;
  cards?: Array<{
    afterIndex: number;
    card: { type: string; pluginId: string; route: string; title?: string; description?: string };
  }>;
  todos?: TodoItem[];
  hasMore?: boolean;
}

// ── 兼容层 ──

/**
 * COMPAT(v0.98): 兼容层，v0.98 后可整个删除。
 *
 * 将老格式（fileOutputs/artifacts/cards）转为新 blocks[] 格式。
 * 新服务端返回 blocks[]，此函数只在升级过渡期（老服务端 → 新前端）命中。
 * 如果没有 data.blocks，还需从 toolCalls 重建 cron/settings 确认卡片，
 * 因为老 session 的 toolResult.details 没有 jobData/settingKey 字段。
 */
function normalizeBlocks(data: HistoryApiResponse): Array<any> {
  if (data.blocks) return data.blocks;
  const blocks: Array<any> = [];
  for (const fo of (data.fileOutputs || [])) {
    for (const f of fo.files) {
      blocks.push({ type: 'file', afterIndex: fo.afterIndex, ...f });
    }
  }
  for (const ar of (data.artifacts || [])) {
    const { afterIndex, ...artifact } = ar;
    blocks.push({ type: 'artifact', afterIndex, ...artifact });
  }
  for (const cd of (data.cards || [])) {
    blocks.push({ type: 'plugin_card', afterIndex: cd.afterIndex, card: { ...cd.card, type: cd.card.type || 'iframe' } });
  }

  // COMPAT: 从 toolCalls 重建 cron/settings 确认卡片（仅老 session 无 blocks[] 时）
  for (let i = 0; i < (data.messages || []).length; i++) {
    const m = data.messages[i];
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      if (tc.name === 'update_settings' && tc.args) {
        const a = tc.args as Record<string, string>;
        if (a.action === 'apply' || (!a.action && a.key && a.value)) {
          blocks.push({
            type: 'settings_confirm',
            afterIndex: i,
            confirmId: '',
            settingKey: a.key || '',
            cardType: (a.key === 'sandbox' || a.key === 'memory.enabled') ? 'toggle' : 'list',
            currentValue: '',
            proposedValue: a.value || '',
            label: a.key || '',
            status: 'confirmed',
          });
        }
      }
      if (tc.name === 'cron' && tc.args) {
        const a = tc.args as Record<string, any>;
        if (a.action === 'add') {
          blocks.push({
            type: 'cron_confirm',
            afterIndex: i,
            confirmId: '',
            jobData: { type: a.type, schedule: a.schedule, prompt: a.prompt, label: a.label },
            status: 'approved',
          });
        }
      }
    }
  }

  return blocks;
}

// ── 构建 ──

export function buildItemsFromHistory(data: HistoryApiResponse): ChatListItem[] {
  const items: ChatListItem[] = [];

  // 按 afterIndex 分组统一 blocks
  const allBlocks = normalizeBlocks(data);
  const blockMap: Record<number, Array<any>> = {};
  for (const b of allBlocks) {
    (blockMap[b.afterIndex] ??= []).push(b);
  }

  for (let i = 0; i < data.messages.length; i++) {
    const m = data.messages[i];
    const id = m.id || `hist-${i}`;

    if (m.role === 'user') {
      // strip steer 前缀（内部标记，不应展示给用户）
      const rawContent = (m.content || '').replace(/^（插话，无需 MOOD）\n?/, '');

      // 过滤系统注入的后台任务通知（steer 消息），不展示给用户
      if (/<hana-background-result\s/.test(rawContent) || /<hana-deferred-tasks>/.test(rawContent)) {
        continue;
      }

      const { text, files, attachedImages, deskContext, quotedText } = parseUserAttachments(rawContent);
      const fileAtts = files.map(f => ({
        path: f.path,
        name: f.name,
        isDir: f.isDirectory,
      }));
      const imageBlocks = m.images || [];
      const markerImageAtts = attachedImages.map((ref, idx) => {
        const img = imageBlocks[idx];
        return {
          path: ref.path,
          name: ref.name,
          isDir: false,
          mimeType: img?.mimeType,
          visionAuxiliary: !img,
        };
      });
      const imageAtts = imageBlocks.slice(attachedImages.length).map((img, idx) => ({
        path: `image-${idx}`,
        name: `image-${idx}.${(img.mimeType || 'image/png').split('/')[1] || 'png'}`,
        isDir: false,
        base64Data: img.data,
        mimeType: img.mimeType,
      }));
      const allAtts = [...fileAtts, ...markerImageAtts, ...imageAtts];
      const msg: ChatMessage = {
        id,
        role: 'user',
        text,
        textHtml: text ? renderMarkdown(text) : undefined,
        attachments: allAtts.length ? allAtts : undefined,
        deskContext: deskContext || undefined,
        quotedText: quotedText || undefined,
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

      // 4. 主文本（去掉 mood 和 card 后的内容）
      const { cards, text: mainText } = parseCardFromContent(afterMood);
      if (mainText) {
        blocks.push({ type: 'text', html: renderMarkdown(mainText) });
      }

      // 5. Cards (before file outputs)
      for (const card of cards) {
        blocks.push({ type: 'plugin_card', card });
      }

      // 6. Content Blocks from unified sideband
      const msgBlocks = blockMap[i];
      if (msgBlocks) {
        for (const b of msgBlocks) blocks.push(b);
      }

      const msg: ChatMessage = { id, role: 'assistant', blocks };
      items.push({ type: 'message', data: msg });
    }
  }

  return items;
}
