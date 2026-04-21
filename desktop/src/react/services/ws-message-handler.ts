/**
 * ws-message-handler.ts — WebSocket 消息分发（从 app-ws-shim.ts 迁移）
 *
 * 纯逻辑模块，不依赖 ctx 注入。通过 Zustand store 访问状态。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- WS 消息分发，msg 结构由服务端动态决定 */

import { streamBufferManager } from '../hooks/use-stream-buffer';
import { dispatchStreamKey } from './stream-key-dispatcher';
import { useStore } from '../stores';
import { updateKeyed } from '../stores/create-keyed-slice';
import { loadSessions as loadSessionsAction } from '../stores/session-actions';
import { handleArtifact } from '../stores/artifact-actions';
import { loadDeskFiles } from '../stores/desk-actions';
import { loadChannels as loadChannelsAction, openChannel as openChannelAction } from '../stores/channel-actions';
import { showError } from '../utils/ui-helpers';
import { getWebSocket } from './websocket';
import {
  replayStreamResume,
  isStreamResumeRebuilding,
  isStreamScopedMessage,
  updateSessionStreamMeta,
} from './stream-resume';
import { TODO_TOOL_NAMES, type TodoToolName } from '../utils/todo-constants';
import { migrateLegacyTodos } from '../utils/todo-compat';

declare function t(key: string, vars?: Record<string, string>): any;

// ── 聊天事件集合（走 StreamBufferManager） ──

const REACT_CHAT_EVENTS = new Set([
  'text_delta', 'thinking_start', 'thinking_delta', 'thinking_end',
  'mood_start', 'mood_text', 'mood_end',
  'tool_start', 'tool_end', 'turn_end',
  'content_block', 'plugin_card',
  'compaction_start', 'compaction_end',
]);

// ── Session 可见性 + 流状态 ──

function ensureCurrentSessionVisible(): void {
  const state = useStore.getState();
  const sessionPath = state.currentSessionPath;
  if (!sessionPath || state.pendingNewSession) return;
  if (state.sessions.some((s: any) => s.path === sessionPath)) return;

  useStore.setState({
    sessions: [{
      path: sessionPath,
      title: null,
      firstMessage: '',
      modified: new Date().toISOString(),
      messageCount: 0,
      agentId: state.currentAgentId || null,
      agentName: state.agentName || null,
      cwd: null,
      _optimistic: true,
    }, ...state.sessions],
  });
}

function hasOptimisticCurrentSession(): boolean {
  const state = useStore.getState();
  const sessionPath = state.currentSessionPath;
  if (!sessionPath) return false;
  return !!state.sessions.find((s: any) => s.path === sessionPath && s._optimistic);
}

export function applyStreamingStatus(isStreaming: boolean): void {
  // isStreaming 已由 streamingSessions 派生，不再写全局布尔值
  if (isStreaming) {
    ensureCurrentSessionVisible();
  } else {
    // React 模式：消息完成由 StreamBuffer turn_end 处理
    if (hasOptimisticCurrentSession()) {
      loadSessionsAction().catch(err => console.warn('[ws] loadSessions failed:', err));
    }
  }
}

// ── 消息分发（大 switch） ──

export function handleServerMessage(msg: any): void {
  const state = useStore.getState();

  const rebuildingFor = isStreamResumeRebuilding();

  if (rebuildingFor && msg.type === 'status' && state.currentSessionPath === rebuildingFor) {
    return;
  }

  if (
    rebuildingFor &&
    isStreamScopedMessage(msg) &&
    msg.sessionPath === rebuildingFor &&
    !msg.__fromReplay &&
    msg.type !== 'stream_resume'
  ) {
    return;
  }

  if (msg.type !== 'stream_resume' && isStreamScopedMessage(msg)) {
    updateSessionStreamMeta(msg);
  }

  // 活跃 block 事件路由：非当前 session 的聊天事件分发到 stream-key-dispatcher
  if (REACT_CHAT_EVENTS.has(msg.type) && msg.sessionPath && msg.sessionPath !== state.currentSessionPath) {
    dispatchStreamKey(msg.sessionPath, msg);
    return;
  }

  // ── React 聊天渲染路径：聊天相关事件走 StreamBufferManager ──
  if (REACT_CHAT_EVENTS.has(msg.type)) {
    streamBufferManager.handle(msg);
    // turn_end 后仍需执行部分通用逻辑（loadSessions、context_usage）
    if (msg.type === 'turn_end') {
      loadSessionsAction();
      const ws = getWebSocket();
      if (ws?.readyState === WebSocket.OPEN) {
        const turnSp = msg.sessionPath;
        if (turnSp) {
          ws.send(JSON.stringify({ type: 'context_usage', sessionPath: turnSp }));
        } else {
          console.warn('[ws] turn_end missing sessionPath, skipping context_usage request');
        }
      }
    }
    // tool_end 后更新 todo（兼容新旧工具名 + 新旧格式）
    if (msg.type === 'tool_end' && TODO_TOOL_NAMES.includes(msg.name as TodoToolName)) {
      const sp = msg.sessionPath;
      if (!sp) {
        console.warn('[ws] tool_end(todo) missing sessionPath, skipping');
      } else {
        const todos = migrateLegacyTodos(msg.details as { todos?: unknown[] } | null);
        useStore.getState().setSessionTodosForPath(sp, todos);
        // bump 版本：若 loadMessages 正在 fetch 旧快照，回来时会发现
        // 版本号变了，主动跳过 hydrate 写入，避免覆盖本次 live 状态。
        useStore.getState().bumpTodosLiveVersion(sp);
      }
    }
    // compaction_end 后更新 token
    if (msg.type === 'compaction_end') {
      const sp = msg.sessionPath;
      if (sp) useStore.getState().removeCompactingSession(sp);
      // 写入 keyed store（含 compat 同步）
      if (sp) {
        if (msg.tokens != null && msg.contextWindow != null) {
          updateKeyed('contextBySession', sp,
            { tokens: msg.tokens ?? null, window: msg.contextWindow ?? null, percent: msg.percent ?? null },
            (_s, d) => ({ contextTokens: d.tokens, contextWindow: d.window, contextPercent: d.percent }),
          );
        } else {
          // SDK returns null right after compaction (no post-compaction response yet)
          // Reset to null so the ring shows empty/estimating instead of stale pre-compaction values
          updateKeyed('contextBySession', sp,
            { tokens: null, window: useStore.getState().contextBySession[sp]?.window ?? null, percent: null },
            (_s, _d) => ({ contextTokens: null, contextPercent: null }),
          );
        }
      }
    }
    if (msg.type === 'compaction_start') {
      const sp = msg.sessionPath;
      if (sp) useStore.getState().addCompactingSession(sp);
    }
    // content_block 中的 artifact 需要通知预览系统更新
    if (msg.type === 'content_block' && msg.block?.type === 'artifact' && state.currentTab === 'chat') {
      handleArtifact({ ...msg.block, sessionPath: msg.sessionPath });
    }
    return;
  }

  // 非聊天渲染事件走传统 switch
  switch (msg.type) {
    case 'stream_resume':
      replayStreamResume(msg);
      break;

    case 'session_title':
      if (msg.title) {
        useStore.setState({
          sessions: state.sessions.map((s: any) =>
            s.path === msg.path ? { ...s, title: msg.title } : s,
          ),
        });
      }
      break;

    case 'desk_changed':
      loadDeskFiles();
      break;

    case 'browser_status': {
      const bsp = msg.sessionPath;
      if (!bsp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      const bRunning = !!msg.running;
      const bUrl = msg.url || null;
      const prevThumbnail = state.browserBySession[bsp]?.thumbnail ?? null;
      const bThumbnail = bRunning ? (msg.thumbnail || prevThumbnail) : null;
      updateKeyed('browserBySession', bsp,
        { running: bRunning, url: bUrl, thumbnail: bThumbnail },
      );
      // renderBrowserCard — no-op (browser card rendering handled by React)
      if (window.platform?.updateBrowserViewer) {
        window.platform.updateBrowserViewer({
          running: bRunning,
          url: bUrl,
          thumbnail: bThumbnail,
        });
      }
      break;
    }

    case 'browser_bg_status': {
      const bgSp = msg.sessionPath;
      if (!bgSp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      const prev = useStore.getState().browserBySession[bgSp] || { running: false, url: null, thumbnail: null };
      updateKeyed('browserBySession', bgSp,
        { ...prev, running: !!msg.running },
      );
      break;
    }

    case 'block_update': {
      const { taskId, patch, sessionPath: sp } = msg;
      if (!taskId || !patch) break;
      if (!sp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      useStore.getState().patchBlockByTaskId(sp, taskId, patch);
      break;
    }

    case 'activity_update':
      if (msg.activity) {
        useStore.setState({ activities: [msg.activity, ...state.activities.slice(0, 499)] });
      }
      break;

    case 'notification':
      if (window.hana?.showNotification) {
        window.hana.showNotification(msg.title, msg.body);
      }
      break;

    case 'bridge_status':
      useStore.getState().triggerBridgeReload();
      break;

    case 'plugin_ui_changed':
      import('../stores/plugin-ui-actions').then(m => m.refreshPluginUI());
      break;

    case 'bridge_message':
      if (msg.message) {
        useStore.getState().addBridgeMessage(msg.message);
      }
      break;

    case 'plan_mode': {
      const sp = msg.sessionPath;
      if (!sp || sp === useStore.getState().currentSessionPath) {
        window.dispatchEvent(new CustomEvent('hana-plan-mode', { detail: { enabled: !!msg.enabled } }));
      }
      break;
    }

    case 'channel_new_message': {
      const store = useStore.getState();
      const isViewing = store.currentTab === 'channels' && store.currentChannel === msg.channelName && document.visibilityState === 'visible';
      if (msg.channelName && isViewing) {
        openChannelAction(msg.channelName);
      } else if (msg.channelName) {
        loadChannelsAction();
      }
      break;
    }

    case 'dm_new_message': {
      const dmId = `dm:${msg.from}`;
      const store2 = useStore.getState();
      const isViewingDM = store2.currentTab === 'channels' && store2.currentChannel === dmId && document.visibilityState === 'visible';
      if (isViewingDM) {
        openChannelAction(dmId, true);
      } else {
        loadChannelsAction();
      }
      break;
    }

    case 'context_usage': {
      const sp = msg.sessionPath;
      if (!sp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      if (msg.tokens != null && msg.contextWindow != null) {
        updateKeyed('contextBySession', sp,
          { tokens: msg.tokens ?? null, window: msg.contextWindow ?? null, percent: msg.percent ?? null },
          (_s, d) => ({ contextTokens: d.tokens, contextWindow: d.window, contextPercent: d.percent }),
        );
      }
      break;
    }

    case 'error': {
      const sp = msg.sessionPath;
      if (!sp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      useStore.setState(s => ({ inlineErrors: { ...s.inlineErrors, [sp]: msg.message } }));
      break;
    }

    case 'confirmation_resolved': {
      // 更新所有 session 中匹配 confirmId 的确认卡片状态
      // cron_confirm 用 approved/rejected，settings_confirm 用 confirmed/rejected
      const sessions = state.chatSessions || {};
      for (const sp of Object.keys(sessions)) {
        useStore.getState().updateLastMessage(sp, (m: any) => {
          if (!m.blocks) return m;
          const updated = m.blocks.map((b: any) => {
            if ((b.type === 'settings_confirm' || b.type === 'cron_confirm') && b.confirmId === msg.confirmId) {
              let status: string;
              if (msg.action === 'confirmed') {
                status = b.type === 'cron_confirm' ? 'approved' : 'confirmed';
              } else {
                status = 'rejected';
              }
              return { ...b, status };
            }
            return b;
          });
          return { ...m, blocks: updated };
        });
      }
      break;
    }

    case 'apply_frontend_setting': {
      if (msg.key === 'theme') {
        window.applyTheme?.(msg.value);
        // 通知其他窗口（设置窗口等）同步主题
        window.platform?.settingsChanged?.('theme');
      }
      break;
    }

    case 'status': {
      // 元数据层：维护所有 session 的 streaming 状态（用 functional setState 防止 stale closure）
      const sp = msg.sessionPath;
      if (sp) {
        if (msg.isStreaming) {
          useStore.setState(s => ({
            streamingSessions: s.streamingSessions.includes(sp) ? s.streamingSessions : [...s.streamingSessions, sp],
            inlineErrors: { ...s.inlineErrors, [sp]: null },
          }));
        } else {
          useStore.setState(s => ({
            streamingSessions: s.streamingSessions.filter((p: string) => p !== sp),
          }));
        }
      }
      // 渲染层：只有焦点 session 才影响 UI
      if (!sp || sp === state.currentSessionPath) {
        applyStreamingStatus(msg.isStreaming);
      }
      break;
    }
  }
}
