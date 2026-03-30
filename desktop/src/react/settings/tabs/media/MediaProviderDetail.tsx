import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../../store';
import { hanaFetch } from '../../api';
import { invalidateConfigCache } from '../../../hooks/use-config';
import { t } from '../../helpers';
import styles from '../../Settings.module.css';

const platform = (window as any).platform;

interface Props {
  providerId: string;
  provider: {
    displayName?: string;
    hasCredentials: boolean;
    models: { id: string; name: string }[];
    availableModels: { id: string; name: string }[];
  };
  config: { defaultImageModel?: { id: string; provider: string }; providerDefaults?: Record<string, any> };
  onSaveConfig: (updates: any) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function MediaProviderDetail({ providerId, provider, config, onSaveConfig, onRefresh }: Props) {
  const { showToast } = useSettingsStore();
  const defaults = config.providerDefaults?.[providerId] || {};
  const isDefault = (modelId: string) =>
    config.defaultImageModel?.id === modelId && config.defaultImageModel?.provider === providerId;

  const updateDefault = (key: string, value: any) => {
    const current = config.providerDefaults || {};
    const provDefaults = { ...current[providerId], [key]: value };
    onSaveConfig({ providerDefaults: { ...current, [providerId]: provDefaults } });
  };

  // ── Model add/remove (same PUT /api/config path as Provider page) ──

  const addModel = async (modelId: string) => {
    try {
      const res = await hanaFetch('/api/providers/summary');
      const summary = await res.json();
      const currentModels = summary.providers?.[providerId]?.models || [];
      await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: { models: [...currentModels, { id: modelId, type: 'image' }] } } }),
      });
      invalidateConfigCache();
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch (err: any) {
      showToast(err.message || 'Failed', 'error');
    }
  };

  const removeModel = async (modelId: string) => {
    try {
      const res = await hanaFetch('/api/providers/summary');
      const summary = await res.json();
      const currentModels = summary.providers?.[providerId]?.models || [];
      const filtered = currentModels.filter((m: any) => (typeof m === 'object' ? m.id : m) !== modelId);
      await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: { models: filtered } } }),
      });
      invalidateConfigCache();
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch (err: any) {
      showToast(err.message || 'Failed', 'error');
    }
  };

  // ── Dropdown state (same pattern as ProviderModelList) ──

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  const addedIds = new Set(provider.models.map(m => m.id));
  const allModels = [...provider.models, ...provider.availableModels];
  const query = search.toLowerCase();
  const filtered = query ? allModels.filter(m => m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query)) : allModels;

  useEffect(() => {
    if (!dropdownOpen || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const w = rect.width + 80;
    const left = Math.min(rect.left, window.innerWidth - w - 8);
    setPanelStyle({
      position: 'fixed',
      left: Math.max(8, left),
      width: w,
      top: rect.bottom + 4,
      maxHeight: window.innerHeight - rect.bottom - 12,
      zIndex: 9999,
    });
  }, [dropdownOpen]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  return (
    <div className={styles['pv-detail-inner']}>
      <div className={styles['pv-detail-header']}>
        <h2 className={styles['pv-detail-title']}>{provider.displayName || providerId}</h2>
      </div>

      {/* Credential status */}
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 'var(--space-md)', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: provider.hasCredentials ? 'var(--success)' : 'var(--text-muted)',
          display: 'inline-block',
        }} />
        {provider.hasCredentials ? t('settings.media.credentialOk') : t('settings.media.credentialMissing')}
      </div>

      <div className={styles['pv-models']}>
        {/* Added model list */}
        {provider.models.length > 0 && (
          <div className={styles['pv-fav-section']}>
            <div className={styles['pv-fav-title']}>
              {t('settings.media.models')}
              <span className={styles['pv-models-count']}>{provider.models.length}</span>
            </div>
            <div className={styles['pv-fav-list']}>
              {provider.models.map(m => (
                <div key={m.id} className={styles['pv-fav-item']}>
                  <span className={styles['pv-fav-item-name']} title={m.id}>{m.name || m.id}</span>
                  <span className={styles['pv-fav-item-id']}>{m.id}</span>
                  {isDefault(m.id) && (
                    <span style={{
                      fontSize: '0.6rem', color: 'var(--accent)',
                      background: 'var(--accent-light)', padding: '1px 6px',
                      borderRadius: '4px', fontWeight: 500, flexShrink: 0,
                    }}>
                      {t('settings.media.default')}
                    </span>
                  )}
                  <div className={styles['pv-fav-item-actions']}>
                    <button className={styles['pv-fav-item-remove']} onClick={() => removeModel(m.id)} title={t('settings.api.removeModel')}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Add model dropdown */}
        <div className={styles['pv-models-action-row']}>
          <button ref={triggerRef} className={styles['pv-model-dropdown-trigger']} onClick={() => setDropdownOpen(!dropdownOpen)}>
            <span>{t('settings.media.addModel')}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>

        {dropdownOpen && (
          <div className={styles['pv-model-dropdown-panel']} ref={panelRef} style={panelStyle}>
            <input
              className={styles['pv-model-dropdown-search']}
              type="text"
              placeholder={t('settings.api.searchModel')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            <div className={styles['pv-model-dropdown-list']}>
              {filtered.map(m => {
                const isAdded = addedIds.has(m.id);
                return (
                  <button
                    key={m.id}
                    className={`${styles['pv-model-dropdown-option']}${isAdded ? ' ' + styles['added'] : ''}`}
                    onClick={() => { if (!isAdded) addModel(m.id); }}
                  >
                    <span className={styles['pv-model-dropdown-option-name']}>{m.name || m.id}</span>
                    {isAdded && <span className={styles['pv-model-dropdown-option-check']}>{'\u2713'}</span>}
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <div className={styles['pv-model-dropdown-empty']}>{t('settings.providers.noModels')}</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Provider-specific defaults */}
      {provider.models.length > 0 && (
        <div style={{ marginTop: 'var(--space-md)', paddingTop: 'var(--space-md)', borderTop: '1px solid var(--overlay-light)' }}>
          <div style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '10px' }}>
            {t('settings.media.providerDefaults')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {t('settings.media.size')}
              </span>
              <select
                style={{ fontFamily: 'inherit', fontSize: '0.75rem', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg)', color: 'var(--text)' }}
                value={defaults.size || ''}
                onChange={(e) => updateDefault('size', e.target.value || undefined)}
              >
                <option value="2K">2K</option>
                <option value="4K">4K</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {t('settings.media.aspectRatio')}
              </span>
              <select
                style={{ fontFamily: 'inherit', fontSize: '0.75rem', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg)', color: 'var(--text)' }}
                value={defaults.aspect_ratio || ''}
                onChange={(e) => updateDefault('aspect_ratio', e.target.value || undefined)}
              >
                <option value="">默认</option>
                <option value="1:1">1:1</option>
                <option value="4:3">4:3</option>
                <option value="3:4">3:4</option>
                <option value="16:9">16:9</option>
                <option value="9:16">9:16</option>
                <option value="3:2">3:2</option>
                <option value="2:3">2:3</option>
                <option value="21:9">21:9</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {t('settings.media.format')}
              </span>
              <select
                style={{ fontFamily: 'inherit', fontSize: '0.75rem', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg)', color: 'var(--text)' }}
                value={defaults.format || ''}
                onChange={(e) => updateDefault('format', e.target.value || undefined)}
              >
                <option value="">默认</option>
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
                <option value="webp">WebP</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {t('settings.media.quality')}
              </span>
              <select
                style={{ fontFamily: 'inherit', fontSize: '0.75rem', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg)', color: 'var(--text)' }}
                value={defaults.quality || ''}
                onChange={(e) => updateDefault('quality', e.target.value || undefined)}
              >
                <option value="">默认</option>
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
