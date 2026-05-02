import { useCallback, useEffect, useRef, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { useStore } from '../../stores';
import styles from './InputArea.module.css';

export type PermissionMode = 'operate' | 'ask' | 'read_only';

const PERMISSION_MODES: PermissionMode[] = ['operate', 'ask', 'read_only'];

function permissionModeLabelKey(mode: PermissionMode) {
  if (mode === 'read_only') return 'input.readOnlyMode';
  if (mode === 'ask') return 'input.askMode';
  return 'input.operateMode';
}

function PermissionModeIcon({ mode }: { mode: PermissionMode }) {
  if (mode === 'read_only') {
    return (
      <svg data-permission-mode={mode} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="11" width="14" height="9" rx="1.5" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
    );
  }
  if (mode === 'ask') {
    return (
      <svg data-permission-mode={mode} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.7-2.5 2-2.5 4" />
        <path d="M12 17h.01" />
      </svg>
    );
  }
  return (
    <svg data-permission-mode={mode} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

export function PlanModeButton({ mode, onChange, locked = false }: {
  mode: PermissionMode;
  onChange: (v: PermissionMode) => void;
  locked?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selectMode = useCallback(async (nextMode: PermissionMode) => {
    setOpen(false);
    if (nextMode === mode) return;
    try {
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
      console.error('[plan-mode] select failed:', err);
    }
  }, [mode, onChange, t]);

  const label = t(permissionModeLabelKey(mode));

  return (
    <div className={`${styles['thinking-selector']} ${styles['plan-mode-selector']}${open ? ` ${styles.open}` : ''}`} ref={ref}>
      <button
        className={`${styles['plan-mode-btn']} ${styles[`plan-mode-${mode}`] || ''}`}
        title={locked ? t('input.accessModeLocked') : t('input.accessMode')}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        disabled={locked}
      >
        <PermissionModeIcon mode={mode} />
        <span className={styles['plan-mode-label']}>{label}</span>
      </button>
      {open && (
        <div className={`${styles['thinking-dropdown']} ${styles['plan-mode-dropdown']}`}>
          {PERMISSION_MODES.map((permissionMode) => (
            <button
              key={permissionMode}
              className={`${styles['thinking-option']}${permissionMode === mode ? ` ${styles.active}` : ''}`}
              onClick={() => selectMode(permissionMode)}
            >
              <span>{t(permissionModeLabelKey(permissionMode))}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
