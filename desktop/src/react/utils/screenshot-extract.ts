// desktop/src/react/utils/screenshot-extract.ts

import type { ChatMessage, ContentBlock } from '../stores/chat-types';
import { isImageOrSvgExt } from './file-kind';

export interface ScreenshotBlock {
  type: 'html' | 'markdown' | 'image';
  content: string;
  // html: pre-rendered HTML from assistant text blocks - inject directly into template
  // markdown: raw Markdown from user messages - main process renders via markdown-it
  // image: base64 dataUrl or file path (caller converts to base64)
}

export interface ScreenshotMessage {
  role: 'user' | 'assistant';
  name: string;
  avatarDataUrl: string | null;
  blocks: ScreenshotBlock[];
}

export interface ScreenshotPayload {
  mode: 'article' | 'conversation';
  theme: string;
  markdown?: string;          // article mode from Markdown editor
  messages?: ScreenshotMessage[];
}

export function buildThemeName(color: string, width: string): string {
  const base = color === 'sakura' ? 'sakura-light' : `solarized-${color}`;
  return width === 'desktop' ? `${base}-desktop` : base;
}

// 扩展名识别统一走 file-kind 中心表；禁止维护私有 IMAGE_EXTS 表。
function extractBlocks(blocks: ContentBlock[]): ScreenshotBlock[] {
  const result: ScreenshotBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      result.push({ type: 'html', content: block.html });
    } else if (block.type === 'file' && isImageOrSvgExt(block.ext)) {
      result.push({ type: 'image', content: block.filePath });
    }
  }
  return result;
}

function extractUserBlocks(msg: ChatMessage): ScreenshotBlock[] {
  if (!msg.text) return [];
  return [{ type: 'markdown', content: msg.text }];
}

export function extractScreenshotPayload(
  messages: ChatMessage[],
  theme: string,
): ScreenshotPayload {
  const roles = new Set(messages.map(m => m.role));
  const isMixed = roles.size > 1;

  const buildMsg = (m: ChatMessage) => ({
    role: m.role,
    name: '',
    avatarDataUrl: null as string | null,
    blocks: m.role === 'user'
      ? extractUserBlocks(m)
      : extractBlocks(m.blocks || []),
  });

  if (isMixed) {
    return {
      mode: 'conversation',
      theme,
      messages: messages.map(buildMsg),
    };
  }

  return {
    mode: 'article',
    theme,
    messages: messages.map(buildMsg),
  };
}
