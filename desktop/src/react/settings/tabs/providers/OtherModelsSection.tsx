import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../../store';
import { hanaFetch } from '../../api';
import {
  t, lookupModelMeta, formatContext, autoSaveGlobalModels,
} from '../../helpers';
import { loadSettingsConfig } from '../../actions';
import { SelectWidget } from '../../widgets/SelectWidget';
import { ModelWidget } from '../../widgets/ModelWidget';
import { KeyInput } from '../../widgets/KeyInput';
import { Toggle } from '../../widgets/Toggle';
import styles from '../../Settings.module.css';

type ModelRef = { id: string; provider: string };

const BROWSER_SEARCH_PROVIDERS = new Set(['bing_browser', 'google_browser', 'duckduckgo_browser']);

function searchProviderNeedsApiKey(provider: string): boolean {
  return !!provider && !BROWSER_SEARCH_PROVIDERS.has(provider);
}

function ToolModelTestBtn({ modelRef }: { modelRef: unknown }) {
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');

  const ref = typeof modelRef === 'object' && modelRef !== null
    ? {
        id: String((modelRef as any).id || ''),
        provider: String((modelRef as any).provider || ''),
      }
    : { id: String(modelRef || ''), provider: '' };
  const hasRef = !!ref.id;

  const test = async () => {
    if (!hasRef) return;
    setStatus('testing');
    try {
      const res = await hanaFetch('/api/models/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: ref.id, provider: ref.provider }),
      });
      const data = await res.json();
      setStatus(data.ok ? 'ok' : 'fail');
    } catch {
      setStatus('fail');
    }
    setTimeout(() => setStatus('idle'), 3000);
  };

  if (!hasRef) return null;

  return (
    <button className={`${styles['pv-tool-test-btn']} ${styles[status] || ''}`} onClick={test} disabled={status === 'testing'}>
      {status === 'testing' ? (
        <svg className={styles['spinning']} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

export function OtherModelsSection({ providers }: { providers: Record<string, { models?: string[]; base_url?: string }> }) {
  const { globalModelsConfig, showToast } = useSettingsStore();
  const savedSearchKey = globalModelsConfig?.search?.api_key || '';
  const [searchApiKey, setSearchApiKey] = useState('');
  const [searchKeyEdited, setSearchKeyEdited] = useState(false);

  // 从后端同步已保存的 key
  useEffect(() => {
    if (!searchKeyEdited && savedSearchKey) setSearchApiKey(savedSearchKey);
  }, [savedSearchKey, searchKeyEdited]);

  const searchProvider = globalModelsConfig?.search?.provider || '';
  const searchIsBrowserProvider = BROWSER_SEARCH_PROVIDERS.has(searchProvider);
  const searchNeedsApiKey = searchProviderNeedsApiKey(searchProvider);

  useEffect(() => {
    if (searchIsBrowserProvider) {
      setSearchApiKey('');
      setSearchKeyEdited(false);
    }
  }, [searchIsBrowserProvider]);

  const verifySearch = async () => {
    const provider = (globalModelsConfig?.search?.provider || '').trim();
    const apiKey = searchApiKey.trim();
    if (!provider) { showToast(t('settings.search.noProvider'), 'error'); return; }
    if (searchProviderNeedsApiKey(provider) && !apiKey) { showToast(t('settings.search.noKey'), 'error'); return; }
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    }
  };

  // 工具模型配置可能来自老数据。展示层可读裸 id；保存路径必须重新选择成 {id, provider}。
  const toModelRef = (raw: unknown): ModelRef | null => {
    if (!raw) return null;
    if (typeof raw === 'object' && (raw as any).id) {
      return {
        id: String((raw as any).id || ''),
        provider: String((raw as any).provider || ''),
      };
    }
    const s = String(raw || '').trim();
    if (!s) return null;
    const slashIdx = s.indexOf('/');
    if (slashIdx > 0 && slashIdx < s.length - 1) {
      return { provider: s.slice(0, slashIdx), id: s.slice(slashIdx + 1) };
    }
    return { id: s, provider: '' };
  };

  const utilityVal = toModelRef(globalModelsConfig?.models?.utility);
  const utilityLargeVal = toModelRef(globalModelsConfig?.models?.utility_large);
  const visionVal = toModelRef(globalModelsConfig?.models?.vision);
  const visionAuxiliaryEnabled = globalModelsConfig?.models?.vision_enabled === true;
  const imageCapableOnly = (model: { input?: string[] }) => (
    Array.isArray(model.input) && model.input.includes('image')
  );

  return (
    <div style={{ padding: 'var(--space-md)' }}>
      <div className={styles['settings-form-grid']}>
        <div className={`${styles['settings-form-field']} ${styles['settings-form-field-half']}`}>
          <label className={styles['settings-form-label']}>{t('settings.api.utilityModel')}</label>
          <div className={styles['pv-tool-model-row']}>
            <ModelWidget
              providers={providers}
              value={utilityVal}
              onSelect={(ref) => {
                autoSaveGlobalModels({ models: { utility: ref } });
              }}
              lookupModelMeta={lookupModelMeta}
              formatContext={formatContext}
            />
            <ToolModelTestBtn modelRef={globalModelsConfig?.models?.utility || ''} />
          </div>
          <span className={styles['settings-form-hint']}>{t('settings.api.utilityModelHint')}</span>
        </div>
        <div className={`${styles['settings-form-field']} ${styles['settings-form-field-half']}`}>
          <label className={styles['settings-form-label']}>{t('settings.api.utilityLargeModel')}</label>
          <div className={styles['pv-tool-model-row']}>
            <ModelWidget
              providers={providers}
              value={utilityLargeVal}
              onSelect={(ref) => {
                autoSaveGlobalModels({ models: { utility_large: ref } });
              }}
              lookupModelMeta={lookupModelMeta}
              formatContext={formatContext}
            />
            <ToolModelTestBtn modelRef={globalModelsConfig?.models?.utility_large || ''} />
          </div>
          <span className={styles['settings-form-hint']}>{t('settings.api.utilityLargeModelHint')}</span>
        </div>
      </div>
      <div className={styles['settings-form-grid']}>
        <div className={`${styles['settings-form-field']} ${styles['settings-form-field-half']}`}>
          <label className={styles['settings-form-label']}>{t('settings.api.visionModel')}</label>
          <div className={styles['settings-toggle-row']}>
            <Toggle
              on={visionAuxiliaryEnabled}
              onChange={(on) => {
                autoSaveGlobalModels({ models: { vision_enabled: on } });
              }}
              label={t('settings.api.visionAuxiliaryToggle')}
            />
          </div>
          <div className={styles['pv-tool-model-row']}>
            <ModelWidget
              providers={providers}
              value={visionVal}
              onSelect={(ref) => {
                autoSaveGlobalModels({ models: { vision: ref } });
              }}
              lookupModelMeta={lookupModelMeta}
              formatContext={formatContext}
              filterModel={imageCapableOnly}
            />
            <ToolModelTestBtn modelRef={globalModelsConfig?.models?.vision || ''} />
          </div>
          <span className={styles['settings-form-hint']}>{t('settings.api.visionModelHint')}</span>
        </div>
      </div>
      <div className={styles['settings-form-grid']}>
        <div className={`${styles['settings-form-field']} ${styles['settings-form-field-half']}`}>
          <label className={styles['settings-form-label']}>{t('settings.api.searchProviderField')}</label>
          <SelectWidget
            options={[
              { value: '', label: 'Default (Bing Browser)' },
              { value: 'bing_browser', label: 'Bing (Browser)' },
              { value: 'google_browser', label: 'Google (Browser)' },
              { value: 'duckduckgo_browser', label: 'DuckDuckGo (Browser)' },
              { value: 'tavily', label: 'Tavily' },
              { value: 'serper', label: 'Serper (Google)' },
              { value: 'brave', label: 'Brave Search' },
            ]}
            value={searchProvider}
            onChange={(val) => autoSaveGlobalModels({
              search: BROWSER_SEARCH_PROVIDERS.has(val)
                ? { provider: val, api_key: '' }
                : { provider: val },
            })}
            placeholder={t('settings.api.searchProviderField')}
          />
        </div>
        <div className={`${styles['settings-form-field']} ${styles['settings-form-field-half']}`}>
          <label className={styles['settings-form-label']}>{t('settings.api.searchApiKey')}</label>
          {searchIsBrowserProvider ? (
            <span className={styles['settings-form-hint']}>{t('settings.api.searchApiKeyNotRequired')}</span>
          ) : (
            <>
              <KeyInput
                value={searchApiKey}
                onChange={(v) => { setSearchApiKey(v); setSearchKeyEdited(true); }}
                placeholder={t('settings.api.apiKeyPlaceholder')}
              />
              <button className={styles['search-verify-btn']} onClick={verifySearch}>
                {t('settings.search.verify')}
              </button>
              <span className={styles['settings-form-hint']}>{t('settings.api.searchApiKeyHint')}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
