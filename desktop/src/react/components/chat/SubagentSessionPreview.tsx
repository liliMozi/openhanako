import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { subscribeStreamKey } from '../../services/stream-key-dispatcher';
import { renderMarkdown } from '../../utils/markdown';
import type { ChatListItem, ChatMessage, ContentBlock } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { loadMessages } from '../../stores/session-actions';
import { ChatTranscript } from './ChatTranscript';
import styles from './Chat.module.css';

const EMPTY_ITEMS: ChatListItem[] = [];
const EMPTY_SESSION_RETRY_DELAY_MS = 800;

interface Props {
  taskId: string;
  sessionPath: string | null;
  agentId?: string | null;
  streamStatus: 'running' | 'done' | 'failed' | 'aborted';
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}

const PREVIEW_STICKY_THRESHOLD = 32;
const STREAM_MESSAGE_ID_PREFIX = 'subagent-preview-stream';

function hasAssistantHistory(items: ChatListItem[]): boolean {
  return items.some((item) => item.type === 'message' && item.data.role === 'assistant');
}

function createStreamMessage(taskId: string): ChatMessage {
  return {
    id: `${STREAM_MESSAGE_ID_PREFIX}-${taskId}`,
    role: 'assistant',
    blocks: [],
  };
}

function upsertBlock(
  blocks: ContentBlock[],
  match: (block: ContentBlock) => boolean,
  nextBlock: ContentBlock,
  insertAtStart = false,
): ContentBlock[] {
  const idx = blocks.findIndex(match);
  if (idx >= 0) {
    const next = [...blocks];
    next[idx] = nextBlock;
    return next;
  }
  return insertAtStart ? [nextBlock, ...blocks] : [...blocks, nextBlock];
}

export function SubagentSessionPreview({ taskId, sessionPath, agentId, streamStatus, scrollContainerRef }: Props) {
  const entry = useStore(s => s.subagentPreviewByTaskId[taskId]);
  const session = useStore(s => (sessionPath ? s.chatSessions[sessionPath] ?? null : null));
  const items = session?.items ?? EMPTY_ITEMS;
  const [retryNonce, setRetryNonce] = useState(0);
  const [streamMessage, setStreamMessage] = useState<ChatMessage | null>(null);
  const [streamRevision, setStreamRevision] = useState(0);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [scrollContainerRef]);

  useEffect(() => {
    stickToBottomRef.current = true;
    setStreamMessage(null);
    setStreamRevision(0);
  }, [sessionPath]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const syncStickyState = () => {
      stickToBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < PREVIEW_STICKY_THRESHOLD;
    };

    syncStickyState();
    el.addEventListener('scroll', syncStickyState, { passive: true });
    return () => el.removeEventListener('scroll', syncStickyState);
  }, [scrollContainerRef, sessionPath]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const raf = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(raf);
  }, [items.length, entry?.loading, streamStatus, streamRevision, scrollToBottom]);

  useEffect(() => {
    const content = contentRef.current;
    const ResizeObserverImpl = window.ResizeObserver;
    if (!content || !ResizeObserverImpl) return;

    const ro = new ResizeObserverImpl(() => {
      if (stickToBottomRef.current) {
        scrollToBottom();
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom, items.length, streamRevision]);

  // streamMessage 的清理完全交给 turn_end 事件（下方 subscribeStreamKey 分支中处理）。
  // 不能用 hasAssistantHistory(items) 做被动推断：多轮 turn 场景下 items 永远有上一轮的
  // assistant 记录，被动清理会把刚开始的新一轮 streamMessage 立刻抹掉。

  useEffect(() => {
    if (!sessionPath) return;
    if (items.length > 0) {
      useStore.getState().markSubagentPreviewLoaded(taskId);
      return;
    }
    if (entry?.loading) return;

    let cancelled = false;
    let retryTimer: number | null = null;

    useStore.getState().setSubagentPreviewLoading(taskId, true);

    void loadMessages(sessionPath)
      .then(() => {
        if (cancelled) return;
        const latestState = useStore.getState();
        const latestEntry = latestState.subagentPreviewByTaskId[taskId];
        if (latestEntry?.sessionPath !== sessionPath) return;

        const latestItems = latestState.chatSessions[sessionPath]?.items ?? EMPTY_ITEMS;
        if (latestItems.length > 0) {
          latestState.markSubagentPreviewLoaded(taskId);
          return;
        }

        latestState.setSubagentPreviewLoading(taskId, false);
        if (streamStatus === 'running') {
          retryTimer = window.setTimeout(() => {
            if (!cancelled) setRetryNonce((n) => n + 1);
          }, EMPTY_SESSION_RETRY_DELAY_MS);
          return;
        }

        const latest = useStore.getState().subagentPreviewByTaskId[taskId];
        if (latest?.sessionPath === sessionPath) useStore.getState().markSubagentPreviewLoaded(taskId);
      })
      .catch(() => {
        if (cancelled) return;
        const latest = useStore.getState().subagentPreviewByTaskId[taskId];
        if (latest?.sessionPath === sessionPath) {
          useStore.getState().setSubagentPreviewLoading(taskId, false);
        }
      });

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [taskId, sessionPath, items.length, retryNonce, streamStatus]);

  useEffect(() => {
    if (!sessionPath || streamStatus !== 'running') return;

    const updateStreamMessage = (updater: (message: ChatMessage) => ChatMessage) => {
      setStreamMessage((prev) => {
        const next = updater(prev || createStreamMessage(taskId));
        return next;
      });
      setStreamRevision((v) => v + 1);
    };

    const unsubscribe = subscribeStreamKey(sessionPath, (event: any) => {
      switch (event.type) {
        case 'thinking_start':
          updateStreamMessage((message) => ({
            ...message,
            blocks: upsertBlock(
              message.blocks || [],
              (block) => block.type === 'thinking',
              { type: 'thinking', content: '', sealed: false },
              true,
            ),
          }));
          break;

        case 'thinking_delta':
          updateStreamMessage((message) => {
            const blocks = message.blocks || [];
            const thinking = blocks.find((block) => block.type === 'thinking') as Extract<ContentBlock, { type: 'thinking' }> | undefined;
            return {
              ...message,
              blocks: upsertBlock(
                blocks,
                (block) => block.type === 'thinking',
                {
                  type: 'thinking',
                  content: `${thinking?.content || ''}${event.delta || ''}`,
                  sealed: false,
                },
                true,
              ),
            };
          });
          break;

        case 'thinking_end':
          updateStreamMessage((message) => {
            const blocks = message.blocks || [];
            const thinking = blocks.find((block) => block.type === 'thinking') as Extract<ContentBlock, { type: 'thinking' }> | undefined;
            return {
              ...message,
              blocks: upsertBlock(
                blocks,
                (block) => block.type === 'thinking',
                {
                  type: 'thinking',
                  content: thinking?.content || '',
                  sealed: true,
                },
                true,
              ),
            };
          });
          break;

        case 'text_delta':
          updateStreamMessage((message) => {
            const blocks = message.blocks || [];
            const textBlock = blocks.find((block) => block.type === 'text') as (Extract<ContentBlock, { type: 'text' }> & { _raw?: string }) | undefined;
            // 维护纯文本累加器 _raw，避免每次 delta 都从 HTML 反向解析
            const prevText = textBlock?._raw ?? '';
            const nextText = prevText + (event.delta || '');
            return {
              ...message,
              blocks: upsertBlock(
                blocks,
                (block) => block.type === 'text',
                { type: 'text', html: renderMarkdown(nextText), _raw: nextText } as any,
              ),
            };
          });
          break;

        case 'tool_start':
          updateStreamMessage((message) => {
            const blocks = [...(message.blocks || [])];
            const groupIndex = [...blocks]
              .reverse()
              .findIndex((block) => block.type === 'tool_group' && block.tools.some((tool) => !tool.done));
            const actualIndex = groupIndex >= 0 ? blocks.length - 1 - groupIndex : -1;
            if (actualIndex >= 0) {
              const group = blocks[actualIndex] as Extract<ContentBlock, { type: 'tool_group' }>;
              blocks[actualIndex] = {
                ...group,
                tools: [...group.tools, { name: event.name, args: event.args, done: false, success: false }],
              };
            } else {
              blocks.push({
                type: 'tool_group',
                tools: [{ name: event.name, args: event.args, done: false, success: false }],
                collapsed: false,
              });
            }
            return { ...message, blocks };
          });
          break;

        case 'tool_end':
          updateStreamMessage((message) => {
            const blocks = [...(message.blocks || [])];
            for (let i = blocks.length - 1; i >= 0; i -= 1) {
              const block = blocks[i];
              if (block.type !== 'tool_group') continue;
              const toolIndex = block.tools.findIndex((tool) => tool.name === event.name && !tool.done);
              if (toolIndex < 0) continue;
              const tools = [...block.tools];
              tools[toolIndex] = {
                ...tools[toolIndex],
                done: true,
                success: !!event.success,
                details: event.details,
              };
              blocks[i] = {
                ...block,
                tools,
                collapsed: tools.length > 1 && tools.every((tool) => tool.done),
              };
              break;
            }
            return { ...message, blocks };
          });
          break;

        case 'content_block':
          updateStreamMessage((message) => ({
            ...message,
            blocks: [...(message.blocks || []), event.block],
          }));
          break;

        case 'turn_end':
          void loadMessages(sessionPath)
            .then(() => {
              const latestItems = useStore.getState().chatSessions[sessionPath]?.items ?? EMPTY_ITEMS;
              if (hasAssistantHistory(latestItems)) {
                setStreamMessage(null);
              }
            })
            .catch(() => {});
          break;

        default:
          break;
      }
    });

    return unsubscribe;
  }, [sessionPath, streamStatus, taskId]);

  const mergedItems = streamMessage
    ? [...items, { type: 'message' as const, data: streamMessage }]
    : items;

  if (!sessionPath) {
    return <div>正在连接 subagent session...</div>;
  }

  return (
    <div ref={contentRef} className={styles.subagentPreviewTranscript}>
      {entry?.loading && mergedItems.length === 0 ? (
        <div>正在加载会话...</div>
      ) : streamStatus === 'running' && mergedItems.length === 0 ? (
        <div>正在等待会话内容...</div>
      ) : mergedItems.length === 0 ? (
        <div>暂无会话内容</div>
      ) : (
        <ChatTranscript
          items={mergedItems}
          sessionPath={sessionPath}
          agentId={agentId}
          readOnly
          hideUserIdentity
        />
      )}
    </div>
  );
}
