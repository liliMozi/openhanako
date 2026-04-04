/**
 * session-actions.ts — Session 生命周期操作（纯逻辑 + API）
 *
 * 从 sidebar-shim.ts 迁移。所有函数直接操作 Zustand store，
 * 不依赖 ctx 注入，不持有闭包状态（除 _switchVersion 防竞争）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- store partial patch + API 响应 JSON */

import { useStore } from './index';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { buildItemsFromHistory } from '../utils/history-builder';
import { loadAvatars as loadAvatarsAction, clearChat as clearChatAction } from './agent-actions';
import { loadDeskFiles } from './desk-actions';
import { saveTabState, restoreTabState } from './artifact-actions';
import { loadModels } from '../utils/ui-helpers';

// ── 防竞争计数器 ──

let _switchVersion = 0;

// ══════════════════════════════════════════════════════
// 消息加载（从 app-messages-shim 迁移）
// ══════════════════════════════════════════════════════

export async function loadMessages(forPath?: string): Promise<void> {
  const targetPath = forPath || useStore.getState().currentSessionPath;
  if (!targetPath) return;
  try {
    const res = await hanaFetch(`/api/sessions/messages?path=${encodeURIComponent(targetPath)}`);
    const data = await res.json();
    // per-session todos
    useStore.getState().setSessionTodosForPath(targetPath, data.todos || []);
    const items = buildItemsFromHistory(data);
    if (items.length > 0) {
      useStore.getState().initSession(targetPath, items, data.hasMore ?? false);
      if (targetPath === useStore.getState().currentSessionPath) {
        useStore.setState({ welcomeVisible: false });
      }
    } else {
      useStore.getState().initSession(targetPath, [], false);
    }
  } catch (err) { console.error('[loadMessages] error:', err); }
}

/** 上滑加载更早的消息（分页） */
export async function loadMoreMessages(forPath?: string): Promise<void> {
  const targetPath = forPath || useStore.getState().currentSessionPath;
  if (!targetPath) return;
  const session = useStore.getState().chatSessions[targetPath];
  if (!session || !session.hasMore || session.loadingMore) return;

  useStore.getState().setLoadingMore(targetPath, true);
  try {
    const before = session.oldestId ?? '';
    const res = await hanaFetch(
      `/api/sessions/messages?path=${encodeURIComponent(targetPath)}&before=${encodeURIComponent(before)}`,
    );
    const data = await res.json();
    const items = buildItemsFromHistory(data);
    if (items.length > 0) {
      useStore.getState().prependItems(targetPath, items, data.hasMore ?? false);
    } else {
      useStore.getState().setLoadingMore(targetPath, false);
    }
  } catch (err) {
    console.error('[loadMoreMessages] error:', err);
    useStore.getState().setLoadingMore(targetPath, false);
  }
}

// ══════════════════════════════════════════════════════
// Session 列表
// ══════════════════════════════════════════════════════

export async function loadSessions(): Promise<void> {
  try {
    const res = await hanaFetch('/api/sessions');
    const data = await res.json();
    const sessions = data || [];

    const s = useStore.getState();
    useStore.setState({ sessions });

    if (sessions.length > 0 && !s.currentSessionPath && !s.pendingNewSession) {
      // 首次加载：走完整的 switchSession 确保后端同步 + 消息加载
      await switchSession(sessions[0].path);
    }
  } catch { /* ignore */ }
}

// ══════════════════════════════════════════════════════
// Session 切换
// ══════════════════════════════════════════════════════

export async function switchSession(path: string): Promise<void> {
  const s = useStore.getState();
  if (path === s.currentSessionPath) return;

  // 关闭浮动面板
  const activePanel = useStore.getState().activePanel;
  if (activePanel === 'activity' || activePanel === 'automation') {
    useStore.getState().setActivePanel(null);
  }

  const myVersion = ++_switchVersion;

  try {
    const res = await hanaFetch('/api/sessions/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (myVersion !== _switchVersion) return;
    if (data.error) {
      console.error('[session] switch failed:', data.error);
      return;
    }

    const state = useStore.getState();

    // 同步 streamingSessions：切入的 session 可能正在 streaming
    let streamingSessions = state.streamingSessions;
    if (data.isStreaming && path) {
      if (!streamingSessions.includes(path)) {
        streamingSessions = [...streamingSessions, path];
      }
    }

    // 同步全局 agent 上下文
    const switchedAgent = data.agentId && data.agentId !== state.currentAgentId;
    const agentPatch: Record<string, any> = {};

    if (switchedAgent) {
      const ag = state.agents.find((a: any) => a.id === data.agentId);
      agentPatch.currentAgentId = data.agentId;
      agentPatch.agentName = data.agentName || ag?.name || data.agentId;
      agentPatch.agentYuan = ag?.yuan || 'hanako';
      agentPatch.agentAvatarUrl = ag?.hasAvatar ? hanaUrl(`/api/agents/${data.agentId}/avatar?t=${Date.now()}`) : null;
    }

    // 保存当前 session 的 tab 状态
    const currentPath = s.currentSessionPath;
    if (currentPath) saveTabState(currentPath);

    // 保存当前 session 的附件到 keyed store
    const currentAttachments = state.attachedFiles;
    if (currentPath && currentAttachments.length) {
      useStore.setState(prev => ({
        attachedFilesBySession: { ...prev.attachedFilesBySession, [currentPath]: currentAttachments },
      }));
    }

    // 批量更新 store
    useStore.setState({
      currentSessionPath: path,
      pendingNewSession: false,
      selectedFolder: null,
      selectedAgentId: null,
      welcomeVisible: false,
      memoryEnabled: data.memoryEnabled !== false,
      streamingSessions,
      browserRunning: !!data.browserRunning,
      browserUrl: data.browserUrl || null,
      browserThumbnail: data.browserRunning ? state.browserThumbnail : null,
      attachedFiles: state.attachedFilesBySession[path] || [],
      deskContextAttached: false,
      docContextAttached: false,
      ...agentPatch,
    });

    // 恢复目标 session 的 tab 状态 + 清除 quotedSelection
    restoreTabState(path);
    useStore.getState().clearQuotedSelection();

    // Sync plan mode for the switched-to session
    window.dispatchEvent(new CustomEvent('hana-plan-mode', { detail: { enabled: data.planMode ?? false } }));

    // 刷新模型列表（当前 session 的模型可能不同）
    loadModels();

    // 如果 store 中没有该 session 的消息数据，加载之
    const hasData = !!useStore.getState().chatSessions?.[path];
    if (!hasData) {
      await loadMessages(path);
    }

    // 加载 desk files（显式传入切换后 session 的 cwd，覆盖 store 中旧的 deskBasePath）
    loadDeskFiles('', data.cwd || undefined);

    // 切换会话后刷新 context ring
    useStore.setState({ contextTokens: null, contextWindow: null, contextPercent: null });
    import('../services/websocket').then(({ getWebSocket }) => {
      const wsConn = getWebSocket();
      if (wsConn?.readyState === WebSocket.OPEN) {
        wsConn.send(JSON.stringify({ type: 'context_usage' }));
      }
    });
  } catch (err) {
    console.error('[session] switch failed:', err);
  }
}

// ══════════════════════════════════════════════════════
// 新建 Session
// ══════════════════════════════════════════════════════

export async function createNewSession(): Promise<void> {
  // 关闭浮动面板
  if (useStore.getState().activePanel === 'activity') {
    useStore.getState().setActivePanel(null);
  }

  const s = useStore.getState();

  useStore.setState({
    welcomeVisible: true,
    currentSessionPath: null,
    selectedFolder: s.homeFolder || null,
    selectedAgentId: null,
    pendingNewSession: true,
    browserRunning: false,
    browserUrl: null,
    browserThumbnail: null,
    attachedFiles: [],
    deskContextAttached: false,
    docContextAttached: false,
  });

  // 重置 context ring
  useStore.setState({ contextTokens: null, contextWindow: null, contextPercent: null });

  // renderBrowserCard — no-op (browser card rendering handled by React)

  // updateFolderButton — no-op (React-driven)

  const currentState = useStore.getState();
  loadDeskFiles('', currentState.selectedFolder || currentState.homeFolder || undefined);

  // pending 状态下刷新 model 列表，让 ModelSelector 显示 agent Chat 默认 model
  loadModels();

  useStore.getState().requestInputFocus();
}

// ══════════════════════════════════════════════════════
// 确保 Session 存在（首次发消息时调用）
// ══════════════════════════════════════════════════════

export async function ensureSession(): Promise<boolean> {
  const s = useStore.getState();
  if (!s.pendingNewSession) return true;

  try {
    const body: Record<string, any> = { memoryEnabled: s.memoryEnabled };
    if (s.selectedFolder) {
      body.cwd = s.selectedFolder;
    }
    if (s.selectedAgentId && s.selectedAgentId !== s.currentAgentId) {
      body.agentId = s.selectedAgentId;
    }

    const res = await hanaFetch('/api/sessions/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[session] create failed:', data.error);
      return false;
    }

    const justSelected = s.selectedFolder;

    // 基础状态更新
    const patch: Record<string, any> = {
      pendingNewSession: false,
      selectedFolder: null,
      selectedAgentId: null,
    };

    if (data.agentId) {
      const switched = data.agentId !== s.currentAgentId;
      patch.currentAgentId = data.agentId;
      if (data.agentName) patch.agentName = data.agentName;
      if (switched) {
        const ag = s.agents.find((a: any) => a.id === data.agentId);
        if (ag?.yuan) patch.agentYuan = ag.yuan;
        patch.agentAvatarUrl = null;
        window.i18n.defaultName = data.agentName || s.agentName;
        // 异步刷新头像
        hanaFetch('/api/health').then((r: Response) => r.json()).then((d: any) => {
          loadAvatarsAction(d.avatars);
        }).catch(() => {
          loadAvatarsAction();
        });
      }
    }

    if (data.path) {
      patch.currentSessionPath = data.path;
      // 初始化空 session，ChatArea 自动渲染
      useStore.getState().initSession(data.path, [], false);
    }

    useStore.setState(patch);

    // New session defaults to plan mode OFF
    window.dispatchEvent(new CustomEvent('hana-plan-mode', { detail: { enabled: data.planMode ?? false } }));

    await loadSessions();

    // 刷新模型列表：session 创建后 activeModel 已绑定，需要同步到 UI
    loadModels();

    // updateFolderButton — no-op (React-driven)

    // 更新 cwdHistory
    if (justSelected) {
      const currentState = useStore.getState();
      let cwdHistory = currentState.cwdHistory.filter((p: string) => p !== justSelected);
      cwdHistory = [justSelected, ...cwdHistory];
      if (cwdHistory.length > 10) cwdHistory = cwdHistory.slice(0, 10);
      useStore.setState({ cwdHistory });
    }

    loadDeskFiles('', data.cwd || undefined);

    return true;
  } catch (err) {
    console.error('[session] create failed:', err);
    return false;
  }
}

// ══════════════════════════════════════════════════════
// 归档 Session
// ══════════════════════════════════════════════════════

export async function archiveSession(path: string): Promise<void> {
  try {
    const res = await hanaFetch('/api/sessions/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[session] archive failed:', data.error);
      showSidebarToast(window.t('session.archiveFailed'));
      return;
    }

    const s = useStore.getState();
    if (path === s.currentSessionPath) {
      useStore.setState({ currentSessionPath: null });
      clearChatAction();
    }

    await loadSessions();

    const updated = useStore.getState();
    if (updated.sessions.length === 0) {
      await createNewSession();
    } else if (!updated.currentSessionPath) {
      await switchSession(updated.sessions[0].path);
    }
  } catch (err) {
    console.error('[session] archive failed:', err);
    showSidebarToast(window.t('session.archiveFailed'));
  }
}

// ══════════════════════════════════════════════════════
// 重命名 Session
// ══════════════════════════════════════════════════════

export async function renameSession(path: string, title: string): Promise<boolean> {
  try {
    const res = await hanaFetch('/api/sessions/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, title }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[session] rename failed:', data.error);
      return false;
    }
    // 乐观更新 store 中的 title
    const sessions = useStore.getState().sessions.map(s =>
      s.path === path ? { ...s, title } : s,
    );
    useStore.setState({ sessions });
    return true;
  } catch (err) {
    console.error('[session] rename failed:', err);
    return false;
  }
}

// ══════════════════════════════════════════════════════
// Toast
// ══════════════════════════════════════════════════════

export function showSidebarToast(text: string, duration = 3000): void {
  useStore.getState().addToast(text, 'info', duration);
}
