import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { invalidateConfigCache } from '../../hooks/use-config';
import { useI18n } from '../../hooks/use-i18n';
import type { ThinkingLevel } from '../../stores/model-slice';
import styles from './InputArea.module.css';

const ALL_THINKING_LEVELS: ThinkingLevel[] = ['off', 'auto', 'high', 'xhigh'];

export function ThinkingLevelButton({ level, onChange, modelXhigh }: {
  level: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  modelXhigh: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const availableLevels = useMemo(() => {
    return ALL_THINKING_LEVELS.filter(lv => lv !== 'xhigh' || modelXhigh);
  }, [modelXhigh]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selectLevel = useCallback(async (next: ThinkingLevel) => {
    onChange(next);
    setOpen(false);
    try {
      await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thinking_level: next }),
      });
      invalidateConfigCache();
    } catch (err) {
      console.error('[thinking-level] save failed:', err);
    }
  }, [onChange]);

  const tLevel = (key: string, fallback: string) => {
    const v = t(key);
    return v !== key ? v : fallback;
  };

  const isOff = level === 'off';

  return (
    <div className={`${styles['thinking-selector']}${open ? ` ${styles.open}` : ''}`} ref={ref}>
      <button
        className={`${styles['thinking-pill']}${isOff ? '' : ` ${styles.active}`}`}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18h6" /><path d="M10 22h4" />
          <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0018 8 6 6 0 006 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5" />
          {isOff && <line x1="4" y1="4" x2="20" y2="20" strokeWidth="1.5" />}
        </svg>
      </button>
      {open && (
        <div className={styles['thinking-dropdown']}>
          {availableLevels.map(lv => (
            <button
              key={lv}
              className={`${styles['thinking-option']}${lv === level ? ` ${styles.active}` : ''}`}
              onClick={() => selectLevel(lv)}
            >
              <span>{tLevel(`input.thinkingLevel.${lv}`, lv)}</span>
              <span className={styles['thinking-option-desc']}>{tLevel(`input.thinkingDesc.${lv}`, '')}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
