/**
 * SessionList — 侧边栏 session 列表 React 组件
 *
 * Phase 6B: 替代 sidebar-shim.ts 中的 renderSessionList / createSessionItem。
 * 通过 portal 渲染到 #sessionList，从 Zustand sessions 状态驱动。
 */

import { Fragment, memo, useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { formatSessionDate } from '../utils/format';
import { switchSession, archiveSession, renameSession, pinSession } from '../stores/session-actions';
import type { Session, Agent } from '../types';
import { yuanFallbackAvatar } from '../utils/agent-helpers';
import { buildSessionSections } from './session-sections';
import styles from './SessionList.module.css';


// ── 主组件 ──

export function SessionList() {
  return <SessionListInner />;
}

// ── 内部组件 ──

function SessionListInner() {
  const { t } = useI18n();
  const sessions = useStore(s => s.sessions);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const agents = useStore(s => s.agents);
  const streamingSessions = useStore(s => s.streamingSessions);
  const browserBySession = useStore(s => s.browserBySession);

  const [browserSessions, setBrowserSessions] = useState<Record<string, string>>({});

  // Fetch browser sessions (re-fetch when browser state changes)
  useEffect(() => {
    if (sessions.length === 0) return;
    hanaFetch('/api/browser/sessions')
      .then(r => r.json())
      .then(data => setBrowserSessions(data || {}))
      .catch(err => console.warn('[sessions] fetch browser sessions failed:', err));
  }, [sessions, browserBySession]);

  if (sessions.length === 0) {
    return <div className={styles.sessionEmpty}>{t('sidebar.empty')}</div>;
  }

  const sections = buildSessionSections(sessions, { mode: 'time' });

  return (
    <>
      {sections.map(section => {
        const items = section.items.map(s => (
          <SessionItem
            key={s.path}
            session={s}
            isActive={!pendingNewSession && s.path === currentSessionPath}
            isStreaming={streamingSessions.includes(s.path)}
            isPinned={!!s.pinnedAt}
            agents={agents}
            browserUrl={browserSessions[s.path] || null}
          />
        ));

        if (section.kind === 'pinned') {
          return (
            <section key={section.id} className={styles.pinnedSection}>
              <div className={`${styles.sessionSectionTitle} ${styles.pinnedSectionTitle}`}>
                <span>{t(section.titleKey)}</span>
                <svg className={styles.pinnedTitleIcon} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 17v5" />
                  <path d="M5 17h14" />
                  <path d="M7 3h10l-2 9H9L7 3z" />
                  <path d="M9 12l-2 5h10l-2-5" />
                </svg>
              </div>
              {items}
            </section>
          );
        }

        return (
          <Fragment key={section.id}>
            <div className={styles.sessionSectionTitle}>{t(section.titleKey)}</div>
            {items}
          </Fragment>
        );
      })}
    </>
  );
}

// ── Session Item ──

const SessionItem = memo(function SessionItem({ session: s, isActive, isStreaming, isPinned, agents, browserUrl }: {
  session: Session;
  isActive: boolean;
  isStreaming: boolean;
  isPinned: boolean;
  agents: Agent[];
  browserUrl: string | null;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(() => {
    if (editing) return;
    switchSession(s.path);
  }, [s.path, editing]);

  const handleArchive = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    archiveSession(s.path);
  }, [s.path]);

  const handlePin = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    pinSession(s.path, !isPinned);
  }, [s.path, isPinned]);

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(s.title || s.firstMessage || '');
    setEditing(true);
  }, [s.title, s.firstMessage]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    setEditing(false);
    if (trimmed && trimmed !== (s.title || s.firstMessage || '')) {
      renameSession(s.path, trimmed);
    }
  }, [editValue, s.path, s.title, s.firstMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
    }
  }, [commitRename]);

  // Auto-focus input when editing starts
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Meta line
  const parts: string[] = [];
  if (s.agentName || s.agentId) parts.push(s.agentName || s.agentId!);
  if (s.cwd) {
    const dirName = s.cwd.split('/').filter(Boolean).pop();
    if (dirName) parts.push(dirName);
  }
  if (s.modified) parts.push(formatSessionDate(s.modified));
  const rcLabel = s.rcAttachment ? `${formatRcPlatform(s.rcAttachment.platform)} 接管中` : null;

  return (
    <button
      className={`${styles.sessionItem}${isActive ? ` ${styles.sessionItemActive}` : ''}`}
      data-session-path={s.path}
      onClick={handleClick}
    >
      <div className={styles.sessionItemHeader}>
        {s.agentId && (
          <AgentBadge agentId={s.agentId} agentName={s.agentName} agents={agents} />
        )}
        {isStreaming && <span className={styles.sessionStreamingDot} />}
        {editing ? (
          <input
            ref={inputRef}
            className={styles.sessionRenameInput}
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={commitRename}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <div className={styles.sessionItemTitle} title={s.title || s.firstMessage || t('session.untitled')}>
            {s.title || s.firstMessage || t('session.untitled')}
          </div>
        )}
      </div>

      {!editing && (
        <div className={styles.sessionPinBtn} title={t(isPinned ? 'session.unpin' : 'session.pin')} onClick={handlePin}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 17v5" />
            <path d="M5 17h14" />
            <path d="M7 3h10l-2 9H9L7 3z" />
            <path d="M9 12l-2 5h10l-2-5" />
          </svg>
        </div>
      )}

      {!editing && (
        <div className={styles.sessionRenameBtn} title={t('session.rename')} onClick={startRename}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
          </svg>
        </div>
      )}

      <div className={styles.sessionArchiveBtn} title="Archive" onClick={handleArchive}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="21 8 21 21 3 21 3 8" />
          <rect x="1" y="3" width="22" height="5" />
          <line x1="10" y1="12" x2="14" y2="12" />
        </svg>
      </div>

      <div className={styles.sessionItemMeta}>
        {parts.join(' · ')}
      </div>

      {rcLabel && (
        <div className={styles.sessionRcBadge}>
          {rcLabel}
        </div>
      )}

      {browserUrl && (
        <span className={styles.sessionBrowserBadge} title={browserUrl}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </span>
      )}
    </button>
  );
});

function formatRcPlatform(platform: string) {
  const lower = (platform || '').toLowerCase();
  if (lower === 'tg' || lower === 'telegram') return 'Telegram';
  if (lower === 'feishu' || lower === 'fs') return '飞书';
  if (lower === 'wechat' || lower === 'wx') return '微信';
  if (lower === 'qq') return 'QQ';
  return platform || 'Bridge';
}

// ── Agent Avatar Badge ──

const AgentBadge = memo(function AgentBadge({ agentId, agentName, agents }: {
  agentId: string;
  agentName: string | null;
  agents: Agent[];
}) {
  const agent = agents.find(a => a.id === agentId);
  const [apiUrl] = useState(() =>
    agent?.hasAvatar ? hanaUrl(`/api/agents/${agentId}/avatar?t=${Date.now()}`) : null,
  );
  const [errored, setErrored] = useState(false);

  const src = (!apiUrl || errored) ? yuanFallbackAvatar(agent?.yuan) : apiUrl;

  return (
    <img
      className={styles.sessionAgentBadge}
      src={src}
      title={agentName || agentId}
      draggable={false}
      onError={() => setErrored(true)}
    />
  );
});
