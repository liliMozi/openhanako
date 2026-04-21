/**
 * ThemeStep.tsx — Step 4: Theme selection
 */

import { useState } from 'react';
import settingsStyles from '../../settings/Settings.module.css';
import { OB_THEMES, themeKey } from '../constants';
import { StepContainer } from '../onboarding-ui';

interface ThemeStepProps {
  goToStep: (index: number) => void;
}

export function ThemeStep({ goToStep }: ThemeStepProps) {
  const [activeTheme, setActiveTheme] = useState(() => localStorage.getItem('hana-theme') || 'auto');

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t('onboarding.theme.title')}</h1>
      <p className="onboarding-subtitle">{t('onboarding.theme.subtitle')}</p>

      <div className={settingsStyles['theme-options']}>
        {OB_THEMES.map(theme => {
          const key = themeKey(theme);
          return (
            <button
              key={theme}
              className={`${settingsStyles['theme-card']}${activeTheme === theme ? ' ' + settingsStyles['active'] : ''}`}
              data-theme={theme}
              onClick={() => {
                setActiveTheme(theme);
                setTheme(theme);
              }}
            >
              <div className={settingsStyles['theme-card-name']}>{t(`settings.appearance.${key}`)}</div>
              <div className={settingsStyles['theme-card-mode']}>{t(`settings.appearance.${key}Mode`)}</div>
            </button>
          );
        })}
      </div>

      <div className="onboarding-actions">
        <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(3)}>
          {t('onboarding.theme.back')}
        </button>
        <button className="ob-btn ob-btn-primary" onClick={() => goToStep(5)}>
          {t('onboarding.theme.next')}
        </button>
      </div>
    </StepContainer>
  );
}
