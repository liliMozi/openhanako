/**
 * SessionList — 侧边栏 session 列表 React 组件
 *
 * Phase 6B: 替代 sidebar-shim.ts 中的 renderSessionList / createSessionItem。
 * 通过 portal 渲染到 #sessionList，从 Zustand sessions 状态驱动。
 */

import { Fragment, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../stores';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { formatSessionDate } from '../utils/format';
import type { Session, Agent } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── 主组件 ──

export function SessionList() {
  const portalTarget = document.getElementById('sessionList');
  if (!portalTarget) {
    console.warn('[SessionList] portal target #sessionList not found');
    return null;
  }
  return createPortal(<SessionListInner />, portalTarget);
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
};

const PLATFORM_COLORS: Record<string, string> = {
  feishu: '#3370ff',
  telegram: '#2AABEE',
  qq: '#12B7F5',
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

function SessionItem({ session: s, isActive, agents, browserUrl }: {
  session: Session;
  isActive: boolean;
  agents: Agent[];
  browserUrl: string | null;
}) {
  const { t } = useI18n();
  const setActivePanel = useStore(st => st.setActivePanel);
  const setBridgeSession = useStore(st => st.setBridgeSession);

  const handleClick = useCallback(() => {
    if (s.bridge && s.bridgeSessionKey) {
      // Bridge session: 在主聊天区域加载消息（接管模式）
      // 关闭可能打开的浮动面板
      setActivePanel(null);

      // 设置 bridge session 状态
      setBridgeSession({
        sessionKey: s.bridgeSessionKey,
        platform: s.bridgePlatform || 'feishu',
        displayName: s.bridgeDisplayName || s.title || s.bridgeSessionKey,
        avatarUrl: s.bridgeAvatarUrl,
      });

      // 通知主聊天区域加载 bridge 消息
      window.dispatchEvent(new CustomEvent('hana-bridge-takeover', {
        detail: {
          sessionKey: s.bridgeSessionKey,
          displayName: s.bridgeDisplayName || s.title || s.bridgeSessionKey,
          platform: s.bridgePlatform,
        },
      }));
      return;
    }
    const sidebar = (window as any).HanaModules?.sidebar;
    sidebar?.switchSession(s.path);
  }, [s, setActivePanel, setBridgeSession]);

  const handleArchive = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (s.bridge) return; // bridge session 不支持归档
    const sidebar = (window as any).HanaModules?.sidebar;
    sidebar?.archiveSession(s.path);
  }, [s]);

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
      className={'session-item' + (isActive ? ' active' : '') + (s.bridge ? ' session-item-bridge' : '')}
      data-session-path={s.path}
      onClick={handleClick}
    >
      <div className="session-item-header">
        {s.bridge ? (
          <>
            <BridgeAvatar name={s.bridgeDisplayName || s.title || '?'} avatarUrl={s.bridgeAvatarUrl} />
            <PlatformBadge platform={s.bridgePlatform || ''} chatType={s.bridgeChatType} />
          </>
        ) : s.agentId ? (
          <AgentBadge agentId={s.agentId} agentName={s.agentName} agents={agents} />
        ) : null}
        <div className="session-item-title">
          {s.title || s.firstMessage || t('session.untitled')}
        </div>
      </div>

      {!s.bridge && (
        <div className="session-archive-btn" title="Archive" onClick={handleArchive}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="21 8 21 21 3 21 3 8" />
            <rect x="1" y="3" width="22" height="5" />
            <line x1="10" y1="12" x2="14" y2="12" />
          </svg>
        </div>
      )}

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
  const [src, setSrc] = useState(() =>
    hanaUrl(`/api/agents/${agentId}/avatar?t=${Date.now()}`),
  );

  const handleError = useCallback(() => {
    const agent = agents.find(a => a.id === agentId);
    setSrc(yuanFallbackAvatar(agent?.yuan));
  }, [agentId, agents]);

  return (
    <img
      className="session-agent-badge"
      src={src}
      title={agentName || agentId}
      draggable={false}
      onError={handleError}
    />
  );
}
