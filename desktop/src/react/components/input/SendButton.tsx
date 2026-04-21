import { useI18n } from '../../hooks/use-i18n';
import styles from './InputArea.module.css';

export function SendButton({ isStreaming, hasInput, disabled, onSend, onSteer, onStop }: {
  isStreaming: boolean;
  hasInput: boolean;
  disabled: boolean;
  onSend: () => void;
  onSteer: () => void;
  onStop: () => void;
}) {
  const { t } = useI18n();

  // 三态：发送 / 插话 / 停止
  const mode = isStreaming ? (hasInput ? 'steer' : 'stop') : 'send';

  return (
    <button
      className={`${styles['send-btn']}${mode === 'steer' ? ` ${styles['is-steer']}` : mode === 'stop' ? ` ${styles['is-streaming']}` : ''}`}
      disabled={disabled}
      onClick={mode === 'steer' ? onSteer : mode === 'stop' ? onStop : onSend}
    >
      {mode === 'send' && (
        <span className={styles['send-label']}>
          <svg className={styles['send-enter-icon']} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 01-4 4H4" />
          </svg>
          <span>{t('chat.send')}</span>
        </span>
      )}
      {mode === 'steer' && (
        <span className={styles['send-label']}>
          <svg className={styles['send-enter-icon']} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>{t('chat.steer')}</span>
        </span>
      )}
      {mode === 'stop' && (
        <span className={styles['send-label']}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
          <span>{t('chat.stop')}</span>
        </span>
      )}
    </button>
  );
}
