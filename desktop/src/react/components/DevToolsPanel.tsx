/**
 * DevToolsPanel.tsx — 开发工具面板（嵌入主窗口）
 *
 * 从独立 BrowserWindow 迁移为主窗口浮动面板。
 * 复用主窗口已有的 WS 连接（devlog 事件存储在 Zustand store）。
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import type { DevLogEntry } from '../stores/ui-slice';

declare function t(key: string, vars?: Record<string, string | number>): string;
declare const platform: { reloadMainWindow?(): void } | undefined;

type DevTab = 'logs' | 'activities' | 'prompt';

interface ActivityItem {
  id: string;
  type: string;
  summary?: string;
  status?: string;
  sessionFile?: string;
  startedAt?: number;
  finishedAt?: number;
}

// ── 子组件：日志面板 ──

function LogsTab({ logs }: { logs: DevLogEntry[] }) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (panelRef.current) {
      panelRef.current.scrollTop = panelRef.current.scrollHeight;
    }
  }, [logs.length]);

  return (
    <div className="devtools-log-panel" ref={panelRef}>
      {logs.length === 0 ? (
        <div className="devtools-empty">{t('devtools.waitingConnection')}</div>
      ) : (
        logs.map((entry, i) => (
          <div
            key={i}
            className={`devtools-log-line${
              entry.level === 'heartbeat' || entry.text.includes('[heartbeat]') ? ' heartbeat' :
              entry.level === 'error' ? ' error' :
              entry.level === 'system' ? ' system' : ''
            }`}
          >
            {entry.time}  {entry.text}
          </div>
        ))
      )}
    </div>
  );
}

// ── 子组件：活动列表 ──

function ActivitiesTab() {
  const activities = useStore(s => s.activities) as ActivityItem[];
  const [loaded, setLoaded] = useState(false);
  const setActivities = useStore(s => s.setActivities);

  useEffect(() => {
    if (!loaded) {
      hanaFetch('/api/desk/activities')
        .then(r => r.json())
        .then(data => {
          setActivities(data.activities || []);
          setLoaded(true);
        })
        .catch(() => setLoaded(true));
    }
  }, [loaded, setActivities]);

  if (activities.length === 0) {
    return <div className="devtools-activity-panel"><div className="devtools-empty">{t('devtools.noActivities')}</div></div>;
  }

  return (
    <div className="devtools-activity-panel">
      {activities.map((a, i) => (
        <div key={a.id || i} className={`devtools-act-item${a.status === 'error' ? ' error' : ''}`}>
          <div className="devtools-act-summary">
            {a.type === 'heartbeat' ? '\u2764\uFE0F' : '\u23F0'}{' '}
            {a.summary || (a.type === 'heartbeat' ? t('devtools.heartbeat') : t('devtools.cronLabel'))}
          </div>
          <div className="devtools-act-meta">
            {a.startedAt ? formatTime(a.startedAt) : ''}
            {' · '}
            {a.type === 'heartbeat' ? t('devtools.heartbeatLabel') : t('devtools.cronLabel')}
            {a.finishedAt && a.startedAt ? ` · ${formatDuration(a.finishedAt - a.startedAt)}` : ''}
          </div>
          {a.sessionFile && <div className="devtools-act-file">{a.sessionFile}</div>}
        </div>
      ))}
    </div>
  );
}

// ── 子组件：System Prompt ──

function PromptTab() {
  const [content, setContent] = useState<string | null>(null);
  const [meta, setMeta] = useState('');

  const load = useCallback(() => {
    hanaFetch('/api/system-prompt')
      .then(r => r.json())
      .then(data => {
        const text = data.content || `(${t('devtools.empty')})`;
        setContent(text);
        const chars = text.length;
        const tokens = Math.round(chars / 1.5);
        setMeta(`${chars} ${t('devtools.chars')} ≈ ${tokens} tokens`);
      })
      .catch(e => setContent(`${t('devtools.loadFailed')}: ${e.message}`));
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="devtools-prompt-wrapper">
      <div className="devtools-prompt-meta">
        <span>{meta}</span>
        <button className="devtools-prompt-refresh" onClick={load}>{t('devtools.refreshBtn')}</button>
      </div>
      <div className="devtools-prompt-panel">
        {content === null ? (
          <div className="devtools-empty">{t('devtools.clickRefresh')}</div>
        ) : content}
      </div>
    </div>
  );
}

// ── 主组件 ──

export function DevToolsPanel() {
  const activePanel = useStore(s => s.activePanel);
  const panelClosing = useStore(s => s.panelClosing);
  const devLogs = useStore(s => s.devLogs);
  const [tab, setTab] = useState<DevTab>('logs');
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [hbLoading, setHbLoading] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // 首次打开时加载历史日志
  const logsLoaded = useRef(false);
  useEffect(() => {
    if (activePanel === 'devtools' && !logsLoaded.current) {
      logsLoaded.current = true;
      hanaFetch('/api/desk/logs')
        .then(r => r.json())
        .then(data => {
          if (data.logs?.length) {
            const entries = data.logs.map((e: any) => ({
              level: e.level || 'info',
              text: e.text || '',
              time: new Date().toLocaleTimeString(undefined, { hour12: false }),
            }));
            useStore.setState({ devLogs: entries });
          }
        })
        .catch(() => {});
    }
  }, [activePanel]);

  if (activePanel !== 'devtools' && !panelClosing) return null;
  const isClosing = activePanel !== 'devtools' && panelClosing;

  function showToast(text: string, error = false, ms = 3000) {
    setToast({ text, error });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }

  // ── 按钮 handlers ──

  async function onHeartbeat() {
    setHbLoading(true);
    try {
      const res = await hanaFetch('/api/desk/heartbeat', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        showToast(t('devtools.heartbeatRunning'));
      } else {
        showToast(data.error || t('devtools.triggerFailed'), true);
        setHbLoading(false);
      }
    } catch (e: any) {
      showToast(`${t('devtools.requestFailed')}: ${e.message}`, true);
      setHbLoading(false);
    }
  }

  async function onMemoryExport() {
    try {
      const res = await hanaFetch('/api/memories/export');
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `hanako-memories-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(t('devtools.memoryExported'));
    } catch (e: any) {
      showToast(`${t('devtools.exportFailed')}: ${e.message}`, true);
    }
  }

  async function onOnboarding() {
    try {
      await (window as any).hana?.debugOpenOnboarding?.();
      showToast(t('devtools.onboardingOpened'));
    } catch (e: any) {
      showToast(`${t('devtools.openFailed')}: ${e.message}`, true);
    }
  }

  async function onOnboardingPreview() {
    try {
      await (window as any).hana?.debugOpenOnboardingPreview?.();
      showToast(t('devtools.previewOpened'));
    } catch (e: any) {
      showToast(`${t('devtools.openFailed')}: ${e.message}`, true);
    }
  }

  function onReload() {
    try {
      (window as any).hana?.reloadMainWindow?.();
      showToast(t('devtools.frontendReloaded'));
    } catch (e: any) {
      showToast(`${t('devtools.refreshFailed')}: ${e.message}`, true);
    }
  }

  // 心跳完成时解除 loading
  useEffect(() => {
    if (hbLoading) {
      const unsub = useStore.subscribe((s) => {
        const latest = (s.activities as ActivityItem[])[0];
        if (latest?.type === 'heartbeat' && latest.finishedAt) {
          setHbLoading(false);
          unsub();
        }
      });
      return unsub;
    }
  }, [hbLoading]);

  return (
    <div className={`floating-panel devtools-panel${isClosing ? ' closing' : ''}`}>
      <div className="devtools-inner">
        {/* 按钮区 */}
        <div className="devtools-buttons">
          <button className={`devtools-btn${hbLoading ? ' loading' : ''}`} onClick={onHeartbeat}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            <span>{t('devtools.heartbeat')}</span>
          </button>
          <button className="devtools-btn" onClick={onMemoryExport}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <span>{t('devtools.memoryExport')}</span>
          </button>
          <button className="devtools-btn" onClick={onOnboarding}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
            <span>Onboarding</span>
          </button>
          <button className="devtools-btn" onClick={onOnboardingPreview}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <span>{t('devtools.previewGuide')}</span>
          </button>
          <button className="devtools-btn full-width" onClick={onReload}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            <span>{t('devtools.reloadFrontend')}</span>
          </button>
        </div>

        {/* Toast */}
        {toast && (
          <div className={`devtools-toast${toast.error ? ' error' : ''}`}>{toast.text}</div>
        )}

        {/* Tab 切换 */}
        <div className="devtools-tabs">
          {(['logs', 'activities', 'prompt'] as DevTab[]).map(k => (
            <button
              key={k}
              className={`devtools-tab${tab === k ? ' active' : ''}`}
              onClick={() => setTab(k)}
            >
              {k === 'logs' ? t('devtools.tabLogs') : k === 'activities' ? t('devtools.tabSessions') : t('devtools.tabPrompt')}
            </button>
          ))}
        </div>

        {/* Tab 内容 */}
        <div className="devtools-tab-content">
          {tab === 'logs' && <LogsTab logs={devLogs} />}
          {tab === 'activities' && <ActivitiesTab />}
          {tab === 'prompt' && <PromptTab />}
        </div>
      </div>
    </div>
  );
}

// ── 工具函数 ──

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diffMin = Math.floor((now - ts) / 60000);
  const diffHr = Math.floor((now - ts) / 3600000);
  if (diffMin < 1) return t('devtools.justNow');
  if (diffMin < 60) return t('devtools.minutesAgo', { n: diffMin });
  if (diffHr < 24) return t('devtools.hoursAgo', { n: diffHr });
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  return sec >= 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`;
}
