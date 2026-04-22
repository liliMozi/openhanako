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
import { switchSession, archiveSession, renameSession } from '../stores/session-actions';
import type { Session, Agent } from '../types';
import { yuanFallbackAvatar } from '../utils/agent-helpers';
import styles from './SessionList.module.css';


// ── 主组件 ──

export function SessionList() {
  return <SessionListInner />;
}

// ── 日期分组 ──

type DateGroup = 'today' | 'yesterday' | 'thisWeek' | 'earlier';

function getSessionDateGroup(isoStr: string | null): DateGroup {
  if (!isoStr) return 'earlier';
  const date = new Date(isoStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);

  if (date >= today) return 'today';
  if (date >= yesterday) return 'yesterday';
  if (date >= weekAgo) return 'thisWeek';
  return 'earlier';
}

interface GroupedSessions {
  key: DateGroup;
  items: Session[];
}

function groupSessionsByDate(sessions: Session[]): GroupedSessions[] {
  const groups: Record<DateGroup, Session[]> = {
    today: [], yesterday: [], thisWeek: [], earlier: [],
  };
  for (const s of sessions) {
    groups[getSessionDateGroup(s.modified)].push(s);
  }
  const order: DateGroup[] = ['today', 'yesterday', 'thisWeek', 'earlier'];
  return order
    .filter(key => groups[key].length > 0)
    .map(key => ({ key, items: groups[key] }));
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

  const grouped = groupSessionsByDate(sessions);

  return (
    <>
      {grouped.map(({ key, items }) => (
        <Fragment key={key}>
          <div className={styles.sessionDateLabel}>{t(`time.${key}`)}</div>
          {items.map(s => (
            <SessionItem
              key={s.path}
              session={s}
              isActive={!pendingNewSession && s.path === currentSessionPath}
              isStreaming={streamingSessions.includes(s.path)}
              agents={agents}
              browserUrl={browserSessions[s.path] || null}
            />
          ))}
        </Fragment>
      ))}
    </>
  );
}

// ── Platform Badge (bridge sessions) ──

const PLATFORM_LABELS: Record<string, string> = {
  feishu: '飞书',
  telegram: 'TG',
  qq: 'QQ',
  wechat: '微信',
  workwechat: '企微',
};

const PLATFORM_COLORS: Record<string, string> = {
  feishu: '#3370ff',
  telegram: '#2AABEE',
  qq: '#12B7F5',
  wechat: '#07C160',
  workwechat: '#4B5563',
};

function PlatformBadge({ platform, chatType }: { platform: string; chatType?: string }) {
  const label = PLATFORM_LABELS[platform] || platform;
  const color = PLATFORM_COLORS[platform] || '#888';
  return (
    <span
      className="session-platform-badge"
      style={{ background: color }}
      title={`${label} ${chatType === 'group' ? '群聊' : '私聊'}`}
    >
      {label}
    </span>
  );
}

// ── Bridge Contact Avatar ──

function BridgeAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string | null }) {
  const [showImg, setShowImg] = useState(!!avatarUrl);
  const initial = (name || '?').slice(0, 1).toUpperCase();

  return (
    <div className="session-agent-badge session-bridge-avatar" title={name}>
      {showImg && avatarUrl ? (
        <img
          src={avatarUrl}
          alt={name}
          draggable={false}
          onError={() => setShowImg(false)}
          style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }}
        />
      ) : (
        <span style={{ fontSize: '11px', fontWeight: 600 }}>{initial}</span>
      )}
    </div>
  );
}

// ── Session Item ──

const SessionItem = memo(function SessionItem({ session: s, isActive, isStreaming, agents, browserUrl }: {
  session: Session;
  isActive: boolean;
  isStreaming: boolean;
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
  if (s.bridge) {
    if (s.bridgeChatType === 'group') parts.push('群聊');
    else parts.push('私聊');
  } else {
    if (s.agentName || s.agentId) parts.push(s.agentName || s.agentId!);
    if (s.cwd) {
      const dirName = s.cwd.split('/').filter(Boolean).pop();
      if (dirName) parts.push(dirName);
    }
    if (s.messageCount) parts.push(t('session.messageCount', { n: s.messageCount }));
  }
  if (s.modified) parts.push(formatSessionDate(s.modified));

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
          <div className={styles.sessionItemTitle}>
            {s.title || s.firstMessage || t('session.untitled')}
          </div>
        )}
      </div>

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
