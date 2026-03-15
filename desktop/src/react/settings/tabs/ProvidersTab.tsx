import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t, PROVIDER_PRESETS, API_FORMAT_OPTIONS } from '../helpers';
import { SelectWidget } from '../widgets/SelectWidget';
import { KeyInput } from '../widgets/KeyInput';
import { loadSettingsConfig } from '../actions';

const platform = (window as any).platform;

// OAuth 合规白名单（MiniMax 合法，OpenAI Codex 灰色但安全）
const ALLOWED_OAUTH = new Set(['minimax', 'openai-codex']);

export function ProvidersTab() {
  const { settingsConfig, showToast } = useSettingsStore();
  const providers = settingsConfig?.providers || {};
  const [newKey, setNewKey] = useState('');
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customApi, setCustomApi] = useState('');
  const [presetVal, setPresetVal] = useState('');
  const [oauthStatus, setOauthStatus] = useState<Record<string, any>>({});

  const registered = new Set(Object.keys(providers));
  const isCustom = presetVal === '__custom__';

  const oauthEntries = Object.entries(oauthStatus).filter(([id]) => ALLOWED_OAUTH.has(id));
  const hasOAuth = oauthEntries.length > 0;
  const oauthProviderIds = new Set(oauthEntries.map(([id]) => id));

  useEffect(() => {
    loadOAuthStatus();
  }, []);

  const loadOAuthStatus = async () => {
    try {
      const res = await hanaFetch('/api/auth/oauth/status');
      setOauthStatus(await res.json());
    } catch {}
  };

  const presetOptions = PROVIDER_PRESETS.map(p => {
    const isRegistered = registered.has(p.value) && !oauthProviderIds.has(p.value);
    return {
      value: p.value,
      label: isRegistered ? p.label + ' ✓' : p.label,
      disabled: isRegistered,
    };
  });
  presetOptions.push({ value: '__custom__', label: t('settings.api.customInput') || '自定义...', disabled: false });

  const addProvider = async () => {
    const key = newKey.trim();
    let name: string, url: string, api: string;
    if (isCustom) {
      name = customName.trim().toLowerCase();
      url = customUrl.trim();
      api = customApi.trim();
      if (!name) { showToast(t('settings.providers.nameRequired'), 'error'); return; }
      if (!url) { showToast(t('settings.providers.urlRequired'), 'error'); return; }
      if (!api) { showToast(t('settings.providers.apiRequired'), 'error'); return; }
    } else if (presetVal) {
      const preset = PROVIDER_PRESETS.find(p => p.value === presetVal);
      name = presetVal;
      url = preset?.url || '';
      api = preset?.api || '';
      if (!url || !api) {
        showToast(t('settings.providers.apiRequired'), 'error');
        return;
      }
    } else {
      showToast(t('settings.providers.nameRequired'), 'error');
      return;
    }

    try {
      const res = await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [name]: { base_url: url, api_key: key, api, models: [] } } }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.providers.added', { name }), 'success');
      setPresetVal('');
      setNewKey('');
      setCustomName('');
      setCustomUrl('');
      setCustomApi('');
      await loadSettingsConfig();
      platform?.settingsChanged?.('models-changed');
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  const deleteProvider = async (name: string) => {
    try {
      const res = await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [name]: null } }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.providers.deleted', { name }), 'success');
      await loadSettingsConfig();
      platform?.settingsChanged?.('models-changed');
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  const fetchModels = async (name: string, baseUrl: string, api: string, btn: HTMLButtonElement | null) => {
    if (btn) btn.classList.add('spinning');
    try {
      const res = await hanaFetch('/api/providers/fetch-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, base_url: baseUrl, api }),
      });
      const data = await res.json();
      if (data.error) { showToast(t('settings.providers.fetchFailed') + ': ' + data.error, 'error'); return; }
      const models = (data.models || []).map((m: any) => m.id || m.name);
      if (models.length === 0) { showToast(t('settings.providers.fetchFailed'), 'error'); return; }
      await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [name]: { models } } }),
      });
      showToast(t('settings.providers.fetchSuccess', { name, n: models.length }), 'success');
      await loadSettingsConfig();
      platform?.settingsChanged?.('models-changed');
    } catch (err: any) {
      showToast(t('settings.providers.fetchFailed') + ': ' + err.message, 'error');
    } finally {
      if (btn) btn.classList.remove('spinning');
    }
  };

  // 右侧列表排除所有 OAuth provider，OAuth 的只在上方卡片区显示
  const apiProviders = Object.entries(providers).filter(([name]) =>
    !oauthProviderIds.has(name)
  );

  return (
    <div className="settings-tab-content active" data-tab="providers">
      <div className="providers-layout">
        <div className="providers-left">
          {/* OAuth */}
          {hasOAuth && (
            <section className="settings-section">
              <h2 className="settings-section-title">{t('settings.oauth.title')}</h2>
              <div className="oauth-list">
                {oauthEntries.map(([id, info]) => (
                  <OAuthRow
                    key={id}
                    providerId={id}
                    info={info}
                    providerConfig={providers[id]}
                    onRefresh={loadOAuthStatus}
                  />
                ))}
              </div>
            </section>
          )}

          {/* 添加供应商 */}
          <section className="settings-section">
            <h2 className="settings-section-title">{t('settings.providers.addTitle')}</h2>
            <div className="settings-field">
              <label className="settings-field-label">{t('settings.providers.name')}</label>
              <SelectWidget
                options={presetOptions}
                value={presetVal}
                onChange={setPresetVal}
                placeholder={t('settings.providers.name') || '选择供应商'}
              />
            </div>
            {isCustom && (
              <>
                <div className="settings-field">
                  <label className="settings-field-label">{t('settings.providers.customName')}</label>
                  <input className="settings-input" type="text" value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="my-provider" />
                </div>
                <div className="settings-field">
                  <label className="settings-field-label">{t('settings.providers.customUrl')}</label>
                  <input className="settings-input" type="text" value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} placeholder="https://api.example.com/v1" />
                </div>
                <div className="settings-field">
                  <label className="settings-field-label">{t('settings.providers.apiFormat')}</label>
                  <SelectWidget
                    options={API_FORMAT_OPTIONS}
                    value={customApi}
                    onChange={setCustomApi}
                    placeholder={t('settings.providers.apiFormat')}
                  />
                </div>
              </>
            )}
            <div className="settings-field">
              <label className="settings-field-label">{t('settings.api.apiKey')}</label>
              <KeyInput value={newKey} onChange={setNewKey} placeholder={t('settings.api.apiKeyPlaceholder')} />
            </div>
            <button className="provider-add-btn" onClick={addProvider}>{t('settings.providers.addBtn')}</button>
          </section>
        </div>

        <div className="providers-right">
          <section className="settings-section">
            <h2 className="settings-section-title">{t('settings.providers.title')}</h2>
            <div className={apiProviders.length > 0 ? 'provider-list' : ''}>
              {apiProviders.length === 0 ? (
                <div className="provider-empty">{t('settings.providers.empty')}</div>
              ) : (
                apiProviders.map(([name, p]: [string, any]) => (
                  <div key={name} className="provider-item" data-provider={name}>
                    <span className="provider-item-name" title={p.base_url || ''}>{name}</span>
                    <span className="provider-item-count">
                      {(p.models || []).length > 0
                        ? t('settings.providers.modelCount', { n: (p.models || []).length })
                        : t('settings.providers.noModels')}
                    </span>
                    <div className="provider-item-actions">
                      <button
                        className="provider-item-action fetch"
                        title={t('settings.providers.fetchModels')}
                        onClick={(e) => fetchModels(name, p.base_url, p.api, e.currentTarget)}
                      >
                        {t('settings.providers.fetchModels')}
                      </button>
                      <button
                        className="provider-item-action delete"
                        title={t('settings.providers.delete')}
                        onClick={() => deleteProvider(name)}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ── OAuth Row ──
function OAuthRow({ providerId, info, providerConfig, onRefresh }: {
  providerId: string;
  info: any;
  providerConfig?: any;
  onRefresh: () => void;
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
        // 设备码流程：显示 user_code + 轮询
        setDeviceCode(data.instructions);
        setPolling(true);
        pollingRef.current = true;
        pollLogin(data.sessionId);
      } else if (data.polling) {
        // callback server 流程（如 OpenAI Codex）：只轮询，不显示设备码
        setPolling(true);
        pollingRef.current = true;
        pollLogin(data.sessionId);
      } else {
        // 授权码流程：用户粘贴 code
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
      onRefresh();
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
          onRefresh();
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
      const res = await hanaFetch('/api/auth/oauth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast(t('settings.oauth.loggedOut'), 'success');
      onRefresh();
    } catch (err: any) {
      showToast(t('settings.oauth.failed') + ': ' + err.message, 'error');
    }
  };

  return (
    <div className="oauth-provider-row">
      <div className="oauth-provider-header">
        <span className="oauth-provider-name">{info.name}</span>
        {info.loggedIn ? (
          <>
            <span className="oauth-status-badge">{t('settings.oauth.loggedIn')}</span>
            <button className="oauth-logout-btn" onClick={logout}>{t('settings.oauth.logout')}</button>
          </>
        ) : (
          <button className="oauth-login-btn" onClick={login}>{t('settings.oauth.login')}</button>
        )}
      </div>
      {info.loggedIn && (
        <div className="oauth-provider-models">
          <span className="provider-item-count">
            {(info.modelCount || 0) > 0
              ? t('settings.providers.modelCount', { n: info.modelCount })
              : t('settings.providers.noModels')}
          </span>
        </div>
      )}
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
            onClick={() => navigator.clipboard.writeText(deviceCode).then(() => showToast(t('settings.oauth.codeCopied'), 'success'))}
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
