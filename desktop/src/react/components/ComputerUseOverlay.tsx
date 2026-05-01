import { useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { useStore } from '../stores';
import { computeComputerOverlayPosition } from '../stores/computer-overlay-slice';
import { getWebSocket } from '../services/websocket';
import styles from './ComputerUseOverlay.module.css';

export function ComputerUseOverlay() {
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const event = useStore(s => currentSessionPath ? s.computerOverlayBySession[currentSessionPath] : null);

  const position = useMemo(() => computeComputerOverlayPosition(event), [event]);
  const foregroundTakeover = !!event && event.inputMode === 'foreground-input' && event.phase !== 'done' && event.phase !== 'error';

  useEffect(() => {
    if (!foregroundTakeover || !currentSessionPath) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      getWebSocket()?.send(JSON.stringify({
        type: 'abort',
        sessionPath: currentSessionPath,
      }));
      useStore.getState().clearComputerOverlayForSession(currentSessionPath);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentSessionPath, foregroundTakeover]);

  if (!event) return null;

  const providerVisualSurface = event.visualSurface === 'provider';
  if (providerVisualSurface && !foregroundTakeover) return null;

  const cssVars = {
    '--cu-x': `${position.x}%`,
    '--cu-y': `${position.y}%`,
  } as CSSProperties;
  const pulseKey = `${event.leaseId || ''}:${event.snapshotId || ''}:${event.phase}:${event.ts}`;
  const shouldRenderCursor = !providerVisualSurface;
  const shouldPulse = shouldRenderCursor && (event.phase === 'done' || event.phase === 'error');

  return (
    <div className={styles.overlay}>
      {foregroundTakeover && (
        <div className={styles.takeoverNotice} role="status">
          <strong>前台接管</strong>
          <span>目标应用不支持后台操作，正在由前台接管。按 Esc 强制退出。</span>
        </div>
      )}
      {shouldRenderCursor && (
        <div
          className={[
            styles.cursor,
            event.phase === 'running' && styles.running,
            event.phase === 'error' && styles.error,
            foregroundTakeover && styles.foreground,
          ].filter(Boolean).join(' ')}
          style={cssVars}
          data-action={event.action}
          aria-hidden="true"
        >
          <svg className={styles.cursorSvg} viewBox="0 0 24 24" fill="none">
            <path
              className={styles.fill}
              d="M3 3L10 22L12.0513 15.8461C12.6485 14.0544 14.0544 12.6485 15.846 12.0513L22 10L3 3Z"
            />
            <path
              className={styles.stroke}
              d="M3 3L10 22L12.0513 15.8461C12.6485 14.0544 14.0544 12.6485 15.846 12.0513L22 10L3 3Z"
            />
          </svg>
        </div>
      )}
      {shouldPulse && (
        <span
          key={pulseKey}
          className={`${styles.pulse} ${styles.showPulse}`}
          style={cssVars}
        />
      )}
    </div>
  );
}
