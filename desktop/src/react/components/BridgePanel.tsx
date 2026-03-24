import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { formatSessionDate, parseMoodFromContent } from '../utils/format';
import { renderMarkdown } from '../utils/markdown';
import fp from './FloatingPanels.module.css';

interface BridgeSession {
  sessionKey: string;
  chatId: string;
  displayName?: string;
  avatarUrl?: string;
  lastActive?: number;
}

interface BridgeMessage {
  role: string;
  content: string;
}

interface StatusData {
  telegram?: { status: string; configured?: boolean };
  feishu?: { status: string; configured?: boolean };
  [key: string]: { status: string; configured?: boolean } | undefined;
}

export function BridgePanel() {
  const activePanel = useStore(s => s.activePanel);
  const setActivePanel = useStore(s => s.setActivePanel);

  const [platform, setPlatform] = useState(() => localStorage.getItem('hana_bridge_tab') || 'feishu');
  const [sessions, setSessions] = useState<BridgeSession[]>([]);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [currentName, setCurrentName] = useState('');
  const [messages, setMessages] = useState<BridgeMessage[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [statusData, setStatusData] = useState<StatusData>({});

  const messagesRef = useRef<HTMLDivElement>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentKeyRef = useRef(currentKey);
  currentKeyRef.current = currentKey;

  // 加载状态
  const loadStatus = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/bridge/status');
      const data = await res.json();
      setStatusData(data);
      updateSidebarDot(data);
    } catch {}
  }, []);

  // 加载平台数据
  const loadPlatformData = useCallback(async (plat: string) => {
    try {
      const [statusRes, sessionsRes] = await Promise.all([
        hanaFetch('/api/bridge/status'),
        hanaFetch(`/api/bridge/sessions?platform=${plat}`),
      ]);
      const sData = await statusRes.json();
      const sessData = await sessionsRes.json();
      setStatusData(sData);
      updateSidebarDot(sData);
      setShowOverlay(!sData[plat]?.configured);
      setSessions(sessData.sessions || []);
    } catch (err) {
      console.error('[bridge] load platform data failed:', err);
    }
  }, []);

  // 面板打开时加载数据
  useEffect(() => {
    if (activePanel === 'bridge') {
      loadPlatformData(platform);
      setChatOpen(false);
      setCurrentKey(null);
    }
  }, [activePanel, platform, loadPlatformData]);

  // 订阅 bridge status 变化（代替 window.__hanaBridgeLoadStatus）
  const bridgeStatusTrigger = useStore(s => s.bridgeStatusTrigger);
  useEffect(() => {
    if (bridgeStatusTrigger > 0) loadStatus();
  }, [bridgeStatusTrigger, loadStatus]);

  // 订阅 bridge 消息（代替 window.__hanaBridgeOnMessage）
  const bridgeLatestMessage = useStore(s => s.bridgeLatestMessage);
  useEffect(() => {
    if (!bridgeLatestMessage || activePanel !== 'bridge') return;
    const msg = bridgeLatestMessage;
    // Leading + trailing debounce：第一条消息立即刷新，后续 500ms 内攒着，到期再刷一次
    if (!refreshTimerRef.current) {
      // leading：立即刷新
      loadPlatformData(platform);
    } else {
      clearTimeout(refreshTimerRef.current);
    }
    // trailing：500ms 后再刷一次（捕获期间的变化）
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      loadPlatformData(platform);
    }, 500);
    // 追加到当前会话（用 ref 避免闭包捕获陈旧值）
    if (msg.sessionKey === currentKeyRef.current) {
      const role = msg.direction === 'out' ? 'assistant' : 'user';
      setMessages(prev => [...prev, { role, content: msg.text }]);
      // 自动滚到底
      setTimeout(() => {
        const el = messagesRef.current;
        if (el) {
          const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (wasAtBottom) el.scrollTop = el.scrollHeight;
        }
      }, 0);
    }
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [bridgeLatestMessage, activePanel, platform, loadPlatformData]);

  const switchTab = useCallback((plat: string) => {
    setPlatform(plat);
    setCurrentKey(null);
    setChatOpen(false);
    localStorage.setItem('hana_bridge_tab', plat);
    loadPlatformData(plat);
  }, [loadPlatformData]);

  const openSession = useCallback(async (sessionKey: string, displayName: string) => {
    setCurrentKey(sessionKey);
    setCurrentName(displayName);
    try {
      const res = await hanaFetch(`/api/bridge/sessions/${encodeURIComponent(sessionKey)}/messages`);
      const data = await res.json();
      setMessages(data.messages || []);
      setChatOpen(true);
      setTimeout(() => {
        if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
      }, 0);
    } catch (err) {
      console.error('[bridge] open session failed:', err);
      setChatOpen(false);
    }
  }, []);

  const resetSession = useCallback(async () => {
    if (!currentKey) return;
    try {
      await hanaFetch(`/api/bridge/sessions/${encodeURIComponent(currentKey)}/reset`, { method: 'POST' });
      openSession(currentKey, currentName);
    } catch (err) {
      console.error('[bridge] reset session failed:', err);
    }
  }, [currentKey, currentName, openSession]);

  const close = useCallback(() => setActivePanel(null), [setActivePanel]);

  if (activePanel !== 'bridge') return null;

  const t = window.t ?? ((p: string) => p);
  const tgStatus = statusData.telegram?.status;
  const fsStatus = statusData.feishu?.status;
  const waStatus = statusData.whatsapp?.status;
  const qqStatus = statusData.qq?.status;
  const wxStatus = statusData.wechat?.status;

  return (
    <div className={`${fp.floatingPanel} ${fp.bridgePanelWide}`} id="bridgePanel">
      <div className={fp.floatingPanelInner}>
        <div className={fp.floatingPanelHeader}>
          <div className={fp.bridgeTabs} id="bridgeTabs">
            <button
              className={`${fp.bridgeTab}${platform === 'feishu' ? ` ${fp.bridgeTabActive}` : ''}`}
              onClick={() => switchTab('feishu')}
            >
              <span className={`${fp.bridgeTabDot}${dotClass(fsStatus)}`} />
              <span>{t('settings.bridge.feishu')}</span>
            </button>
            <button
              className={`${fp.bridgeTab}${platform === 'telegram' ? ` ${fp.bridgeTabActive}` : ''}`}
              onClick={() => switchTab('telegram')}
            >
              <span className={`${fp.bridgeTabDot}${dotClass(tgStatus)}`} />
              Telegram
            </button>
            <button
              className={`${fp.bridgeTab}${platform === 'whatsapp' ? ` ${fp.bridgeTabActive}` : ''}`}
              onClick={() => switchTab('whatsapp')}
            >
              <span className={`${fp.bridgeTabDot}${dotClass(waStatus)}`} />
              WhatsApp
            </button>
            <button
              className={`${fp.bridgeTab}${platform === 'qq' ? ` ${fp.bridgeTabActive}` : ''}`}
              onClick={() => switchTab('qq')}
            >
              <span className={`${fp.bridgeTabDot}${dotClass(qqStatus)}`} />
              QQ
            </button>
            <button
              className={`${fp.bridgeTab}${platform === 'wechat' ? ` ${fp.bridgeTabActive}` : ''}`}
              onClick={() => switchTab('wechat')}
            >
              <span className={`${fp.bridgeTabDot}${dotClass(wxStatus)}`} />
              {t('settings.bridge.wechat')}
            </button>
          </div>
          <button className={fp.floatingPanelClose} onClick={close}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className={fp.bridgeBody}>
          {showOverlay && (
            <div className={fp.bridgeOverlay} id="bridgeOverlay">
              <div className={fp.bridgeOverlayContent}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <div className={fp.bridgeOverlayText}>
                  {t('bridge.notConfigured', { platform: platform === 'telegram' ? 'Telegram' : platform === 'whatsapp' ? 'WhatsApp' : platform === 'qq' ? 'QQ' : platform === 'wechat' ? t('settings.bridge.wechat') : t('settings.bridge.feishu') })}
                </div>
                <button className={fp.bridgeOverlayBtn} onClick={() => window.platform.openSettings('bridge')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  <span>{t('bridge.goToSettings')}</span>
                </button>
              </div>
            </div>
          )}
          <div className={fp.bridgeSidebar} id="bridgeSidebar">
            <div className={fp.bridgeContactList} id="bridgeContactList">
              {sessions.length === 0 ? (
                <div className={fp.bridgeContactEmpty}>{t('bridge.noSessions')}</div>
              ) : (
                sessions.map(s => {
                  const name = s.displayName || s.chatId;
                  return (
                    <div
                      key={s.sessionKey}
                      className={`${fp.bridgeContactItem}${s.sessionKey === currentKey ? ` ${fp.bridgeContactItemActive}` : ''}`}
                      onClick={() => openSession(s.sessionKey, name)}
                    >
                      <ContactAvatar name={name} avatarUrl={s.avatarUrl} />
                      <div className={fp.bridgeContactInfo}>
                        <div className={fp.bridgeContactName}>{name}</div>
                        {s.lastActive && (
                          <div className={fp.bridgeContactTime}>
                            {formatSessionDate(new Date(s.lastActive).toISOString())}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
          <div className={fp.bridgeChat} id="bridgeChat">
            {chatOpen ? (
              <>
                <div className={fp.bridgeChatHeader} id="bridgeChatHeader">
                  <span className={fp.bridgeChatHeaderName}>{currentName}</span>
                  <button className={fp.bridgeChatReset} title={t('bridge.resetContext')} onClick={resetSession}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="1 4 1 10 7 10" />
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                    </svg>
                  </button>
                </div>
                <div className={fp.bridgeChatMessages} ref={messagesRef} id="bridgeChatMessages">
                  {messages.length === 0 ? (
                    <div className={fp.bridgeChatNoMsg}>{t('bridge.noMessages')}</div>
                  ) : (
                    messages.map((m, i) => <ChatBubble key={`bridge-msg-${i}`} message={m} />)
                  )}
                </div>
              </>
            ) : (
              <div className={fp.bridgeChatEmpty} id="bridgeChatEmpty">
                <span>{t('bridge.selectChat')}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function dotClass(status?: string): string {
  if (status === 'connected') return ' bridge-dot-ok';
  if (status === 'error') return ' bridge-dot-err';
  return ' bridge-dot-off';
}

function updateSidebarDot(data: Record<string, { status: string } | undefined>) {
  const anyConnected = data.telegram?.status === 'connected' || data.feishu?.status === 'connected' || data.whatsapp?.status === 'connected' || data.qq?.status === 'connected';
  useStore.setState({ bridgeDotConnected: anyConnected });
}

function ContactAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
  const [showImg, setShowImg] = useState(!!avatarUrl);
  return (
    <div className={fp.bridgeContactAvatar}>
      {showImg && avatarUrl ? (
        <img
          className={fp.bridgeContactAvatarImg}
          src={avatarUrl}
          alt={name}
          onError={() => setShowImg(false)}
        />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </div>
  );
}

function ChatBubble({ message: m }: { message: BridgeMessage }) {
  if (m.role === 'assistant') {
    const { text } = parseMoodFromContent(m.content);
    const cleaned = (text || m.content).replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, '');
    return (
      <div className={`${fp.bridgeBubbleRow} ${fp.bridgeBubbleIn}`}>
        <div className={`${fp.bridgeBubble} md-content`} dangerouslySetInnerHTML={{ __html: renderMarkdown(cleaned) }} />
      </div>
    );
  }
  // user: 去掉 [platform 私聊] xxx: 前缀
  let displayText = m.content;
  const prefixMatch = displayText.match(/^\[.+?\]\s*.+?:\s*/);
  if (prefixMatch) displayText = displayText.slice(prefixMatch[0].length);
  return (
    <div className={`${fp.bridgeBubbleRow} ${fp.bridgeBubbleOut}`}>
      <div className={fp.bridgeBubble}>{displayText}</div>
    </div>
  );
}
