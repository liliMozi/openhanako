import React, { useState, useEffect } from 'react';
import { useSettingsStore, type ProviderSummary } from '../../store';
import { hanaFetch } from '../../api';
import { t, API_FORMAT_OPTIONS } from '../../helpers';
import { SelectWidget } from '../../widgets/SelectWidget';
import { KeyInput } from '../../widgets/KeyInput';
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
  const baseUrl = summary.base_url || presetInfo?.url || '';
  const api = summary.api || presetInfo?.api || '';

  // 未编辑时，从 summary 同步遮掩值到输入框（让用户看到"已保存"）
  useEffect(() => {
    if (!keyEdited && summary.api_key_masked) {
      setKeyVal(summary.api_key_masked);
    }
  }, [summary.api_key_masked, keyEdited]);

  const verifyAndSave = async (btn: HTMLButtonElement) => {
    if (!keyEdited) return;
    const key = keyVal.trim();
    if (!key && !presetInfo?.local) return;
    btn.classList.add(styles['spinning']);
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
        ? { base_url: baseUrl, api_key: key, api, models: [] as string[] }
        : { api_key: key };
      await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: payload } }),
      });
      showToast(t('settings.providers.verifySuccess'), 'success');
      if (isPresetSetup) useSettingsStore.setState({ selectedProviderId: providerId });
      setKeyEdited(false);
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
        body: JSON.stringify({ base_url: baseUrl, api, api_key: (keyEdited && keyVal.trim()) || undefined }),
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
        <span className={`${styles['pv-cred-value']} ${styles['muted']}`}>{baseUrl || '\u2014'}</span>
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
                showToast(t('settings.saved'), 'success');
                await onRefresh();
              } catch { /* swallow */ }
            }}
            placeholder="API Format"
          />
        </div>
      </div>
    </div>
  );
}
