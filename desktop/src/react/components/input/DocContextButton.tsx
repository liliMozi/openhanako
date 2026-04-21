import { useI18n } from '../../hooks/use-i18n';
import styles from './InputArea.module.css';

export function DocContextButton({ active, disabled, onToggle }: {
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();

  return (
    <button
      className={`${styles['desk-context-btn']}${active ? ` ${styles.active}` : ''}`}
      title={t('input.docContext')}
      disabled={disabled}
      onClick={onToggle}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
      <span className={styles['desk-context-label']}>{t('input.docContext')}</span>
    </button>
  );
}
