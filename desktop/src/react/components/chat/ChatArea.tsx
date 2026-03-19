/**
 * ChatArea — 聊天消息列表（干净重写版）
 *
 * 原理：每个 session 一个原生滚动 div，visibility:hidden 保持 scrollTop。
 * 不用 Virtuoso，不用 Activity，不用快照，不用任何花活。
 */

import { memo, useRef, useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../stores';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { CompactionNotice } from './CompactionNotice';
import type { ChatListItem } from '../../stores/chat-types';

const MAX_ALIVE = 5;

// ── 入口 ──

export function ChatArea() {
  const chatArea = document.getElementById('chatArea');
  const mainContent = chatArea?.parentElement;
  if (!chatArea || !mainContent) return null;
  return (
    <>
      {createPortal(<PanelHost />, chatArea)}
      {createPortal(<ScrollToBottomBtn />, mainContent)}
    </>
  );
}

// ── PanelHost：管理 alive 列表 ──

function PanelHost() {
  const currentPath = useStore(s => s.currentSessionPath);
  const chatSessions = useStore(s => s.chatSessions);
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const [alive, setAlive] = useState<string[]>([]);

  // 隐藏旧 #messages
  useEffect(() => {
    const el = document.getElementById('messages');
    if (el) el.style.display = 'none';
  }, []);

  // 加入 alive 列表（不重排已有位置，避免 React 移动 DOM 节点导致 scrollTop 丢失）
  useEffect(() => {
    if (!currentPath) return;
    if (!chatSessions[currentPath] || chatSessions[currentPath].items.length === 0) return;
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
  }, [currentPath, chatSessions]);

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

const Panel = memo(function Panel({ path, active }: { path: string; active: boolean }) {
  const items = useStore(s => s.chatSessions[path]?.items || []);
  const ref = useRef<HTMLDivElement>(null);
  const scrolledOnce = useRef(false);


  // 首次有内容时滚到底
  useEffect(() => {
    if (scrolledOnce.current) return;
    const el = ref.current;
    if (el && items.length > 0) {
      el.scrollTop = el.scrollHeight;
      scrolledOnce.current = true;
      console.log(`[panel] ${path.slice(-12)} initial scroll to bottom: ${el.scrollTop}`);
    }
  }, [items.length, path]);

  // 新消息 + 在底部附近 → 自动滚
  const prevLen = useRef(items.length);
  useEffect(() => {
    if (items.length > prevLen.current && active) {
      const el = ref.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
        requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
      }
    }
    prevLen.current = items.length;
  }, [items.length, active]);

  if (items.length === 0) return null;

  return (
    <div
      ref={ref}
      className="chat-session-panel"
      style={{
        visibility: active ? 'visible' : 'hidden',
        zIndex: active ? 1 : 0,
        pointerEvents: active ? 'auto' : 'none',
      }}
    >
      <div className="chat-session-messages">
        {items.map((item, i) => (
          <ItemView
            key={item.type === 'message' ? item.data.id : `c-${i}`}
            item={item}
            prevItem={i > 0 ? items[i - 1] : undefined}
          />
        ))}
        <div className="chat-session-footer" />
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
    <button className="scroll-to-bottom-fab" onClick={() => {
      _scrollBtn.el?.scrollTo({ top: _scrollBtn.el.scrollHeight, behavior: 'smooth' });
    }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
}

// ── ItemView ──

const ItemView = memo(function ItemView({ item, prevItem }: {
  item: ChatListItem;
  prevItem?: ChatListItem;
}) {
  if (item.type === 'compaction') {
    return <CompactionNotice yuan={item.yuan} />;
  }
  const msg = item.data;
  const prevRole = prevItem?.type === 'message' ? prevItem.data.role : null;
  const showAvatar = msg.role !== prevRole;
  if (msg.role === 'user') {
    return <UserMessage message={msg} showAvatar={showAvatar} />;
  }
  return <AssistantMessage message={msg} showAvatar={showAvatar} />;
});
