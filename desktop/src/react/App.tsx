/**
 * App.tsx — React 根组件 + 应用初始化
 *
 * 所有初始化逻辑从 app.js / bridge.ts 迁移至此。
 * 不再依赖 __hanaState Proxy、HanaModules shim 或 __hanaInit。
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
import { ChannelsPanel } from './components/ChannelsPanel';
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
      <SidebarLayout />
      <ActivityPanel />
      <AutomationPanel />
      <BridgePanel />
      <PreviewPanel />
      <BrowserCard />
      <DeskSection />
      <InputArea />
      <SessionList />
      <WelcomeScreen />
      <ChatArea />
      <ChannelsPanel />
    </ErrorBoundary>
  );
}

export default App;
