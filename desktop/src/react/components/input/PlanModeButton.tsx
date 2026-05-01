import { useCallback } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { useStore } from '../../stores';
import styles from './InputArea.module.css';

export type PermissionMode = 'operate' | 'ask' | 'read_only';

const NEXT_MODE: Record<PermissionMode, PermissionMode> = {
  operate: 'ask',
  ask: 'read_only',
  read_only: 'operate',
};

export function PlanModeButton({ mode, onChange, locked = false }: {
  mode: PermissionMode;
  onChange: (v: PermissionMode) => void;
  locked?: boolean;
}) {
  const { t } = useI18n();

  const handleClick = useCallback(async () => {
    try {
      const nextMode = NEXT_MODE[mode] || 'ask';
      const pendingNewSession = useStore.getState().pendingNewSession === true;
      const res = await hanaFetch('/api/session-permission-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: nextMode, pendingNewSession }),
      });
      const data = await res.json();
      if (data.locked) {
        window.dispatchEvent(new CustomEvent('hana-inline-notice', {
          detail: { text: t('input.accessModeLocked'), type: 'error' },
        }));
      }
      onChange((data.mode || nextMode) as PermissionMode);
    } catch (err) {
      console.error('[plan-mode] toggle failed:', err);
    }
  }, [mode, onChange, t]);

  const label = mode === 'read_only'
    ? t('input.readOnlyMode')
    : (mode === 'ask' ? t('input.askMode') : t('input.operateMode'));

  return (
    <button
      className={`${styles['plan-mode-btn']} ${styles[`plan-mode-${mode}`] || ''}`}
      title={locked ? t('input.accessModeLocked') : t('input.accessMode')}
      onClick={handleClick}
      disabled={locked}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
      </svg>
      <span className={styles['plan-mode-label']}>{label}</span>
    </button>
  );
}
