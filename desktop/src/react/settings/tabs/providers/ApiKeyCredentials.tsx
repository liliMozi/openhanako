import React, { useState, useEffect } from 'react';
import { useSettingsStore, type ProviderSummary } from '../../store';
import { hanaFetch } from '../../api';
import { invalidateConfigCache } from '../../../hooks/use-config';
import { t, API_FORMAT_OPTIONS } from '../../helpers';
import { SelectWidget } from '../../widgets/SelectWidget';
import { KeyInput } from '../../widgets/KeyInput';
import { getApiKeySavePlan } from './api-key-save-plan';
import styles from '../../Settings.module.css';

const platform = window.platform;

export function ApiKeyCredentials({ providerId, summary, providerConfig, isPresetSetup, presetInfo, onRefresh }: {
  providerId: string;
  summary: ProviderSummary;
  providerConfig?: Record<string, unknown>;
  isPresetSetup?: boolean;
  presetInfo?: { label: string; value: string; url?: string; api?: string; local?: boolean };
  onRefresh: () => Promise<void>;
}) {
  const { showToast } = useSettingsStore();
  const [keyVal, setKeyVal] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const derivedBaseUrl = summary.base_url || presetInfo?.url || '';
  const [urlVal, setUrlVal] = useState(derivedBaseUrl);
  const [urlEdited, setUrlEdited] = useState(false);
  const api = summary.api || presetInfo?.api || '';

  // 未编辑时，从 summary 同步已保存的 key 到输入框
  useEffect(() => {
    if (!keyEdited && summary.api_key) {
      setKeyVal(summary.api_key);
    }
  }, [summary.api_key, keyEdited]);

  // 未编辑时，从 summary 同步 base_url
  useEffect(() => {
    if (!urlEdited) setUrlVal(derivedBaseUrl);
  }, [derivedBaseUrl, urlEdited]);

  const verifyAndSave = async (btn: HTMLButtonElement) => {
    const plan = getApiKeySavePlan({
      keyEdited,
      keyVal,
      urlEdited,
      urlVal,
      derivedBaseUrl,
      isPresetSetup: !!isPresetSetup,
      isLocalPreset: !!presetInfo?.local,
      api,
    });
    if (!plan.shouldSave) return;
    btn.classList.add(styles['spinning']);
    try {
      if (plan.shouldVerify) {
        const testRes = await hanaFetch('/api/providers/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base_url: plan.effectiveUrl, api: plan.api, api_key: plan.key }),
        });
        const testData = await testRes.json();
        if (!testData.ok) {
          showToast(t('settings.providers.verifyFailed'), 'error');
          return;
        }
      }
      await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: plan.payload } }),
      });
      invalidateConfigCache();
      showToast(plan.shouldVerify ? t('settings.providers.verifySuccess') : t('settings.saved'), 'success');
      if (isPresetSetup) useSettingsStore.setState({ selectedProviderId: providerId });
      setKeyEdited(false);
      if (urlEdited) setUrlEdited(false);
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    } finally {
      btn.classList.remove(styles['spinning']);
    }
  };

  const [connStatus, setConnStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');

  const verifyOnly = async (btn: HTMLButtonElement) => {
    setConnStatus('testing');
    btn.classList.add(styles['spinning']);
    try {
      const testRes = await hanaFetch('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_url: urlVal.trim() || derivedBaseUrl, api, api_key: keyVal.trim() || undefined }),
      });
      const testData = await testRes.json();
      setConnStatus(testData.ok ? 'ok' : 'fail');
      showToast(testData.ok ? t('settings.providers.verifySuccess') : t('settings.providers.verifyFailed'), testData.ok ? 'success' : 'error');
    } catch {
      setConnStatus('fail');
      showToast(t('settings.providers.verifyFailed'), 'error');
    } finally {
      btn.classList.remove(styles['spinning']);
    }
  };

  return (
    <div className={styles['pv-credentials']}>
      <div className={styles['pv-cred-row']}>
        <span className={styles['pv-cred-label']}>{t('settings.api.apiKey')}</span>
        <div className={styles['pv-cred-key-row']}>
          <KeyInput
            value={keyVal}
            onChange={(v) => { setKeyVal(v); setKeyEdited(true); setConnStatus('idle'); }}
            placeholder={isPresetSetup ? t('settings.providers.setupHint') : ''}
          />
          <button
            className={`${styles['pv-cred-conn-icon']} ${styles[connStatus] || ''}`}
            title={t('settings.providers.verifyConnection')}
            onClick={(e) => {
              if (keyEdited && (keyVal.trim() || presetInfo?.local)) {
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
      <div className={styles['pv-cred-row']}>
        <span className={styles['pv-cred-label']}>Base URL</span>
        <div className={styles['pv-cred-url-row']}>
          <input
            className={styles['settings-input']}
            type="text"
            value={urlVal}
            onChange={(e) => { setUrlVal(e.target.value); setUrlEdited(true); }}
            onBlur={async () => {
              if (!urlEdited || isPresetSetup) return;
              const trimmed = urlVal.trim();
              if (trimmed === derivedBaseUrl) { setUrlEdited(false); return; }
              try {
                await hanaFetch('/api/config', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ providers: { [providerId]: { base_url: trimmed } } }),
                });
                invalidateConfigCache();
                showToast(t('settings.saved'), 'success');
                setUrlEdited(false);
                await onRefresh();
              } catch { /* swallow */ }
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            placeholder="https://api.example.com/v1"
            readOnly={!!isPresetSetup}
          />
        </div>
      </div>
      <div className={styles['pv-cred-row']}>
        <span className={styles['pv-cred-label']}>{t('settings.providers.apiType')}</span>
        <div className={styles['pv-cred-select-wrapper']}>
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
                invalidateConfigCache();
                showToast(t('settings.saved'), 'success');
                await onRefresh();
              } catch { /* swallow */ }
            }}
            placeholder="API Format"
            disabled={!!isPresetSetup}
          />
        </div>
      </div>
    </div>
  );
}
