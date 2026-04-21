/**
 * Settings window API utilities
 * 从 settings store 读 port/token，独立于主窗口
 */
import { useSettingsStore } from './store';

const DEFAULT_TIMEOUT = 30_000;

export function hanaUrl(path: string): string {
  const { serverPort, serverToken } = useSettingsStore.getState();
  const sep = path.includes('?') ? '&' : '?';
  const tokenParam = serverToken ? `${sep}token=${serverToken}` : '';
  return `http://127.0.0.1:${serverPort}${path}${tokenParam}`;
}

export async function hanaFetch(
  path: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { serverPort, serverToken } = useSettingsStore.getState();
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (serverToken) {
    headers['Authorization'] = `Bearer ${serverToken}`;
  }

  const { timeout = DEFAULT_TIMEOUT, signal: callerSignal, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  // If caller provided a signal, forward its abort to our controller
  if (callerSignal) {
    if (callerSignal.aborted) { controller.abort(); }
    else { callerSignal.addEventListener('abort', () => controller.abort(), { once: true }); }
  }

  try {
    const res = await fetch(`http://127.0.0.1:${serverPort}${path}`, {
      ...fetchOpts,
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`hanaFetch ${path}: ${res.status} ${res.statusText}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** 根据 yuan 类型返回 fallback 头像路径 */
export function yuanFallbackAvatar(yuan?: string): string {
  const t = window.t || ((k: string) => k);
  const types = (t('yuan.types') || {}) as Record<string, { avatar?: string }>;
  const entry = types[yuan || 'hanako'];
  return `assets/${entry?.avatar || 'Hanako.png'}`;
}
