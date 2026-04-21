/**
 * ChatArea — 聊天消息列表（干净重写版）
 *
 * 原理：每个 session 一个原生滚动 div，visibility:hidden 保持 scrollTop。
 * 不用 Virtuoso，不用 Activity，不用快照，不用任何花活。
 */

import { memo, useRef, useEffect, useState, useCallback } from 'react';
import { useStore } from '../../stores';
import { loadMoreMessages } from '../../stores/session-actions';

const EMPTY_ITEMS: ChatListItem[] = [];
import type { ChatListItem } from '../../stores/chat-types';
import { ChatTranscript } from './ChatTranscript';
import styles from './Chat.module.css';

const MAX_ALIVE = 5;
const LOAD_MORE_THRESHOLD = 200; // 距顶部多少 px 触发加载

// ── 入口 ──

export function ChatArea() {
  return (
    <>
      <PanelHost />
      <ScrollToBottomBtn />
    </>
  );
}

// ── PanelHost：管理 alive 列表 ──

function PanelHost() {
  const currentPath = useStore(s => s.currentSessionPath);
  const currentHasItems = useStore(s => !!(currentPath && s.chatSessions[currentPath]?.items?.length));
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const [alive, setAlive] = useState<string[]>([]);

  // 加入 alive 列表（不重排已有位置，避免 React 移动 DOM 节点导致 scrollTop 丢失）
  useEffect(() => {
    if (!currentPath || !currentHasItems) return;
    setAlive(prev => {
      if (prev.includes(currentPath)) return prev; // 已存在，不动
      if (prev.length >= MAX_ALIVE) {
        // 淘汰第一个非当前的
        const evictIdx = prev.findIndex(p => p !== currentPath);
        const next = [...prev];
        next.splice(evictIdx, 1);
        next.push(currentPath);
        return next;
      }
      return [...prev, currentPath];
    });
  }, [currentPath, currentHasItems]);

  if (welcomeVisible || !currentPath) return null;

  return (
    <>
      {alive.map(path => (
        <Panel key={path} path={path} active={path === currentPath} />
      ))}
    </>
  );
}

// ── Panel：一个 session 的原生滚动容器 ──

const SCROLL_THRESHOLD = 50;

const Panel = memo(function Panel({ path, active }: { path: string; active: boolean }) {
  const items = useStore(s => s.chatSessions[path]?.items || EMPTY_ITEMS);
  const hasMore = useStore(s => s.chatSessions[path]?.hasMore ?? false);
  const loadingMore = useStore(s => s.chatSessions[path]?.loadingMore ?? false);
  const isSessionStreaming = useStore(s => s.streamingSessions.includes(path));
  const sessionAgentId = useStore(s => s.sessions.find(se => se.path === path)?.agentId ?? null);
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isAtBottom = useRef(true);

  // 判断是否在底部
  const checkAtBottom = () => {
    const el = ref.current;
    if (!el) return;
    isAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
  };

  // 滚到底
  const scrollToBottom = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // scroll 事件维护 isAtBottom 标志 + 上滑加载更多
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      checkAtBottom();
      // 触顶加载更多
      if (el.scrollTop < LOAD_MORE_THRESHOLD) {
        const session = useStore.getState().chatSessions[path];
        if (session?.hasMore && !session.loadingMore) {
          loadMoreMessages(path);
        }
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [path]);

  // prepend 后保持滚动位置：监听 items 变化，如果头部变了就修正 scrollTop
  const prevFirstId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const firstId = items[0]?.type === 'message' ? items[0].data.id : undefined;
    const el = ref.current;
    if (el && prevFirstId.current && firstId !== prevFirstId.current) {
      // 头部 id 变了 → prepend 发生，修正 scrollTop 让原来的内容不跳
      const prevHeight = el.dataset.prevScrollHeight;
      if (prevHeight) {
        el.scrollTop += el.scrollHeight - Number(prevHeight);
      }
    }
    prevFirstId.current = firstId;
  }, [items]);

  // 在 loadingMore 变成 true 前快照 scrollHeight
  useEffect(() => {
    const el = ref.current;
    if (el && loadingMore) {
      el.dataset.prevScrollHeight = String(el.scrollHeight);
    }
  }, [loadingMore]);

  // ResizeObserver：内容高度变化 + 在底部 → 自动滚
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (active && isAtBottom.current) {
        scrollToBottom();
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [active]);

  // 首次有内容 → 滚到底
  const scrolledOnce = useRef(false);
  useEffect(() => {
    if (scrolledOnce.current) return;
    if (items.length > 0) {
      scrollToBottom();
      isAtBottom.current = true;
      scrolledOnce.current = true;
    }
  }, [items.length]);

  // 新消息加入 → 强制 sticky（发送消息后自动跟随）
  const prevLen = useRef(items.length);
  useEffect(() => {
    if (items.length > prevLen.current && active) {
      isAtBottom.current = true;
      scrollToBottom();
    }
    prevLen.current = items.length;
  }, [items.length, active]);

  if (items.length === 0) return null;

  return (
    <div
      ref={ref}
      className={styles.sessionPanel}
      style={{
        visibility: active ? 'visible' : 'hidden',
        zIndex: active ? 1 : 0,
        pointerEvents: active ? 'auto' : 'none',
      }}
    >
      <div ref={contentRef} className={styles.sessionMessages}>
        {hasMore && (
          <div className={styles.loadMoreHint}>
            {loadingMore ? '...' : ''}
          </div>
        )}
        <ChatTranscript items={items} sessionPath={path} agentId={sessionAgentId} />
        {isSessionStreaming && (
          <div className={styles.typingIndicator}>
            <span /><span /><span />
          </div>
        )}
        <div className={styles.sessionFooter} />
      </div>
    </div>
  );
});

// ── ScrollToBottom 按钮 ──

let _scrollBtn = { el: null as HTMLElement | null, visible: false, listeners: [] as (() => void)[] };

function ScrollToBottomBtn() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const update = () => setVisible(_scrollBtn.visible);
    _scrollBtn.listeners.push(update);
    return () => { _scrollBtn.listeners = _scrollBtn.listeners.filter(f => f !== update); };
  }, []);

  if (!visible) return null;
  return (
    <button className={styles.scrollToBottomFab} onClick={() => {
      _scrollBtn.el?.scrollTo({ top: _scrollBtn.el.scrollHeight, behavior: 'smooth' });
    }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
}
