/**
 * FloatPreviewCard — 侧边栏折叠时的浮动预览卡片
 *
 * 左侧：session 列表 + 新建聊天 + 设置按钮
 * 右侧：desk 文件列表 + 笺编辑区
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../stores';
import { hanaUrl } from '../hooks/use-hana-fetch';
import { createNewSession, switchSession } from '../stores/session-actions';
import { yuanFallbackAvatar } from '../utils/agent-helpers';
import { saveJianContent } from '../stores/desk-actions';

declare function t(key: string, vars?: Record<string, string | number>): string;

/* eslint-disable @typescript-eslint/no-explicit-any -- 浮动预览卡片：session/deskFile 数据为动态 JSON */

interface FloatCardState {
  side: 'left' | 'right';
  anchorRect: DOMRect;
}

let _enterTimer: ReturnType<typeof setTimeout> | null = null;
let _leaveTimer: ReturnType<typeof setTimeout> | null = null;

export function useFloatCard() {
  const [floatCard, setFloatCard] = useState<FloatCardState | null>(null);

  const show = useCallback((side: 'left' | 'right', target: HTMLElement) => {
    if (_leaveTimer) clearTimeout(_leaveTimer);
    if (_enterTimer) clearTimeout(_enterTimer);
    _enterTimer = setTimeout(() => {
      const isCollapsed = side === 'left'
        ? !useStore.getState().sidebarOpen
        : !useStore.getState().jianOpen;
      if (!isCollapsed) return;
      setFloatCard({ side, anchorRect: target.getBoundingClientRect() });
    }, 500);
  }, []);

  const scheduleHide = useCallback(() => {
    if (_enterTimer) clearTimeout(_enterTimer);
    _leaveTimer = setTimeout(() => setFloatCard(null), 200);
  }, []);

  const cancelHide = useCallback(() => {
    if (_leaveTimer) clearTimeout(_leaveTimer);
  }, []);

  const hide = useCallback(() => {
    if (_enterTimer) clearTimeout(_enterTimer);
    if (_leaveTimer) clearTimeout(_leaveTimer);
    setFloatCard(null);
  }, []);

  return { floatCard, show, scheduleHide, cancelHide, hide };
}

export function FloatPreviewCard({
  state,
  onMouseEnter,
  onMouseLeave,
  onAction,
}: {
  state: FloatCardState;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onAction: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  const style: React.CSSProperties = {
    top: state.anchorRect.bottom + 6,
    ...(state.side === 'left'
      ? { left: state.anchorRect.left }
      : { right: window.innerWidth - state.anchorRect.right }),
  };

  return (
    <div
      ref={cardRef}
      className={`float-card float-card-${state.side}${visible ? ' visible' : ''}`}
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {state.side === 'left' ? <SessionListCard onAction={onAction} /> : <DeskListCard />}
    </div>
  );
}

// ── 左侧：Session 列表 ──

function SessionListCard({ onAction }: { onAction: () => void }) {
  const sessions = useStore(s => s.sessions);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const agents = useStore(s => s.agents);
  const agentYuan = useStore(s => s.agentYuan);

  if (sessions.length === 0) {
    return <div className="float-card-empty">{t('common.noChats')}</div>;
  }

  return (
    <>
      <div className="float-card-list">
        {sessions.slice(0, 12).map((sess: any) => (
          <div
            key={sess.path}
            className={`float-card-item${sess.path === currentSessionPath ? ' active' : ''}`}
            onClick={() => { onAction(); switchSession(sess.path); }}
          >
            <SessionAvatar sess={sess} agents={agents} agentYuan={agentYuan} />
            <span className="float-card-item-text">{sess.title || t('session.untitled')}</span>
          </div>
        ))}
      </div>
      <div className="float-card-bar">
        <div className="float-card-bar-btn" onClick={() => { onAction(); createNewSession(); }}>
          + {t('sidebar.newChat')}
        </div>
        <span className="float-card-bar-divider" />
        <div
          className="float-card-bar-btn float-card-bar-icon"
          title={t('settings.title')}
          onClick={() => { onAction(); window.platform?.openSettings(); }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </div>
      </div>
    </>
  );
}

function SessionAvatar({ sess, agents, agentYuan }: { sess: any; agents: any[]; agentYuan: string }) {
  const [src, setSrc] = useState(() => {
    if (sess.agentId) {
      const ag = agents.find((x: any) => x.id === sess.agentId);
      if (ag?.hasAvatar) return hanaUrl(`/api/agents/${sess.agentId}/avatar?t=${Date.now()}`);
      return yuanFallbackAvatar(ag?.yuan || agentYuan);
    }
    return yuanFallbackAvatar(agentYuan);
  });
  return (
    <img
      className="float-card-avatar"
      draggable={false}
      src={src}
      onError={() => {
        const ag = agents.find((x: any) => x.id === sess.agentId);
        setSrc(yuanFallbackAvatar(ag?.yuan));
      }}
    />
  );
}

// ── 右侧：Desk 文件列表 + 笺 ──

function DeskListCard() {
  const deskFiles = useStore(s => s.deskFiles);
  const deskJianContent = useStore(s => s.deskJianContent);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleJianInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    useStore.setState({ deskJianContent: val });
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveJianContent(), 800);
  }, []);

  return (
    <>
      {deskFiles.length === 0 ? (
        <div className="float-card-empty">{t('desk.emptyTitle')}</div>
      ) : (
        <div className="float-card-list">
          {deskFiles.slice(0, 12).map((f: any) => (
            <div key={f.name} className={`float-card-item${f.isDir ? ' is-dir' : ''}`}>
              {f.isDir ? `${f.name}/` : f.name}
            </div>
          ))}
        </div>
      )}
      <div className="float-card-jian">
        <div className="float-card-jian-label">{t('desk.jianLabel')}</div>
        <textarea
          className="float-card-jian-input"
          placeholder={t('desk.jianPlaceholder')}
          spellCheck={false}
          value={deskJianContent || ''}
          onChange={handleJianInput}
        />
      </div>
    </>
  );
}
