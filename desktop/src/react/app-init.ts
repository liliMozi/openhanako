/**
 * app-init.ts — 应用初始化逻辑（纯函数，非 React 组件）
 *
 * 从 App.tsx 提取。包含：
 * - __hanaLog 日志上报
 * - 全局错误 / unhandled rejection 监听
 * - initApp() 主初始化流程
 */

import { useStore } from './stores';
import { hanaFetch } from './hooks/use-hana-fetch';
import { applyAgentIdentity, loadAgents, loadAvatars } from './stores/agent-actions';
import { loadSessions } from './stores/session-actions';
import { connectWebSocket, getWebSocket } from './services/websocket';
import { setStatus, loadModels } from './utils/ui-helpers';
import { initJian, loadDeskFiles } from './stores/desk-actions';
import { loadChannels } from './stores/channel-actions';
import { initEditorEvents } from './stores/artifact-actions';
import { updateLayout } from './components/SidebarLayout';
import { initErrorBusBridge } from './errors/error-bus-bridge';
import { refreshPluginUI } from './stores/plugin-ui-actions';
// @ts-expect-error — shared JS module
import { errorBus as _errorBus } from '../../../shared/error-bus.js';
// @ts-expect-error — shared JS module
import { AppError as _AppError } from '../../../shared/errors.js';

declare const i18n: {
  locale: string;
  defaultName: string;
  load(locale: string): Promise<void>;
};
declare function t(key: string, vars?: Record<string, string | number>): string;

/* eslint-disable @typescript-eslint/no-explicit-any -- 全局 bootstrap：platform/IPC callback 签名含 any */

// Race guard: rapid agent switches (A→B→C) can cause stale async responses
// from earlier switches to overwrite current state. Same pattern as
// _switchVersion in session-actions.ts.
let _agentSwitchVersion = 0;

// ── __hanaLog：前端日志上报 ──
window.__hanaLog = function (level: string, module: string, message: string) {
  const { serverPort } = useStore.getState();
  if (!serverPort) return;
  hanaFetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, module, message }),
  }).catch(err => console.warn('[hanaLog] log upload failed:', err));
};

// ── 全局错误捕获 ──
window.addEventListener('error', (e) => {
  _errorBus.report(_AppError.wrap(e.error || e.message), {
    context: { filename: e.filename, line: e.lineno },
  });
});
window.addEventListener('unhandledrejection', (e) => {
  _errorBus.report(_AppError.wrap(e.reason));
});

// ── 主初始化流程 ──

export async function initApp(): Promise<void> {
  const platform = window.platform;

  // 1. 获取 server 连接信息并存入 Zustand
  const serverPort = await platform.getServerPort();
  const serverToken = await platform.getServerToken();
  useStore.setState({ serverPort, serverToken });

  if (!serverPort) {
    setStatus('status.serverNotReady', false);
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
    useStore.setState({ locale: i18n.locale });

    // 4. 应用 agent 身份
    await applyAgentIdentity({
      agentName: healthData.agent || 'Hanako',
      userName: healthData.user || t('common.user'),
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

    // 6. 加载头像
    loadAvatars(healthData.avatars);
  } catch (err) {
    console.error('[init] i18n/health/config failed:', err);
  }

  // 8. 连接 WebSocket
  connectWebSocket();
  initErrorBusBridge();

  // 9. 加载模型
  await loadModels();

  // 10. 加载 agents + sessions
  useStore.setState({ pendingNewSession: true });
  await loadAgents();
  await loadSessions();

  // 11. 初始化书桌
  initJian();

  // 12. 初始化编辑器事件
  initEditorEvents();

  // 13b. 初始 layout 计算
  updateLayout();

  // 14. 任务计划 badge 初始值
  try {
    const res = await hanaFetch('/api/desk/cron');
    const data = await res.json();
    const count = (data.jobs || []).length;
    useStore.setState({ automationCount: count });
  } catch { /* ignore */ }

  // 15. Bridge 状态指示点（启动时就查一次，不等用户打开面板）
  try {
    const res = await hanaFetch('/api/bridge/status');
    const data = await res.json();
    const anyConnected = data.telegram?.status === 'connected' || data.feishu?.status === 'connected' || data.qq?.status === 'connected' || data.whatsapp?.status === 'connected';
    useStore.setState({ bridgeDotConnected: anyConnected });
  } catch { /* ignore */ }

  // 16. 加载插件 UI（pages / widgets）
  refreshPluginUI();

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
      case 'agent-switched': {
        const myVersion = ++_agentSwitchVersion;

        applyAgentIdentity({
          agentName: data.agentName,
          agentId: data.agentId,
        });
        loadSessions();

        // Reset channel state for new agent
        useStore.setState({
          currentChannel: null,
          channelMessages: [],
          channelMembers: [],
          channelTotalUnread: 0,
          channelHeaderName: '',
          channelHeaderMembersText: '',
          channelInfoName: '',
          channelIsDM: false,
        });
        loadChannels();

        // Reload models and reset thinking level
        loadModels();
        useStore.setState({ thinkingLevel: 'auto' });

        // Reload desk files, homeFolder, cwdHistory
        hanaFetch('/api/config').then(r => r.json()).then((cfg: any) => {
          if (myVersion !== _agentSwitchVersion) return; // stale
          useStore.setState({
            homeFolder: cfg.deskHome || null,
            cwdHistory: cfg.cwdHistory || [],
          });
          loadDeskFiles('', cfg.deskHome || undefined);
        }).catch(() => {});

        // Reload automation count and clear activities
        hanaFetch('/api/desk/cron').then(r => r.json()).then((d: any) => {
          if (myVersion !== _agentSwitchVersion) return; // stale
          useStore.setState({ automationCount: d.jobs?.length || 0 });
        }).catch(() => {});
        useStore.setState({ activities: [] });
        break;
      }
      case 'locale-changed':
        i18n.load(data.locale).then(() => {
          i18n.defaultName = useStore.getState().agentName;
          useStore.setState({ locale: i18n.locale });
        });
        break;
      case 'models-changed': {
        loadModels();
        // 模型配置变更可能改变 contextWindow（用户把 1M 模型改成 256k 等），
        // 主动补发一次 context_usage 让 ContextRing 立即吃到新分母。
        const sp = useStore.getState().currentSessionPath;
        if (sp) {
          const ws = getWebSocket();
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'context_usage', sessionPath: sp }));
          }
        }
        break;
      }
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
      case 'paper-texture-changed':
        setPaperTexture(data.enabled);
        break;
      case 'leaves-overlay-changed':
        window.dispatchEvent(new CustomEvent('hana-settings', {
          detail: { type: 'leaves-overlay-changed', enabled: data.enabled },
        }));
        break;
    }
  });

  // 20. Skill Viewer overlay（主进程 / 设置窗口 → 渲染进程）
  window.hana?.onShowSkillViewer?.((data: any) => {
    useStore.setState({ skillViewerData: data });
  });

  // 21. 通知 app ready
  platform.appReady();
}
