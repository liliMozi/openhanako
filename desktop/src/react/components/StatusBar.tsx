import { useStore } from '../stores';
import { connectWebSocket } from '../services/websocket';
import styles from './StatusBar.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

export function StatusBar() {
  const wsState = useStore((s) => s.wsState);
  const attempt = useStore((s) => s.wsReconnectAttempt);

  if (wsState === 'connected') return null;

  return (
    <div className={styles.bar}>
      {wsState === 'reconnecting' && (
        <span className={styles.text}>{t('status.reconnecting')} ({attempt})</span>
      )}
      {wsState === 'disconnected' && (
        <>
          <span className={styles.text}>{t('status.disconnected')}</span>
          <button className={styles.reconnect} onClick={() => connectWebSocket()}>
            {t('status.reconnect')}
          </button>
        </>
      )}
    </div>
  );
}
