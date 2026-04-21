import { useEffect, useMemo } from 'react';
import { useStore } from '../../stores';
import { usePluginIframe } from '../../hooks/use-plugin-iframe';
import { hanaUrl } from '../../hooks/use-hana-fetch';
import s from './PluginPageView.module.css';

interface Props {
  pluginId: string;
}

export function PluginPageView({ pluginId }: Props) {
  const pages = useStore(st => st.pluginPages);
  const agentId = useStore(st => st.currentAgentId);
  const page = useMemo(() => pages.find(p => p.pluginId === pluginId), [pages, pluginId]);

  const iframeSrc = useMemo(() => {
    if (!page?.routeUrl) return null;
    const theme = document.documentElement.dataset.theme || 'warm-paper';
    const cssUrl = hanaUrl(`/api/plugins/theme.css?theme=${encodeURIComponent(theme)}`);
    const fullUrl = hanaUrl(page.routeUrl);
    const sep = fullUrl.includes('?') ? '&' : '?';
    return `${fullUrl}${sep}agentId=${encodeURIComponent(agentId || '')}&hana-theme=${encodeURIComponent(theme)}&hana-css=${encodeURIComponent(cssUrl)}`;
  }, [page?.routeUrl, agentId]);

  const { iframeRef, status, postToIframe, retry } = usePluginIframe(iframeSrc);

  useEffect(() => {
    if (status === 'ready') postToIframe('visibility-changed', { visible: true });
    return () => { postToIframe('visibility-changed', { visible: false }); };
  }, [status, postToIframe]);

  if (!page) {
    return (
      <div className={s.container}>
        <div className={s.error}>插件未找到</div>
      </div>
    );
  }

  return (
    <div className={s.container}>
      {status === 'loading' && (
        <div className={s.overlay}><div className={s.spinner} /></div>
      )}
      {status === 'error' && (
        <div className={s.overlay}>
          <p>插件加载失败</p>
          <button className={s.retryBtn} onClick={retry}>重试</button>
        </div>
      )}
      <iframe
        ref={iframeRef}
        className={s.iframe}
        src={iframeSrc || undefined}
        sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
        style={{ opacity: status === 'ready' ? 1 : 0 }}
      />
    </div>
  );
}
