import React, { useState, useCallback, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { MediaProviderDetail } from './media/MediaProviderDetail';
import styles from '../Settings.module.css';

interface MediaProvider {
  providerId: string;
  displayName?: string;
  hasCredentials: boolean;
  models: { id: string; name: string }[];
  availableModels: { id: string; name: string }[];
}

interface MediaConfig {
  defaultImageModel?: { id: string; provider: string };
  providerDefaults?: Record<string, any>;
}

export function MediaTab() {
  const [providers, setProviders] = useState<Record<string, MediaProvider>>({});
  const [config, setConfig] = useState<MediaConfig>({});
  const [selected, setSelected] = useState<string | null>(null);
  const { showToast } = useSettingsStore();

  const load = useCallback(async () => {
    try {
      const agentId = useSettingsStore.getState().getSettingsAgentId();
      const res = await hanaFetch(`/api/plugins/image-gen/providers?agentId=${agentId}`);
      const data = await res.json();
      setProviders(data.providers || {});
      setConfig(data.config || {});
      // Auto-select first provider
      if (!selected) {
        const ids = Object.keys(data.providers || {});
        if (ids.length > 0) setSelected(ids[0]);
      }
    } catch { /* plugin not loaded yet */ }
  }, [selected]);

  useEffect(() => { load(); }, [load]);

  const providerIds = Object.keys(providers);
  const allImageModels = providerIds.flatMap(pid =>
    (providers[pid].models || []).map(m => ({ ...m, provider: pid }))
  );

  const saveConfig = async (updates: Partial<MediaConfig>) => {
    try {
      const agentId = useSettingsStore.getState().getSettingsAgentId();
      await hanaFetch(`/api/plugins/image-gen/config?agentId=${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      setConfig(prev => ({ ...prev, ...updates }));
      showToast(t('settings.saved'), 'success');
    } catch (err: any) {
      showToast(err.message || 'Save failed', 'error');
    }
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="media">
      <div className={styles['pv-layout']}>
        {/* Left: Provider list */}
        <div className={styles['pv-list']}>
          <div className={styles['pv-list-section-title']}>{t('settings.media.imageGeneration')}</div>
          {providerIds.map(pid => {
            const p = providers[pid];
            return (
              <button
                key={pid}
                className={`${styles['pv-list-item']}${selected === pid ? ' ' + styles['selected'] : ''}${!p.hasCredentials ? ' ' + styles['dim'] : ''}`}
                onClick={() => setSelected(pid)}
              >
                <span className={`${styles['pv-status-dot']}${p.hasCredentials ? ' ' + styles['on'] : ''}`} />
                <span className={styles['pv-list-item-name']}>{p.displayName || pid}</span>
                <span className={styles['pv-list-item-count']}>{p.models.length}</span>
              </button>
            );
          })}

          {/* Placeholder sections for future capabilities */}
          <div className={styles['pv-list-divider']} />
          <div className={styles['pv-list-section-title']} style={{ color: 'var(--text-muted)' }}>
            {t('settings.media.speechRecognition')}
          </div>
          <div className={styles['pv-list-item']} style={{ opacity: 0.3, pointerEvents: 'none' }}>
            <span className={styles['pv-status-dot']} />
            <span className={styles['pv-list-item-name']} style={{ fontStyle: 'italic', fontSize: '0.7rem' }}>
              {t('settings.media.comingSoon')}
            </span>
          </div>

          <div className={styles['pv-list-divider']} />
          <div className={styles['pv-list-section-title']} style={{ color: 'var(--text-muted)' }}>
            {t('settings.media.speechSynthesis')}
          </div>
          <div className={styles['pv-list-item']} style={{ opacity: 0.3, pointerEvents: 'none' }}>
            <span className={styles['pv-status-dot']} />
            <span className={styles['pv-list-item-name']} style={{ fontStyle: 'italic', fontSize: '0.7rem' }}>
              {t('settings.media.comingSoon')}
            </span>
          </div>
        </div>

        {/* Right: Provider detail */}
        <div className={styles['pv-detail']}>
          {selected && providers[selected] ? (
            <MediaProviderDetail
              providerId={selected}
              provider={providers[selected]}
              config={config}
              onSaveConfig={saveConfig}
              onRefresh={load}
            />
          ) : (
            <div className={styles['pv-empty']}>
              {t('settings.media.noProvider')}
            </div>
          )}
        </div>
      </div>

      {/* Bottom: Global default image model */}
      <section className={`${styles['settings-section']} ${styles['pv-other-section']}`}>
        <h2 className={styles['settings-section-title']}>{t('settings.media.globalDefault')}</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
            {t('settings.media.defaultModel')}
          </span>
          <select
            style={{
              fontFamily: 'inherit',
              fontSize: '0.75rem',
              padding: '6px 10px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg)',
              color: 'var(--text)',
              flex: 1,
            }}
            value={config.defaultImageModel ? `${config.defaultImageModel.provider}/${config.defaultImageModel.id}` : ''}
            onChange={(e) => {
              const val = e.target.value;
              if (!val) {
                saveConfig({ defaultImageModel: undefined });
                return;
              }
              const [provider, ...rest] = val.split('/');
              saveConfig({ defaultImageModel: { id: rest.join('/'), provider } });
            }}
          >
            <option value="">—</option>
            {allImageModels.map(m => (
              <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                {m.provider} / {m.name || m.id}
              </option>
            ))}
          </select>
        </div>
      </section>
    </div>
  );
}
