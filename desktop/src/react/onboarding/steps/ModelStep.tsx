/**
 * ModelStep.tsx — Step 3: Model selection
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { SelectWidget } from '../../settings/widgets/SelectWidget';
import type { SelectOption } from '../../settings/widgets/SelectWidget';
import { Toggle } from '../../settings/widgets/Toggle';
import { lookupReferenceModelMeta } from '../../utils/model-metadata';
import { loadModels as loadModelsAction, saveModel as saveModelAction } from '../onboarding-actions';
import type { AddedModelEntry, AddedModelObject, DiscoveredModel, HanaFetch } from '../onboarding-actions';
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

type AddedModelDraft = AddedModelObject;

function toSavedModelEntry(model: AddedModelDraft): AddedModelEntry {
  const hasMeta = !!model.name?.trim()
    || typeof model.context === 'number'
    || typeof model.maxOutput === 'number'
    || typeof model.image === 'boolean'
    || typeof model.reasoning === 'boolean';
  if (!hasMeta) return model.id;
  return {
    id: model.id,
    ...(model.name?.trim() ? { name: model.name.trim() } : {}),
    ...(typeof model.context === 'number' ? { context: model.context } : {}),
    ...(typeof model.maxOutput === 'number' ? { maxOutput: model.maxOutput } : {}),
    ...(typeof model.image === 'boolean' ? { image: model.image } : {}),
    ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
  };
}

function parsePositiveInteger(raw: string): number | undefined | null {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function numberFromMeta(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boolFromMeta(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function ModelStep({
  preview, hanaFetch, providerName, providerUrl, providerApi, apiKey,
  goToStep, showError,
}: ModelStepProps) {
  const [fetchedModels, setFetchedModels] = useState<DiscoveredModel[]>([]);
  const [addedModels, setAddedModels] = useState<AddedModelDraft[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [manualModelId, setManualModelId] = useState('');
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [modelLoading, setModelLoading] = useState('');
  const [selectedUtility, setSelectedUtility] = useState('');
  const [selectedUtilityLarge, setSelectedUtilityLarge] = useState('');
  const [editingModelId, setEditingModelId] = useState('');
  const [editName, setEditName] = useState('');
  const [editContext, setEditContext] = useState('');
  const [editMaxOutput, setEditMaxOutput] = useState('');
  const [editImage, setEditImage] = useState<boolean | undefined>(undefined);
  const [editReasoning, setEditReasoning] = useState<boolean | undefined>(undefined);

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
        setSelectedUtility('');
        setSelectedUtilityLarge('');
        setAddedModels([]);
        setSelectedModel('');
        modelsLoadedFor.current = providerName;
        setModelLoading('');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setModelLoading(msg);
      }
    };
    doLoad();
  }, [preview, hanaFetch, providerName, providerUrl, providerApi, apiKey]);

  const addedModelIds = new Set(addedModels.map(model => model.id));
  const availableModels = fetchedModels.filter(model => !addedModelIds.has(model.id));
  const filteredModels = modelSearch.trim()
    ? availableModels.filter(m => m.id.toLowerCase().includes(modelSearch.trim().toLowerCase()))
    : availableModels;

  const baselineForModel = useCallback((modelId: string) => {
    const reference = lookupReferenceModelMeta(modelId, providerName);
    const fetched = fetchedModels.find(model => model.id === modelId);
    return {
      name: reference?.name || fetched?.name || '',
      context: numberFromMeta(reference?.context) ?? numberFromMeta(fetched?.context),
      maxOutput: numberFromMeta(reference?.maxOutput) ?? numberFromMeta(fetched?.maxOutput),
      image: boolFromMeta(reference?.image ?? reference?.vision),
      reasoning: boolFromMeta(reference?.reasoning),
    };
  }, [fetchedModels, providerName]);

  const effectiveModelMeta = useCallback((model: AddedModelDraft) => {
    const baseline = baselineForModel(model.id);
    return {
      name: model.name ?? baseline.name,
      context: model.context ?? baseline.context,
      maxOutput: model.maxOutput ?? baseline.maxOutput,
      image: model.image ?? baseline.image,
      reasoning: model.reasoning ?? baseline.reasoning,
    };
  }, [baselineForModel]);

  const labelForModel = useCallback((modelId: string) => {
    const added = addedModels.find(model => model.id === modelId);
    if (added) {
      const meta = effectiveModelMeta(added);
      if (meta.name?.trim()) return meta.name.trim();
    }
    return modelId;
  }, [addedModels, effectiveModelMeta]);

  const modelSelectOptions: SelectOption[] = addedModels.map(model => ({
    value: model.id,
    label: labelForModel(model.id),
  }));

  const addModel = useCallback((rawModelId: string) => {
    const modelId = rawModelId.trim();
    if (!modelId || addedModelIds.has(modelId)) return;
    const next = [...addedModels, { id: modelId }];
    setAddedModels(next);
    if (!selectedModel) setSelectedModel(modelId);
    setAddMenuOpen(false);
    setModelSearch('');
  }, [addedModelIds, addedModels, selectedModel]);

  const addManualModel = useCallback(() => {
    const modelId = manualModelId.trim();
    if (!modelId) return;
    addModel(modelId);
    if (!addedModelIds.has(modelId)) setManualModelId('');
  }, [addModel, addedModelIds, manualModelId]);

  const removeModel = useCallback((modelId: string) => {
    const next = addedModels.filter(model => model.id !== modelId);
    setAddedModels(next);
    if (selectedModel === modelId) setSelectedModel(next[0]?.id || '');
    if (selectedUtility === modelId) setSelectedUtility('');
    if (selectedUtilityLarge === modelId) setSelectedUtilityLarge('');
    if (editingModelId === modelId) setEditingModelId('');
  }, [addedModels, selectedModel, selectedUtility, selectedUtilityLarge, editingModelId]);

  const startEditing = useCallback((model: AddedModelDraft) => {
    const meta = effectiveModelMeta(model);
    setEditingModelId(model.id);
    setEditName(meta.name || '');
    setEditContext(meta.context ? String(meta.context) : '');
    setEditMaxOutput(meta.maxOutput ? String(meta.maxOutput) : '');
    setEditImage(typeof meta.image === 'boolean' ? meta.image : undefined);
    setEditReasoning(typeof meta.reasoning === 'boolean' ? meta.reasoning : undefined);
  }, [effectiveModelMeta]);

  const saveEditing = useCallback(() => {
    const context = parsePositiveInteger(editContext);
    const maxOutput = parsePositiveInteger(editMaxOutput);
    if (context === null || maxOutput === null) {
      showError(t('onboarding.model.invalidNumber'));
      return;
    }

    setAddedModels(prev => prev.map(model => {
      if (model.id !== editingModelId) return model;
      const baseline = baselineForModel(model.id);
      const name = editName.trim();
      return {
        id: model.id,
        ...(name && name !== baseline.name ? { name } : {}),
        ...(context && context !== baseline.context ? { context } : {}),
        ...(maxOutput && maxOutput !== baseline.maxOutput ? { maxOutput } : {}),
        ...(typeof editImage === 'boolean' && editImage !== baseline.image ? { image: editImage } : {}),
        ...(typeof editReasoning === 'boolean' && editReasoning !== baseline.reasoning ? { reasoning: editReasoning } : {}),
      };
    }));
    setEditingModelId('');
  }, [baselineForModel, editContext, editImage, editMaxOutput, editName, editReasoning, editingModelId, showError]);

  const currentEditingModel = editingModelId
    ? addedModels.find(model => model.id === editingModelId)
    : undefined;

  const canContinue = preview || (
    addedModels.length > 0
    && !!selectedModel
    && !!selectedUtility
    && !!selectedUtilityLarge
  );

  const candidateList = modelLoading
    ? [{ id: '__loading__', label: modelLoading, disabled: true }]
    : filteredModels.length > 0
      ? filteredModels.map(model => ({ id: model.id, label: model.id, disabled: false }))
      : [{ id: '__empty__', label: t('onboarding.model.empty'), disabled: true }];

  // ── Next ──
  const onNext = useCallback(async () => {
    if (preview) { goToStep(4); return; }
    if (!canContinue) return;
    try {
      await saveModelAction({
        hanaFetch, selectedModel, providerName,
        addedModels: addedModels.map(toSavedModelEntry),
        selectedUtility, selectedUtilityLarge,
      });
      goToStep(4);
    } catch (err) {
      console.error('[onboarding] save model failed:', err);
      showError(t('onboarding.error'));
    }
  }, [preview, canContinue, hanaFetch, selectedModel, providerName, addedModels, selectedUtility, selectedUtilityLarge, goToStep, showError]);

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t('onboarding.model.title')}</h1>
      <p className="onboarding-subtitle">{t('onboarding.model.subtitle')}</p>

      <div className="ob-added-models">
        <div className="ob-added-models-title">
          <span>{t('onboarding.model.addedModels')}</span>
          <span className="ob-added-models-count">{addedModels.length}</span>
        </div>

        {addedModels.length === 0 ? (
          <div className="ob-added-models-empty">{t('onboarding.model.noAddedModels')}</div>
        ) : (
          <div className="ob-added-models-list">
            {addedModels.map(model => (
              <div key={model.id} className={`ob-added-model-row${selectedModel === model.id ? ' main' : ''}`}>
                <div className="ob-added-model-info">
                  <span className="ob-added-model-name" title={model.id}>{labelForModel(model.id)}</span>
                  {labelForModel(model.id) !== model.id && <span className="ob-added-model-id">{model.id}</span>}
                </div>
                <div className="ob-added-model-actions">
                  {selectedModel === model.id ? (
                    <span className="ob-main-model-badge">{t('onboarding.model.mainModel')}</span>
                  ) : (
                    <button type="button" className="ob-main-model-btn" onClick={() => setSelectedModel(model.id)}>
                      {t('onboarding.model.setMainModel')}
                    </button>
                  )}
                  <button type="button" className="ob-model-icon-btn" title={t('onboarding.model.editModel')} onClick={() => startEditing(model)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button type="button" className="ob-model-icon-btn" title={t('onboarding.model.removeModel')} onClick={() => removeModel(model.id)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {currentEditingModel && (
          <div className="ob-model-edit-panel">
            <div className="ob-model-edit-title">{t('onboarding.model.editTitle')}</div>
            <div className="ob-model-edit-grid">
              <label className="ob-model-edit-field">
                <span>{t('onboarding.model.displayName')}</span>
                <input aria-label={t('onboarding.model.displayName')} className="ob-input" value={editName} placeholder={currentEditingModel.id} onChange={e => setEditName(e.target.value)} />
              </label>
              <label className="ob-model-edit-field">
                <span>{t('onboarding.model.contextLength')}</span>
                <input aria-label={t('onboarding.model.contextLength')} className="ob-input" value={editContext} inputMode="numeric" placeholder="131072" onChange={e => setEditContext(e.target.value)} />
              </label>
              <label className="ob-model-edit-field">
                <span>{t('onboarding.model.maxOutput')}</span>
                <input aria-label={t('onboarding.model.maxOutput')} className="ob-input" value={editMaxOutput} inputMode="numeric" placeholder="16384" onChange={e => setEditMaxOutput(e.target.value)} />
              </label>
            </div>
            <div className="ob-model-edit-checks">
              <div className="ob-model-edit-toggle-row">
                <Toggle on={editImage === true} onChange={setEditImage} label={t('onboarding.model.imageInput')} />
              </div>
              <div className="ob-model-edit-toggle-row">
                <Toggle on={editReasoning === true} onChange={setEditReasoning} label={t('onboarding.model.reasoning')} />
              </div>
            </div>
            <div className="ob-model-edit-actions">
              <button type="button" className="ob-btn ob-btn-secondary" onClick={() => setEditingModelId('')}>{t('onboarding.model.cancelEdit')}</button>
              <button type="button" className="ob-btn ob-btn-primary" onClick={saveEditing}>{t('onboarding.model.saveEdit')}</button>
            </div>
          </div>
        )}
      </div>

      <div className="ob-add-model">
        <button type="button" className="ob-add-model-trigger" onClick={() => setAddMenuOpen(open => !open)}>
          <span>{t('onboarding.model.addModel')}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {addMenuOpen && (
          <div className="ob-add-model-menu">
            <input
              className="ob-input ob-add-model-search"
              type="text"
              placeholder={t('onboarding.model.addModelSearchPlaceholder')}
              value={modelSearch}
              onChange={e => setModelSearch(e.target.value)}
              autoComplete="off"
              autoFocus
            />
            <div className="ob-add-model-options">
              {candidateList.map(candidate => (
                <button
                  key={candidate.id}
                  type="button"
                  className="ob-add-model-option"
                  disabled={candidate.disabled}
                  onClick={() => addModel(candidate.id)}
                >
                  {candidate.label}
                </button>
              ))}
            </div>
            <div className="ob-add-model-manual">
              <input
                className="ob-input ob-add-model-manual-input"
                type="text"
                placeholder={t('onboarding.model.manualModelPlaceholder')}
                value={manualModelId}
                onChange={e => setManualModelId(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') addManualModel();
                }}
                autoComplete="off"
              />
              <button
                type="button"
                className="ob-add-model-manual-btn"
                onClick={addManualModel}
                disabled={!manualModelId.trim() || addedModelIds.has(manualModelId.trim())}
              >
                {t('onboarding.model.addManualModel')}
              </button>
            </div>
          </div>
        )}
      </div>

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
            disabled={addedModels.length === 0}
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
            disabled={addedModels.length === 0}
          />
        </div>
      </div>

      <div className="onboarding-actions">
        <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(2)}>
          {t('onboarding.model.back')}
        </button>
        <button
          className="ob-btn ob-btn-primary"
          disabled={!canContinue}
          onClick={onNext}
        >
          {t('onboarding.model.next')}
        </button>
      </div>
    </StepContainer>
  );
}
