/**
 * ModelStep.tsx — Step 3: Model selection
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { SelectWidget } from '../../settings/widgets/SelectWidget';
import type { SelectOption } from '../../settings/widgets/SelectWidget';
import { loadModels as loadModelsAction, saveModel as saveModelAction } from '../onboarding-actions';
import type { HanaFetch } from '../onboarding-actions';
import { StepContainer } from '../onboarding-ui';

interface ModelStepProps {
  preview: boolean;
  hanaFetch: HanaFetch;
  providerName: string;
  providerUrl: string;
  providerApi: string;
  apiKey: string;
  goToStep: (index: number) => void;
  showError: (msg: string) => void;
}

export function ModelStep({
  preview, hanaFetch, providerName, providerUrl, providerApi, apiKey,
  goToStep, showError,
}: ModelStepProps) {
  const [fetchedModels, setFetchedModels] = useState<{ id: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [modelLoading, setModelLoading] = useState('');
  const [selectedUtility, setSelectedUtility] = useState('');
  const [selectedUtilityLarge, setSelectedUtilityLarge] = useState('');

  const modelsLoadedFor = useRef('');

  // ── Load models on mount ──
  useEffect(() => {
    const doLoad = async () => {
      if (preview) {
        setFetchedModels([{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }]);
        setModelLoading('');
        return;
      }
      if (modelsLoadedFor.current === providerName) return;

      setModelLoading(t('onboarding.model.loading'));
      try {
        const result = await loadModelsAction({ hanaFetch, providerName, providerUrl, providerApi, apiKey });
        if (result.error) {
          setModelLoading(result.error);
          return;
        }
        setFetchedModels(result.models);
        setSelectedModel('');
        setSelectedUtility('');
        setSelectedUtilityLarge('');
        modelsLoadedFor.current = providerName;
        setModelLoading('');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setModelLoading(msg);
      }
    };
    doLoad();
  }, [preview, hanaFetch, providerName, providerUrl, providerApi, apiKey]);

  // ── Filtered models ──
  const filteredModels = modelSearch
    ? fetchedModels.filter(m => m.id.toLowerCase().includes(modelSearch.toLowerCase()))
    : fetchedModels;

  // ── SelectWidget options ──
  const modelSelectOptions: SelectOption[] = fetchedModels.map(m => ({ value: m.id, label: m.id }));

  // ── Next ──
  const onNext = useCallback(async () => {
    if (preview) { goToStep(4); return; }
    if (!selectedModel || !selectedUtility || !selectedUtilityLarge) return;
    try {
      await saveModelAction({
        hanaFetch, selectedModel, fetchedModels, providerName,
        selectedUtility, selectedUtilityLarge,
      });
      goToStep(4);
    } catch (err) {
      console.error('[onboarding] save model failed:', err);
      showError(t('onboarding.error'));
    }
  }, [preview, selectedModel, hanaFetch, fetchedModels, providerName, selectedUtility, selectedUtilityLarge, goToStep, showError]);

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t('onboarding.model.title')}</h1>
      <p className="onboarding-subtitle">{t('onboarding.model.subtitle')}</p>

      <input
        className="ob-input ob-model-search"
        type="text"
        placeholder={t('onboarding.model.searchPlaceholder')}
        value={modelSearch}
        onChange={e => setModelSearch(e.target.value)}
        autoComplete="off"
      />

      <div className="model-list">
        {modelLoading ? (
          <div className="model-empty">{modelLoading}</div>
        ) : filteredModels.length === 0 ? (
          <div className="model-empty">{t('onboarding.model.empty')}</div>
        ) : (
          filteredModels.map(model => (
            <div
              key={model.id}
              className={`model-item${selectedModel === model.id ? ' selected' : ''}`}
              onClick={() => setSelectedModel(model.id)}
            >
              {model.id}
            </div>
          ))
        )}
      </div>

      {/* Utility model selectors */}
      <div className="ob-utility-section">
        <div className="ob-utility-block">
          <div className="ob-utility-header">
            <span className="ob-utility-title">{t('onboarding.model.utility')}</span>
            <span className="ob-utility-hint">{t('onboarding.model.utilityHint')}</span>
          </div>
          <SelectWidget
            options={modelSelectOptions}
            value={selectedUtility}
            onChange={setSelectedUtility}
            placeholder={'\u2014'}
          />
        </div>
        <div className="ob-utility-block">
          <div className="ob-utility-header">
            <span className="ob-utility-title">{t('onboarding.model.utilityLarge')}</span>
            <span className="ob-utility-hint">{t('onboarding.model.utilityLargeHint')}</span>
          </div>
          <SelectWidget
            options={modelSelectOptions}
            value={selectedUtilityLarge}
            onChange={setSelectedUtilityLarge}
            placeholder={'\u2014'}
          />
        </div>
      </div>

      <div className="onboarding-actions">
        <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(2)}>
          {t('onboarding.model.back')}
        </button>
        <button
          className="ob-btn ob-btn-primary"
          disabled={!preview && (!selectedModel || !selectedUtility || !selectedUtilityLarge)}
          onClick={onNext}
        >
          {t('onboarding.model.next')}
        </button>
      </div>
    </StepContainer>
  );
}
