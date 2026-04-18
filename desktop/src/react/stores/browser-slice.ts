import { useStore } from './index';

export interface BrowserSlice {
  /** 按 session path 存储的 browser 状态（权威源） */
  browserBySession: Record<string, { running: boolean; url: string | null; thumbnail: string | null }>;
}

export const createBrowserSlice = (
  set: (partial: Partial<BrowserSlice>) => void
): BrowserSlice => ({
  browserBySession: {},
});

// ── Selector hook ──

const DEFAULT_BROWSER_STATE = { running: false, url: null as string | null, thumbnail: null as string | null };

/** 获取指定 session 的浏览器状态。组件中使用此 hook 替代全局 browserRunning/browserUrl/browserThumbnail */
export function useBrowserState(sessionPath?: string | null) {
  return useStore(st => {
    const sp = sessionPath ?? st.currentSessionPath;
    if (!sp) return DEFAULT_BROWSER_STATE;
    return st.browserBySession[sp] || DEFAULT_BROWSER_STATE;
  });
}

/** 判断是否有任何 session 的浏览器正在运行 */
export function useAnyBrowserRunning() {
  return useStore(st => Object.values(st.browserBySession).some(b => b.running));
}
