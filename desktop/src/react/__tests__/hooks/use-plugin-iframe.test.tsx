/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { usePluginIframe } from '../../hooks/use-plugin-iframe';

const switchTab = vi.fn();

vi.mock('../../components/channels/ChannelTabBar', () => ({
  switchTab: (...args: unknown[]) => switchTab(...args),
}));

function attachIframeWindow(iframe: HTMLIFrameElement, contentWindow: Window & { postMessage: ReturnType<typeof vi.fn> }) {
  Object.defineProperty(iframe, 'contentWindow', {
    configurable: true,
    value: contentWindow,
  });
}

function Harness({ routeUrl }: { routeUrl: string | null }) {
  const { iframeRef, status, postToIframe } = usePluginIframe(routeUrl);
  return (
    <div>
      <div data-testid="status">{status}</div>
      <iframe ref={iframeRef} data-testid="iframe" />
      <button onClick={() => postToIframe('visibility-changed', { visible: true })}>post</button>
    </div>
  );
}

describe('usePluginIframe', () => {
  afterEach(() => {
    cleanup();
    switchTab.mockReset();
  });

  it('只接受来自预期 iframe 窗口和 origin 的 ready 消息', () => {
    render(<Harness routeUrl="http://127.0.0.1:3210/api/plugins/demo/page?token=abc" />);
    const iframe = screen.getByTestId('iframe') as HTMLIFrameElement;
    const trustedWindow = { postMessage: vi.fn() } as unknown as Window & { postMessage: ReturnType<typeof vi.fn> };
    attachIframeWindow(iframe, trustedWindow);

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'ready' },
        origin: 'http://evil.test',
        source: trustedWindow,
      }));
    });
    expect(screen.getByTestId('status').textContent).toBe('loading');

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'ready' },
        origin: 'http://127.0.0.1:3210',
        source: { postMessage: vi.fn() } as unknown as Window,
      }));
    });
    expect(screen.getByTestId('status').textContent).toBe('loading');

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'ready' },
        origin: 'http://127.0.0.1:3210',
        source: trustedWindow,
      }));
    });
    expect(screen.getByTestId('status').textContent).toBe('ready');
  });

  it('navigate-tab 只接受可信消息，postToIframe 使用精确 targetOrigin', async () => {
    render(<Harness routeUrl="http://127.0.0.1:3210/api/plugins/demo/widget?token=abc" />);
    const iframe = screen.getByTestId('iframe') as HTMLIFrameElement;
    const trustedWindow = { postMessage: vi.fn() } as unknown as Window & { postMessage: ReturnType<typeof vi.fn> };
    attachIframeWindow(iframe, trustedWindow);

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'navigate-tab', payload: { tab: 'channels' } },
        origin: 'http://evil.test',
        source: trustedWindow,
      }));
    });
    await Promise.resolve();
    expect(switchTab).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'navigate-tab', payload: { tab: 'channels' } },
        origin: 'http://127.0.0.1:3210',
        source: trustedWindow,
      }));
    });
    await waitFor(() => expect(switchTab).toHaveBeenCalledWith('channels'));

    fireEvent.click(screen.getByText('post'));
    expect(trustedWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'visibility-changed',
        payload: { visible: true },
        seq: 1,
      }),
      'http://127.0.0.1:3210',
    );
  });
});
