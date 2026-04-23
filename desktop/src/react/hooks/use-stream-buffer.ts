/**
 * StreamBufferManager — per-session 流式事件节流缓冲
 *
 * WS 事件到达时写入 buffer（纯 JS 对象，不触发 React），
 * 每 FLUSH_INTERVAL ms 批量 flush 到 Zustand store。
 *
 * 设计为 singleton，不依赖 React 组件生命周期。
 * app-ws-shim 直接调用 streamBufferManager.handle(msg)。
 */

import type { ChatMessage, ContentBlock } from '../stores/chat-types';
import { useStore } from '../stores';
import { renderMarkdown } from '../utils/markdown';
import { cleanMoodText } from '../utils/message-parser';
import {
  registerStreamBufferInvalidator,
  registerStreamBufferSnapshot,
  type StreamBufferSnapshot,
} from '../stores/stream-invalidator';
import { bumpMessageLiveVersion } from '../stores/message-live-version';

/* eslint-disable @typescript-eslint/no-explicit-any -- 流式消息 handle(msg) 接收动态 JSON */

const FLUSH_INTERVAL = 200;

interface Buffer {
  sessionPath: string;
  textAcc: string;
  thinkingAcc: string;
  moodAcc: string;
  moodYuan: string;
  inThinking: boolean;
  inMood: boolean;
  inCard: boolean;
  cardAttrs: { type: string; plugin: string; route: string; title?: string } | null;
  cardDescAcc: string;
  lastFlushTime: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** 当前 turn 绑定的 assistant message id */
  messageId: string | null;
}

function createBuffer(sessionPath: string): Buffer {
  return {
    sessionPath,
    textAcc: '',
    thinkingAcc: '',
    moodAcc: '',
    moodYuan: 'hanako',
    inThinking: false,
    inMood: false,
    inCard: false,
    cardAttrs: null,
    cardDescAcc: '',
    lastFlushTime: 0,
    flushTimer: null,
    messageId: null,
  };
}

function resolveSessionYuan(sessionPath: string): string {
  const state = useStore.getState();
  const sessionAgentId = state.sessions.find((session: any) => session.path === sessionPath)?.agentId ?? null;
  if (!sessionAgentId) return 'hanako';
  return state.agents.find((agent: any) => agent.id === sessionAgentId)?.yuan || 'hanako';
}

class StreamBufferManager {
  private buffers = new Map<string, Buffer>();

  /** 获取或创建 session buffer */
  private getBuffer(sessionPath: string): Buffer {
    let buf = this.buffers.get(sessionPath);
    if (!buf) {
      buf = createBuffer(sessionPath);
      this.buffers.set(sessionPath, buf);
    }
    return buf;
  }

  /** 确保 store 中已存在当前 turn 绑定的 assistant message */
  private ensureMessage(buf: Buffer): void {
    const store = useStore.getState();
    const session = store.chatSessions[buf.sessionPath];
    if (!session) return; // session 未初始化（loadMessages 尚未完成）

    const existingId = buf.messageId;
    const existing = existingId
      ? session.items.find((item) =>
        item.type === 'message' &&
        item.data.id === existingId &&
        item.data.role === 'assistant',
      )
      : null;
    if (existing) return;

    const id = existingId || `stream-${Date.now()}`;
    const msg: ChatMessage = { id, role: 'assistant', blocks: [] };
    store.appendItem(buf.sessionPath, { type: 'message', data: msg });
    bumpMessageLiveVersion(buf.sessionPath);
    buf.messageId = id;
  }

  private updateTargetMessage(buf: Buffer, updater: (msg: ChatMessage) => ChatMessage): void {
    this.ensureMessage(buf);
    if (!buf.messageId) return;
    const updated = useStore.getState().updateMessageById(buf.sessionPath, buf.messageId, updater);
    if (!updated) {
      console.warn('[stream] target assistant message missing after ensureMessage:', buf.sessionPath, buf.messageId);
      return;
    }
    bumpMessageLiveVersion(buf.sessionPath);
  }

  /** 调度节流 flush */
  private scheduleFlush(buf: Buffer): void {
    const now = Date.now();
    if (now - buf.lastFlushTime >= FLUSH_INTERVAL) {
      this.flush(buf);
    } else if (!buf.flushTimer) {
      buf.flushTimer = setTimeout(() => {
        buf.flushTimer = null;
        this.flush(buf);
      }, FLUSH_INTERVAL - (now - buf.lastFlushTime));
    }
  }

  /** 把 buffer 中累积的内容一次性 flush 到 Zustand */
  private flush(buf: Buffer): void {
    buf.lastFlushTime = Date.now();
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }

    this.updateTargetMessage(buf, (msg) => {
      const blocks = [...(msg.blocks || [])];

      // ── Thinking ──
      if (buf.thinkingAcc || buf.inThinking) {
        const idx = blocks.findIndex(b => b.type === 'thinking');
        const thinkingBlock: ContentBlock = {
          type: 'thinking',
          content: buf.thinkingAcc,
          sealed: !buf.inThinking,
        };
        if (idx >= 0) blocks[idx] = thinkingBlock;
        else blocks.unshift(thinkingBlock); // thinking 在最前面
      }

      // ── Mood ──
      if (buf.moodAcc || buf.inMood) {
        const idx = blocks.findIndex(b => b.type === 'mood');
        const moodBlock: ContentBlock = {
          type: 'mood',
          yuan: buf.moodYuan,
          text: buf.inMood ? buf.moodAcc : cleanMoodText(buf.moodAcc),
        };
        if (idx >= 0) blocks[idx] = moodBlock;
        else {
          // mood 在 thinking 后面
          const insertAt = blocks.findIndex(b => b.type !== 'thinking');
          blocks.splice(insertAt >= 0 ? insertAt : blocks.length, 0, moodBlock);
        }
      }

      // ── Text ──
      if (buf.textAcc) {
        const displayText = buf.textAcc.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, '');
        const html = renderMarkdown(displayText);
        const idx = blocks.findIndex(b => b.type === 'text');
        if (idx >= 0) {
          blocks[idx] = { type: 'text', html };
        } else {
          blocks.push({ type: 'text', html });
        }
      }

      return { ...msg, blocks };
    });
  }

  // ── 公开事件处理器 ──

  handle(msg: any): void {
    const sessionPath = msg.sessionPath;
    if (!sessionPath) {
      console.warn('[ws] stream event missing sessionPath:', msg.type);
      return;
    }
    const buf = this.getBuffer(sessionPath);

    switch (msg.type) {
      case 'text_delta':
        this.ensureMessage(buf);
        buf.textAcc += msg.delta || '';
        this.scheduleFlush(buf);
        break;

      case 'thinking_start':
        this.ensureMessage(buf);
        buf.inThinking = true;
        buf.thinkingAcc = '';
        this.flush(buf);
        break;

      case 'thinking_delta':
        buf.thinkingAcc += msg.delta || '';
        // thinking 内容不频繁 flush，等 end 或下一个 text_delta
        break;

      case 'thinking_end':
        buf.inThinking = false;
        this.flush(buf);
        break;

      case 'mood_start':
        this.ensureMessage(buf);
        buf.inMood = true;
        buf.moodAcc = '';
        buf.moodYuan = resolveSessionYuan(sessionPath);
        this.flush(buf);
        break;

      case 'mood_text':
        buf.moodAcc += msg.delta || '';
        this.scheduleFlush(buf);
        break;

      case 'mood_end':
        buf.inMood = false;
        this.flush(buf);
        break;

      case 'card_start':
        this.ensureMessage(buf);
        buf.inCard = true;
        buf.cardAttrs = msg.attrs || null;
        buf.cardDescAcc = '';
        break;

      case 'card_text':
        buf.cardDescAcc += msg.delta || '';
        break;

      case 'card_end': {
        buf.inCard = false;
        if (buf.cardAttrs) {
          this.flush(buf); // flush pending text first
          const card = {
            type: buf.cardAttrs.type || 'iframe',
            pluginId: buf.cardAttrs.plugin || '',
            route: buf.cardAttrs.route || '',
            title: buf.cardAttrs.title,
            description: buf.cardDescAcc,
          };
          this.updateTargetMessage(buf, (m) => ({
            ...m,
            blocks: [...(m.blocks || []), { type: 'plugin_card' as const, card }],
          }));
        }
        buf.cardAttrs = null;
        buf.cardDescAcc = '';
        break;
      }

      case 'tool_start':
        this.ensureMessage(buf);
        // 工具事件频率低，直接写 store
        this.flush(buf); // 先 flush 文本
        this.updateTargetMessage(buf, (m) => {
          const blocks = [...(m.blocks || [])];
          // 找最后一个 tool_group 或创建新的
          let lastTg = blocks.length - 1;
          while (lastTg >= 0 && blocks[lastTg].type !== 'tool_group') lastTg--;
          if (lastTg >= 0 && blocks[lastTg].type === 'tool_group') {
            const tg = blocks[lastTg] as Extract<ContentBlock, { type: 'tool_group' }>;
            // 如果上一个 group 里还有未完成的工具，追加到同一个 group
            if (tg.tools.some(t => !t.done)) {
              blocks[lastTg] = {
                ...tg,
                tools: [...tg.tools, { name: msg.name, args: msg.args, done: false, success: false }],
              };
              return { ...m, blocks };
            }
          }
          // 新建 tool_group
          blocks.push({
            type: 'tool_group',
            tools: [{ name: msg.name, args: msg.args, done: false, success: false }],
            collapsed: false,
          });
          return { ...m, blocks };
        });
        break;

      case 'tool_end':
        this.updateTargetMessage(buf, (m) => {
          const blocks = [...(m.blocks || [])];
          // 从后往前找含该 tool 名且未 done 的
          for (let i = blocks.length - 1; i >= 0; i--) {
            if (blocks[i].type !== 'tool_group') continue;
            const tg = blocks[i] as Extract<ContentBlock, { type: 'tool_group' }>;
            const toolIdx = tg.tools.findIndex(t => t.name === msg.name && !t.done);
            if (toolIdx >= 0) {
              const tools = [...tg.tools];
              tools[toolIdx] = { ...tools[toolIdx], done: true, success: !!msg.success, details: msg.details };
              const allDone = tools.every(t => t.done);
              blocks[i] = { ...tg, tools, collapsed: allDone && tools.length > 1 };
              return { ...m, blocks };
            }
          }
          return m;
        });
        break;

      case 'content_block': {
        this.ensureMessage(buf);
        this.flush(buf);
        let block = msg.block;
        // Apply cached patches (block_update 可能先于 content_block 到达)
        if (block.taskId) {
          const pending = (useStore.getState() as any)._pendingBlockPatches;
          const cached = pending?.[block.taskId];
          if (cached) {
            block = { ...block, ...cached };
            delete pending[block.taskId];
          }
        }
        this.updateTargetMessage(buf, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), block],
        }));
        break;
      }

      case 'compaction_start':
        break;

      case 'compaction_end':
        break;

      case 'turn_end':
        this.flush(buf);
        // 清理 buffer
        buf.textAcc = '';
        buf.thinkingAcc = '';
        buf.moodAcc = '';
        buf.inThinking = false;
        buf.inMood = false;
        buf.inCard = false;
        buf.cardAttrs = null;
        buf.cardDescAcc = '';
        buf.messageId = null;
        break;

    }
  }

  /** 清理指定 session 的 buffer */
  clear(sessionPath: string): void {
    const buf = this.buffers.get(sessionPath);
    if (buf?.flushTimer) clearTimeout(buf.flushTimer);
    this.buffers.delete(sessionPath);
  }

  /** 清理所有 */
  clearAll(): void {
    for (const [, buf] of this.buffers) {
      if (buf.flushTimer) clearTimeout(buf.flushTimer);
    }
    this.buffers.clear();
  }

  /**
   * 取当前 buffer 的快照。供 loadMessages 在 session 重建后合并 in-flight
   * 内容：jsonl 只在 turn_end 落盘，在 stream 进行中重建 session 时，
   * 这份快照是避免 UI 上"正在流的消息凭空消失"的唯一来源。
   */
  snapshot(sessionPath: string): StreamBufferSnapshot | null {
    const buf = this.buffers.get(sessionPath);
    if (!buf) return null;
    const hasContent = !!(buf.textAcc || buf.thinkingAcc || buf.moodAcc);
    if (!hasContent) return null;
    return {
      hasContent: true,
      messageId: buf.messageId,
      text: buf.textAcc,
      thinking: buf.thinkingAcc,
      mood: buf.inMood ? buf.moodAcc : cleanMoodText(buf.moodAcc),
      moodYuan: buf.moodYuan,
      inThinking: buf.inThinking,
      inMood: buf.inMood,
    };
  }
}

/** 全局 singleton */
export const streamBufferManager = new StreamBufferManager();

// 让 chat-slice / session-actions 通过桥接模块触达 manager，打破循环依赖。
registerStreamBufferInvalidator((sessionPath) => {
  if (sessionPath == null) streamBufferManager.clearAll();
  else streamBufferManager.clear(sessionPath);
});
registerStreamBufferSnapshot((sessionPath) => streamBufferManager.snapshot(sessionPath));
