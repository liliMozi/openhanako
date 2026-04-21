import { useRef, useEffect, useState, useMemo } from 'react';
import { hanaUrl } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';
import type { PluginCardDetails } from '../../types';
import s from './PluginCardBlock.module.css';

interface Props { card: PluginCardDetails; }

const MAX_W = 400;
const MAX_H = 600;

function parseRatio(raw?: string): number {
  if (!raw) return 0;
  const [w, h] = raw.split(':').map(Number);
  return (w && h) ? w / h : 0;
}

export function PluginCardBlock({ card }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const agentId = useStore(st => st.currentAgentId);

  // Compute initial size from aspectRatio hint; 0 means unknown
  const ratio = parseRatio(card.aspectRatio);
  const defaultW = MAX_W;
  const defaultH = ratio > 0
    ? Math.min(Math.round(defaultW / ratio), MAX_H)
    : Math.round(defaultW * 0.75); // 4:3 fallback for old cards

  const [size, setSize] = useState({ w: defaultW, h: defaultH });

  const isIframe = !card.type || card.type === 'iframe';

  const src = useMemo(() => {
    if (!isIframe) return '';
    const theme = document.documentElement.dataset.theme || 'warm-paper';
    const cssUrl = hanaUrl(`/api/plugins/theme.css?theme=${encodeURIComponent(theme)}`);
    const base = hanaUrl(`/api/plugins/${card.pluginId}${card.route}`);
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}agentId=${encodeURIComponent(agentId || '')}&hana-theme=${encodeURIComponent(theme)}&hana-css=${encodeURIComponent(cssUrl)}`;
  }, [card.pluginId, card.route, isIframe, agentId]);

  useEffect(() => {
    if (!isIframe) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (e.data?.type === 'ready') setReady(true);
      if (e.data?.type === 'resize-request') {
        const { width, height } = e.data.payload || {};
        setSize(prev => ({
          w: typeof width === 'number' && width >= 50 ? Math.min(width, MAX_W) : prev.w,
          h: typeof height === 'number' && height >= 30 ? Math.min(height, MAX_H) : prev.h,
        }));
      }
    };
    window.addEventListener('message', onMessage);
    const timeout = setTimeout(() => setReady(true), 5000);
    return () => { window.removeEventListener('message', onMessage); clearTimeout(timeout); };
  }, [isIframe]);

  if (!isIframe || error) {
    if (!card.description) return null;
    return (
      <div className={s.container}>
        {card.title && <div className={s.title}>{card.title}</div>}
        <div className={s.description}>{card.description}</div>
      </div>
    );
  }

  return (
    <div className={s.container}>
      <iframe
        ref={iframeRef}
        className={s.iframe}
        src={src}
        sandbox="allow-scripts allow-same-origin"
        style={{ width: size.w, height: size.h, opacity: ready ? 1 : 0.3 }}
        onError={() => setError(true)}
      />
    </div>
  );
}
