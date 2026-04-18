import React, { useState, useCallback, useEffect } from 'react';
import { useSettingsStore, type ProviderSummary } from '../store';
import { hanaFetch } from '../api';
import { t, PROVIDER_PRESETS } from '../helpers';
import { loadSettingsConfig } from '../actions';
import { ProviderDetail } from './providers/ProviderDetail';
import { AddCustomButton } from './providers/ProviderList';
import { OtherModelsSection } from './providers/OtherModelsSection';
import styles from '../Settings.module.css';

export function ProvidersTab() {
  const { providersSummary, selectedProviderId, settingsConfig } = useSettingsStore();
  const providers = settingsConfig?.providers || {};
  const [addingProvider, setAddingProvider] = useState(false);

  const loadSummary = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/providers/summary');
      const data = await res.json();
      useSettingsStore.setState({ providersSummary: data.providers || {} });
    } catch { /* swallow */ }
  }, []);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  const providerIds = Object.keys(providersSummary);
  const selected = selectedProviderId;

  // 分组：OAuth / Coding Plan / API Key
  const oauthProviders = providerIds.filter(id => providersSummary[id].supports_oauth);
  const codingPlanProviders = providerIds.filter(id => !providersSummary[id].supports_oauth && providersSummary[id].is_coding_plan);
  const registeredApiKey = providerIds.filter(id => !providersSummary[id].supports_oauth && !providersSummary[id].is_coding_plan);
  const registeredSet = new Set(providerIds);

  const unregisteredPresets = PROVIDER_PRESETS.filter(p =>
    !registeredSet.has(p.value) && !oauthProviders.includes(p.value)
  );
  const presetValues = new Set(PROVIDER_PRESETS.map(p => p.value));
  const customProviders = registeredApiKey.filter(id => !presetValues.has(id));
  const presetProviders = registeredApiKey.filter(id => presetValues.has(id));

  const selectProvider = (id: string) => {
    useSettingsStore.setState({ selectedProviderId: id });
  };

  const renderRegistered = (id: string) => {
    const p = providersSummary[id];
    const preset = PROVIDER_PRESETS.find(pr => pr.value === id);
    const modelCount = (p.models || []).length;
    return (
      <button
        key={id}
        className={`${styles['pv-list-item']}${selected === id  ? ' ' + styles['selected'] : ''}`}
        onClick={() => selectProvider(id)}
      >
        <span className={`${styles['pv-status-dot']}${p.has_credentials  ? ' ' + styles['on'] : ''}`} />
        <span className={styles['pv-list-item-name']}>{preset?.label || p.display_name || id}</span>
        <span className={styles['pv-list-item-count']}>{modelCount}</span>
      </button>
    );
  };

  const renderUnregistered = (preset: typeof PROVIDER_PRESETS[0]) => (
    <button
      key={preset.value}
      className={`${styles['pv-list-item']} ${styles['dim']}${selected === preset.value ? ' ' + styles['selected'] : ''}`}
      onClick={() => selectProvider(preset.value)}
    >
      <span className={styles['pv-status-dot']} />
      <span className={styles['pv-list-item-name']}>{preset.label}</span>
    </button>
  );

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="providers">
      <div className={styles['pv-layout']}>
        {/* ── 左栏 ── */}
        <div className={styles['pv-list']}>
          {oauthProviders.length > 0 && (
            <>
              <div className={styles['pv-list-section-title']}>OAuth</div>
              {oauthProviders.map(renderRegistered)}
            </>
          )}

          {codingPlanProviders.length > 0 && (
            <>
              <div className={styles['pv-list-section-title']}>Coding Plan</div>
              {codingPlanProviders.map(renderRegistered)}
            </>
          )}

          <div className={styles['pv-list-section-title']}>API</div>
          {presetProviders.map(renderRegistered)}
          {unregisteredPresets.map(renderUnregistered)}
          {customProviders.map(renderRegistered)}

          <AddCustomButton
            adding={addingProvider}
            onToggle={() => setAddingProvider(!addingProvider)}
            onDone={() => { setAddingProvider(false); loadSummary(); }}
            onCancel={() => setAddingProvider(false)}
          />
        </div>

        {/* ── 右栏：Provider 详情 ── */}
        <div className={styles['pv-detail']}>
          {selected ? (() => {
            const existing = providersSummary[selected];
            const preset = PROVIDER_PRESETS.find(p => p.value === selected);
            const summary: ProviderSummary = existing || {
              type: 'api-key' as const,
              display_name: preset?.label || selected,
              base_url: preset?.url || '',
              api: preset?.api || '',
              api_key: '',
              models: [],
              custom_models: [],
              has_credentials: false,
              supports_oauth: false,
              can_delete: false,
            };
            return (
              <ProviderDetail
                providerId={selected}
                summary={summary}
                providerConfig={providers[selected]}
                isPresetSetup={!existing && !!preset}
                presetInfo={preset}
                onRefresh={async () => { await loadSettingsConfig(); await loadSummary(); }}
              />
            );
          })() : (
            <div className={styles['pv-empty']}>
              {t('settings.providers.selectHint')}
            </div>
          )}
        </div>
      </div>

      {/* ── 底部：全局模型分配 ── */}
      <section className={`${styles['settings-section']} ${styles['pv-other-section']}`}>
        <h2 className={styles['settings-section-title']}>{t('settings.api.otherModelSection')}</h2>
        <OtherModelsSection providers={providers} />
      </section>
    </div>
  );
}
