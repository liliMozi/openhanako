/**
 * NameStep.tsx — Step 1: User name input
 */

import { useState, useCallback } from 'react';
import { saveUserName } from '../onboarding-actions';
import type { HanaFetch } from '../onboarding-actions';
import { StepContainer } from '../onboarding-ui';

interface NameStepProps {
  preview: boolean;
  hanaFetch: HanaFetch;
  goToStep: (index: number) => void;
  showError: (msg: string) => void;
}

export function NameStep({ preview, hanaFetch, goToStep, showError }: NameStepProps) {
  const [userName, setUserName] = useState('');

  const onNext = useCallback(async () => {
    if (preview) { goToStep(2); return; }
    const trimmed = userName.trim();
    if (!trimmed) return;
    try {
      await saveUserName(hanaFetch, trimmed);
      goToStep(2);
    } catch (err) {
      console.error('[onboarding] save name failed:', err);
      showError(t('onboarding.error'));
    }
  }, [preview, hanaFetch, userName, goToStep, showError]);

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t('onboarding.name.title')}</h1>
      <p className="onboarding-subtitle">{t('onboarding.name.subtitle')}</p>
      <input
        className="ob-input"
        type="text"
        style={{ textAlign: 'center', maxWidth: 260 }}
        placeholder={t('onboarding.name.placeholder')}
        value={userName}
        onChange={e => setUserName(e.target.value)}
        autoComplete="off"
      />
      <div className="onboarding-actions">
        <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(0)}>
          {t('onboarding.name.back')}
        </button>
        <button
          className="ob-btn ob-btn-primary"
          disabled={!preview && !userName.trim()}
          onClick={onNext}
        >
          {t('onboarding.name.next')}
        </button>
      </div>
    </StepContainer>
  );
}
