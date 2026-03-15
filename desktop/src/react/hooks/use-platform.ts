import type { PlatformApi } from '../types';

declare global {
  interface Window {
    platform: PlatformApi;
  }
}

/**
 * 获取平台 API（Electron IPC 或 Web fallback）
 * platform.js 在 React 之前加载，所以 window.platform 始终可用
 */
export function usePlatform(): PlatformApi {
  return window.platform;
}
