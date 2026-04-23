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
import { migrateLegacyTodos } from '../utils/todo-compat';
import { loadAvatars as loadAvatarsAction, clearChat as clearChatAction } from './agent-actions';
import { loadDeskFiles } from './desk-actions';
import { loadModels } from '../utils/ui-helpers';
import { updateKeyed } from './create-keyed-slice';
import { snapshotStreamBuffer, type StreamBufferSnapshot } from './stream-invalidator';
import { renderMarkdown } from '../utils/markdown';
import type { ChatMessage, ContentBlock } from './chat-types';
import { readMessageLiveVersion } from './message-live-version';

// ── 防竞争计数器 ──

let _switchVersion = 0;

function resetDeskForSessionCwd(cwd?: string | null): void {
  const state = useStore.getState();
  const nextBasePath = cwd || '';
  const currentBasePath = state.deskBasePath || '';
  const nextSubdir = nextBasePath && currentBasePath === nextBasePath
    ? (state.deskCurrentPath || '')
    : '';
  // Session 切换后的 cwd 以服务端显式返回值为准；旧 session 的相对子目录
  // 不得隐式带入新 workspace，否则会把上一个工作区的视图假设泄漏过来。
  state.setDeskBasePath(nextBasePath);
  state.setDeskCurrentPath(nextSubdir);
  state.setDeskFiles([]);
  state.setDeskJianContent(null);
  if (!cwd) return;
  void loadDeskFiles(nextSubdir, cwd);
}

function clearSessionRuntimeCaches(path: string): void {
  useStore.getState().clearSession?.(path);
  useStore.setState((s: Record<string, any>) => {
    const { [path]: _attached, ...attachedFilesBySession } = s.attachedFilesBySession || {};
    const { [path]: _draft, ...drafts } = s.drafts || {};
    const { [path]: _streamMeta, ...sessionStreams } = s.sessionStreams || {};
    const { [path]: _browser, ...browserBySession } = s.browserBySession || {};
    const { [path]: _scroll, ...scrollPositions } = s.scrollPositions || {};
    const { [path]: _todos, ...todosBySession } = s.todosBySession || {};
    const { [path]: _todosLive, ...todosLiveVersionBySession } = s.todosLiveVersionBySession || {};
    return {
      attachedFilesBySession,
      drafts,
      sessionStreams,
      browserBySession,
      scrollPositions,
      streamingSessions: (s.streamingSessions || []).filter((sessionPath: string) => sessionPath !== path),
      todosBySession,
      todosLiveVersionBySession,
      inlineErrors: s.inlineErrors ? { ...s.inlineErrors, [path]: null } : s.inlineErrors,
    };
  });
}

// ══════════════════════════════════════════════════════
// 消息加载（从 app-messages-shim 迁移）
// ══════════════════════════════════════════════════════

export async function loadMessages(forPath?: string): Promise<void> {
  const targetPath = forPath || useStore.getState().currentSessionPath;
  if (!targetPath) return;
  const messageLiveVersionBefore = readMessageLiveVersion(targetPath);
  // 捕获 hydrate 前的 live 版本：若 fetch 期间有 tool_end 更新 todos，
  // 后面就跳过 hydrate 写入，避免旧快照覆盖刚收到的实时状态。
  const todosLiveVersionBefore =
    useStore.getState().todosLiveVersionBySession[targetPath] ?? 0;
  // messages 维度的竞态护栏：rapid switch 或并发 load 时，只有最新一次调用
  // 的响应允许 apply initSession，stale 响应直接丢弃。
  const myVersion = useStore.getState().bumpLoadMessagesVersion(targetPath);
  try {
    const res = await hanaFetch(`/api/sessions/messages?path=${encodeURIComponent(targetPath)}`);
    const data = await res.json();
    const latestVersion =
      useStore.getState()._loadMessagesVersion[targetPath] ?? 0;
    if (latestVersion !== myVersion) {
      // 已经有更新的 loadMessages 在途，stale 响应不应覆盖新状态。
      // todos 与 messages 必须作为同一份 hydrate 快照一起生效或一起丢弃。
      return;
    }
    const messageLiveVersionNow = readMessageLiveVersion(targetPath);
    if (messageLiveVersionNow !== messageLiveVersionBefore) {
      console.log(
        '[loadMessages] 跳过 session hydrate: mid-flight 收到 live message 更新',
        targetPath,
      );
      return;
    }
    const todosLiveVersionNow =
      useStore.getState().todosLiveVersionBySession[targetPath] ?? 0;
    if (todosLiveVersionNow !== todosLiveVersionBefore) {
      console.log(
        '[loadMessages] 跳过 session hydrate: mid-flight 收到 live todo 更新',
        targetPath,
      );
      return;
    }
    // per-session todos（防御性兼容层：即使后端漏转或缓存残留，这里兜底再转一次）
    const rawTodos = data.todos || [];
    const migratedTodos = migrateLegacyTodos({ todos: rawTodos });
    const items = buildItemsFromHistory(data);
    useStore.getState().setSessionTodosForPath(targetPath, migratedTodos);
    if (items.length > 0) {
      useStore.getState().initSession(targetPath, items, data.hasMore ?? false);
      if (targetPath === useStore.getState().currentSessionPath) {
        useStore.setState({ welcomeVisible: false });
      }
    } else {
      useStore.getState().initSession(targetPath, [], false);
    }
    // In-flight guard: jsonl 仅在 turn_end 落盘。若 session 在 stream 进行中
    // 被 reload（switchSession 冷启动 / stream-resume truncated），合并 buffer
    // 当前快照作为末尾 assistant，避免 UI 上"正在写的消息消失"。
    // 同步执行，不 await，保证中途不会有 text_delta 事件插入。
    const snapshot = snapshotStreamBuffer(targetPath);
    if (snapshot?.hasContent) {
      useStore.getState().appendItem(targetPath, {
        type: 'message',
        data: buildInflightAssistantMessage(snapshot),
      });
    }
  } catch (err) { console.error('[loadMessages] error:', err); }
}

function buildInflightAssistantMessage(snap: StreamBufferSnapshot): ChatMessage {
  const blocks: ContentBlock[] = [];
  if (snap.thinking || snap.inThinking) {
    blocks.push({ type: 'thinking', content: snap.thinking, sealed: !snap.inThinking });
  }
  if (snap.mood) {
    blocks.push({ type: 'mood', yuan: snap.moodYuan, text: snap.mood });
  }
  if (snap.text) {
    const displayText = snap.text.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, '');
    blocks.push({ type: 'text', html: renderMarkdown(displayText) });
  }
  return { id: snap.messageId || `inflight-${Date.now()}`, role: 'assistant', blocks };
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
      body: JSON.stringify({ path, currentSessionPath: s.currentSessionPath }),
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

    // 保存当前 session 的附件到 keyed store
    const currentPath = s.currentSessionPath;
    const currentAttachments = state.attachedFiles;
    if (currentPath) {
      useStore.setState(prev => ({
        attachedFilesBySession: { ...prev.attachedFilesBySession, [currentPath]: [...currentAttachments] },
      }));
    }

    // 批量更新 store（切 currentSessionPath 切换对话内容；desk/preview 是 user-level，不随 session 切换）
    useStore.setState({
      currentSessionPath: path,
      pendingNewSession: false,
      selectedFolder: null,
      selectedAgentId: null,
      welcomeVisible: false,
      memoryEnabled: data.memoryEnabled !== false,
      streamingSessions,
      attachedFiles: state.attachedFilesBySession[path] || [],
      deskContextAttached: false,
      docContextAttached: false,
      ...agentPatch,
    });

    resetDeskForSessionCwd(data.cwd || null);

    // desk / preview 状态是 user-level，但 workspace root 以切入 session 的 cwd 为准

    // 同步浏览器状态到 keyed store（服务端返回当前 session 的 browser 状态）
    if (path) {
      updateKeyed('browserBySession', path, {
        running: !!data.browserRunning,
        url: data.browserUrl || null,
        thumbnail: data.browserRunning ? (state.browserBySession[path]?.thumbnail ?? null) : null,
      });
    }

    useStore.getState().clearQuotedSelection();

    // Sync plan mode for the switched-to session
    window.dispatchEvent(new CustomEvent('hana-plan-mode', { detail: { enabled: data.planMode ?? false } }));

    // 刷新模型列表（当前 session 的模型可能不同）
    loadModels();

    // Hydrate per-session model snapshot from switch response。
    // provider 缺失不写入——空 provider 会让 ModelSelector 的复合键匹配全错
    // （老 session 的 meta 可能没带 provider，走 migration 或下一次显式选择修复）。
    if (data.currentModelId && data.currentModelProvider) {
      useStore.getState().updateSessionModel(path, {
        id: data.currentModelId,
        name: data.currentModelName || data.currentModelId,
        provider: data.currentModelProvider,
        input: Array.isArray(data.currentModelInput) ? data.currentModelInput : undefined,
        reasoning: data.currentModelReasoning ?? undefined,
        contextWindow: data.currentModelContextWindow ?? undefined,
      });
    }

    // 如果 store 中没有该 session 的消息数据，加载之
    const hasData = !!useStore.getState().chatSessions?.[path];
    if (!hasData) {
      await loadMessages(path);
    }

    // 切换会话后刷新 context ring
    useStore.setState({ contextTokens: null, contextWindow: null, contextPercent: null });
    import('../services/websocket').then(({ getWebSocket }) => {
      const wsConn = getWebSocket();
      if (wsConn?.readyState === WebSocket.OPEN) {
        wsConn.send(JSON.stringify({ type: 'context_usage', sessionPath: path }));
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
    // 用当前 desk 视图作为新 session 的 cwd 草稿（保持视觉连续）
    selectedFolder: s.deskBasePath || s.homeFolder || null,
    selectedAgentId: null,
    pendingNewSession: true,
    attachedFiles: [],
    deskContextAttached: false,
    docContextAttached: false,
  });

  // 重置 context ring
  useStore.setState({ contextTokens: null, contextWindow: null, contextPercent: null });

  // desk / preview 视图保持不变（user-level state，切 session 不清）

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
    body.currentSessionPath = s.currentSessionPath;

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

    resetDeskForSessionCwd(data.cwd || null);

    // New session defaults to plan mode OFF
    window.dispatchEvent(new CustomEvent('hana-plan-mode', { detail: { enabled: data.planMode ?? false } }));

    await loadSessions();

    // 刷新模型列表：session 创建后 activeModel 已绑定，需要同步到 UI
    loadModels();

    // 更新 cwdHistory
    if (justSelected) {
      const currentState = useStore.getState();
      let cwdHistory = currentState.cwdHistory.filter((p: string) => p !== justSelected);
      cwdHistory = [justSelected, ...cwdHistory];
      if (cwdHistory.length > 10) cwdHistory = cwdHistory.slice(0, 10);
      useStore.setState({ cwdHistory });
    }

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
    const isCurrent = path === s.currentSessionPath;
    clearSessionRuntimeCaches(path);
    if (isCurrent) {
      clearChatAction();
      useStore.setState({ currentSessionPath: null });
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
// 归档管理：列出 / 恢复 / 永久删 / 批量清理
// ══════════════════════════════════════════════════════

export interface ArchivedSession {
  path: string;
  title: string | null;
  archivedAt: string;
  sizeBytes: number;
  agentId: string;
  agentName: string;
}

export type RestoreResult = 'ok' | 'conflict' | 'error';

export async function listArchivedSessions(): Promise<ArchivedSession[]> {
  try {
    const res = await hanaFetch('/api/sessions/archived');
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.error('[archived] list failed:', err);
    return [];
  }
}

export async function restoreSession(path: string): Promise<RestoreResult> {
  try {
    const res = await hanaFetch('/api/sessions/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (res.status === 409) return 'conflict';
    if (!res.ok) return 'error';
    return 'ok';
  } catch (err) {
    console.error('[archived] restore failed:', err);
    return 'error';
  }
}

export async function deleteArchivedSession(path: string): Promise<boolean> {
  try {
    const res = await hanaFetch('/api/sessions/archived/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    return res.ok;
  } catch (err) {
    console.error('[archived] delete failed:', err);
    return false;
  }
}

export async function cleanupArchivedSessions(maxAgeDays: 30 | 90): Promise<{ deleted: number }> {
  try {
    const res = await hanaFetch('/api/sessions/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxAgeDays }),
    });
    if (!res.ok) return { deleted: 0 };
    const data = await res.json();
    return { deleted: data.deleted ?? 0 };
  } catch (err) {
    console.error('[archived] cleanup failed:', err);
    return { deleted: 0 };
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
