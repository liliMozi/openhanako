import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import {
  t, formatContext, getProviderDisplayName, lookupModelMeta, resolveProviderForModel,
  autoSaveConfig, autoSaveGlobalModels, autoSaveModels,
  CONTEXT_PRESETS, OUTPUT_PRESETS,
} from '../helpers';
import { SelectWidget } from '../widgets/SelectWidget';
import { KeyInput } from '../widgets/KeyInput';
import { loadSettingsConfig } from '../actions';
import { ModelWidget } from '../widgets/ModelWidget';
import { ComboInput } from '../widgets/ComboInput';

const platform = (window as any).platform;

export function ModelsTab() {
  const {
    settingsConfig, globalModelsConfig,
    pendingFavorites, pendingDefaultModel, showToast,
  } = useSettingsStore();
  const providers = settingsConfig?.providers || {};
  const [providerPickerState, setProviderPickerState] = useState<{
    modelId: string;
    resolve: (providerId: string | null) => void;
  } | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState('');

  const providerOptions = Object.keys(providers).map((providerId) => ({
    value: providerId,
    label: getProviderDisplayName(providerId),
  }));

  const closeProviderPicker = (providerId: string | null = null) => {
    setProviderPickerState((current) => {
      current?.resolve(providerId);
      return null;
    });
    setSelectedProviderId('');
  };

  const openProviderPicker = (modelId: string) => new Promise<string | null>((resolve) => {
    setSelectedProviderId('');
    setProviderPickerState({ modelId, resolve });
  });

  const persistModelProviderBinding = async (modelId: string, providerId: string) => {
    const currentConfig = useSettingsStore.getState().settingsConfig || {};
    const currentProviders = currentConfig.providers || {};
    const providerConfig = currentProviders[providerId] || {};
    const nextModels = [...new Set([...(providerConfig.models || []), modelId])];

    const res = await hanaFetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: { [providerId]: { models: nextModels } } }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    useSettingsStore.setState({
      settingsConfig: {
        ...currentConfig,
        providers: {
          ...currentProviders,
          [providerId]: {
            ...providerConfig,
            models: nextModels,
            model_count: nextModels.length,
          },
        },
      },
    });
    platform?.settingsChanged?.('models-changed');
  };

  const ensureModelProviderBinding = async (modelId: string) => {
    const existingProvider = resolveProviderForModel(modelId);
    if (existingProvider) return existingProvider;

    if (providerOptions.length === 0) {
      showToast(t('settings.api.customProviderNoOptions'), 'error');
      return null;
    }

    // 自定义模型的典型场景就是“列表里拿不到它”，因此这里不能猜 provider，
    // 必须先让用户显式绑定，再把模型写进对应供应商的 models 列表。
    const selectedProvider = await openProviderPicker(modelId);
    if (!selectedProvider) return null;

    await persistModelProviderBinding(modelId, selectedProvider);
    return selectedProvider;
  };

  return (
    <>
      <div className="settings-tab-content active" data-tab="models">
        {/* 主模型 */}
        <section className="settings-section cml-section">
          <h2 className="settings-section-title">{t('settings.api.mainModelSection')}</h2>
          <p className="settings-hint">{t('settings.api.mainModelHint')}</p>
          <ChatModelSection
            providers={providers}
            ensureModelProviderBinding={ensureModelProviderBinding}
          />
        </section>

        {/* 其他 */}
        <section className="settings-section">
          <h2 className="settings-section-title">{t('settings.api.otherModelSection')}</h2>
          <OtherModelsSection
            providers={providers}
            ensureModelProviderBinding={ensureModelProviderBinding}
          />
        </section>
      </div>

      {providerPickerState && (
        <CustomModelProviderOverlay
          modelId={providerPickerState.modelId}
          providerOptions={providerOptions}
          selectedProviderId={selectedProviderId}
          onSelect={setSelectedProviderId}
          onCancel={() => closeProviderPicker(null)}
          onConfirm={() => {
            if (!selectedProviderId) {
              showToast(t('settings.api.customProviderRequired'), 'error');
              return;
            }
            closeProviderPicker(selectedProviderId);
          }}
        />
      )}
    </>
  );
}

function ChatModelSection({
  providers,
  ensureModelProviderBinding,
}: {
  providers: Record<string, any>;
  ensureModelProviderBinding: (modelId: string) => Promise<string | null>;
}) {
  const { pendingFavorites, pendingDefaultModel, showToast } = useSettingsStore();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [sdkModels, setSdkModels] = useState<Record<string, string[]>>({});

  // 加载 SDK 可用模型，按 provider 分组（补充 OAuth provider 等不在 providers.yaml models 列表里的）
  useEffect(() => {
    hanaFetch('/api/models').then(r => r.json()).then(data => {
      const byProvider: Record<string, string[]> = {};
      for (const m of (data.models || [])) {
        if (!byProvider[m.provider]) byProvider[m.provider] = [];
        byProvider[m.provider].push(m.id);
      }
      setSdkModels(byProvider);
    }).catch(() => {});
  }, []);

  const removeFavorite = (mid: string) => {
    const next = new Set(pendingFavorites);
    next.delete(mid);
    let nextDefault = pendingDefaultModel;
    if (mid === pendingDefaultModel) {
      nextDefault = [...next][0] || '';
      const partial: Record<string, any> = { models: { chat: nextDefault } };
      if (nextDefault) {
        const prov = resolveProviderForModel(nextDefault);
        if (prov) partial.api = { provider: prov };
      }
      autoSaveConfig(partial, { refreshModels: true });
    }
    useSettingsStore.setState({ pendingFavorites: next, pendingDefaultModel: nextDefault });
    autoSaveModels();
  };

  const addFavorite = (mid: string) => {
    const wasEmpty = pendingFavorites.size === 0;
    const next = new Set(pendingFavorites);
    next.add(mid);
    const updates: Partial<any> = { pendingFavorites: next };
    if (wasEmpty) {
      updates.pendingDefaultModel = mid;
      const partial: Record<string, any> = { models: { chat: mid } };
      const prov = resolveProviderForModel(mid);
      if (prov) partial.api = { provider: prov };
      autoSaveConfig(partial, { refreshModels: true });
    }
    useSettingsStore.setState(updates);
    autoSaveModels();
  };

  const addCustomModelFromSearch = async () => {
    const modelId = pickerSearch.trim();
    if (!modelId) return;
    const providerId = await ensureModelProviderBinding(modelId);
    if (!providerId) return;
    addFavorite(modelId);
    setPickerSearch('');
    setPickerOpen(false);
  };

  const query = pickerSearch.toLowerCase();

  const handleCustomSubmit = () => {
    const val = customInput.trim();
    if (!val) return;
    addFavorite(val);
    setCustomInput('');
    setPickerOpen(false);
  };

  return (
    <div className="cml-row">
      <div className="cml-col-add">
        <button
          className="cml-add-btn"
          type="button"
          onClick={() => { setPickerOpen(!pickerOpen); setPickerSearch(''); }}
        >
          <span>+</span> <span>{t('settings.api.addModel')}</span>
        </button>
        <div className={`cml-picker${pickerOpen ? ' open' : ''}`}>
          <input
            className="cml-picker-search"
            type="text"
            placeholder={t('settings.api.searchModel')}
            value={pickerSearch}
            onChange={(e) => setPickerSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void addCustomModelFromSearch();
              }
            }}
            autoFocus={pickerOpen}
          />
          <div className="cml-picker-options">
            {Object.entries(
              // 合并 providers.yaml models 和 SDK 可用模型
              (() => {
                const merged: Record<string, string[]> = {};
                for (const [name, p] of Object.entries(providers)) {
                  merged[name] = [...(p.models || [])];
                }
                for (const [name, ids] of Object.entries(sdkModels)) {
                  if (!merged[name]) merged[name] = [];
                  const existing = new Set(merged[name]);
                  for (const id of ids) {
                    if (!existing.has(id)) merged[name].push(id);
                  }
                }
                return merged;
              })()
            ).map(([provName, allModels]: [string, string[]]) => {
              const filtered = query ? allModels.filter((id: string) => id.toLowerCase().includes(query)) : allModels;
              if (filtered.length === 0) return null;
              const providerLabel = getProviderDisplayName(provName);
              return (
                <React.Fragment key={provName}>
                  <div className="cml-picker-group">{providerLabel}</div>
                  {filtered.map((mid: string) => {
                    const isAdded = pendingFavorites.has(mid);
                    const meta = lookupModelMeta(mid);
                    return (
                      <button
                        key={mid}
                        className={`cml-picker-option${isAdded ? ' added' : ''}`}
                        onClick={() => { if (!isAdded) addFavorite(mid); }}
                      >
                        <span className="cml-picker-option-name">{mid}</span>
                        {isAdded ? (
                          <span className="cml-picker-option-added">✓</span>
                        ) : (
                          <span className="cml-picker-option-provider">{providerLabel}</span>
                        )}
                        {meta?.context && (
                          <span className="cml-picker-option-ctx">{formatContext(meta.context)}</span>
                        )}
                      </button>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </div>
          <div className="mdw-custom-row">
            <input
              type="text"
              className="mdw-custom-input"
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
              className="mdw-custom-confirm"
              onClick={(e) => { e.stopPropagation(); handleCustomSubmit(); }}
            >
              ↵
            </button>
          </div>
        </div>
      </div>

      <div className="cml-col-list">
        {pendingFavorites.size === 0 ? (
          <div className="cml-empty">{t('settings.api.noModels')}</div>
        ) : (
          <>
            <div className="cml-list-header">
              <span className="cml-list-header-name">{t('settings.api.modelName')}</span>
              <span className="cml-list-header-meta">{t('settings.api.contextShort')}</span>
              <span className="cml-list-header-meta">{t('settings.api.outputLength')}</span>
              <span className="cml-list-header-actions" aria-hidden="true" />
            </div>
            {[...pendingFavorites].map(mid => {
              const meta = lookupModelMeta(mid) || {};
              return (
                <React.Fragment key={mid}>
                  <div className="cml-item">
                    <span className="cml-item-name" title={mid}>{mid}</span>
                    <span className="cml-item-meta">{meta.context ? formatContext(meta.context) : '—'}</span>
                    <span className="cml-item-meta">{meta.maxOutput ? formatContext(meta.maxOutput) : '—'}</span>
                    <div className="cml-item-actions">
                      <button
                        className="cml-health-btn"
                        title="Health check"
                        onClick={async (e) => {
                          const btn = e.currentTarget;
                          btn.classList.remove('health-ok', 'health-fail');
                          btn.classList.add('spinning');
                          try {
                            const res = await hanaFetch('/api/models/health', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ modelId: mid }),
                            });
                            const data = await res.json();
                            btn.classList.remove('spinning');
                            btn.classList.add(data.ok ? 'health-ok' : 'health-fail');
                            if (!data.ok) showToast(`${mid}: ${data.error || 'unhealthy'}`, 'error');
                          } catch (err: any) {
                            btn.classList.remove('spinning');
                            btn.classList.add('health-fail');
                            showToast(`${mid}: ${err.message}`, 'error');
                          }
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                        </svg>
                      </button>
                      <button
                        className="cml-edit-btn"
                        title={t('settings.api.editModel')}
                        onClick={() => setEditingModel(editingModel === mid ? null : mid)}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                      <button
                        className="cml-item-remove"
                        title={t('settings.api.removeModel')}
                        onClick={() => removeFavorite(mid)}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  {editingModel === mid && (
                    <ModelEditPanel
                      modelId={mid}
                      onClose={() => setEditingModel(null)}
                      providers={providers}
                    />
                  )}
                </React.Fragment>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

function ModelEditPanel({ modelId, onClose, providers }: {
  modelId: string; onClose: () => void; providers: Record<string, any>;
}) {
  const meta = lookupModelMeta(modelId) || {};
  const [ctxVal, setCtxVal] = useState(String(meta.context || ''));
  const [outVal, setOutVal] = useState(String(meta.maxOutput || ''));

  const save = async () => {
    const entry: Record<string, any> = {};
    const ctx = ctxVal.trim();
    const maxOut = outVal.trim();
    if (ctx) entry.context = parseInt(ctx);
    if (maxOut) entry.maxOutput = parseInt(maxOut);
    const config = useSettingsStore.getState().settingsConfig;
    const currentOverrides = config?.models?.overrides || {};
    await autoSaveConfig({ models: { overrides: { ...currentOverrides, [modelId]: entry } } });
    onClose();
  };

  return (
    <div className="cml-edit-panel">
      <div className="cml-edit-panel-columns">
        <div className="cml-edit-panel-col">
          <label className="cml-edit-panel-label">{t('settings.api.contextLength')}</label>
          <ComboInput presets={CONTEXT_PRESETS} value={ctxVal} onChange={setCtxVal} placeholder="131072" />
        </div>
        <div className="cml-edit-panel-col">
          <label className="cml-edit-panel-label">{t('settings.api.maxOutput')}</label>
          <ComboInput presets={OUTPUT_PRESETS} value={outVal} onChange={setOutVal} placeholder="16384" />
        </div>
      </div>
      <div className="cml-edit-panel-actions">
        <button type="button" className="cml-edit-panel-btn" onClick={onClose}>{t('settings.api.cancel')}</button>
        <button type="button" className="cml-edit-panel-btn primary" onClick={save}>{t('settings.api.save')}</button>
      </div>
    </div>
  );
}

function OtherModelsSection({
  providers,
  ensureModelProviderBinding,
}: {
  providers: Record<string, any>;
  ensureModelProviderBinding: (modelId: string) => Promise<string | null>;
}) {
  const { globalModelsConfig, settingsConfig, pendingFavorites, showToast } = useSettingsStore();
  const [searchApiKey, setSearchApiKey] = useState('');

  const selectSharedModel = async (role: string, modelId: string) => {
    const providerId = await ensureModelProviderBinding(modelId);
    if (!providerId) return;
    await autoSaveGlobalModels({ models: { [role]: modelId } });
  };

  const searchProvider = globalModelsConfig?.search?.provider || '';
  const maskedSearchKey = globalModelsConfig?.search?.api_key;

  const verifySearch = async () => {
    const provider = (globalModelsConfig?.search?.provider || '').trim();
    const apiKey = searchApiKey.trim();
    if (!provider) { showToast(t('settings.search.noProvider'), 'error'); return; }
    if (!apiKey) { showToast(t('settings.search.noKey'), 'error'); return; }
    try {
      const res = await hanaFetch('/api/search/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, api_key: apiKey }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast(t('settings.search.verified'), 'success');
        await loadSettingsConfig();
      } else {
        showToast(t('settings.search.verifyFailed') + (data.error ? ': ' + data.error : ''), 'error');
      }
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  return (
    <>
      <div className="settings-row">
        <div className="settings-field settings-field-half">
          <label className="settings-field-label">{t('settings.api.utilityModel')}</label>
          <ModelWidget
            providers={providers}
            favorites={pendingFavorites}
            value={globalModelsConfig?.models?.utility || ''}
            onSelect={(id) => autoSaveGlobalModels({ models: { utility: id } })}
            onCustomSelect={(id) => selectSharedModel('utility', id)}
            lookupModelMeta={lookupModelMeta}
            formatContext={formatContext}
          />
          <span className="settings-field-hint">{t('settings.api.utilityModelHint')}</span>
        </div>
        <div className="settings-field settings-field-half">
          <label className="settings-field-label">{t('settings.api.utilityLargeModel')}</label>
          <ModelWidget
            providers={providers}
            favorites={pendingFavorites}
            value={globalModelsConfig?.models?.utility_large || ''}
            onSelect={(id) => autoSaveGlobalModels({ models: { utility_large: id } })}
            onCustomSelect={(id) => selectSharedModel('utility_large', id)}
            lookupModelMeta={lookupModelMeta}
            formatContext={formatContext}
          />
          <span className="settings-field-hint">{t('settings.api.utilityLargeModelHint')}</span>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-field settings-field-half">
          <label className="settings-field-label">{t('settings.api.searchProviderField')}</label>
          <SelectWidget
            options={[
              { value: '', label: 'Not configured' },
              { value: 'tavily', label: 'Tavily' },
              { value: 'serper', label: 'Serper (Google)' },
              { value: 'brave', label: 'Brave Search' },
            ]}
            value={searchProvider}
            onChange={(val) => autoSaveGlobalModels({ search: { provider: val } })}
            placeholder={t('settings.api.searchProviderField')}
          />
        </div>
        <div className="settings-field settings-field-half">
          <label className="settings-field-label">{t('settings.api.searchApiKey')}</label>
          <KeyInput
            value={searchApiKey}
            onChange={setSearchApiKey}
            placeholder={maskedSearchKey || t('settings.api.apiKeyPlaceholder')}
          />
          <button className="search-verify-btn" onClick={verifySearch}>
            {t('settings.search.verify')}
          </button>
          <span className="settings-field-hint">{t('settings.api.searchApiKeyHint')}</span>
        </div>
      </div>
    </>
  );
}

function CustomModelProviderOverlay({
  modelId,
  providerOptions,
  selectedProviderId,
  onSelect,
  onCancel,
  onConfirm,
}: {
  modelId: string;
  providerOptions: Array<{ value: string; label: string }>;
  selectedProviderId: string;
  onSelect: (providerId: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
      if (event.key === 'Enter' && selectedProviderId) onConfirm();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, onConfirm, selectedProviderId]);

  return (
    <div
      className="custom-model-provider-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="custom-model-provider-card">
        <div className="custom-model-provider-title">{t('settings.api.customProviderTitle')}</div>
        <div className="custom-model-provider-body">
          <div className="custom-model-provider-model">
            <span className="custom-model-provider-label">{t('settings.api.modelName')}</span>
            <code className="custom-model-provider-code">{modelId}</code>
          </div>
          <p className="custom-model-provider-hint">{t('settings.api.customProviderHint')}</p>
          <div className="settings-field">
            <label className="settings-field-label">{t('settings.api.provider')}</label>
            <SelectWidget
              options={providerOptions}
              value={selectedProviderId}
              onChange={onSelect}
              placeholder={t('settings.api.customProviderPlaceholder')}
            />
          </div>
        </div>
        <div className="custom-model-provider-actions">
          <button type="button" className="custom-model-provider-cancel" onClick={onCancel}>
            {t('settings.api.cancel')}
          </button>
          <button
            type="button"
            className="custom-model-provider-confirm"
            onClick={onConfirm}
            disabled={!selectedProviderId}
          >
            {t('settings.api.customProviderConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
