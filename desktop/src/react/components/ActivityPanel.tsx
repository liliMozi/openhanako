import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../stores';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { formatSessionDate, injectCopyButtons, parseMoodFromContent } from '../utils/format';

interface ActivityItem {
  id: string;
  type: string;
  summary?: string;
  label?: string;
  status?: string;
  agentId?: string;
  agentName?: string;
  sessionFile?: string;
  startedAt?: number;
  finishedAt?: number;
}

interface DetailMessage {
  role: string;
  content: string;
}

interface DetailState {
  title: string;
  messages: DetailMessage[];
}

function yuanFallbackAvatar(yuan?: string): string {
  const t = window.t ?? ((p: string) => p);
  const types = t('yuan.types') as unknown;
  if (types && typeof types === 'object') {
    const entry = (types as Record<string, { avatar?: string }>)[yuan || 'hanako'];
    return `assets/${entry?.avatar || 'Hanako.png'}`;
  }
  return 'assets/Hanako.png';
}

export function ActivityPanel() {
  const activePanel = useStore(s => s.activePanel);
  const panelClosing = useStore(s => s.panelClosing);
  const activities = useStore(s => s.activities) as ActivityItem[];
  const agents = useStore(s => s.agents);
  const currentAgentId = useStore(s => s.currentAgentId);
  const agentName = useStore(s => s.agentName);
  const setActivities = useStore(s => s.setActivities);

  const [detail, setDetail] = useState<DetailState | null>(null);
  const [hbEnabled, setHbEnabled] = useState(true);
  const t = window.t ?? ((p: string) => p);

  // 打开面板时加载活动 + 巡检状态
  useEffect(() => {
    if (activePanel === 'activity') {
      hanaFetch('/api/desk/activities')
        .then(r => r.json())
        .then(data => setActivities(data.activities || []))
        .catch(() => {});
      hanaFetch('/api/config')
        .then(r => r.json())
        .then(data => setHbEnabled(data.desk?.heartbeat_enabled !== false))
        .catch(() => {});
      setDetail(null);
    }
  }, [activePanel, setActivities]);

  const toggleHeartbeat = useCallback(async () => {
    const next = !hbEnabled;
    setHbEnabled(next);
    try {
      await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desk: { heartbeat_enabled: next } }),
      });
    } catch {
      setHbEnabled(!next); // rollback
    }
  }, [hbEnabled]);

  const openSession = useCallback(async (activityId: string) => {
    try {
      const res = await hanaFetch(`/api/desk/activities/${activityId}/session`);
      const data = await res.json();
      if (data.error) return;

      const { activity, messages } = data;
      const typeText = activity.type === 'heartbeat' ? t('activity.heartbeat')
        : activity.type === 'delegate' ? t('activity.delegate')
        : (activity.label || t('activity.cron'));
      const timeStr = activity.startedAt
        ? formatSessionDate(new Date(activity.startedAt).toISOString())
        : '';
      setDetail({
        title: `${activity.agentName} · ${typeText}  ${timeStr}`,
        messages: messages || [],
      });
    } catch {}
  }, []);

  const closeDetail = useCallback(() => setDetail(null), []);
  const close = useCallback(() => {
    useStore.getState().setActivePanel(null);
    setDetail(null);
  }, []);

  if (activePanel !== 'activity') return null;

  return (
    <div className={`floating-panel${panelClosing ? ' closing' : ''}`} id="activityPanel">
      <div className="floating-panel-inner">
        {detail ? (
          // 详情视图
          <div id="activityDetailView">
            <div className="floating-panel-header">
              <button className="floating-panel-back" onClick={closeDetail}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
                <span>{t('activity.back')}</span>
              </button>
              <span className="floating-panel-subtitle">{detail.title}</span>
              <button className="floating-panel-close" onClick={close}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <DetailBody messages={detail.messages} />
          </div>
        ) : (
          // 列表视图
          <div id="activityListView">
            <div className="floating-panel-header">
              <h2 className="floating-panel-title">{t('activity.title')}</h2>
              <div className="activity-hb-toggle">
                <span className="hana-toggle-label">{t('activity.heartbeat')}</span>
                <button
                  className={'hana-toggle' + (hbEnabled ? ' on' : '')}
                  onClick={toggleHeartbeat}
                />
              </div>
              <button className="floating-panel-close" onClick={close}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="floating-panel-body">
              <div className="activity-cards" id="activityCards">
                {activities.length === 0 ? (
                  <div className="activity-empty">{t('activity.empty')}</div>
                ) : (
                  activities.map(a => (
                    <ActivityCard
                      key={a.id}
                      activity={a}
                      agents={agents}
                      currentAgentId={currentAgentId}
                      agentName={agentName}
                      onOpen={openSession}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityCard({
  activity: a,
  agents,
  currentAgentId,
  agentName,
  onOpen,
}: {
  activity: ActivityItem;
  agents: { id: string; yuan: string }[];
  currentAgentId: string | null;
  agentName: string;
  onOpen: (id: string) => void;
}) {
  const agentId = a.agentId || currentAgentId;
  const avatarSrc = hanaUrl(`/api/agents/${agentId}/avatar?t=${Date.now()}`);
  const ag = agents.find(x => x.id === agentId);

  const t = window.t ?? ((p: string) => p);
  const typeText = a.type === 'heartbeat' ? t('activity.heartbeat')
    : a.type === 'delegate' ? t('activity.delegate')
    : (a.label || t('activity.cron'));

  let durationText = '';
  if (a.finishedAt && a.startedAt) {
    const seconds = Math.round((a.finishedAt - a.startedAt) / 1000);
    const text = seconds >= 60
      ? `${Math.floor(seconds / 60)}m${seconds % 60}s`
      : `${seconds}s`;
    durationText = t('activity.duration', { text });
  }

  return (
    <div
      className={'act-card' + (a.status === 'error' ? ' error' : '')}
      style={a.sessionFile ? { cursor: 'pointer' } : undefined}
      onClick={a.sessionFile ? () => onOpen(a.id) : undefined}
    >
      <div className="act-card-head">
        <img
          className="act-card-avatar"
          src={avatarSrc}
          onError={e => { (e.target as HTMLImageElement).onerror = null; (e.target as HTMLImageElement).src = yuanFallbackAvatar(ag?.yuan); }}
          draggable={false}
        />
        <span className="act-card-agent-name">{a.agentName || agentName}</span>
        <span className="act-card-badge">{typeText}</span>
        <span className="act-card-time">
          {a.startedAt ? formatSessionDate(new Date(a.startedAt).toISOString()) : ''}
        </span>
      </div>
      <div className="act-card-summary">
        {a.summary || (a.type === 'heartbeat' ? t('activity.patrolDone') : t('activity.cronDone'))}
      </div>
      <div className="act-card-meta">
        {durationText && <span className="act-card-duration">{durationText}</span>}
        {a.status === 'error' && <span style={{ color: 'var(--danger)' }}>{t('activity.error')}</span>}
        {a.sessionFile && <span className="act-card-view-hint">{t('activity.viewSession')}</span>}
      </div>
    </div>
  );
}

function DetailBody({ messages }: { messages: DetailMessage[] }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const t = window.t ?? ((p: string) => p);
  const md = (window as unknown as Record<string, unknown>).markdownit as ((opts: Record<string, boolean>) => { render: (s: string) => string }) | undefined;
  const mdInstance = md?.({ html: false, breaks: true, linkify: true, typographer: true });

  useEffect(() => {
    if (bodyRef.current) {
      injectCopyButtons(bodyRef.current);
    }
  }, [messages]);

  return (
    <div className="floating-panel-body" ref={bodyRef}>
      {messages.map((m, i) => {
        if (m.role === 'assistant') {
          const { mood, text } = parseMoodFromContent(m.content);
          return (
            <div key={i} className="activity-detail-msg assistant">
              <div className="activity-detail-bubble">
                {mood && (
                  <details className="mood-wrapper">
                    <summary className="mood-summary">{t('mood.label')}</summary>
                    <div className="mood-block">{mood}</div>
                  </details>
                )}
                {text && (
                  <div
                    className="md-content"
                    dangerouslySetInnerHTML={{
                      __html: mdInstance
                        ? mdInstance.render(text.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, ''))
                        : text,
                    }}
                  />
                )}
              </div>
            </div>
          );
        }
        return (
          <div key={i} className="activity-detail-msg user">
            <div className="activity-detail-bubble">{m.content}</div>
          </div>
        );
      })}
    </div>
  );
}
