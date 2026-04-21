/**
 * ProviderStep.tsx — Step 2: Provider configuration + connection test
 */

import { useState, useCallback } from 'react';
import { PROVIDER_PRESETS } from '../constants';
import type { ProviderPreset } from '../constants';
import { testConnection, saveProvider as saveProviderAction } from '../onboarding-actions';
import type { HanaFetch } from '../onboarding-actions';
import { StepContainer, Multiline } from '../onboarding-ui';

// ── SVG Icons (local to this step) ──

const EyeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOffIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

interface ProviderStepProps {
  preview: boolean;
  hanaFetch: HanaFetch;
  goToStep: (index: number) => void;
  showError: (msg: string) => void;
  onProviderReady: (providerName: string, providerUrl: string, providerApi: string, apiKey: string) => void;
}

export function ProviderStep({
  preview, hanaFetch, goToStep, showError, onProviderReady,
}: ProviderStepProps) {
  // ── Provider state ──
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [providerName, setProviderName] = useState('');
  const [providerUrl, setProviderUrl] = useState('');
  const [providerApi, setProviderApi] = useState('openai-completions');
  const [apiKey, setApiKey] = useState('');
  const [isLocalProvider, setIsLocalProvider] = useState(false);
  const [connectionTested, setConnectionTested] = useState(false);
  const [testStatus, setTestStatus] = useState<{ type: '' | 'loading' | 'success' | 'error'; text: string }>({ type: '', text: '' });
  const [showKey, setShowKey] = useState(false);

  // ── Custom provider fields ──
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customApi, setCustomApi] = useState('openai-completions');

  const isZh = i18n.locale?.startsWith('zh');

  // ── Preset selection ──
  const selectPreset = useCallback((preset: ProviderPreset) => {
    setSelectedPreset(preset.value);
    setConnectionTested(false);
    setTestStatus({ type: '', text: '' });

    if (preset.custom) {
      setProviderName(customName.trim().toLowerCase().replace(/\s+/g, '-'));
      setProviderUrl(customUrl.trim());
      setProviderApi(customApi);
      setIsLocalProvider(false);
    } else {
      setProviderName(preset.value);
      setProviderUrl(preset.url);
      setProviderApi(preset.api);
      setIsLocalProvider(!!preset.local);
      if (preset.local) setApiKey('');
    }
  }, [customName, customUrl, customApi]);

  // ── Custom input sync ──
  const onCustomInput = useCallback((name: string, url: string, api: string) => {
    setCustomName(name);
    setCustomUrl(url);
    setCustomApi(api);
    if (selectedPreset === '_custom') {
      setProviderName(name.trim().toLowerCase().replace(/\s+/g, '-'));
      setProviderUrl(url.trim());
      setProviderApi(api);
      setConnectionTested(false);
      setTestStatus({ type: '', text: '' });
    }
  }, [selectedPreset]);

  // ── API key input ──
  const onApiKeyInput = useCallback((val: string) => {
    const cleaned = val.replace(/[^\x20-\x7E]/g, '').trim();
    setApiKey(cleaned);
    setConnectionTested(false);
    setTestStatus({ type: '', text: '' });
  }, []);

  // ── Button states ──
  const hasKey = !!apiKey || isLocalProvider;
  const hasProvider = !!providerName;
  const hasUrl = !!providerUrl;
  const testBtnDisabled = preview ? false : !(hasProvider && hasUrl && hasKey);
  const nextDisabled = preview ? false : !(hasProvider && hasUrl && hasKey && connectionTested);

  // ── Test connection ──
  const onTest = useCallback(async () => {
    if (preview) {
      setTestStatus({ type: 'success', text: t('onboarding.provider.testSuccess') });
      setConnectionTested(true);
      return;
    }
    setTestStatus({ type: 'loading', text: t('onboarding.provider.testing') });
    try {
      const result = await testConnection({ hanaFetch, providerUrl, providerApi, apiKey });
      if (result.ok) {
        setTestStatus({ type: 'success', text: result.text });
        setConnectionTested(true);
      } else {
        setTestStatus({ type: 'error', text: result.text });
        setConnectionTested(false);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestStatus({ type: 'error', text: msg });
      setConnectionTested(false);
    }
  }, [preview, hanaFetch, providerUrl, providerApi, apiKey]);

  // ── Next ──
  const onNext = useCallback(async () => {
    if (preview) { goToStep(3); return; }
    if (!connectionTested) return;
    try {
      await saveProviderAction({ hanaFetch, providerName, providerUrl, apiKey, providerApi });
      onProviderReady(providerName, providerUrl, providerApi, apiKey);
      goToStep(3);
    } catch (err) {
      console.error('[onboarding] save provider failed:', err);
      showError(t('onboarding.provider.testFailed'));
    }
  }, [preview, connectionTested, hanaFetch, providerName, providerUrl, apiKey, providerApi, goToStep, showError, onProviderReady]);

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t('onboarding.provider.title')}</h1>
      <Multiline className="onboarding-subtitle" text={t('onboarding.provider.subtitle')} />

      <div className="provider-grid">
        {PROVIDER_PRESETS.map(preset => (
          <div
            key={preset.value}
            className={`provider-card${selectedPreset === preset.value ? ' selected' : ''}`}
            onClick={() => selectPreset(preset)}
          >
            {preset.custom
              ? t('onboarding.provider.custom')
              : (isZh && 'labelZh' in preset && preset.labelZh ? preset.labelZh : preset.label)
            }
          </div>
        ))}
      </div>

      {/* Custom provider fields */}
      {selectedPreset === '_custom' && (
        <div className="custom-provider-row">
          <div className="custom-provider-fields">
            <div className="custom-field">
              <span className="ob-field-label">{t('onboarding.provider.customName')}</span>
              <input
                className="ob-input"
                type="text"
                placeholder={t('onboarding.provider.customNamePlaceholder')}
                value={customName}
                onChange={e => onCustomInput(e.target.value, customUrl, customApi)}
                autoComplete="off"
              />
            </div>
            <div className="custom-field">
              <span className="ob-field-label">{t('onboarding.provider.customUrl')}</span>
              <input
                className="ob-input"
                type="text"
                placeholder={t('onboarding.provider.customUrlPlaceholder')}
                value={customUrl}
                onChange={e => onCustomInput(customName, e.target.value, customApi)}
                autoComplete="off"
              />
            </div>
            <div className="custom-field">
              <select
                className="ob-input"
                value={customApi}
                onChange={e => onCustomInput(customName, customUrl, e.target.value)}
              >
                <option value="openai-completions">OpenAI Compatible</option>
                <option value="anthropic-messages">Anthropic Messages</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* API Key */}
      {!isLocalProvider && (
        <>
          <span className="ob-field-label">{t('onboarding.provider.keyLabel')}</span>
          <div className="ob-key-row">
            <input
              className="ob-input"
              type={showKey ? 'text' : 'password'}
              placeholder={t('onboarding.provider.keyPlaceholder')}
              value={apiKey}
              onChange={e => onApiKeyInput(e.target.value)}
              autoComplete="off"
            />
            <button className="ob-key-toggle" onClick={() => setShowKey(!showKey)}>
              {showKey ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </>
      )}

      {/* Test connection */}
      <div className="ob-test-row">
        <button
          className="ob-test-btn"
          disabled={testBtnDisabled}
          onClick={onTest}
        >
          {t('onboarding.provider.test')}
        </button>
        {testStatus.text && (
          <span className={`ob-status ${testStatus.type}`}>{testStatus.text}</span>
        )}
      </div>

      <div className="onboarding-actions">
        <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(1)}>
          {t('onboarding.provider.back')}
        </button>
        <button
          className="ob-btn ob-btn-primary"
          disabled={nextDisabled}
          onClick={onNext}
        >
          {t('onboarding.provider.next')}
        </button>
      </div>
    </StepContainer>
  );
}
