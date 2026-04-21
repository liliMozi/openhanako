import { useCallback } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import styles from './InputArea.module.css';

export function PlanModeButton({ enabled, onToggle }: {
  enabled: boolean;
  onToggle: (v: boolean) => void;
}) {
  const { t } = useI18n();

  const handleClick = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/plan-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });
      const data = await res.json();
      onToggle(data.enabled);
    } catch (err) {
      console.error('[plan-mode] toggle failed:', err);
    }
  }, [enabled, onToggle]);

  return (
    <button
      className={`${styles['plan-mode-btn']}${!enabled ? ` ${styles.active}` : ''}`}
      title={t('input.planMode')}
      onClick={handleClick}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
      </svg>
      <span className={styles['plan-mode-label']}>{t('input.planMode')}</span>
    </button>
  );
}
