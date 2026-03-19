/**
 * app-ws-shim.ts — WebSocket 连接 / 消息分发 / 流恢复
 *
 * 从 app.js 提取（Phase 4），ctx 注入模式。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { streamBufferManager } from '../hooks/use-stream-buffer';

declare function t(key: string, vars?: Record<string, string>): any;

interface AppWsCtx {
  state: Record<string, any>;
  chatArea: HTMLElement;
  md: { render: (src: string) => string };
  scrollToBottom: () => void;
  setStatus: (text: string, connected: boolean) => void;
  showError: (message: string) => void;
  injectCopyButtons: (el: HTMLElement) => void;
  escapeHtml: (s: string) => string;
  platform: Record<string, any>;
  _cr: () => Record<string, any>;
  _fc: () => Record<string, any>;
  _ar: () => Record<string, any>;
  _sb: () => Record<string, any>;
  _ch: () => Record<string, any>;
  _dk: () => Record<string, any>;
  _msg: () => Record<string, any>;
  _ag: () => Record<string, any>;
}

let ctx: AppWsCtx;

// ── WS 重连状态 ──
let _wsRetryDelay = 1000;
const WS_RETRY_MAX = 30000;
let _wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
let _wsResumeVersion = 0;

// ── 流恢复状态 ──
let _streamResumeRebuildVersion = 0;
let _streamResumeRebuildingFor: string | null = null;

// ── Session 流元数据 ──

function getSessionStreamMeta(sessionPath?: string): { streamId: string | null; lastSeq: number } | null {
  const path = sessionPath || ctx.state.currentSessionPath;
  if (!path) return null;
  if (!ctx.state.sessionStreams[path]) {
    ctx.state.sessionStreams[path] = { streamId: null, lastSeq: 0 };
  }
  return ctx.state.sessionStreams[path];
}

function isStreamScopedMessage(msg: any): boolean {
  return !!(msg && msg.sessionPath && (msg.streamId || Number.isFinite(msg.seq)));
}

function updateSessionStreamMeta(meta: any = {}): void {
  const sessionPath = meta.sessionPath || ctx.state.currentSessionPath;
  if (!sessionPath) return;

  const entry = getSessionStreamMeta(sessionPath);
  if (!entry) return;

  if (meta.streamId) {
    if (entry.streamId && entry.streamId !== meta.streamId) {
      entry.lastSeq = 0;
    }
    entry.streamId = meta.streamId;
  }

  if (Number.isFinite(meta.seq)) {
    entry.lastSeq = Math.max(entry.lastSeq || 0, meta.seq);
  }
}

function requestStreamResume(sessionPath?: string, opts: any = {}): void {
  const { state } = ctx;
  const path = sessionPath || state.currentSessionPath;
  if (!path || state.ws?.readyState !== WebSocket.OPEN) return;
  const meta = getSessionStreamMeta(path) || { streamId: null, lastSeq: 0 };
  const fromStart = !!opts.fromStart;
  const streamId = opts.streamId !== undefined ? opts.streamId : (meta.streamId || null);
  const sinceSeq = Number.isFinite(opts.sinceSeq)
    ? Math.max(0, Math.floor(opts.sinceSeq))
    : (fromStart ? 0 : (meta.lastSeq || 0));
  state.ws.send(JSON.stringify({
    type: 'resume_stream',
    sessionPath: path,
    streamId,
    sinceSeq,
  }));
}

// ── Session 可见性 + 流状态 ──

function ensureCurrentSessionVisible(): void {
  const { state } = ctx;
  const sessionPath = state.currentSessionPath;
  if (!sessionPath || state.pendingNewSession) return;
  if (state.sessions.some((s: any) => s.path === sessionPath)) return;

  state.sessions = [{
    path: sessionPath,
    title: null,
    firstMessage: '',
    modified: new Date().toISOString(),
    messageCount: 0,
    agentId: state.currentAgentId || null,
    agentName: state.agentName || null,
    _optimistic: true,
  }, ...state.sessions];
}

function hasOptimisticCurrentSession(): boolean {
  const { state } = ctx;
  const sessionPath = state.currentSessionPath;
  if (!sessionPath) return false;
  return !!state.sessions.find((s: any) => s.path === sessionPath && s._optimistic);
}

function applyStreamingStatus(isStreaming: boolean): void {
  const { state } = ctx;
  state.isStreaming = !!isStreaming;
  if (state.isStreaming) {
    ensureCurrentSessionVisible();
  } else {
    // React 模式：消息完成由 StreamBuffer turn_end 处理
    if (hasOptimisticCurrentSession()) {
      ctx._sb().loadSessions().catch(() => {});
    }
  }
}

// ── 流恢复 / 重建 ──

async function rebuildCurrentSessionFromResume(msg: any): Promise<void> {
  const { state } = ctx;
  const sessionPath = msg.sessionPath || state.currentSessionPath;
  if (!sessionPath || sessionPath !== state.currentSessionPath) return;

  const myVersion = ++_streamResumeRebuildVersion;
  _streamResumeRebuildingFor = sessionPath;
  try {
    // 清掉旧 buffer 防止脏写
    streamBufferManager.clear(sessionPath);
    ctx._ag().clearChat();
    await ctx._msg().loadMessages();

    if (myVersion !== _streamResumeRebuildVersion) return;
    if (state.currentSessionPath !== sessionPath) return;

    const meta = getSessionStreamMeta(sessionPath);
    if (meta) {
      meta.streamId = msg.streamId || null;
      meta.lastSeq = 0;
    }

    for (const entry of msg.events || []) {
      handleServerMessage({
        ...entry.event,
        sessionPath,
        streamId: msg.streamId || null,
        seq: entry.seq,
        __fromReplay: true,
      });
    }

    applyStreamingStatus(msg.isStreaming);

    if (state.currentSessionPath === sessionPath && state.ws?.readyState === WebSocket.OPEN && msg.isStreaming) {
      requestStreamResume(sessionPath);
    }
  } finally {
    if (myVersion === _streamResumeRebuildVersion && _streamResumeRebuildingFor === sessionPath) {
      _streamResumeRebuildingFor = null;
    }
  }
}

function replayStreamResume(msg: any): void {
  const { state } = ctx;
  const sessionPath = msg.sessionPath || state.currentSessionPath;
  if (!sessionPath || sessionPath !== state.currentSessionPath) return;

  if (msg.reset || msg.truncated) {
    rebuildCurrentSessionFromResume(msg).catch((err) => {
      console.error('[stream] rebuild failed:', err);
      _streamResumeRebuildingFor = null;
    });
    return;
  }

  const meta = getSessionStreamMeta(sessionPath);
  if (meta && msg.streamId) {
    if (msg.reset) meta.lastSeq = 0;
    if (meta.streamId && meta.streamId !== msg.streamId) {
      meta.lastSeq = 0;
    }
    meta.streamId = msg.streamId;
  }

  for (const entry of msg.events || []) {
    handleServerMessage({
      ...entry.event,
      sessionPath,
      streamId: msg.streamId || null,
      seq: entry.seq,
      __fromReplay: true,
    });
  }

  applyStreamingStatus(msg.isStreaming);
}

// ── WebSocket 连接 ──

function connectWS(): void {
  const { state } = ctx;
  if (_wsRetryTimer) { clearTimeout(_wsRetryTimer); _wsRetryTimer = null; }
  if (state.ws) {
    try { state.ws.onclose = null; state.ws.close(); } catch { /* silent */ }
  }

  const tokenParam = state.serverToken ? `?token=${state.serverToken}` : '';
  const url = `ws://127.0.0.1:${state.serverPort}/ws${tokenParam}`;
  state.ws = new WebSocket(url);

  state.ws.onopen = () => {
    state.connected = true;
    _wsRetryDelay = 1000;
    ctx.setStatus(t('status.connected'), true);

    if (state.currentSessionPath && state.isStreaming) {
      const myVersion = ++_wsResumeVersion;
      const targetPath = state.currentSessionPath;
      Promise.resolve().then(async () => {
        if (myVersion !== _wsResumeVersion) return;
        if (state.currentSessionPath !== targetPath) return;
        requestStreamResume(targetPath);
      }).catch((err) => {
        console.error('[ws] reconnect resume failed:', err);
      });
    }
  };

  state.ws.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (err) {
      console.error('[ws] message parse error:', err);
    }
  };

  state.ws.onclose = () => {
    state.connected = false;
    ctx.setStatus(t('status.disconnected'), false);
    _wsRetryTimer = setTimeout(connectWS, _wsRetryDelay);
    _wsRetryDelay = Math.min(_wsRetryDelay * 2, WS_RETRY_MAX);
  };

  state.ws.onerror = () => {};
}

// ── 消息分发（大 switch） ──

function handleServerMessage(msg: any): void {
  const { state, md, scrollToBottom, showError, injectCopyButtons } = ctx;
  const _cr = ctx._cr;
  const _fc = ctx._fc;
  const _ar = ctx._ar;
  const _sb = ctx._sb;
  const _ch = ctx._ch;
  const _dk = ctx._dk;
  const _msg = ctx._msg;

  if (_streamResumeRebuildingFor && msg.type === 'status' && state.currentSessionPath === _streamResumeRebuildingFor) {
    return;
  }

  if (
    _streamResumeRebuildingFor &&
    isStreamScopedMessage(msg) &&
    msg.sessionPath === _streamResumeRebuildingFor &&
    !msg.__fromReplay &&
    msg.type !== 'stream_resume'
  ) {
    return;
  }

  if (msg.type !== 'stream_resume' && isStreamScopedMessage(msg)) {
    updateSessionStreamMeta(msg);
  }

  // React 模式：stream 事件由 StreamBufferManager 按 sessionPath 路由，无需 PanelManager

  // ── React 聊天渲染路径：聊天相关事件走 StreamBufferManager ──
  const REACT_CHAT_EVENTS = new Set([
    'text_delta', 'thinking_start', 'thinking_delta', 'thinking_end',
    'mood_start', 'mood_text', 'mood_end',
    'xing_start', 'xing_text', 'xing_end',
    'tool_start', 'tool_end', 'turn_end',
    'file_output', 'skill_activated', 'artifact',
    'browser_screenshot', 'cron_confirmation',
    'compaction_start', 'compaction_end',
  ]);
  if (REACT_CHAT_EVENTS.has(msg.type)) {
    streamBufferManager.handle(msg);
    // turn_end 后仍需执行部分通用逻辑（loadSessions、context_usage）
    if (msg.type === 'turn_end') {
      _sb().loadSessions();
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'context_usage' }));
      }
    }
    // tool_end 后更新 todo
    if (msg.type === 'tool_end' && msg.name === 'todo' && msg.details?.todos) {
      state.sessionTodos = msg.details.todos;
    }
    // compaction_end 后更新 token
    if (msg.type === 'compaction_end') {
      state._compacting = false;
      if (msg.tokens != null && msg.contextWindow != null) {
        state.contextTokens = msg.tokens;
        state.contextWindow = msg.contextWindow;
        state.contextPercent = msg.percent;
      }
    }
    if (msg.type === 'compaction_start') {
      state._compacting = true;
    }
    // artifact 需要通知 artifacts shim 更新预览
    if (msg.type === 'artifact' && state.currentTab === 'chat') {
      _ar().handleArtifact(msg);
    }
    // scrollToBottom 由 Virtuoso followOutput 自动处理
    return;
  }

  // 非聊天渲染事件走传统 switch
  switch (msg.type) {
    case 'stream_resume':
      replayStreamResume(msg);
      break;

    case 'session_title':
      if (msg.title) {
        state.sessions = state.sessions.map((s: any) =>
          s.path === msg.path ? { ...s, title: msg.title } : s,
        );
      }
      break;

    case 'desk_changed':
      _dk().loadDeskFiles();
      break;

    case 'browser_status':
      state.browserRunning = !!msg.running;
      state.browserUrl = msg.url || null;
      if (msg.thumbnail) state.browserThumbnail = msg.thumbnail;
      if (!msg.running) state.browserThumbnail = null;
      _ar().renderBrowserCard();
      if (ctx.platform?.updateBrowserViewer) {
        ctx.platform.updateBrowserViewer({
          running: state.browserRunning,
          url: state.browserUrl,
          thumbnail: state.browserThumbnail,
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
        state.activities = [msg.activity, ...state.activities.slice(0, 499)];
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

    case 'channel_new_message':
      if (msg.channelName && state.currentChannel === msg.channelName) {
        _ch().openChannel(msg.channelName);
      } else if (msg.channelName) {
        _ch().loadChannels();
      }
      break;

    case 'dm_new_message': {
      const dmId = `dm:${msg.from}`;
      if (state.currentChannel === dmId) {
        _ch().openChannel(dmId, true);
      } else {
        _ch().loadChannels();
      }
      break;
    }
      // 更新 token 用量
      if (msg.tokens != null && msg.contextWindow != null) {
        state.contextTokens = msg.tokens;
        state.contextWindow = msg.contextWindow;
        state.contextPercent = msg.percent;
      }
      break;

    case 'context_usage':
      if (msg.tokens != null && msg.contextWindow != null) {
        state.contextTokens = msg.tokens;
        state.contextWindow = msg.contextWindow;
        state.contextPercent = msg.percent;
      }
      break;

    case 'error':
      showError(msg.message);
      break;

    case 'status': {
      // 元数据层：维护所有 session 的 streaming 状态
      const sp = msg.sessionPath;
      if (sp) {
        const list: string[] = state.streamingSessions || [];
        if (msg.isStreaming) {
          if (!list.includes(sp)) state.streamingSessions = [...list, sp];
        } else {
          state.streamingSessions = list.filter((p: string) => p !== sp);
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

// ── Setup ──

/**
 * 提前锁定 stream resume：切到正在 streaming 的 session 前调用，
 * 阻止实时事件写 DOM，直到 stream_resume 回放完成。
 */
function lockStreamResumeFor(sessionPath: string): void {
  ++_streamResumeRebuildVersion;
  _streamResumeRebuildingFor = sessionPath;
}

export function setupAppWsShim(modules: Record<string, unknown>): void {
  modules.appWs = {
    connectWS,
    handleServerMessage,
    requestStreamResume,
    applyStreamingStatus,
    lockStreamResumeFor,
    initAppWs: (injected: AppWsCtx) => { ctx = injected; },
  };
}
