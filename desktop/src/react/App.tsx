/**
 * App.tsx — React 根组件 + 应用初始化
 *
 * React 渲染完整 DOM 树，不再依赖 index.html 的静态 HTML。
 * 所有初始化逻辑从 app.js / bridge.ts 迁移至此。
 */

import { useEffect } from 'react';
import { useStore } from './stores';
import { hanaFetch } from './hooks/use-hana-fetch';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ActivityPanel } from './components/ActivityPanel';
import { AutomationPanel } from './components/AutomationPanel';
import { BridgePanel } from './components/BridgePanel';
import { PreviewPanel } from './components/PreviewPanel';
import { BrowserCard } from './components/BrowserCard';
import { DeskSection } from './components/DeskSection';
import { InputArea } from './components/InputArea';
import { SessionList } from './components/SessionList';
import { WelcomeScreen } from './components/WelcomeScreen';
import { ChatArea } from './components/chat/ChatArea';
import { ChannelsPanel, ChannelList, ChannelMessages, ChannelMembers, ChannelInput, ChannelReadonly, ChannelCreate } from './components/ChannelsPanel';
import { SidebarLayout, updateLayout } from './components/SidebarLayout';
import { useSidebarResize } from './hooks/use-sidebar-resize';
import { applyAgentIdentity, loadAgents, loadAvatars } from './stores/agent-actions';
import { loadSessions } from './stores/session-actions';
import { connectWebSocket } from './services/websocket';
import { setStatus, loadModels, applyStaticI18n } from './utils/ui-helpers';
import { initJian } from './stores/desk-actions';
import { initEditorEvents } from './stores/artifact-actions';

declare const i18n: {
  locale: string;
  defaultName: string;
  load(locale: string): Promise<void>;
};
declare function t(key: string, vars?: Record<string, string | number>): string;

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── 主题加载（替代 app.js 顶层调用） ──
loadSavedTheme();
loadSavedFont();

// ── 全局 drag 阻止（防止 Electron 默认文件拖入导航） ──
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// ── __hanaLog：前端日志上报 ──
window.__hanaLog = function (level: string, module: string, message: string) {
  const { serverPort } = useStore.getState();
  if (!serverPort) return;
  hanaFetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, module, message }),
  }).catch(() => {});
};

// ── 全局错误捕获 ──
window.addEventListener('error', (e) => {
  window.__hanaLog?.('error', 'desktop', `${e.message} at ${e.filename}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  window.__hanaLog?.('error', 'desktop', `unhandledRejection: ${e.reason}`);
});

// ── 初始化流程 ──

async function init(): Promise<void> {
  const platform = window.platform;

  // 1. 获取 server 连接信息并存入 Zustand
  const serverPort = await platform.getServerPort();
  const serverToken = await platform.getServerToken();
  useStore.setState({ serverPort, serverToken });

  if (!serverPort) {
    setStatus(t('status.serverNotReady'), false);
    platform.appReady();
    return;
  }

  // 2. 并行获取 health + config
  try {
    const [healthRes, configRes] = await Promise.all([
      hanaFetch('/api/health'),
      hanaFetch('/api/config'),
    ]);
    const healthData = await healthRes.json();
    const configData = await configRes.json();

    // 3. 加载 i18n
    await i18n.load(configData.locale || 'zh-CN');

    // 4. 应用 agent 身份
    await applyAgentIdentity({
      agentName: healthData.agent || 'Hanako',
      userName: healthData.user || '用户',
      ui: { avatars: false, agents: false, welcome: true },
    });

    // 5. 设置 desk 相关状态
    useStore.setState({
      homeFolder: configData.desk?.home_folder || null,
      selectedFolder: configData.desk?.home_folder || null,
    });
    if (Array.isArray(configData.cwd_history)) {
      useStore.setState({ cwdHistory: configData.cwd_history });
    }

    // 6. 应用静态 i18n 文本
    applyStaticI18n();

    // 7. 加载头像
    loadAvatars(healthData.avatars);
  } catch (err) {
    console.error('[init] i18n/health/config failed:', err);
  }

  // 8. 连接 WebSocket
  connectWebSocket();

  // 9. 加载模型
  await loadModels();

  // 10. 加载 agents + sessions
  useStore.setState({ pendingNewSession: true });
  await loadAgents();
  await loadSessions();

  // 11. 初始化书桌
  initJian();

  // 12. 初始化拖拽附件
  initDragDrop();

  // 13. 初始化编辑器事件
  initEditorEvents();

  // 13b. 初始 layout 计算
  updateLayout();

  // 14. 浮动面板按钮
  const $ = (sel: string) => document.querySelector(sel);
  const _togglePanel = (panel: string) => {
    const s = useStore.getState();
    s.setActivePanel(s.activePanel === panel ? null : panel);
  };
  $('#activityBar')?.addEventListener('click', () => _togglePanel('activity'));
  $('#automationBar')?.addEventListener('click', () => _togglePanel('automation'));
  $('#bridgeBar')?.addEventListener('click', () => _togglePanel('bridge'));

  // 15. 任务计划 badge
  try {
    const res = await hanaFetch('/api/desk/cron');
    const data = await res.json();
    const count = (data.jobs || []).length;
    const badge = document.getElementById('automationCountBadge');
    if (badge) badge.textContent = count > 0 ? String(count) : '';
  } catch { /* ignore */ }

  // 16. 浏览器后台按钮
  $('#browserBgBar')?.addEventListener('click', () => {
    platform?.openBrowserViewer?.();
  });

  // 17. 设置按钮
  $('#settingsBtn')?.addEventListener('click', () => platform.openSettings());

  // 18. 设置快捷键
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      platform.openSettings();
    }
  });

  // 19. 设置变更监听
  platform.onSettingsChanged((type: string, data: any) => {
    switch (type) {
      case 'agent-switched':
        applyAgentIdentity({
          agentName: data.agentName,
          agentId: data.agentId,
        });
        loadSessions();
        (window as any).__loadDeskSkills?.();
        break;
      case 'skills-changed':
        (window as any).__loadDeskSkills?.();
        break;
      case 'locale-changed':
        i18n.load(data.locale).then(() => {
          i18n.defaultName = useStore.getState().agentName;
          applyStaticI18n();
        });
        break;
      case 'models-changed':
        loadModels();
        break;
      case 'agent-created':
      case 'agent-deleted':
        loadAgents();
        break;
      case 'agent-updated':
        applyAgentIdentity({
          agentName: data.agentName,
          agentId: data.agentId,
          ui: { settings: false },
        });
        break;
      case 'theme-changed':
        setTheme(data.theme);
        break;
      case 'font-changed':
        setSerifFont(data.serif);
        break;
    }
  });

  // 20. 通知 app ready
  platform.appReady();
}

// ── 拖拽附件（从 bridge.ts appInput shim 迁移） ──

function initDragDrop(): void {
  const mainContent = document.querySelector('.main-content');
  const dropOverlay = document.getElementById('dropOverlay');
  if (!mainContent || !dropOverlay) return;

  let dragCounter = 0;

  mainContent.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) dropOverlay.classList.add('visible');
  });
  mainContent.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) dropOverlay.classList.remove('visible');
  });
  mainContent.addEventListener('dragover', (e) => e.preventDefault());
  mainContent.addEventListener('drop', async (e: Event) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.remove('visible');

    const de = e as DragEvent;
    const files = de.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const store = useStore.getState();
    if (store.attachedFiles.length >= 9) return;

    let srcPaths: string[] = [];
    const nameMap: Record<string, string> = {};
    for (const file of Array.from(files)) {
      const filePath = window.platform?.getFilePath?.(file);
      if (filePath) {
        srcPaths.push(filePath);
        nameMap[filePath] = file.name;
      }
    }
    if (srcPaths.length === 0) return;

    // Desk 文件直接附加（保留原始路径，不走 upload）
    const toSlash = (s: string) => s.replace(/\\/g, '/');
    const baseName = (s: string) => s.replace(/\\/g, '/').split('/').pop() || s;
    const s = useStore.getState();
    const deskBase = toSlash(s.deskBasePath ?? '').replace(/\/+$/, '');
    if (deskBase) {
      const prefix = deskBase + '/';
      const deskFileMap = new Map(s.deskFiles.map((f: any) => [f.name, f]));
      const isDeskPath = (p: string) => toSlash(p).startsWith(prefix);
      const deskPaths = srcPaths.filter(isDeskPath);
      srcPaths = srcPaths.filter((p) => !isDeskPath(p));
      for (const p of deskPaths) {
        if (useStore.getState().attachedFiles.length >= 9) break;
        const name = baseName(p);
        const knownFile = deskFileMap.get(name);
        useStore.getState().addAttachedFile({
          path: p,
          name,
          isDirectory: knownFile?.isDir ?? false,
        });
      }
    }
    if (srcPaths.length === 0) return;

    try {
      const res = await hanaFetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: srcPaths }),
      });
      const data = await res.json();
      for (const item of data.uploads || []) {
        if (item.dest) {
          useStore.getState().addAttachedFile({
            path: item.dest,
            name: item.name,
            isDirectory: item.isDirectory || false,
          });
        }
      }
    } catch (err) {
      console.error('[upload]', err);
      for (const p of srcPaths) {
        useStore.getState().addAttachedFile({
          path: p,
          name: nameMap[p] || p.split('/').pop() || p,
        });
      }
    }
  });
}

// ── React 组件 ──

function App() {
  useSidebarResize();

  useEffect(() => {
    init().catch((err: unknown) => {
      console.error('[init] 初始化异常:', err);
      window.platform?.appReady?.();
    });
  }, []);

  return (
    <ErrorBoundary>
      {/* Headless behavior components */}
      <SidebarLayout />
      <ChannelsPanel />

      {/* ── Titlebar ── */}
      <div className="titlebar">
        <button className="tb-toggle tb-toggle-left" id="tbToggleLeft" title="侧边栏">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="9" y1="3" x2="9" y2="21"></line>
          </svg>
        </button>
        <div className="tb-tabs" id="tbTabs">
          <div className="tb-tabs-slider" id="tbSlider"></div>
          <button className="tb-tab active" data-tab="chat">聊天</button>
          <button className="tb-tab" data-tab="channels">
            频道
            <span className="tb-tab-badge hidden" id="channelTabBadge"></span>
          </button>
        </div>
        <button className="tb-toggle tb-toggle-right" id="tbToggleRight" title="书桌">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="15" y1="3" x2="15" y2="21"></line>
          </svg>
        </button>
      </div>

      {/* ── App body ── */}
      <div className="app">
        {/* Left sidebar */}
        <aside className="sidebar" id="sidebar">
          <div className="sidebar-inner">
            <div className="sidebar-chat-content" id="sidebarChatContent">
              <div className="sidebar-header">
                <span className="sidebar-title"></span>
                <div className="sidebar-header-actions">
                  <button className="sidebar-action-btn" id="newSessionBtn" title="">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19"></line>
                      <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                  </button>
                  <button className="sidebar-action-btn" id="settingsBtn" title="">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3"></circle>
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                    </svg>
                  </button>
                  <button className="sidebar-action-btn" id="sidebarCollapseBtn" title="">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 6 9 12 15 18"></polyline>
                    </svg>
                  </button>
                </div>
              </div>
              <button className="sidebar-activity-bar sidebar-bridge-card" id="bridgeBar">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                </svg>
                <span id="bridgeBarLabel">接入</span>
                <span className="sidebar-bridge-dot" id="bridgeDot"></span>
              </button>
              <button className="sidebar-activity-bar" id="activityBar">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
                </svg>
                <span id="activityBarLabel">助手活动</span>
              </button>
              <button className="sidebar-activity-bar" id="automationBar">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                <span>任务计划</span>
                <span className="automation-count-badge" id="automationCountBadge"></span>
              </button>
              <button className="sidebar-activity-bar browser-bg-bar hidden" id="browserBgBar" title="后台浏览器运行中，点击查看">
                <svg className="browser-bg-globe" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="2" y1="12" x2="22" y2="12"></line>
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
                </svg>
                <span>后台浏览器</span>
              </button>
              <div className="session-list" id="sessionList">
                <SessionList />
              </div>
            </div>

            {/* 频道 tab 内容 */}
            <div className="sidebar-channel-content hidden" id="sidebarChannelContent">
              <div className="sidebar-header">
                <span className="sidebar-title">频道 <span className="beta-badge">Beta</span></span>
                <div className="sidebar-header-actions">
                  <button className="sidebar-action-btn" id="channelCreateBtn" title="新建频道">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19"></line>
                      <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                  </button>
                  <button className="sidebar-action-btn" id="channelCollapseBtn" title="">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 6 9 12 15 18"></polyline>
                    </svg>
                  </button>
                </div>
              </div>
              <div className="channel-list-wrap" id="channelListWrap">
                <div className="channel-list" id="channelList">
                  <ChannelList />
                </div>
                <div className="channel-disabled-overlay hidden" id="channelDisabledOverlay">
                  <span>频道功能已关闭</span>
                </div>
                <div className="channel-toggle-bar">
                  <span className="channel-toggle-bar-label">频道功能开关</span>
                  <button className="hana-toggle on" id="channelToggle"></button>
                </div>
              </div>
            </div>
          </div>
          <div className="resize-handle resize-handle-right" id="sidebarResizeHandle"></div>
        </aside>

        {/* Main content */}
        <div className="main-content">
          <BrowserCard />
          <div className="drop-overlay" id="dropOverlay">
            <div className="drop-overlay-inner">
              <span className="drop-icon">📎</span>
              <span className="drop-text"></span>
            </div>
          </div>

          <div className="chat-area" id="chatArea">
            <div className="welcome" id="welcome">
              <WelcomeScreen />
            </div>
            <div className="messages" id="messages"></div>
            <ChatArea />
          </div>

          <div className="input-area">
            <InputArea />
          </div>

          <div className="channel-view" id="channelView">
            <div className="channel-header" id="channelHeader">
              <div className="channel-header-info">
                <span className="channel-header-name" id="channelHeaderName"></span>
                <span className="channel-header-members" id="channelHeaderMembers"></span>
              </div>
              <div className="channel-header-actions">
                <button className="channel-header-action-btn" id="channelInfoToggle" title="频道信息">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                  </svg>
                </button>
                <button className="channel-header-action-btn" id="channelMenuBtn" title="更多">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <circle cx="12" cy="5" r="1"></circle>
                    <circle cx="12" cy="12" r="1"></circle>
                    <circle cx="12" cy="19" r="1"></circle>
                  </svg>
                </button>
              </div>
            </div>
            <div className="channel-messages" id="channelMessages">
              <ChannelMessages />
            </div>
            <div className="channel-input-area hidden" id="channelInputArea">
              <ChannelInput />
            </div>
            <div className="channel-readonly-notice hidden" id="channelReadonlyNotice">
              <ChannelReadonly />
            </div>
          </div>

          {/* Floating panels render into main-content */}
          <ActivityPanel />
          <AutomationPanel />
          <BridgePanel />
        </div>

        <PreviewPanel />

        {/* Right sidebar (Jian) */}
        <aside className="jian-sidebar" id="jianSidebar">
          <div className="resize-handle resize-handle-left" id="jianResizeHandle"></div>
          <div className="jian-sidebar-inner">
            <div className="jian-chat-content" id="jianChatContent">
              <DeskSection />
            </div>

            <div className="jian-channel-content hidden" id="jianChannelContent">
              <div className="jian-card">
                <div className="channel-info-section">
                  <div className="channel-info-label">频道信息</div>
                  <div className="channel-info-name" id="channelInfoName"></div>
                </div>
                <div className="channel-info-section">
                  <div className="channel-info-label">成员</div>
                  <div className="channel-members-list" id="channelMembersList">
                    <ChannelMembers />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* Connection status */}
      <div className="connection-status" id="connectionStatus">
        <span className="status-dot"></span>
        <span className="status-text"></span>
      </div>

      {/* Channel create overlay */}
      <div className="agent-create-overlay" id="channelCreateOverlay">
        <ChannelCreate />
      </div>
    </ErrorBoundary>
  );
}

export default App;
