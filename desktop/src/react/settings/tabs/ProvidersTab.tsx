import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore, type ProviderSummary } from '../store';
import { hanaFetch } from '../api';
import {
  t, formatContext, lookupModelMeta, resolveProviderForModel,
  autoSaveConfig, autoSaveGlobalModels, autoSaveModels,
  PROVIDER_PRESETS, API_FORMAT_OPTIONS, CONTEXT_PRESETS, OUTPUT_PRESETS,
} from '../helpers';
import { SelectWidget } from '../widgets/SelectWidget';
import { KeyInput } from '../widgets/KeyInput';
import { ModelWidget } from '../widgets/ModelWidget';
import { ComboInput } from '../widgets/ComboInput';
import { loadSettingsConfig } from '../actions';

const platform = (window as any).platform;

// ════════════════════════════════════════════════════
// Main Tab
// ════════════════════════════════════════════════════

export function ProvidersTab() {
  const { providersSummary, selectedProviderId, settingsConfig, pendingFavorites, globalModelsConfig } = useSettingsStore();
  const providers = settingsConfig?.providers || {};
  const [addingProvider, setAddingProvider] = useState(false);

  // 加载 summary
  const loadSummary = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/providers/summary');
      const data = await res.json();
      useSettingsStore.setState({ providersSummary: data.providers || {} });
    } catch {}
  }, []);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  const providerIds = Object.keys(providersSummary);
  // selectedProviderId 可以是 summary 里的，也可以是未注册的 preset
  const selected = selectedProviderId;

  // 分组：OAuth → 分割线 → 已注册 API Key → 未注册 presets → 自定义（非 preset 非 OAuth）
  const oauthProviders = providerIds.filter(id => providersSummary[id].supports_oauth);
  const registeredApiKey = providerIds.filter(id => !providersSummary[id].supports_oauth);
  const registeredSet = new Set(providerIds);
  // 排除 minimax（OAuth 管）和已注册的
  const unregisteredPresets = PROVIDER_PRESETS.filter(p =>
    !registeredSet.has(p.value) && !oauthProviders.includes(p.value)
  );
  // 自定义 provider（不在 presets 也不在 OAuth 中的）
  const presetValues = new Set(PROVIDER_PRESETS.map(p => p.value));
  const customProviders = registeredApiKey.filter(id => !presetValues.has(id));
  const presetProviders = registeredApiKey.filter(id => presetValues.has(id));

  const selectProvider = (id: string) => {
    useSettingsStore.setState({ selectedProviderId: id });
  };

  const renderRegistered = (id: string) => {
    const p = providersSummary[id];
    const preset = PROVIDER_PRESETS.find(pr => pr.value === id);
    const favCount = (p.models || []).filter(m => pendingFavorites.has(m)).length
      + (p.custom_models || []).filter(m => pendingFavorites.has(m)).length;
    const totalCount = (p.models || []).length + (p.custom_models || []).length;
    return (
      <button
        key={id}
        className={`pv-list-item${selected === id ? ' selected' : ''}`}
        onClick={() => selectProvider(id)}
      >
        <span className={`pv-status-dot${p.has_credentials ? ' on' : ''}`} />
        <span className="pv-list-item-name">{preset?.label || p.display_name || id}</span>
        <span className="pv-list-item-count">{favCount}/{totalCount}</span>
      </button>
    );
  };

  const renderUnregistered = (preset: typeof PROVIDER_PRESETS[0]) => (
    <button
      key={preset.value}
      className={`pv-list-item dim${selected === preset.value ? ' selected' : ''}`}
      onClick={() => selectProvider(preset.value)}
    >
      <span className="pv-status-dot" />
      <span className="pv-list-item-name">{preset.label}</span>
    </button>
  );

  // 右栏内容：已注册 → ProviderDetail，未注册 preset → 配置引导
  const isUnregisteredPreset = selected && !registeredSet.has(selected) && PROVIDER_PRESETS.some(p => p.value === selected);
  const selectedPreset = isUnregisteredPreset ? PROVIDER_PRESETS.find(p => p.value === selected) : null;

  return (
    <div className="settings-tab-content active" data-tab="providers">
      <div className="pv-layout">
        {/* ── 左栏 ── */}
        <div className="pv-list">
          {/* OAuth 分组 */}
          {oauthProviders.length > 0 && (
            <>
              <div className="pv-list-section-title">OAuth</div>
              {oauthProviders.map(renderRegistered)}
            </>
          )}

          {/* API Key 分组 */}
          <div className="pv-list-section-title">API</div>
          {/* 已注册 preset providers */}
          {presetProviders.map(renderRegistered)}

          {/* 未注册 preset providers（灰色） */}
          {unregisteredPresets.map(renderUnregistered)}

          {/* 自定义 providers */}
          {customProviders.map(renderRegistered)}

          {/* 添加自定义供应商 */}
          <AddCustomButton
            adding={addingProvider}
            onToggle={() => setAddingProvider(!addingProvider)}
            onDone={() => { setAddingProvider(false); loadSummary(); }}
            onCancel={() => setAddingProvider(false)}
          />
        </div>

        {/* ── 右栏：Provider 详情 ── */}
        <div className="pv-detail">
          {selected ? (() => {
            // 已注册 or 未注册 preset → 统一用 ProviderDetail
            const existing = providersSummary[selected];
            const preset = PROVIDER_PRESETS.find(p => p.value === selected);
            const summary: ProviderSummary = existing || {
              type: 'api-key' as const,
              display_name: preset?.label || selected,
              base_url: preset?.url || '',
              api: preset?.api || '',
              api_key_masked: '',
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
            <div className="pv-empty">
              {t('settings.providers.selectHint')}
            </div>
          )}
        </div>
      </div>

      {/* ── 底部：全局模型分配 ── */}
      <section className="settings-section pv-other-section">
        <h2 className="settings-section-title">{t('settings.api.otherModelSection')}</h2>
        <OtherModelsSection providers={providers} />
      </section>
    </div>
  );
}

// ════════════════════════════════════════════════════
// Provider Detail (右栏)
// ════════════════════════════════════════════════════

function ProviderDetail({ providerId, summary, providerConfig, isPresetSetup, presetInfo, onRefresh }: {
  providerId: string;
  summary: ProviderSummary;
  providerConfig?: any;
  isPresetSetup?: boolean;
  presetInfo?: any;
  onRefresh: () => Promise<void>;
}) {
  return (
    <div className="pv-detail-inner">
      <div className="pv-detail-header">
        <h2 className="pv-detail-title">{summary.display_name || providerId}</h2>
        {summary.can_delete && !isPresetSetup && (
          <ProviderDeleteButton providerId={providerId} onRefresh={onRefresh} />
        )}
      </div>
      {/* 凭证 */}
      {summary.supports_oauth ? (
        <OAuthCredentials providerId={providerId} summary={summary} onRefresh={onRefresh} />
      ) : (
        <ApiKeyCredentials
          providerId={providerId}
          summary={summary}
          providerConfig={providerConfig}
          isPresetSetup={isPresetSetup}
          presetInfo={presetInfo}
          onRefresh={onRefresh}
        />
      )}

      {/* 已收藏模型（紧凑） */}
      <FavoritedModels providerId={providerId} summary={summary} />

      {/* 全部模型（下拉选择器） */}
      <ProviderModelList providerId={providerId} summary={summary} onRefresh={onRefresh} />
    </div>
  );
}

// ════════════════════════════════════════════════════
// Credentials: API Key
// ════════════════════════════════════════════════════

function ApiKeyCredentials({ providerId, summary, providerConfig, isPresetSetup, presetInfo, onRefresh }: {
  providerId: string; summary: ProviderSummary; providerConfig?: any;
  isPresetSetup?: boolean; presetInfo?: any; onRefresh: () => Promise<void>;
}) {
  const { showToast } = useSettingsStore();
  const [keyVal, setKeyVal] = useState('');
  const baseUrl = summary.base_url || presetInfo?.url || '';
  const api = summary.api || presetInfo?.api || '';

  // 验证 + 保存 API Key
  const verifyAndSave = async (btn: HTMLButtonElement) => {
    const key = keyVal.trim();
    if (!key && !presetInfo?.local) return;
    btn.classList.add('spinning');
    try {
      const testRes = await hanaFetch('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_url: baseUrl, api, api_key: key }),
      });
      const testData = await testRes.json();
      if (!testData.ok) {
        showToast(t('settings.providers.verifyFailed'), 'error');
        return;
      }
      const payload = isPresetSetup
        ? { base_url: baseUrl, api_key: key, api, models: [] }
        : { api_key: key };
      await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: payload } }),
      });
      showToast(t('settings.providers.verifySuccess'), 'success');
      if (isPresetSetup) useSettingsStore.setState({ selectedProviderId: providerId });
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    } finally {
      btn.classList.remove('spinning');
    }
  };

  const [connStatus, setConnStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');

  const verifyOnly = async (btn: HTMLButtonElement) => {
    setConnStatus('testing');
    btn.classList.add('spinning');
    try {
      const testRes = await hanaFetch('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_url: baseUrl, api, api_key: keyVal.trim() || undefined }),
      });
      const testData = await testRes.json();
      setConnStatus(testData.ok ? 'ok' : 'fail');
      showToast(testData.ok ? t('settings.providers.verifySuccess') : t('settings.providers.verifyFailed'), testData.ok ? 'success' : 'error');
    } catch {
      setConnStatus('fail');
      showToast(t('settings.providers.verifyFailed'), 'error');
    } finally {
      btn.classList.remove('spinning');
    }
  };

  return (
    <div className="pv-credentials">
      <div className="pv-cred-row">
        <span className="pv-cred-label">{t('settings.api.apiKey')}</span>
        <div className="pv-cred-key-row">
          <KeyInput
            value={keyVal}
            onChange={(v) => { setKeyVal(v); setConnStatus('idle'); }}
            placeholder={summary.api_key_masked || (isPresetSetup ? t('settings.providers.setupHint') : '')}
          />
          <button
            className={`pv-cred-conn-icon ${connStatus}`}
            title={t('settings.providers.verifyConnection')}
            onClick={(e) => {
              const key = keyVal.trim();
              if (key || presetInfo?.local) {
                verifyAndSave(e.currentTarget);
              } else {
                verifyOnly(e.currentTarget);
              }
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </button>
        </div>
      </div>
      <div className="pv-cred-row">
        <span className="pv-cred-label">Base URL</span>
        <span className="pv-cred-value muted">{baseUrl || '—'}</span>
      </div>
      <div className="pv-cred-row">
        <span className="pv-cred-label">{t('settings.providers.apiType')}</span>
        <div className="pv-cred-select-wrapper">
          <SelectWidget
            options={API_FORMAT_OPTIONS}
            value={api || ''}
            onChange={async (val) => {
              if (isPresetSetup) return;
              try {
                await hanaFetch('/api/config', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ providers: { [providerId]: { api: val } } }),
                });
                showToast(t('settings.saved'), 'success');
                await onRefresh();
              } catch {}
            }}
            placeholder="API Format"
          />
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════
// Credentials: OAuth
// ════════════════════════════════════════════════════

function OAuthCredentials({ providerId, summary, onRefresh }: {
  providerId: string; summary: ProviderSummary; onRefresh: () => Promise<void>;
}) {
  const { showToast } = useSettingsStore();
  const [codeInput, setCodeInput] = useState('');
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const pollingRef = useRef(false);

  const login = async () => {
    try {
      const res = await hanaFetch('/api/auth/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      platform?.openExternal?.(data.url);
      if (data.instructions) {
        setDeviceCode(data.instructions);
        setPolling(true);
        pollingRef.current = true;
        pollLogin(data.sessionId);
      } else if (data.polling) {
        setPolling(true);
        pollingRef.current = true;
        pollLogin(data.sessionId);
      } else {
        setShowCodeInput(true);
        (window as any).__oauthSessionId = data.sessionId;
      }
    } catch (err: any) {
      showToast(t('settings.oauth.failed') + ': ' + err.message, 'error');
    }
  };

  const submitCode = async () => {
    const code = codeInput.trim();
    if (!code) return;
    try {
      const res = await hanaFetch('/api/auth/oauth/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: (window as any).__oauthSessionId, code }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.oauth.success'), 'success');
      setShowCodeInput(false);
      await onRefresh();
    } catch (err: any) {
      showToast(t('settings.oauth.failed') + ': ' + err.message, 'error');
    }
  };

  const pollLogin = async (sessionId: string) => {
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 3000));
      if (!pollingRef.current) return;
      try {
        const res = await hanaFetch(`/api/auth/oauth/poll/${sessionId}`);
        const data = await res.json();
        if (data.status === 'done') {
          showToast(t('settings.oauth.success'), 'success');
          setDeviceCode(null);
          setPolling(false);
          pollingRef.current = false;
          await onRefresh();
          return;
        }
        if (data.status === 'error') throw new Error(data.error || 'Login failed');
      } catch (err: any) {
        showToast(t('settings.oauth.failed') + ': ' + err.message, 'error');
        setDeviceCode(null);
        setPolling(false);
        pollingRef.current = false;
        return;
      }
    }
    setDeviceCode(null);
    setPolling(false);
    pollingRef.current = false;
  };

  const logout = async () => {
    try {
      await hanaFetch('/api/auth/oauth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      showToast(t('settings.oauth.loggedOut'), 'success');
      await onRefresh();
    } catch (err: any) {
      showToast(t('settings.oauth.failed') + ': ' + err.message, 'error');
    }
  };

  return (
    <div className="pv-credentials">
      <div className="pv-cred-row">
        <span className="pv-cred-label">OAuth</span>
        {summary.logged_in ? (
          <div className="pv-oauth-status">
            <span className="oauth-status-badge">{t('settings.oauth.loggedIn')}</span>
            <button className="oauth-logout-btn" onClick={logout}>{t('settings.oauth.logout')}</button>
          </div>
        ) : (
          <button className="oauth-login-btn" onClick={login}>{t('settings.oauth.login')}</button>
        )}
      </div>

      {showCodeInput && (
        <div className="oauth-code-section">
          <input
            className="settings-input oauth-code-input"
            type="text"
            placeholder={t('settings.oauth.codePlaceholder')}
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitCode(); }}
            autoFocus
          />
          <button className="oauth-code-submit" onClick={submitCode}>{t('settings.oauth.submit')}</button>
        </div>
      )}
      {deviceCode && (
        <div className="oauth-code-section oauth-device-code">
          <div
            className="oauth-user-code"
            title={t('settings.oauth.clickToCopy')}
            onClick={() => navigator.clipboard.writeText(deviceCode).then(() => useSettingsStore.getState().showToast(t('settings.oauth.codeCopied'), 'success'))}
          >
            {deviceCode}
          </div>
          <div className="oauth-device-hint">{t('settings.oauth.deviceHint')}</div>
          <div className="oauth-device-spinner">{t('settings.oauth.waiting')}</div>
        </div>
      )}
      {polling && !deviceCode && !showCodeInput && (
        <div className="oauth-code-section">
          <div className="oauth-device-spinner">{t('settings.oauth.waiting')}</div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════
// Favorited Models (紧凑列表，在凭证和全部模型之间)
// ════════════════════════════════════════════════════

function FavoritedModels({ providerId, summary }: {
  providerId: string; summary: ProviderSummary;
}) {
  const { pendingFavorites, pendingDefaultModel } = useSettingsStore();
  const allModels = [...new Set([...(summary.models || []), ...(summary.custom_models || [])])];
  const favModels = allModels.filter(m => pendingFavorites.has(m));

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

  const [editing, setEditing] = useState<{ id: string; anchor: HTMLElement } | null>(null);

  if (favModels.length === 0) return null;

  return (
    <div className="pv-fav-section">
      <div className="pv-fav-title">
        {t('settings.api.addedModels')}
        <span className="pv-models-count">{favModels.length}</span>
      </div>
      <div className="pv-fav-list">
        {favModels.map(mid => {
          const meta = lookupModelMeta(mid) || {};
          return (
            <div key={mid} className="pv-fav-item">
              <span className="pv-fav-item-name" title={mid}>{meta.displayName || meta.name || mid}</span>
              {(meta.displayName || meta.name) && meta.displayName !== mid && meta.name !== mid && <span className="pv-fav-item-id">{mid}</span>}
              {meta.context && <span className="pv-model-ctx">{formatContext(meta.context)}</span>}
              <div className="pv-fav-item-actions">
                <button
                  className="pv-fav-item-edit"
                  title={t('settings.api.editModel')}
                  onClick={(e) => setEditing({ id: mid, anchor: e.currentTarget })}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
                <button className="pv-fav-item-remove" onClick={() => removeFavorite(mid)} title={t('settings.api.removeModel')}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {editing && (
        <ModelEditPanel modelId={editing.id} anchorEl={editing.anchor} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════
// Provider Model List (折叠式)
// ════════════════════════════════════════════════════

function ProviderModelList({ providerId, summary, onRefresh }: {
  providerId: string; summary: ProviderSummary; onRefresh: () => Promise<void>;
}) {
  const { pendingFavorites, pendingDefaultModel, showToast } = useSettingsStore();
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const [customInput, setCustomInput] = useState('');
  const [editingModel, setEditingModel] = useState<{ id: string; anchor: HTMLElement } | null>(null);

  const allModels = [...new Set([...(summary.models || []), ...(summary.custom_models || [])])];
  const query = search.toLowerCase();
  const filtered = query ? allModels.filter(m => m.toLowerCase().includes(query)) : allModels;

  const toggleFavorite = (mid: string) => {
    const next = new Set(pendingFavorites);
    if (next.has(mid)) {
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
    } else {
      next.add(mid);
      const wasEmpty = pendingFavorites.size === 0;
      const updates: Partial<any> = { pendingFavorites: next };
      if (wasEmpty) {
        updates.pendingDefaultModel = mid;
        const partial: Record<string, any> = { models: { chat: mid } };
        partial.api = { provider: providerId };
        autoSaveConfig(partial, { refreshModels: true });
      }
      useSettingsStore.setState(updates);
    }
    autoSaveModels();
  };

  const addCustomModel = async () => {
    const id = customInput.trim();
    if (!id) return;
    try {
      if (summary.supports_oauth) {
        const res = await hanaFetch(`/api/auth/oauth/${providerId}/custom-models`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: id }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
      } else {
        const currentModels = summary.models || [];
        await hanaFetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providers: { [providerId]: { models: [...currentModels, id] } } }),
        });
      }
      setCustomInput('');
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  const [fetchHint, setFetchHint] = useState<{ msg: string; ok: boolean } | null>(null);
  const fetchHintTimer = useRef<ReturnType<typeof setTimeout>>(null);

  const showFetchHint = (msg: string, ok: boolean) => {
    if (fetchHintTimer.current) clearTimeout(fetchHintTimer.current);
    setFetchHint({ msg, ok });
    fetchHintTimer.current = setTimeout(() => setFetchHint(null), 2500);
  };

  const fetchModels = async (btn: HTMLButtonElement | null) => {
    if (btn) btn.classList.add('spinning');
    try {
      const res = await hanaFetch('/api/providers/fetch-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: providerId, base_url: summary.base_url, api: summary.api }),
      });
      const data = await res.json();
      if (data.error) { showFetchHint(t('settings.providers.fetchFailed'), false); return; }
      const models = (data.models || []).map((m: any) => m.id || m.name);
      if (models.length === 0) { showFetchHint(t('settings.providers.fetchFailed'), false); return; }
      await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: { models } } }),
      });
      showFetchHint(t('settings.providers.fetchSuccess', { name: providerId, n: models.length }), true);
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch (err: any) {
      showFetchHint(t('settings.providers.fetchFailed'), false);
    } finally {
      if (btn) btn.classList.remove('spinning');
    }
  };

  // 下拉打开/关闭
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  // 计算面板位置（fixed，从触发器上方展开）
  useEffect(() => {
    if (!dropdownOpen || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const w = rect.width + 80;
    const left = Math.min(rect.left, window.innerWidth - w - 8);
    setPanelStyle({
      position: 'fixed',
      left: Math.max(8, left),
      width: w,
      bottom: window.innerHeight - rect.top + 4,
      zIndex: 9999,
    });
  }, [dropdownOpen]);

  // 点击外部关闭
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
    <div className="pv-models">
      {/* 添加模型行：下拉 + 读取按钮 同一行等高 */}
      <div className="pv-models-action-row">
        <button ref={triggerRef} className="pv-model-dropdown-trigger" onClick={() => setDropdownOpen(!dropdownOpen)}>
          <span>{t('settings.api.addModel')}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        <button
          className="pv-fetch-btn-inline"
          title={t('settings.providers.fetchModels')}
          onClick={(e) => fetchModels(e.currentTarget)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          {t('settings.providers.fetchModels')}
        </button>
      </div>
      {fetchHint && <div className={`pv-fetch-hint ${fetchHint.ok ? 'ok' : 'fail'}`}>{fetchHint.msg}</div>}
      {dropdownOpen && (
          <div className="pv-model-dropdown-panel" ref={panelRef} style={panelStyle}>
            <input
              className="pv-model-dropdown-search"
              type="text"
              placeholder={t('settings.api.searchModel')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            <div className="pv-model-dropdown-list">
              {filtered.map(mid => {
                const isFav = pendingFavorites.has(mid);
                const meta = lookupModelMeta(mid) || {};
                return (
                  <button
                    key={mid}
                    className={`pv-model-dropdown-option${isFav ? ' added' : ''}`}
                    onClick={() => { if (!isFav) { toggleFavorite(mid); } }}
                  >
                    <span className="pv-model-dropdown-option-name">{mid}</span>
                    {isFav && <span className="pv-model-dropdown-option-check">✓</span>}
                    {meta.context && <span className="pv-model-ctx">{formatContext(meta.context)}</span>}
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <div className="pv-model-dropdown-empty">{t('settings.providers.noModels')}</div>
              )}
            </div>
            {/* 自定义模型输入 */}
            <div className="pv-model-dropdown-custom">
              <input
                className="pv-model-dropdown-custom-input"
                type="text"
                placeholder={t('settings.oauth.customModelPlaceholder')}
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { addCustomModel(); } }}
              />
              <button className="pv-model-add-btn" onClick={addCustomModel}>↵</button>
            </div>
          </div>
        )}
    </div>
  );
}

// ════════════════════════════════════════════════════
// Model Edit Panel (reused from ModelsTab)
// ════════════════════════════════════════════════════

function ModelEditPanel({ modelId, anchorEl, onClose }: {
  modelId: string; anchorEl: HTMLElement | null; onClose: () => void;
}) {
  const { showToast } = useSettingsStore();
  const meta = lookupModelMeta(modelId) || {};
  const [displayName, setDisplayName] = useState(meta.displayName || '');
  const [ctxVal, setCtxVal] = useState(String(meta.context || ''));
  const [outVal, setOutVal] = useState(String(meta.maxOutput || ''));
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  // 居中定位
  useEffect(() => {
    setStyle({
      position: 'fixed',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: 9999,
      width: 360,
    });
  }, [anchorEl]);

  const save = async () => {
    const entry: Record<string, any> = {};
    const name = displayName.trim();
    const ctx = ctxVal.trim();
    const maxOut = outVal.trim();
    if (name) entry.displayName = name;
    if (ctx) entry.context = parseInt(ctx);
    if (maxOut) entry.maxOutput = parseInt(maxOut);
    const config = useSettingsStore.getState().settingsConfig;
    const currentOverrides = config?.models?.overrides || {};
    await autoSaveConfig({ models: { overrides: { ...currentOverrides, [modelId]: entry } } });
    showToast(t('settings.saved'), 'success');
    onClose();
  };

  return (
    <>
    <div className="pv-model-edit-overlay" onClick={onClose} />
    <div ref={panelRef} className="pv-model-edit-card" style={style}>
      <div className="pv-model-edit-field">
        <label className="pv-model-edit-label">ID</label>
        <span className="pv-model-edit-id">{modelId}</span>
      </div>
      <div className="pv-model-edit-field">
        <label className="pv-model-edit-label">{t('settings.api.displayName')}</label>
        <input
          className="settings-input"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={modelId}
        />
      </div>
      <div className="pv-model-edit-row">
        <div className="pv-model-edit-field">
          <label className="pv-model-edit-label">{t('settings.api.contextLength')}</label>
          <ComboInput presets={CONTEXT_PRESETS} value={ctxVal} onChange={setCtxVal} placeholder="131072" />
        </div>
        <div className="pv-model-edit-field">
          <label className="pv-model-edit-label">{t('settings.api.maxOutput')}</label>
          <ComboInput presets={OUTPUT_PRESETS} value={outVal} onChange={setOutVal} placeholder="16384" />
        </div>
      </div>
      <div className="pv-model-edit-actions">
        <button type="button" className="pv-add-form-btn" onClick={onClose}>{t('settings.api.cancel')}</button>
        <button type="button" className="pv-add-form-btn primary" onClick={save}>{t('settings.api.save')}</button>
      </div>
    </div>
    </>
  );
}

// ════════════════════════════════════════════════════
// Add Provider Form
// ════════════════════════════════════════════════════

// ════════════════════════════════════════════════════
// Add Custom Button (fixed popover)
// ════════════════════════════════════════════════════

function AddCustomButton({ adding, onToggle, onDone, onCancel }: {
  adding: boolean; onToggle: () => void; onDone: () => void; onCancel: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (!adding || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - 360 - 8);
    setStyle({
      left: Math.max(8, left),
      bottom: window.innerHeight - rect.top + 4,
    });
  }, [adding]);

  // 点击外部关闭
  useEffect(() => {
    if (!adding) return;
    const handler = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (popRef.current?.contains(e.target as Node)) return;
      onCancel();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [adding, onCancel]);

  return (
    <div className="pv-add-wrapper">
      <button ref={btnRef} className="pv-add-btn" onClick={onToggle}>
        + {t('settings.providers.addCustom')}
      </button>
      {adding && (
        <div ref={popRef} className="pv-add-popover" style={style}>
          <AddProviderForm onDone={onDone} onCancel={onCancel} />
        </div>
      )}
    </div>
  );
}

// (PresetSetup 已合并到 ApiKeyCredentials，通过 isPresetSetup prop 区分)

// ════════════════════════════════════════════════════
// Add Custom Provider
// ════════════════════════════════════════════════════

function AddProviderForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { showToast } = useSettingsStore();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [api, setApi] = useState('openai-completions');

  const submit = async () => {
    const n = name.trim().toLowerCase();
    const u = url.trim();
    if (!n) { showToast(t('settings.providers.nameRequired'), 'error'); return; }
    if (!u) { showToast(t('settings.providers.urlRequired'), 'error'); return; }
    try {
      const res = await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [n]: { base_url: u, api_key: apiKey.trim(), api, models: [] } } }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.providers.added', { name: n }), 'success');
      await loadSettingsConfig();
      platform?.settingsChanged?.('models-changed');
      useSettingsStore.setState({ selectedProviderId: n });
      onDone();
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  return (
    <div className="pv-add-form">
      <div className="pv-add-form-field">
        <label className="pv-add-form-label">{t('settings.providers.customName')}</label>
        <input className="settings-input" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-provider" />
      </div>
      <div className="pv-add-form-field">
        <label className="pv-add-form-label">Base URL</label>
        <input className="settings-input" type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/v1" />
      </div>
      <div className="pv-add-form-field">
        <label className="pv-add-form-label">{t('settings.api.apiKey')}</label>
        <KeyInput value={apiKey} onChange={setApiKey} placeholder={t('settings.api.apiKeyPlaceholder')} />
      </div>
      <div className="pv-add-form-field">
        <label className="pv-add-form-label">{t('settings.providers.apiFormat')}</label>
        <SelectWidget options={API_FORMAT_OPTIONS} value={api} onChange={setApi} placeholder="API Format" />
      </div>
      <div className="pv-add-form-actions">
        <button className="pv-add-form-btn" onClick={onCancel}>{t('settings.api.cancel')}</button>
        <button className="pv-add-form-btn primary" onClick={submit}>{t('settings.providers.addBtn')}</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════
// Delete Provider
// ════════════════════════════════════════════════════

function ProviderDeleteButton({ providerId, onRefresh }: { providerId: string; onRefresh: () => Promise<void> }) {
  const { showToast } = useSettingsStore();
  const [confirming, setConfirming] = useState(false);

  const handleDelete = async () => {
    try {
      const res = await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: null } }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.providers.deleted', { name: providerId }), 'success');
      useSettingsStore.setState({ selectedProviderId: null });
      setConfirming(false);
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  return (
    <>
      <button className="pv-delete-btn" onClick={() => setConfirming(true)}>
        {t('settings.providers.delete')}
      </button>
      {confirming && (
        <>
          <div className="pv-model-edit-overlay" onClick={() => setConfirming(false)} />
          <div className="pv-confirm-dialog">
            <p className="pv-confirm-text">
              {t('settings.providers.deleteConfirm', { name: providerId })}
            </p>
            <div className="pv-confirm-actions">
              <button className="pv-add-form-btn" onClick={() => setConfirming(false)}>{t('settings.api.cancel')}</button>
              <button className="pv-add-form-btn danger" onClick={handleDelete}>{t('settings.providers.delete')}</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ════════════════════════════════════════════════════
// Other Models Section (migrated from ModelsTab)
// ════════════════════════════════════════════════════

function ToolModelTestBtn({ modelId }: { modelId: string }) {
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');

  const test = async () => {
    if (!modelId) return;
    setStatus('testing');
    try {
      const res = await hanaFetch('/api/models/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      });
      const data = await res.json();
      setStatus(data.ok ? 'ok' : 'fail');
    } catch {
      setStatus('fail');
    }
    setTimeout(() => setStatus('idle'), 3000);
  };

  if (!modelId) return null;

  return (
    <button className={`pv-tool-test-btn ${status}`} onClick={test} disabled={status === 'testing'}>
      {status === 'testing' ? (
        <svg className="spinning" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      ) : status === 'ok' ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : status === 'fail' ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      )}
    </button>
  );
}

function OtherModelsSection({ providers }: { providers: Record<string, any> }) {
  const { globalModelsConfig, pendingFavorites, showToast } = useSettingsStore();
  const [searchApiKey, setSearchApiKey] = useState('');

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
          <div className="pv-tool-model-row">
            <ModelWidget
              providers={providers}
              favorites={pendingFavorites}
              value={globalModelsConfig?.models?.utility || ''}
              onSelect={(id) => autoSaveGlobalModels({ models: { utility: id } })}
              lookupModelMeta={lookupModelMeta}
              formatContext={formatContext}
            />
            <ToolModelTestBtn modelId={globalModelsConfig?.models?.utility || ''} />
          </div>
          <span className="settings-field-hint">{t('settings.api.utilityModelHint')}</span>
        </div>
        <div className="settings-field settings-field-half">
          <label className="settings-field-label">{t('settings.api.utilityLargeModel')}</label>
          <div className="pv-tool-model-row">
            <ModelWidget
              providers={providers}
              favorites={pendingFavorites}
              value={globalModelsConfig?.models?.utility_large || ''}
              onSelect={(id) => autoSaveGlobalModels({ models: { utility_large: id } })}
              lookupModelMeta={lookupModelMeta}
              formatContext={formatContext}
            />
            <ToolModelTestBtn modelId={globalModelsConfig?.models?.utility_large || ''} />
          </div>
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
