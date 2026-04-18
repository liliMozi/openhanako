/**
 * LocaleStep.tsx — Step 0: Language selection
 */

import { useState, useCallback } from 'react';
import { LOCALES } from '../constants';
import { saveLocale } from '../onboarding-actions';
import type { HanaFetch } from '../onboarding-actions';
import { StepContainer, Multiline } from '../onboarding-ui';

interface LocaleStepProps {
  preview: boolean;
  hanaFetch: HanaFetch;
  avatarSrc: string;
  initialLocale: string;
  goToStep: (index: number) => void;
  showError: (msg: string) => void;
  onLocaleChange: (locale: string) => void;
}

export function LocaleStep({
  preview, hanaFetch, avatarSrc, initialLocale,
  goToStep, showError, onLocaleChange,
}: LocaleStepProps) {
  const [locale, setLocale] = useState(initialLocale);

  const changeLocale = useCallback(async (loc: string) => {
    if (locale === loc) return;
    setLocale(loc);
    onLocaleChange(loc);
    await i18n.load(loc);
  }, [locale, onLocaleChange]);

  const onNext = useCallback(async () => {
    if (!preview) {
      try {
        await saveLocale(hanaFetch, locale);
      } catch (err) {
        console.error('[onboarding] save locale failed:', err);
      }
    }
    goToStep(1);
  }, [preview, hanaFetch, locale, goToStep]);

  return (
    <StepContainer>
      <img className="onboarding-avatar" src={avatarSrc} draggable={false} alt="" />
      <h1 className="onboarding-title">{t('onboarding.welcome.title')}</h1>
      <Multiline className="onboarding-subtitle" text={t('onboarding.welcome.subtitle')} />
      <div className="ob-locale-picker">
        {LOCALES.map(loc => (
          <button
            key={loc.value}
            className={`ob-locale-btn${locale === loc.value ? ' active' : ''}`}
            onClick={() => changeLocale(loc.value)}
          >
            <span>{loc.label}</span>
          </button>
        ))}
      </div>
      <div className="onboarding-actions">
        <button className="ob-btn ob-btn-primary" onClick={onNext}>
          {t('onboarding.welcome.next')}
        </button>
      </div>
    </StepContainer>
  );
}
