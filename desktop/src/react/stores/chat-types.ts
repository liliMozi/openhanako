/**
 * chat-types.ts — 聊天消息数据模型
 *
 * 历史消息和流式消息共用同一套类型。
 * ContentBlock 按展示顺序排列（thinking → mood → tools → text → xing），
 * 不按流式到达顺序。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── 工具调用 ──

export interface ToolCall {
  name: string;
  args?: Record<string, unknown>;
  done: boolean;
  success: boolean;
}

// ── 用户附件 ──

export interface UserAttachment {
  path: string;
  name: string;
  isDir: boolean;
  base64Data?: string;
  mimeType?: string;
}

export interface DeskContext {
  dir: string;
  fileCount: number;
}

// ── 内容块 ──

export type ContentBlock =
  | { type: 'thinking'; content: string; sealed: boolean }
  | { type: 'mood'; yuan: string; text: string }
  | { type: 'tool_group'; tools: ToolCall[]; collapsed: boolean }
  | { type: 'text'; html: string }
  | { type: 'xing'; title: string; content: string; sealed: boolean }
  | { type: 'file_output'; filePath: string; label: string; ext: string }
  | { type: 'artifact'; artifactId: string; artifactType: string; title: string; content: string; language?: string }
  | { type: 'browser_screenshot'; base64: string; mimeType: string }
  | { type: 'skill'; skillName: string; skillFilePath: string }
  | { type: 'cron_confirm'; jobData: Record<string, unknown>; status: 'pending' | 'approved' | 'rejected' };

// ── 消息 ──

export interface ChatMessage {
  id: string;              // 服务端返回的稳定 ID（JSONL 行号）
  role: 'user' | 'assistant';
  // User
  text?: string;
  textHtml?: string;
  attachments?: UserAttachment[];
  deskContext?: DeskContext | null;
  // Assistant
  blocks?: ContentBlock[];
  // 通用
  timestamp?: number;
}

// ── Virtuoso 列表项 ──

export type ChatListItem =
  | { type: 'message'; data: ChatMessage }
  | { type: 'compaction'; id: string; yuan: string };

// ── Per-session 消息状态 ──

export interface SessionMessages {
  items: ChatListItem[];
  hasMore: boolean;
  loadingMore: boolean;
  oldestId?: string;
}

// ── 流式缓冲（不入 Zustand） ──

export interface StreamBuffer {
  sessionPath: string;
  textAcc: string;
  thinkingAcc: string;
  moodAcc: string;
  moodYuan: string;
  xingAcc: string;
  xingTitle: string;
  inThinking: boolean;
  inMood: boolean;
  inXing: boolean;
  lastFlushTime: number;
}
