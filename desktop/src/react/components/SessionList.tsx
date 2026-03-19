/**
 * SessionList — 侧边栏 session 列表 React 组件
 *
 * Phase 6B: 替代 sidebar-shim.ts 中的 renderSessionList / createSessionItem。
 * 通过 portal 渲染到 #sessionList，从 Zustand sessions 状态驱动。
 */

import { Fragment, useCallback, useEffect, useState } from 'react';
import { useStore } from '../stores';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { formatSessionDate } from '../utils/format';
import { switchSession, archiveSession } from '../stores/session-actions';
import type { Session, Agent } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

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

// ── Yuan fallback ──

function yuanFallbackAvatar(yuan?: string): string {
  const t = window.t ?? ((p: string) => p);
  const types = t('yuan.types') as unknown;
  if (types && typeof types === 'object') {
    const entry = (types as Record<string, { avatar?: string }>)[yuan || 'hanako'];
    return `assets/${entry?.avatar || 'Hanako.png'}`;
  }
  return 'assets/Hanako.png';
}

// ── 内部组件 ──

function SessionListInner() {
  const { t } = useI18n();
  const sessions = useStore(s => s.sessions);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const agents = useStore(s => s.agents);
  const streamingSessions = useStore(s => s.streamingSessions);

  const [browserSessions, setBrowserSessions] = useState<Record<string, string>>({});

  // Fetch browser sessions
  useEffect(() => {
    if (sessions.length === 0) return;
    hanaFetch('/api/browser/sessions')
      .then(r => r.json())
      .then(data => setBrowserSessions(data || {}))
      .catch(() => {});
  }, [sessions]);

  if (sessions.length === 0) {
    return <div className="session-empty">{t('sidebar.empty')}</div>;
  }

  const grouped = groupSessionsByDate(sessions);

  return (
    <>
      {grouped.map(({ key, items }) => (
        <Fragment key={key}>
          <div className="session-date-label">{t(`time.${key}`)}</div>
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

// ── Session Item ──

function SessionItem({ session: s, isActive, isStreaming, agents, browserUrl }: {
  session: Session;
  isActive: boolean;
  isStreaming: boolean;
  agents: Agent[];
  browserUrl: string | null;
}) {
  const { t } = useI18n();

  const handleClick = useCallback(() => {
    switchSession(s.path);
  }, [s.path]);

  const handleArchive = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    archiveSession(s.path);
  }, [s.path]);

  // Meta line
  const parts: string[] = [];
  if (s.agentName || s.agentId) parts.push(s.agentName || s.agentId!);
  if (s.cwd) {
    const dirName = s.cwd.split('/').filter(Boolean).pop();
    if (dirName) parts.push(dirName);
  }
  if (s.modified) parts.push(formatSessionDate(s.modified));

  return (
    <button
      className={'session-item' + (isActive ? ' active' : '')}
      data-session-path={s.path}
      onClick={handleClick}
    >
      <div className="session-item-header">
        {s.agentId && (
          <AgentBadge agentId={s.agentId} agentName={s.agentName} agents={agents} />
        )}
        {isStreaming && <span className="session-streaming-dot" />}
        <div className="session-item-title">
          {s.title || s.firstMessage || t('session.untitled')}
        </div>
      </div>

      <div className="session-archive-btn" title="Archive" onClick={handleArchive}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="21 8 21 21 3 21 3 8" />
          <rect x="1" y="3" width="22" height="5" />
          <line x1="10" y1="12" x2="14" y2="12" />
        </svg>
      </div>

      <div className="session-item-meta">
        {parts.join(' · ')}
      </div>

      {browserUrl && (
        <span className="session-browser-badge" title={browserUrl}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </span>
      )}
    </button>
  );
}

// ── Agent Avatar Badge ──

function AgentBadge({ agentId, agentName, agents }: {
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
      className="session-agent-badge"
      src={src}
      title={agentName || agentId}
      draggable={false}
      onError={() => setErrored(true)}
    />
  );
}
