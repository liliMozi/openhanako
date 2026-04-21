import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock useStore before importing hanaFetch
vi.mock('../../stores', () => ({
  useStore: {
    getState: () => ({
      serverPort: '3210',
      serverToken: 'test-token-123',
    }),
  },
}));

import { hanaUrl, hanaFetch } from '../../hooks/use-hana-fetch';

describe('hanaUrl', () => {
  it('构建带 token 的 URL', () => {
    const url = hanaUrl('/api/health');
    expect(url).toBe('http://127.0.0.1:3210/api/health?token=test-token-123');
  });

  it('路径已有 query param 时用 & 连接', () => {
    const url = hanaUrl('/api/sessions?limit=10');
    expect(url).toBe('http://127.0.0.1:3210/api/sessions?limit=10&token=test-token-123');
  });
});

describe('hanaFetch', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('发送带 Authorization header 的请求', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok' }),
    });

    await hanaFetch('/api/health');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3210/api/health');
    expect(opts.headers.Authorization).toBe('Bearer test-token-123');
  });

  it('非 2xx 状态码抛出错误', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(hanaFetch('/api/missing')).rejects.toThrow('404');
  });

  it('传递自定义 method 和 headers', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await hanaFetch('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const call = mockFetch.mock.calls[0];
    const url = call[0];
    const opts = call[1];
    expect(url).toBe('http://127.0.0.1:3210/api/test');
    // headers 被合并，Authorization 被注入
    expect(opts.headers).toHaveProperty('Authorization', 'Bearer test-token-123');
  });

  it('传递 AbortSignal 用于超时', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await hanaFetch('/api/test');

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});
