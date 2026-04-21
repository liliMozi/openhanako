/**
 * BrowserViewerApp.tsx — 浏览器查看器工具栏
 *
 * 工具栏只负责按钮和标题显示。
 * WebContentsView 由 main.cjs 管理，attach 在工具栏下方区域。
 */

import { useState, useEffect } from 'react';
import { initTheme } from '../bootstrap';

declare function t(key: string): string;
declare function setTheme(name: string): void;

initTheme();

export function BrowserViewerApp() {
  const [title, setTitle] = useState('');
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);

  useEffect(() => {
    const hana = window.hana;

    // 监听主题切换
    hana?.onSettingsChanged?.((type: string, data: any) => {
      if (type === 'theme-changed' && data?.theme) setTheme(data.theme);
    });

    // 接收浏览器状态更新
    hana?.onBrowserUpdate?.((data: any) => {
      if (data.title) setTitle(data.title);
      if (data.canGoBack !== undefined) setCanBack(data.canGoBack);
      if (data.canGoForward !== undefined) setCanForward(data.canGoForward);
      if (data.running === false) {
        setTitle('');
        setCanBack(false);
        setCanForward(false);
      }
    });

    // i18n
    window.i18n?.load?.(navigator.language || 'zh');
  }, []);

  const hana = window.hana;

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          {/* Close */}
          <button
            className="tb-btn close-btn"
            title={t?.('browser.closeBtn') || ''}
            onClick={() => hana?.closeBrowserViewer?.()}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
              <path d="M4 4l6 6M10 4l-6 6" />
            </svg>
          </button>

          <div className="nav-sep" />

          {/* Back */}
          <button
            className={`tb-btn${canBack ? '' : ' disabled'}`}
            title={t?.('browser.back') || ''}
            onClick={() => hana?.browserGoBack?.()}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8.5 2.5L4.5 7l4 4.5" />
            </svg>
          </button>

          {/* Forward */}
          <button
            className={`tb-btn${canForward ? '' : ' disabled'}`}
            title={t?.('browser.forward') || ''}
            onClick={() => hana?.browserGoForward?.()}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5.5 2.5L9.5 7l-4 4.5" />
            </svg>
          </button>

          {/* Reload */}
          <button
            className="tb-btn"
            title={t?.('browser.reload') || ''}
            onClick={() => hana?.browserReload?.()}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 7a4 4 0 1 1-4-4" />
              <path d="M11 3v2.5H8.5" />
            </svg>
          </button>
        </div>

        {/* Drag area + title */}
        <div className="toolbar-drag">
          <span className="page-title">{title}</span>
        </div>

        {/* Emergency stop */}
        <div className="toolbar-right">
          <button
            className="stop-btn"
            title={t?.('browser.emergencyStop') || ''}
            onClick={() => hana?.browserEmergencyStop?.()}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <rect x="3" y="3" width="8" height="8" rx="1" fill="currentColor" stroke="none" />
            </svg>
          </button>
        </div>
      </div>

      {/* Card shadow frame (WebContentsView sits on top) */}
      <div className="card-frame" />
    </>
  );
}
