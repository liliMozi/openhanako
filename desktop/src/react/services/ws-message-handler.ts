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
import { handleAppEvent } from './app-event-actions';
import {
  replayStreamResume,
  isStreamResumeRebuilding,
  isStreamScopedMessage,
  updateSessionStreamMeta,
} from './stream-resume';
import { TODO_TOOL_NAMES, type TodoToolName } from '../utils/todo-constants';
import { migrateLegacyTodos } from '../utils/todo-compat';
import { renderMarkdown } from '../utils/markdown';
import { bumpMessageLiveVersion } from '../stores/message-live-version';

declare function t(key: string, vars?: Record<string, string>): any;

let requestContextUsage: (sessionPath: string) => void = () => {};

export function configureWsMessageHandler(options: {
  requestContextUsage?: (sessionPath: string) => void;
}): void {
  requestContextUsage = options.requestContextUsage || (() => {});
}

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

function isKnownChatSession(sessionPath: string, state = useStore.getState()): boolean {
  return !!state.chatSessions?.[sessionPath] || state.sessions.some((s: any) => s.path === sessionPath);
}

export function applyStreamingStatus(isStreaming: boolean, sessionPath: string | null): void {
  // 元数据层：把 isStreaming 视为 sessionPath 维度的权威信号，统一写回 streamingSessions。
  // 这一层不分焦点，任何来源（普通 status、stream_resume 恢复）都必须到达这里，
  // 否则重连后服务端说「已结束」前端却留着旧的 streaming 标记，UI 会卡在"思考中"。
  if (sessionPath) {
    if (isStreaming) {
      useStore.setState(s => ({
        streamingSessions: s.streamingSessions.includes(sessionPath)
          ? s.streamingSessions
          : [...s.streamingSessions, sessionPath],
      }));
      useStore.getState().clearInlineError(sessionPath);
    } else {
      useStore.setState(s => ({
        streamingSessions: s.streamingSessions.filter((p: string) => p !== sessionPath),
      }));
    }
  }

  // 渲染层：只有焦点 session 才影响 UI 占位 / sessions 列表。
  const focused = useStore.getState().currentSessionPath;
  if (sessionPath && sessionPath !== focused) return;
  if (isStreaming) {
    ensureCurrentSessionVisible();
  } else if (hasOptimisticCurrentSession()) {
    loadSessionsAction().catch(err => console.warn('[ws] loadSessions failed:', err));
  }
}

function attachmentsEqual(a: any, b: any): boolean {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const la = left[i] || {};
    const rb = right[i] || {};
    if ((la.path || '') !== (rb.path || '')) return false;
    if ((la.name || '') !== (rb.name || '')) return false;
    if (!!la.isDir !== !!rb.isDir) return false;
    if ((la.mimeType || '') !== (rb.mimeType || '')) return false;
    if ((la.base64Data || '') !== (rb.base64Data || '')) return false;
    if (!!la.visionAuxiliary !== !!rb.visionAuxiliary) return false;
  }
  return true;
}

function sameJsonish(a: any, b: any): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function replayUserMessageAlreadyHydrated(sessionPath: string, message: any): boolean {
  const session = useStore.getState().chatSessions[sessionPath];
  const last = session?.items?.[session.items.length - 1];
  if (!last || last.type !== 'message' || last.data?.role !== 'user') return false;
  const text = typeof message?.text === 'string' ? message.text : '';
  return last.data.text === text &&
    (last.data.quotedText || '') === (message?.quotedText || '') &&
    attachmentsEqual(last.data.attachments, message?.attachments) &&
    sameJsonish(last.data.deskContext, message?.deskContext);
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

  // 活跃 block 事件路由：非当前 session 的聊天事件也要写入正常聊天缓存。
  // stream-key-dispatcher 只负责卡片/预览订阅，不能吞掉主 transcript 的后台流。
  if (REACT_CHAT_EVENTS.has(msg.type) && msg.sessionPath && msg.sessionPath !== state.currentSessionPath) {
    if (isKnownChatSession(msg.sessionPath, state)) {
      streamBufferManager.handle(msg);
    }
    dispatchStreamKey(msg.sessionPath, msg);
    return;
  }

  // ── React 聊天渲染路径：聊天相关事件走 StreamBufferManager ──
  if (REACT_CHAT_EVENTS.has(msg.type)) {
    streamBufferManager.handle(msg);
    // turn_end 后仍需执行部分通用逻辑（loadSessions、context_usage）
    if (msg.type === 'turn_end') {
      loadSessionsAction();
      const turnSp = msg.sessionPath;
      if (turnSp) {
        requestContextUsage(turnSp);
      } else {
        console.warn('[ws] turn_end missing sessionPath, skipping context_usage request');
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

    case 'computer_overlay': {
      const sp = msg.sessionPath;
      if (!sp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      if (msg.phase === 'clear') {
        useStore.getState().clearComputerOverlayForSession(sp);
      } else {
        useStore.getState().setComputerOverlayForSession(sp, {
          phase: msg.phase || 'running',
          action: msg.action || 'computer',
          agentId: msg.agentId ?? null,
          leaseId: msg.leaseId ?? null,
          snapshotId: msg.snapshotId ?? null,
          target: msg.target ?? null,
          inputMode: msg.inputMode === 'foreground-input' ? 'foreground-input' : 'background',
          visualSurface: msg.visualSurface === 'provider' ? 'provider' : 'renderer',
          requiresForeground: msg.requiresForeground === true,
          interruptKey: msg.interruptKey ?? null,
          errorCode: msg.errorCode ?? null,
          ts: msg.ts || Date.now(),
        });
      }
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

    case 'app_event':
      if (msg.event?.type) {
        handleAppEvent(msg.event.type, msg.event.payload || {});
      }
      break;

    case 'bridge_message':
      if (msg.message) {
        useStore.getState().addBridgeMessage(msg.message);
      }
      break;

    case 'session_user_message': {
      const sp = msg.sessionPath;
      if (!sp || !msg.message) break;
      if (!useStore.getState().chatSessions[sp]) {
        useStore.getState().initSession(sp, [], false);
      }
      if (msg.__fromReplay === true && replayUserMessageAlreadyHydrated(sp, msg.message)) {
        break;
      }
      const text = typeof msg.message.text === 'string' ? msg.message.text : '';
      useStore.getState().appendItem(sp, {
        type: 'message',
        data: {
          id: msg.message.id || `user-${Date.now()}`,
          role: 'user',
          text,
          textHtml: text ? renderMarkdown(text) : undefined,
          attachments: msg.message.attachments,
          quotedText: msg.message.quotedText,
          skills: msg.message.skills,
          deskContext: msg.message.deskContext ?? undefined,
        },
      });
      bumpMessageLiveVersion(sp);
      if (sp === useStore.getState().currentSessionPath) {
        useStore.setState({ welcomeVisible: false });
      }
      break;
    }

    case 'bridge_rc_attached': {
      const sp = msg.sessionPath;
      if (sp && msg.sessionKey) {
        useStore.setState((s) => ({
          sessions: s.sessions.map((session) => session.path === sp
            ? {
              ...session,
              rcAttachment: {
                sessionKey: msg.sessionKey,
                platform: msg.platform || 'bridge',
                title: msg.title || null,
              },
            }
            : session),
        }));
      }
      break;
    }

    case 'bridge_rc_detached': {
      const sp = msg.sessionPath;
      if (sp) {
        useStore.setState((s) => ({
          sessions: s.sessions.map((session) => session.path === sp
            ? { ...session, rcAttachment: null }
            : session),
        }));
      }
      break;
    }

    case 'plan_mode': {
      const sp = msg.sessionPath;
      if (!sp || sp === useStore.getState().currentSessionPath) {
        window.dispatchEvent(new CustomEvent('hana-plan-mode', {
          detail: { enabled: !!msg.enabled, mode: msg.enabled ? 'read_only' : 'operate' },
        }));
      }
      break;
    }

    case 'permission_mode': {
      const sp = msg.sessionPath;
      if (!sp || sp === useStore.getState().currentSessionPath) {
        window.dispatchEvent(new CustomEvent('hana-plan-mode', {
          detail: { enabled: msg.mode === 'read_only', mode: msg.mode },
        }));
      }
      break;
    }

    case 'access_mode': {
      const sp = msg.sessionPath;
      if (!sp || sp === useStore.getState().currentSessionPath) {
        window.dispatchEvent(new CustomEvent('hana-plan-mode', {
          detail: {
            enabled: msg.readOnly === true,
            mode: msg.permissionMode || msg.mode,
          },
        }));
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
      useStore.getState().setInlineError(sp, msg.message);
      break;
    }

    case 'confirmation_resolved': {
      // 更新所有 session 中匹配 confirmId 的确认卡片状态。确认块可能不在最后一条消息，
      // 输入区也从消息块派生 pending 状态，所以这里按 session/message/block 三层显式定位。
      const nextStatusFor = (blockType: string): string => {
        if (msg.action === 'confirmed') return blockType === 'cron_confirm' ? 'approved' : 'confirmed';
        if (msg.action === 'timeout') return 'timeout';
        return 'rejected';
      };
      let changedPaths: string[] = [];
      useStore.setState((s: any) => {
        const chatSessions = s.chatSessions || {};
        let changed = false;
        const nextSessions: Record<string, any> = {};

        for (const [sp, session] of Object.entries(chatSessions) as Array<[string, any]>) {
          let sessionChanged = false;
          const items = (session.items || []).map((item: any) => {
            if (item.type !== 'message' || !item.data?.blocks) return item;
            let messageChanged = false;
            const blocks = item.data.blocks.map((b: any) => {
              const matchesType = b.type === 'settings_confirm'
                || b.type === 'cron_confirm'
                || b.type === 'session_confirmation';
              if (!matchesType || b.confirmId !== msg.confirmId) return b;
              messageChanged = true;
              return { ...b, status: nextStatusFor(b.type) };
            });
            if (!messageChanged) return item;
            sessionChanged = true;
            return { ...item, data: { ...item.data, blocks } };
          });
          if (!sessionChanged) {
            nextSessions[sp] = session;
            continue;
          }
          changed = true;
          changedPaths.push(sp);
          nextSessions[sp] = { ...session, items };
        }

        return changed ? { chatSessions: nextSessions } : {};
      });
      changedPaths = Array.from(new Set(changedPaths));
      for (const sp of changedPaths) bumpMessageLiveVersion(sp);
      break;
    }

    case 'apply_frontend_setting': {
      if (msg.key === 'theme') {
        window.applyTheme?.(msg.value);
        // 通知其他窗口（设置窗口等）同步主题
        window.platform?.settingsChanged?.('theme-changed', { theme: msg.value });
      }
      break;
    }

    case 'status': {
      // streamingSessions 维护 + 焦点 UI 占位一并由 applyStreamingStatus 处理
      applyStreamingStatus(msg.isStreaming, msg.sessionPath || null);
      break;
    }
  }
}
