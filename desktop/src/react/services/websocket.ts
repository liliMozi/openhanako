/**
 * websocket.ts — WebSocket 连接管理（从 app-ws-shim.ts 迁移）
 *
 * 模块级 singleton，管理 WS 连接生命周期、重连逻辑。
 * 不依赖 ctx 注入，不依赖 React 组件生命周期。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { handleServerMessage, applyStreamingStatus } from './ws-message-handler';
import { requestStreamResume, injectHandlers } from './stream-resume';
import { useStore } from '../stores';
import { setStatus } from '../utils/ui-helpers';

declare function t(key: string, vars?: Record<string, string>): any;

// ── 模块级 WS 实例 ──
let _ws: WebSocket | null = null;

// ── WS 重连状态 ──
let _wsRetryDelay = 1000;
const WS_RETRY_MAX = 30000;
let _wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
let _wsResumeVersion = 0;

// 注入循环依赖的 handlers
injectHandlers(handleServerMessage, applyStreamingStatus);

/** 获取当前 WebSocket 实例 */
export function getWebSocket(): WebSocket | null {
  return _ws;
}

/** 发起 WebSocket 连接 */
export function connectWebSocket(port?: string, token?: string): void {
  // 如果没有传参，从 Zustand store 获取
  const storeState = useStore.getState();
  const serverPort = port || storeState.serverPort;
  const serverToken = token || storeState.serverToken;

  if (!serverPort) return;

  if (_wsRetryTimer) { clearTimeout(_wsRetryTimer); _wsRetryTimer = null; }
  if (_ws) {
    try { _ws.onclose = null; _ws.close(); } catch { /* silent */ }
  }

  const tokenParam = serverToken ? `?token=${serverToken}` : '';
  const url = `ws://127.0.0.1:${serverPort}/ws${tokenParam}`;
  _ws = new WebSocket(url);

  _ws.onopen = () => {
    useStore.setState({ connected: true });
    _wsRetryDelay = 1000;

    setStatus(t('status.connected'), true);

    const s = useStore.getState();
    if (s.currentSessionPath && s.isStreaming) {
      const myVersion = ++_wsResumeVersion;
      const targetPath = s.currentSessionPath;
      Promise.resolve().then(async () => {
        if (myVersion !== _wsResumeVersion) return;
        if (useStore.getState().currentSessionPath !== targetPath) return;
        requestStreamResume(targetPath);
      }).catch((err) => {
        console.error('[ws] reconnect resume failed:', err);
      });
    }
  };

  _ws.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (err) {
      console.error('[ws] message parse error:', err);
    }
  };

  _ws.onclose = () => {
    useStore.setState({ connected: false });
    setStatus(t('status.disconnected'), false);
    _wsRetryTimer = setTimeout(() => connectWebSocket(serverPort, serverToken), _wsRetryDelay);
    _wsRetryDelay = Math.min(_wsRetryDelay * 2, WS_RETRY_MAX);
  };

  _ws.onerror = () => {};
}
