/**
 * MDW（模型下拉组件）的 React 版本
 * 从 /api/models 读取唯一信源，按 provider 分组、支持搜索和自定义输入
 */
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { hanaFetch } from '../api';
import styles from '../Settings.module.css';

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number | null;
}

interface ModelWidgetProps {
  /** @deprecated 不再使用，保留兼容签名 */
  providers?: Record<string, { models?: string[]; base_url?: string }>;
  value: string;
  onSelect: (ref: { id: string; provider: string }) => void;
  placeholder?: string;
  lookupModelMeta?: (id: string) => any;
  formatContext?: (n: number) => string;
}

export function ModelWidget({
  value, onSelect,
  placeholder, formatContext,
}: ModelWidgetProps) {
  const t = window.t || ((k: string) => k);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [customInput, setCustomInput] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // 从唯一信源获取模型列表
  useEffect(() => {
    hanaFetch('/api/models').then(r => r.json()).then(data => {
      setModels(data.models || []);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [open]);

  useEffect(() => {
    if (open) {
      setSearch('');
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  const query = search.toLowerCase();

  // 按 provider 分组
  const grouped = useMemo(() => {
    const groups: Record<string, ModelInfo[]> = {};
    for (const m of models) {
      if (query && !m.id.toLowerCase().includes(query) && !m.name.toLowerCase().includes(query)) continue;
      const g = m.provider || '';
      if (!groups[g]) groups[g] = [];
      groups[g].push(m);
    }
    return groups;
  }, [models, query]);

  const handleCustomSubmit = () => {
    const val = customInput.trim();
    if (!val) return;
    onSelect({ id: val, provider: '' });
    setCustomInput('');
    setOpen(false);
  };

  return (
    <div className={styles['mdw']} ref={ref}>
      <button
        className={styles['mdw-trigger']}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        <span className={styles['mdw-value']}>{value || `— ${placeholder || t('settings.api.selectModel')} —`}</span>
        <span className={styles['mdw-arrow']}>▾</span>
      </button>
      <div className={`${styles['mdw-popup']}${open ? ' ' + styles['open'] : ''}`}>
        <input
          ref={searchRef}
          className={styles['mdw-search']}
          type="text"
          placeholder={t('settings.api.searchModel')}
          spellCheck={false}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
        <div className={styles['mdw-options']}>
          {Object.entries(grouped).map(([provider, items]) => (
            <div key={provider || '__none'}>
              {provider && <div className={styles['mdw-group-header']}>{provider}</div>}
              {items.map(m => (
                <button
                  key={`${m.provider}/${m.id}`}
                  className={`${styles['mdw-option']}${m.id === value ? ' ' + styles['selected'] : ''}`}
                  type="button"
                  onClick={() => { onSelect({ id: m.id, provider: m.provider }); setOpen(false); }}
                >
                  <span className={styles['mdw-option-name']}>{m.name || m.id}</span>
                  {m.contextWindow && formatContext && (
                    <span className={styles['mdw-option-ctx']}>{formatContext(m.contextWindow)}</span>
                  )}
                </button>
              ))}
            </div>
          ))}
          <div className={styles['mdw-custom-row']}>
            <input
              type="text"
              className={styles['mdw-custom-input']}
              placeholder={t('settings.api.customInput')}
              spellCheck={false}
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCustomSubmit();
                e.stopPropagation();
              }}
            />
            <button
              type="button"
              className={styles['mdw-custom-confirm']}
              onClick={(e) => { e.stopPropagation(); handleCustomSubmit(); }}
            >
              ↵
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
