/**
 * stream-resume.ts — 流恢复逻辑（从 app-ws-shim.ts 迁移）
 *
 * 管理 per-session 流元数据、断线重连后的 stream resume 请求和事件重放。
 * 不依赖 ctx 注入，通过 Zustand store 访问状态。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- WS 消息协议为动态 JSON，类型无法静态收窄 */

import { streamBufferManager } from '../hooks/use-stream-buffer';
import { useStore } from '../stores';
import { getWebSocket } from './websocket';
import { clearChat } from '../stores/agent-actions';
import { loadMessages } from '../stores/session-actions';

// 延迟导入，打破循环依赖
let _handleServerMessage: ((msg: any) => void) | null = null;
let _applyStreamingStatus: ((isStreaming: boolean) => void) | null = null;

export function injectHandlers(
  handleServerMessage: (msg: any) => void,
  applyStreamingStatus: (isStreaming: boolean) => void,
): void {
  _handleServerMessage = handleServerMessage;
  _applyStreamingStatus = applyStreamingStatus;
}

// ── 流恢复版本计数 ──
let _streamResumeRebuildVersion = 0;
let _streamResumeRebuildingFor: string | null = null;

// ── Session 流元数据（module-level，不走 Zustand） ──
const _sessionStreams: Record<string, { streamId: string | null; lastSeq: number }> = {};

export function getSessionStreamMeta(sessionPath?: string): { streamId: string | null; lastSeq: number } | null {
  const path = sessionPath || useStore.getState().currentSessionPath;
  if (!path) return null;
  if (!_sessionStreams[path]) {
    _sessionStreams[path] = { streamId: null, lastSeq: 0 };
  }
  return _sessionStreams[path];
}

export function isStreamScopedMessage(msg: any): boolean {
  return !!(msg && msg.sessionPath && (msg.streamId || Number.isFinite(msg.seq)));
}

export function updateSessionStreamMeta(meta: any = {}): void {
  const sessionPath = meta.sessionPath || useStore.getState().currentSessionPath;
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

export function isStreamResumeRebuilding(): string | null {
  return _streamResumeRebuildingFor;
}

export function requestStreamResume(sessionPath?: string, opts: any = {}): void {
  const path = sessionPath || useStore.getState().currentSessionPath;
  const ws = getWebSocket();
  if (!path || !ws || ws.readyState !== WebSocket.OPEN) return;
  const meta = getSessionStreamMeta(path) || { streamId: null, lastSeq: 0 };
  const fromStart = !!opts.fromStart;
  const streamId = opts.streamId !== undefined ? opts.streamId : (meta.streamId || null);
  const sinceSeq = Number.isFinite(opts.sinceSeq)
    ? Math.max(0, Math.floor(opts.sinceSeq))
    : (fromStart ? 0 : (meta.lastSeq || 0));
  ws.send(JSON.stringify({
    type: 'resume_stream',
    sessionPath: path,
    streamId,
    sinceSeq,
  }));
}

// ── 流恢复 / 重建 ──

async function rebuildCurrentSessionFromResume(msg: any): Promise<void> {
  const currentSessionPath = useStore.getState().currentSessionPath;
  const sessionPath = msg.sessionPath || currentSessionPath;
  if (!sessionPath || sessionPath !== currentSessionPath) return;

  const myVersion = ++_streamResumeRebuildVersion;
  _streamResumeRebuildingFor = sessionPath;
  try {
    // 清掉旧 buffer 防止脏写
    streamBufferManager.clear(sessionPath);

    clearChat();
    await loadMessages(sessionPath);

    if (myVersion !== _streamResumeRebuildVersion) return;
    if (useStore.getState().currentSessionPath !== sessionPath) return;

    const meta = getSessionStreamMeta(sessionPath);
    if (meta) {
      meta.streamId = msg.streamId || null;
      meta.lastSeq = 0;
    }

    for (const entry of msg.events || []) {
      _handleServerMessage?.({
        ...entry.event,
        sessionPath,
        streamId: msg.streamId || null,
        seq: entry.seq,
        __fromReplay: true,
      });
    }

    _applyStreamingStatus?.(msg.isStreaming);

    const ws = getWebSocket();
    if (useStore.getState().currentSessionPath === sessionPath && ws?.readyState === WebSocket.OPEN && msg.isStreaming) {
      requestStreamResume(sessionPath);
    }
  } finally {
    if (myVersion === _streamResumeRebuildVersion && _streamResumeRebuildingFor === sessionPath) {
      _streamResumeRebuildingFor = null;
    }
  }
}

export function replayStreamResume(msg: any): void {
  const currentSessionPath = useStore.getState().currentSessionPath;
  const sessionPath = msg.sessionPath || currentSessionPath;
  if (!sessionPath || sessionPath !== currentSessionPath) return;

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
    _handleServerMessage?.({
      ...entry.event,
      sessionPath,
      streamId: msg.streamId || null,
      seq: entry.seq,
      __fromReplay: true,
    });
  }

  _applyStreamingStatus?.(msg.isStreaming);
}
