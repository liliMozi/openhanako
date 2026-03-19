/**
 * StreamBufferManager — per-session 流式事件节流缓冲
 *
 * WS 事件到达时写入 buffer（纯 JS 对象，不触发 React），
 * 每 FLUSH_INTERVAL ms 批量 flush 到 Zustand store。
 *
 * 设计为 singleton，不依赖 React 组件生命周期。
 * app-ws-shim 直接调用 streamBufferManager.handle(msg)。
 */

import type { ChatMessage, ContentBlock, ChatListItem } from '../stores/chat-types';
import { useStore } from '../stores';
import { renderMarkdown } from '../utils/markdown';
import { cleanMoodText } from '../utils/message-parser';

/* eslint-disable @typescript-eslint/no-explicit-any */

const FLUSH_INTERVAL = 200;

interface Buffer {
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
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** 当前 turn 是否已追加了空 assistant message */
  messageAppended: boolean;
}

function createBuffer(sessionPath: string): Buffer {
  return {
    sessionPath,
    textAcc: '',
    thinkingAcc: '',
    moodAcc: '',
    moodYuan: 'hanako',
    xingAcc: '',
    xingTitle: '',
    inThinking: false,
    inMood: false,
    inXing: false,
    lastFlushTime: 0,
    flushTimer: null,
    messageAppended: false,
  };
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

  /** 确保 store 中已为该 session 追加了一条空 assistant message */
  private ensureMessage(buf: Buffer): void {
    if (buf.messageAppended) return;
    buf.messageAppended = true;

    const store = useStore.getState();
    const session = store.chatSessions[buf.sessionPath];
    if (!session) return; // session 未初始化（可能还没 loadMessages）

    const id = `stream-${Date.now()}`;
    const msg: ChatMessage = { id, role: 'assistant', blocks: [] };
    store.appendItem(buf.sessionPath, { type: 'message', data: msg });
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

    const store = useStore.getState();
    store.updateLastMessage(buf.sessionPath, (msg) => {
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
          const insertAt = blocks.findIndex(b => b.type !== 'thinking') ;
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

      // ── Xing ──
      if (buf.xingAcc || buf.inXing) {
        const idx = blocks.findIndex(b => b.type === 'xing');
        const xingBlock: ContentBlock = {
          type: 'xing',
          title: buf.xingTitle,
          content: buf.xingAcc,
          sealed: !buf.inXing,
        };
        if (idx >= 0) blocks[idx] = xingBlock;
        else blocks.push(xingBlock);
      }

      return { ...msg, blocks };
    });
  }

  // ── 公开事件处理器 ──

  handle(msg: any): void {
    const sessionPath = msg.sessionPath || (window as any).__hanaState?.currentSessionPath;
    if (!sessionPath) return;
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
        buf.moodYuan = (window as any).__hanaState?.agentYuan || 'hanako';
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

      case 'xing_start':
        this.ensureMessage(buf);
        buf.inXing = true;
        buf.xingAcc = '';
        buf.xingTitle = msg.title || '反省';
        this.flush(buf);
        break;

      case 'xing_text':
        buf.xingAcc += msg.delta || '';
        break;

      case 'xing_end':
        buf.inXing = false;
        this.flush(buf);
        break;

      case 'tool_start':
        this.ensureMessage(buf);
        // 工具事件频率低，直接写 store
        this.flush(buf); // 先 flush 文本
        useStore.getState().updateLastMessage(sessionPath, (m) => {
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
        useStore.getState().updateLastMessage(sessionPath, (m) => {
          const blocks = [...(m.blocks || [])];
          // 从后往前找含该 tool 名且未 done 的
          for (let i = blocks.length - 1; i >= 0; i--) {
            if (blocks[i].type !== 'tool_group') continue;
            const tg = blocks[i] as Extract<ContentBlock, { type: 'tool_group' }>;
            const toolIdx = tg.tools.findIndex(t => t.name === msg.name && !t.done);
            if (toolIdx >= 0) {
              const tools = [...tg.tools];
              tools[toolIdx] = { ...tools[toolIdx], done: true, success: !!msg.success };
              const allDone = tools.every(t => t.done);
              blocks[i] = { ...tg, tools, collapsed: allDone && tools.length > 1 };
              return { ...m, blocks };
            }
          }
          return m;
        });
        break;

      case 'file_output':
        this.ensureMessage(buf);
        this.flush(buf);
        useStore.getState().updateLastMessage(sessionPath, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), { type: 'file_output', filePath: msg.filePath, label: msg.label, ext: msg.ext }],
        }));
        break;

      case 'artifact':
        this.ensureMessage(buf);
        this.flush(buf);
        useStore.getState().updateLastMessage(sessionPath, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), {
            type: 'artifact',
            artifactId: msg.artifactId || msg.id,
            artifactType: msg.artifactType || msg.type,
            title: msg.title || '',
            content: msg.content || '',
            language: msg.language,
          }],
        }));
        break;

      case 'browser_screenshot':
        this.ensureMessage(buf);
        this.flush(buf);
        useStore.getState().updateLastMessage(sessionPath, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), { type: 'browser_screenshot', base64: msg.base64, mimeType: msg.mimeType }],
        }));
        break;

      case 'skill_activated':
        this.ensureMessage(buf);
        this.flush(buf);
        useStore.getState().updateLastMessage(sessionPath, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), { type: 'skill', skillName: msg.skillName, skillFilePath: msg.skillFilePath }],
        }));
        break;

      case 'cron_confirmation':
        this.ensureMessage(buf);
        this.flush(buf);
        useStore.getState().updateLastMessage(sessionPath, (m) => ({
          ...m,
          blocks: [...(m.blocks || []), { type: 'cron_confirm', jobData: msg.jobData, status: 'pending' as const }],
        }));
        break;

      case 'compaction_start':
        useStore.getState().appendItem(sessionPath, {
          type: 'compaction',
          id: `compaction-${Date.now()}`,
          yuan: (window as any).__hanaState?.agentYuan || 'hanako',
        });
        break;

      case 'compaction_end':
        // 移除 compaction notice（遍历找到最后一个 compaction item 删掉）
        useStore.getState().updateLastMessage(sessionPath, m => m); // no-op，触发重渲染
        // TODO: 可以加一个 removeLastCompaction action
        break;

      case 'turn_end':
        this.flush(buf);
        // 清理 buffer
        buf.textAcc = '';
        buf.thinkingAcc = '';
        buf.moodAcc = '';
        buf.xingAcc = '';
        buf.inThinking = false;
        buf.inMood = false;
        buf.inXing = false;
        buf.messageAppended = false;
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
}

/** 全局 singleton */
export const streamBufferManager = new StreamBufferManager();
