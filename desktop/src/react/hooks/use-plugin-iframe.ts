import { useEffect, useRef, useState, useCallback } from 'react';

type IframeStatus = 'loading' | 'ready' | 'error';

const HANDSHAKE_TIMEOUT_MS = 5000;
const TYPE_WHITELIST = ['ready', 'navigate-tab', 'resize-request'];

export function usePluginIframe(routeUrl: string | null) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<IframeStatus>('loading');
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!routeUrl) return;
    setStatus('loading');

    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data.type !== 'string') return;
      if (!TYPE_WHITELIST.includes(data.type)) return;

      if (data.type === 'ready') {
        clearTimeout(timeoutRef.current);
        setStatus('ready');
      }
      if (data.type === 'navigate-tab' && data.payload?.tab) {
        import('../components/channels/ChannelTabBar').then(m => m.switchTab(data.payload.tab));
      }
      if (data.type === 'resize-request' && typeof data.payload?.height === 'number') {
        const maxH = window.innerHeight - 48;
        const h = Math.max(100, Math.min(data.payload.height, maxH));
        const iframe = iframeRef.current;
        if (iframe) iframe.style.height = `${h}px`;
      }
    };

    window.addEventListener('message', onMessage);
    timeoutRef.current = setTimeout(() => setStatus('error'), HANDSHAKE_TIMEOUT_MS);

    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timeoutRef.current);
    };
  }, [routeUrl]);

  const postToIframe = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    seqRef.current += 1;
    iframe.contentWindow.postMessage({ type, payload, seq: seqRef.current }, '*');
  }, []);

  const retry = useCallback(() => {
    setStatus('loading');
    const iframe = iframeRef.current;
    if (iframe && routeUrl) {
      iframe.src = routeUrl;
    }
    timeoutRef.current = setTimeout(() => setStatus('error'), HANDSHAKE_TIMEOUT_MS);
  }, [routeUrl]);

  return { iframeRef, status, postToIframe, retry };
}
