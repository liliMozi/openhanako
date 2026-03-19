/**
 * ws-message-handler.ts — WebSocket 消息分发（从 app-ws-shim.ts 迁移）
 *
 * 纯逻辑模块，不依赖 ctx 注入。通过 Zustand store 访问状态。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { streamBufferManager } from '../hooks/use-stream-buffer';
import { useStore } from '../stores';
import { loadSessions as loadSessionsAction } from '../stores/session-actions';
import { handleArtifact } from '../stores/artifact-actions';
import { loadDeskFiles } from '../stores/desk-actions';
import { showError } from '../utils/ui-helpers';
import { getWebSocket } from './websocket';
import {
  replayStreamResume,
  isStreamResumeRebuilding,
  isStreamScopedMessage,
  updateSessionStreamMeta,
} from './stream-resume';

declare function t(key: string, vars?: Record<string, string>): any;

// ── 聊天事件集合（走 StreamBufferManager） ──

const REACT_CHAT_EVENTS = new Set([
  'text_delta', 'thinking_start', 'thinking_delta', 'thinking_end',
  'mood_start', 'mood_text', 'mood_end',
  'xing_start', 'xing_text', 'xing_end',
  'tool_start', 'tool_end', 'turn_end',
  'file_output', 'skill_activated', 'artifact',
  'browser_screenshot', 'cron_confirmation',
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
  useStore.setState({ isStreaming: !!isStreaming });
  if (isStreaming) {
    ensureCurrentSessionVisible();
  } else {
    // React 模式：消息完成由 StreamBuffer turn_end 处理
    if (hasOptimisticCurrentSession()) {
      loadSessionsAction().catch(() => {});
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

  // ── React 聊天渲染路径：聊天相关事件走 StreamBufferManager ──
  if (REACT_CHAT_EVENTS.has(msg.type)) {
    streamBufferManager.handle(msg);
    // turn_end 后仍需执行部分通用逻辑（loadSessions、context_usage）
    if (msg.type === 'turn_end') {
      loadSessionsAction();
      const ws = getWebSocket();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'context_usage' }));
      }
    }
    // tool_end 后更新 todo
    if (msg.type === 'tool_end' && msg.name === 'todo' && msg.details?.todos) {
      useStore.setState({ sessionTodos: msg.details.todos });
    }
    // compaction_end 后更新 token
    if (msg.type === 'compaction_end') {
      const patch: Record<string, any> = { compacting: false };
      if (msg.tokens != null && msg.contextWindow != null) {
        patch.contextTokens = msg.tokens;
        patch.contextWindow = msg.contextWindow;
        patch.contextPercent = msg.percent;
      }
      useStore.setState(patch);
    }
    if (msg.type === 'compaction_start') {
      useStore.setState({ compacting: true });
    }
    // artifact 需要通知 artifacts shim 更新预览
    if (msg.type === 'artifact' && state.currentTab === 'chat') {
      handleArtifact(msg);
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

    case 'browser_status':
      useStore.setState({
        browserRunning: !!msg.running,
        browserUrl: msg.url || null,
        browserThumbnail: msg.running ? (msg.thumbnail || state.browserThumbnail) : null,
      });
      // renderBrowserCard — no-op (browser card rendering handled by React)
      if ((window as any).platform?.updateBrowserViewer) {
        (window as any).platform.updateBrowserViewer({
          running: !!msg.running,
          url: msg.url || null,
          thumbnail: msg.running ? (msg.thumbnail || state.browserThumbnail) : null,
        });
      }
      break;

    case 'browser_bg_status': {
      const bar = document.getElementById('browserBgBar');
      if (bar) bar.classList.toggle('hidden', !msg.running);
      break;
    }

    case 'activity_update':
      if (msg.activity) {
        useStore.setState({ activities: [msg.activity, ...state.activities.slice(0, 499)] });
      }
      break;

    case 'notification':
      if ((window as any).hana?.showNotification) {
        (window as any).hana.showNotification(msg.title, msg.body);
      }
      break;

    case 'bridge_status':
      (window as any).__hanaBridgeLoadStatus?.();
      break;

    case 'bridge_message':
      if (msg.message) {
        (window as any).__hanaBridgeOnMessage?.(msg.message);
      }
      break;

    case 'plan_mode':
      window.dispatchEvent(new CustomEvent('hana-plan-mode', { detail: { enabled: !!msg.enabled } }));
      break;

    case 'channel_new_message': {
      const store = useStore.getState();
      if (msg.channelName && store.currentChannel === msg.channelName) {
        store.openChannel(msg.channelName);
      } else if (msg.channelName) {
        store.loadChannels();
      }
      break;
    }

    case 'dm_new_message': {
      const dmId = `dm:${msg.from}`;
      const store2 = useStore.getState();
      if (store2.currentChannel === dmId) {
        store2.openChannel(dmId, true);
      } else {
        store2.loadChannels();
      }
      break;
    }

    case 'context_usage':
      if (msg.tokens != null && msg.contextWindow != null) {
        useStore.setState({
          contextTokens: msg.tokens,
          contextWindow: msg.contextWindow,
          contextPercent: msg.percent,
        });
      }
      break;

    case 'error': {
      showError(msg.message);
      break;
    }

    case 'status': {
      // 元数据层：维护所有 session 的 streaming 状态
      const sp = msg.sessionPath;
      if (sp) {
        const list: string[] = state.streamingSessions || [];
        if (msg.isStreaming) {
          if (!list.includes(sp)) useStore.setState({ streamingSessions: [...list, sp] });
        } else {
          useStore.setState({ streamingSessions: list.filter((p: string) => p !== sp) });
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
