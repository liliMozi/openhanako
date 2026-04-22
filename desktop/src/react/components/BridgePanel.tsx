import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { formatSessionDate } from '../utils/format';
import { parseMoodFromContent, moodLabel } from '../utils/message-parser';
import { renderMarkdown } from '../utils/markdown';

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
  const panelClosing = useStore(s => s.panelClosing);
  const setActivePanel = useStore(s => s.setActivePanel);

  const [platform, setPlatform] = useState(() => localStorage.getItem('hana_bridge_tab') || 'feishu');
  const [sessions, setSessions] = useState<BridgeSession[]>([]);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [currentName, setCurrentName] = useState('');
  const [messages, setMessages] = useState<BridgeMessage[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [statusData, setStatusData] = useState<StatusData>({});

  // Streaming state for assistant reply
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingMood, setStreamingMood] = useState<{ yuan: string; text: string } | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  const containerRef = useRef<Element | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentKeyRef = useRef(currentKey);
  currentKeyRef.current = currentKey;
  const streamingContentRef = useRef(streamingContent);
  streamingContentRef.current = streamingContent;

  useEffect(() => {
    containerRef.current = document.querySelector('.main-content');
  }, []);

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
      // 检查平台是否已配置（飞书：任一飞书实例 configured 即可）
      let configured = sData[plat]?.configured;
      if (!configured && sData.instances) {
        configured = Object.entries(sData.instances).some(([id, inst]: [string, any]) =>
          (id === plat || id.startsWith(plat + ':')) && inst?.configured
        );
      }
      setShowOverlay(!configured);
      setSessions(sessData.sessions || []);
    } catch (err) {
      console.error('[bridge] load platform data failed:', err);
    }
  }, []);

  const openSession = useCallback(async (sessionKey: string, displayName: string) => {
    setCurrentKey(sessionKey);
    setCurrentName(displayName);
    setStreamingContent('');
    setStreamingMood(null);
    setIsStreaming(false);
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

  const switchTab = useCallback((plat: string) => {
    setPlatform(plat);
    setCurrentKey(null);
    setChatOpen(false);
    localStorage.setItem('hana_bridge_tab', plat);
    loadPlatformData(plat);
  }, [loadPlatformData]);

  // 面板打开时加载数据
  useEffect(() => {
    if (activePanel === 'bridge') {
      loadPlatformData(platform);
      // 不在这里 reset chatOpen，让 hana-bridge-open-session 事件有机会设置
    }
  }, [activePanel, platform, loadPlatformData]);

  // 监听从 SessionList 点击 bridge session 的事件
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.sessionKey) return;
      const { sessionKey, displayName, platform: plat } = detail;
      if (plat && plat !== platform) {
        setPlatform(plat);
        localStorage.setItem('hana_bridge_tab', plat);
        // 先加载平台数据，再打开会话
        loadPlatformData(plat).then(() => {
          openSession(sessionKey, displayName || sessionKey);
        });
      } else {
        openSession(sessionKey, displayName || sessionKey);
      }
    };
    window.addEventListener('hana-bridge-open-session', handler);
    return () => window.removeEventListener('hana-bridge-open-session', handler);
  }, [platform, loadPlatformData, openSession]);

  // 注册 WS 回调 + streaming 事件监听
  useEffect(() => {
    window.__hanaBridgeLoadStatus = loadStatus;
    window.__hanaBridgeOnMessage = (msg) => {
      if (activePanel !== 'bridge') return;
      // 防抖刷新联系人列表
      if (!refreshTimerRef.current) {
        refreshTimerRef.current = setTimeout(() => {
          refreshTimerRef.current = null;
          loadPlatformData(platform);
        }, 500);
      }
      // 追加到当前会话（用 ref 避免闭包捕获陈旧值）
      if (msg.sessionKey === currentKeyRef.current) {
        const role = msg.direction === 'out' ? 'assistant' : 'user';
        setMessages(prev => [...prev, { role, content: msg.text }]);
        // 完成消息到达，清除 streaming 状态
        if (msg.direction === 'out') {
          setStreamingContent('');
          setStreamingMood(null);
          setIsStreaming(false);
        }
        // 自动滚到底
        setTimeout(() => {
          const el = messagesRef.current;
          if (el) {
            const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (wasAtBottom) el.scrollTop = el.scrollHeight;
          }
        }, 0);
      }
    };

    // Bridge streaming events from hana-bridge-stream
    const streamHandler = (e: Event) => {
      if (activePanel !== 'bridge') return;
      const detail = (e as CustomEvent).detail;
      if (!detail?.sessionKey || detail.sessionKey !== currentKeyRef.current) return;

      switch (detail.type) {
        case 'text_delta':
          setIsStreaming(true);
          setStreamingContent(prev => prev + (detail.delta || ''));
          break;
        case 'thinking_start':
          setIsStreaming(true);
          break;
        case 'thinking_delta':
          break; // thinking not shown in bridge panel
        case 'thinking_end':
          break;
        case 'mood_start':
          setStreamingMood({ yuan: '', text: '' });
          break;
        case 'mood_text':
          setStreamingMood(prev => prev ? { ...prev, text: prev.text + (detail.delta || '') } : null);
          break;
        case 'mood_end':
          setStreamingMood(prev => prev ? { ...prev, yuan: prev.yuan || 'hanako' } : null);
          break;
      }

      // 自动滚到底
      setTimeout(() => {
        const el = messagesRef.current;
        if (el) {
          const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (wasAtBottom) el.scrollTop = el.scrollHeight;
        }
      }, 0);
    };
    window.addEventListener('hana-bridge-stream', streamHandler);

    return () => {
      delete window.__hanaBridgeLoadStatus;
      delete window.__hanaBridgeOnMessage;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      window.removeEventListener('hana-bridge-stream', streamHandler);
    };
  }, [activePanel, platform, loadStatus, loadPlatformData]);

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

  if (activePanel !== 'bridge' || !containerRef.current) return null;

  const t = window.t ?? ((p: string) => p);
  const tgStatus = statusData.telegram?.status;
  // 飞书状态：取所有飞书实例中最好的状态（任一 connected 即为 connected）
  const instances = (statusData as any)?.instances || {};
  const fsConnected = Object.entries(instances).some(([id, inst]: [string, any]) =>
    (id === 'feishu' || id.startsWith('feishu:')) && inst?.status === 'connected'
  );
  const fsStatus = fsConnected ? 'connected' : (statusData.feishu?.status || undefined);
  const waStatus = statusData.whatsapp?.status;
  const qqStatus = statusData.qq?.status;

  return createPortal(
    <div className={`floating-panel bridge-panel-wide${panelClosing ? ' closing' : ''}`} id="bridgePanel">
      <div className="floating-panel-inner">
        <div className="floating-panel-header">
          <div className="bridge-tabs" id="bridgeTabs">
            <button
              className={'bridge-tab' + (platform === 'feishu' ? ' active' : '')}
              onClick={() => switchTab('feishu')}
            >
              <span className={'bridge-tab-dot' + dotClass(fsStatus)} />
              <span>{t('settings.bridge.feishu') || '飞书'}</span>
            </button>
            <button
              className={'bridge-tab' + (platform === 'telegram' ? ' active' : '')}
              onClick={() => switchTab('telegram')}
            >
              <span className={'bridge-tab-dot' + dotClass(tgStatus)} />
              Telegram
            </button>
            <button
              className={'bridge-tab' + (platform === 'whatsapp' ? ' active' : '')}
              onClick={() => switchTab('whatsapp')}
            >
              <span className={'bridge-tab-dot' + dotClass(waStatus)} />
              WhatsApp
            </button>
            <button
              className={'bridge-tab' + (platform === 'qq' ? ' active' : '')}
              onClick={() => switchTab('qq')}
            >
              <span className={'bridge-tab-dot' + dotClass(qqStatus)} />
              QQ
            </button>
          </div>
          <button className="floating-panel-close" onClick={close}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="bridge-body">
          {showOverlay && (
            <div className="bridge-overlay" id="bridgeOverlay">
              <div className="bridge-overlay-content">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <div className="bridge-overlay-text">
                  {t('bridge.notConfigured', { platform: platform === 'telegram' ? 'Telegram' : platform === 'whatsapp' ? 'WhatsApp' : platform === 'qq' ? 'QQ' : (t('settings.bridge.feishu') || '飞书') })}
                </div>
                <button className="bridge-overlay-btn" onClick={() => window.platform.openSettings('bridge')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  <span>{t('bridge.goToSettings') || '前往设置'}</span>
                </button>
              </div>
            </div>
          )}
          <div className="bridge-sidebar" id="bridgeSidebar">
            <div className="bridge-contact-list" id="bridgeContactList">
              {sessions.length === 0 ? (
                <div className="bridge-contact-empty">{t('bridge.noSessions') || '暂无会话'}</div>
              ) : (
                sessions.map(s => {
                  const name = s.displayName || s.chatId;
                  return (
                    <div
                      key={s.sessionKey}
                      className={'bridge-contact-item' + (s.sessionKey === currentKey ? ' active' : '')}
                      onClick={() => openSession(s.sessionKey, name)}
                    >
                      <ContactAvatar name={name} avatarUrl={s.avatarUrl} />
                      <div className="bridge-contact-info">
                        <div className="bridge-contact-name">{name}</div>
                        {s.lastActive && (
                          <div className="bridge-contact-time">
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
          <div className="bridge-chat" id="bridgeChat">
            {chatOpen ? (
              <>
                <div className="bridge-chat-header" id="bridgeChatHeader">
                  <span className="bridge-chat-header-name">{currentName}</span>
                  <button className="bridge-chat-reset" title={t('bridge.resetContext')} onClick={resetSession}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="1 4 1 10 7 10" />
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                    </svg>
                  </button>
                </div>
                <div className="bridge-chat-messages" ref={messagesRef} id="bridgeChatMessages">
                  {messages.length === 0 && !isStreaming ? (
                    <div className="bridge-chat-no-msg">{t('bridge.noMessages') || '暂无消息'}</div>
                  ) : (
                    <>
                      {messages.map((m, i) => <ChatBubble key={i} message={m} />)}
                      {isStreaming && <StreamingBubble content={streamingContent} mood={streamingMood} />}
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="bridge-chat-empty" id="bridgeChatEmpty">
                <span>{t('bridge.selectChat') || '选择一个对话'}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    containerRef.current,
  );
}

function dotClass(status?: string): string {
  if (status === 'connected') return ' bridge-dot-ok';
  if (status === 'error') return ' bridge-dot-err';
  return ' bridge-dot-off';
}

function updateSidebarDot(data: Record<string, { status: string } | undefined> & { instances?: Record<string, { status: string }> }) {
  const dot = document.getElementById('bridgeDot');
  if (!dot) return;
  // 检查顶层兼容字段和所有 instances
  let anyConnected = data.telegram?.status === 'connected' || data.feishu?.status === 'connected' || data.whatsapp?.status === 'connected' || data.qq?.status === 'connected';
  if (!anyConnected && data.instances) {
    anyConnected = Object.values(data.instances).some(i => i?.status === 'connected');
  }
  dot.classList.toggle('connected', anyConnected);
}

function ContactAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
  const [showImg, setShowImg] = useState(!!avatarUrl);
  return (
    <div className="bridge-contact-avatar">
      {showImg && avatarUrl ? (
        <img
          className="bridge-contact-avatar-img"
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

function StreamingBubble({ content, mood }: { content: string; mood: { yuan: string; text: string } | null }) {
  let cleaned = content.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, '');
  // Strip complete mood/pulse/reflect tags (already rendered via MoodWidget)
  cleaned = cleaned.replace(/<(mood|pulse|reflect)>[\s\S]*?<\/\1>\s*/gi, '');
  // Strip partial open tags that haven't closed yet during streaming
  cleaned = cleaned.replace(/<(mood|pulse|reflect)>[\s\S]*$/gi, '');
  // Strip orphan close tags
  cleaned = cleaned.replace(/<\/(mood|pulse|reflect)>\s*/gi, '');
  return (
    <div className="bridge-bubble-row bridge-bubble-in">
      {mood?.text && (
        <MoodWidget yuan={mood.yuan || 'hanako'} text={mood.text} />
      )}
      <div className="bridge-bubble bridge-bubble-streaming" dangerouslySetInnerHTML={{ __html: renderMarkdown(cleaned || '\u00a0') }} />
    </div>
  );
}

function MoodWidget({ yuan, text }: { yuan: string; text: string }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen(v => !v), []);
  return (
    <div className="mood-wrapper" data-yuan={yuan}>
      <div className="mood-summary" onClick={toggle}>
        <span className={`mood-arrow${open ? ' mood-arrow-open' : ''}`}>›</span>
        {' '}{moodLabel(yuan)}
      </div>
      {open && <div className="mood-block">{text}</div>}
    </div>
  );
}

function ChatBubble({ message: m }: { message: BridgeMessage }) {
  if (m.role === 'assistant') {
    const { mood, yuan, text } = parseMoodFromContent(m.content);
    let cleaned = text.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, '');
    // 安全网：如果 parseMoodFromContent 没完全清理，再剥一次
    cleaned = cleaned.replace(/<(mood|pulse|reflect)>[\s\S]*?<\/\1>\s*/gi, '');
    if (!mood || !yuan) {
      console.warn('[bridge] mood parse failed', { content: m.content.slice(0, 200) });
    }
    return (
      <div className="bridge-bubble-row bridge-bubble-in">
        {mood && yuan && <MoodWidget yuan={yuan} text={mood} />}
        <div className="bridge-bubble" dangerouslySetInnerHTML={{ __html: renderMarkdown(cleaned) }} />
      </div>
    );
  }
  // user: 直接显示原始内容
  return (
    <div className="bridge-bubble-row bridge-bubble-out">
      <div className="bridge-bubble">{m.content}</div>
    </div>
  );
}
