import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import styles from './InputArea.module.css';

export function ModelSelector({ models, disabled }: { models: Array<{ id: string; name: string; provider?: string; isCurrent?: boolean }>; disabled?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = models.find(m => m.isCurrent);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const switchModel = useCallback(async (modelId: string) => {
    try {
      await hanaFetch('/api/models/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      });
      const res = await hanaFetch('/api/models/favorites');
      const data = await res.json();
      useStore.setState({ models: data.models || [] });
    } catch (err) {
      console.error('[model] switch failed:', err);
    }
    setOpen(false);
  }, []);

  // 按 provider 分组
  const grouped = useMemo(() => {
    const groups: Record<string, typeof models> = {};
    for (const m of models) {
      const key = m.provider || '';
      if (!groups[key]) groups[key] = [];
      groups[key].push(m);
    }
    // 当前模型不在 favorites 时强制加入
    if (current && !models.find(m => m.id === current.id)) {
      const key = current.provider || '';
      if (!groups[key]) groups[key] = [];
      groups[key].unshift(current);
    }
    return groups;
  }, [models, current]);

  const groupKeys = Object.keys(grouped);
  const hasMultipleProviders = groupKeys.length > 1 || (groupKeys.length === 1 && groupKeys[0] !== '');

  return (
    <div className={`${styles['model-selector']}${open ? ` ${styles.open}` : ''}`} ref={ref}>
      <button className={`${styles['model-pill']}${disabled ? ` ${styles['model-pill-disabled']}` : ''}`} onClick={(e) => { e.stopPropagation(); if (!disabled) setOpen(!open); }}>
        <span>{current?.name || t('model.unknown') || '...'}</span>
        <span className={styles['model-arrow']}>▾</span>
      </button>
      {open && (
        <div className={styles['model-dropdown']}>
          {groupKeys.map(provider => {
            const items = grouped[provider];
            return (
              <div key={provider || '__none'}>
                {hasMultipleProviders && (
                  <div className={styles['model-group-header']}>{provider || '—'}</div>
                )}
                {items.map(m => (
                  <button
                    key={m.id}
                    className={`${styles['model-option']}${m.isCurrent ? ` ${styles.active}` : ''}`}
                    onClick={() => switchModel(m.id)}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
