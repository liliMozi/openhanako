/**
 * BrowserCard — 浏览器浮动卡片
 *
 * 替代旧 artifacts.js 的 renderBrowserCard 逻辑。
 * 当 browserRunning 为 true 时，在聊天区顶部显示浮动卡片。
 * 由 App.tsx 在 .main-content 内直接渲染。
 */

import { useCallback } from 'react';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';

export function BrowserCard() {
  const browserRunning = useStore(s => s.browserRunning);
  const browserUrl = useStore(s => s.browserUrl);
  const browserThumbnail = useStore(s => s.browserThumbnail);
  const setBrowserRunning = useStore(s => s.setBrowserRunning);
  const setBrowserThumbnail = useStore(s => s.setBrowserThumbnail);

  const handleClick = useCallback(() => {
    window.platform?.openBrowserViewer?.();
  }, []);

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setBrowserRunning(false);
    setBrowserThumbnail(null);
    window.platform?.browserEmergencyStop?.();
    const sessionPath = useStore.getState().currentSessionPath;
    if (sessionPath) {
      hanaFetch('/api/browser/close-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionPath }),
      }).catch(() => {});
    }
  }, [setBrowserRunning, setBrowserThumbnail]);

  if (!browserRunning) return null;

  let displayUrl = '';
  try {
    if (browserUrl) displayUrl = new URL(browserUrl).hostname;
  } catch {
    displayUrl = browserUrl || '';
  }

  return (
    <div className="browser-floating-card" id="browserFloatingCard" onClick={handleClick}>
      <div className="browser-floating-info">
        <div className="browser-floating-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="2" y1="12" x2="22" y2="12"></line>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
          </svg>
        </div>
        <div className="browser-floating-text">
          <div className="browser-floating-label">{(window.t ?? ((p: string) => p))('browser.using')}</div>
          {displayUrl && (
            <div className="browser-floating-url">{displayUrl}</div>
          )}
        </div>
      </div>
      <div className="browser-floating-right">
        {browserThumbnail && (
          <img
            className="browser-floating-thumb"
            src={`data:image/jpeg;base64,${browserThumbnail}`}
            alt=""
            draggable={false}
          />
        )}
        <button className="browser-floating-close" title={(window.t ?? ((p: string) => p))('browser.close')} onClick={handleClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12"></path>
          </svg>
        </button>
      </div>
    </div>
  );
}
