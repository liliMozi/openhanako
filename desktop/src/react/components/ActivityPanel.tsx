import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../stores';
import { usePanel } from '../hooks/use-panel';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { fetchConfig, invalidateConfigCache } from '../hooks/use-config';
import { loadSessions, switchSession } from '../stores/session-actions';
import { formatSessionDate, injectCopyButtons, parseMoodFromContent } from '../utils/format';
import { yuanFallbackAvatar } from '../utils/agent-helpers';
import { getMd } from '../utils/markdown';
import fp from './FloatingPanels.module.css';
import chatStyles from './chat/Chat.module.css';

// ── 稳定头像时间戳（避免每次渲染生成新 URL） ──
let _avatarTs = Date.now();

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
  activityId: string;
  title: string;
  agentId: string;
  agentName: string;
  messages: DetailMessage[];
}

const FLEX_COLUMN_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 };
const CURSOR_POINTER_STYLE: React.CSSProperties = { cursor: 'pointer' };
const DANGER_COLOR_STYLE: React.CSSProperties = { color: 'var(--danger)' };

export function ActivityPanel() {
  const activities = useStore(s => s.activities) as ActivityItem[];
  const agents = useStore(s => s.agents);
  const currentAgentId = useStore(s => s.currentAgentId);
  const agentName = useStore(s => s.agentName);
  const setActivities = useStore(s => s.setActivities);

  const [detail, setDetail] = useState<DetailState | null>(null);
  const [hbEnabled, setHbEnabled] = useState(true);
  const t = window.t ?? ((p: string) => p);

  const loadData = useCallback(() => {
    hanaFetch('/api/desk/activities')
      .then(r => r.json())
      .then(data => setActivities(data.activities || []))
      .catch(err => console.warn('[activity] fetch activities failed:', err));
    fetchConfig()
      .then(data => setHbEnabled(data.desk?.heartbeat_master !== false))
      .catch(err => console.warn('[activity] fetch config failed:', err));
    setDetail(null);
  }, [setActivities]);

  const { visible, close: closePanel } = usePanel('activity', loadData, [currentAgentId]);
  const close = useCallback(() => { closePanel(); setDetail(null); }, [closePanel]);

  const toggleHeartbeat = useCallback(async () => {
    const next = !hbEnabled;
    setHbEnabled(next);
    try {
      await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desk: { heartbeat_master: next } }),
      });
      invalidateConfigCache();
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
        : activity.type === 'subagent' ? t('activity.subagent')
        : (activity.label || t('activity.cron'));
      const timeStr = activity.startedAt
        ? formatSessionDate(new Date(activity.startedAt).toISOString())
        : '';
      setDetail({
        activityId,
        title: `${typeText}  ${timeStr}`,
        agentId: activity.agentId || currentAgentId || '',
        agentName: activity.agentName || agentName,
        messages: messages || [],
      });
    } catch {}
  }, []);

  const closeDetail = useCallback(() => setDetail(null), []);

  const promoteActivity = useCallback(async (activityId: string) => {
    try {
      const res = await hanaFetch(`/api/desk/activities/${activityId}/promote`, { method: 'POST' });
      const data = await res.json();
      if (data.error || !data.sessionPath) return;
      await loadSessions();
      await switchSession(data.sessionPath);
    } catch (err) {
      console.error('[activity] promote failed:', err);
    }
  }, []);

  if (!visible) return null;

  return (
    <div className={fp.floatingPanel} id="activityPanel">
      <div className={fp.floatingPanelInner}>
        {detail ? (
          // 详情视图
          <div id="activityDetailView" style={FLEX_COLUMN_STYLE}>
            <div className={fp.floatingPanelHeader}>
              <button className={fp.floatingPanelBack} onClick={closeDetail}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
              <DetailHeader detail={detail} />
              <button
                className={fp.actPromoteBtn}
                onClick={() => promoteActivity(detail.activityId)}
                title={t('activity.promote')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="17 11 12 6 7 11" />
                  <line x1="12" y1="6" x2="12" y2="18" />
                </svg>
                <span>{t('activity.promote')}</span>
              </button>
              <button className={fp.floatingPanelClose} onClick={close}>
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
          <div id="activityListView" style={FLEX_COLUMN_STYLE}>
            <div className={fp.floatingPanelHeader}>
              <h2 className={fp.floatingPanelTitle}>{t('activity.title')}</h2>
              <div className={fp.activityHbToggle}>
                <span className="hana-toggle-label">{t('activity.heartbeat')}</span>
                <button
                  className={'hana-toggle' + (hbEnabled ? ' on' : '')}
                  onClick={toggleHeartbeat}
                />
              </div>
              <button className={fp.floatingPanelClose} onClick={close}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className={fp.floatingPanelBody}>
              <div className={fp.activityCards} id="activityCards">
                {activities.length === 0 ? (
                  <div className={fp.activityEmpty}>{t('activity.empty')}</div>
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
  agents: { id: string; yuan: string; hasAvatar?: boolean }[];
  currentAgentId: string | null;
  agentName: string;
  onOpen: (id: string) => void;
}) {
  const agentId = a.agentId || currentAgentId;
  const ag = agents.find(x => x.id === agentId);
  const avatarSrc = ag?.hasAvatar
    ? hanaUrl(`/api/agents/${agentId}/avatar?t=${_avatarTs}`)
    : yuanFallbackAvatar(ag?.yuan);

  const t = window.t ?? ((p: string) => p);
  const typeText = a.type === 'heartbeat' ? t('activity.heartbeat')
    : a.type === 'subagent' ? t('activity.subagent')
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
      className={`${fp.actCard}${a.status === 'error' ? ` ${fp.actCardError}` : ''}`}
      style={a.sessionFile ? CURSOR_POINTER_STYLE : undefined}
      onClick={a.sessionFile ? () => onOpen(a.id) : undefined}
    >
      <div className={fp.actCardHead}>
        <img
          className={fp.actCardAvatar}
          src={avatarSrc}
          onError={e => { (e.target as HTMLImageElement).onerror = null; (e.target as HTMLImageElement).src = yuanFallbackAvatar(ag?.yuan); }}
          draggable={false}
        />
        <span className={fp.actCardAgentName}>{a.agentName || agentName}</span>
        <span className={fp.actCardBadge}>{typeText}</span>
        <span className={fp.actCardTime}>
          {a.startedAt ? formatSessionDate(new Date(a.startedAt).toISOString()) : ''}
        </span>
      </div>
      <div className={fp.actCardSummary}>
        {a.summary || (a.type === 'heartbeat' ? t('activity.patrolDone') : t('activity.cronDone'))}
      </div>
      <div className={fp.actCardMeta}>
        {durationText && <span className={fp.actCardDuration}>{durationText}</span>}
        {a.status === 'error' && <span style={DANGER_COLOR_STYLE}>{t('activity.error')}</span>}
        {a.sessionFile && <span className={fp.actCardViewHint}>{t('activity.viewSession')}</span>}
      </div>
    </div>
  );
}

function DetailHeader({ detail }: { detail: DetailState }) {
  const agents = useStore(s => s.agents);
  const ag = agents.find(x => x.id === detail.agentId);
  const avatarSrc = ag?.hasAvatar
    ? hanaUrl(`/api/agents/${detail.agentId}/avatar?t=${_avatarTs}`)
    : yuanFallbackAvatar(ag?.yuan);

  return (
    <div className={fp.detailHeaderInfo}>
      <img
        className={fp.detailHeaderAvatar}
        src={avatarSrc}
        onError={e => { (e.target as HTMLImageElement).onerror = null; (e.target as HTMLImageElement).src = yuanFallbackAvatar(ag?.yuan); }}
        draggable={false}
      />
      <div className={fp.detailHeaderText}>
        <span className={fp.detailHeaderName}>{detail.agentName}</span>
        <span className={fp.detailHeaderSubtitle}>{detail.title}</span>
      </div>
    </div>
  );
}

function DetailBody({ messages }: { messages: DetailMessage[] }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const t = window.t ?? ((p: string) => p);
  const mdInstance = getMd();

  useEffect(() => {
    if (bodyRef.current) {
      injectCopyButtons(bodyRef.current);
    }
  }, [messages]);

  return (
    <div className={fp.floatingPanelBody} ref={bodyRef}>
      {messages.map((m, i) => {
        if (m.role === 'assistant') {
          const { mood, text } = parseMoodFromContent(m.content);
          return (
            <div key={`msg-${i}`} className={`${fp.activityDetailMsg} ${fp.activityDetailMsgAssistant}`}>
              <div className={fp.activityDetailBubble}>
                {mood && (
                  <details className={chatStyles.moodWrapper}>
                    <summary className={chatStyles.moodSummary}>{t('mood.label')}</summary>
                    <div className={chatStyles.moodBlock}>{mood}</div>
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
          <div key={`msg-${i}`} className={`${fp.activityDetailMsg} ${fp.activityDetailMsgUser}`}>
            <div className={fp.activityDetailBubble}>{m.content}</div>
          </div>
        );
      })}
    </div>
  );
}
