/**
 * TutorialStep.tsx — Step 5: Feature tutorial + finish
 */

import { useState, useCallback } from 'react';
import { StepContainer, Multiline } from '../onboarding-ui';

// ── SVG Icons ──

const MemoryIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v0m0 8c0-2 1.5-2.5 1.5-4.5a1.5 1.5 0 10-3 0C10.5 13.5 12 14 12 16z" />
  </svg>
);

const SkillsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
  </svg>
);

const WorkspaceIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
  </svg>
);

const JianIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="13" y2="17" />
  </svg>
);

// ── Tutorial card sub-component ──

function TutorialCard({ icon, title, desc }: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="tutorial-card">
      <div className="tutorial-card-header">
        <span className="tutorial-card-icon">{icon}</span>
        <span className="tutorial-card-title">{title}</span>
      </div>
      <Multiline className="tutorial-card-desc" text={desc} />
    </div>
  );
}

// ── Main component ──

interface TutorialStepProps {
  preview: boolean;
  showError: (msg: string) => void;
}

export function TutorialStep({ preview, showError }: TutorialStepProps) {
  const [finishing, setFinishing] = useState(false);

  const onFinish = useCallback(async () => {
    if (preview) { window.close(); return; }
    setFinishing(true);
    try {
      await window.hana.onboardingComplete?.();
    } catch (err) {
      console.error('[onboarding] complete failed:', err);
      showError(t('onboarding.error'));
      setFinishing(false);
    }
  }, [preview, showError]);

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t('onboarding.tutorial.title')}</h1>

      <div className="tutorial-cards">
        <TutorialCard
          icon={<MemoryIcon />}
          title={t('onboarding.tutorial.memory.title')}
          desc={t('onboarding.tutorial.memory.desc')}
        />
        <TutorialCard
          icon={<SkillsIcon />}
          title={t('onboarding.tutorial.skills.title')}
          desc={t('onboarding.tutorial.skills.desc')}
        />
        <TutorialCard
          icon={<WorkspaceIcon />}
          title={t('onboarding.tutorial.workspace.title')}
          desc={t('onboarding.tutorial.workspace.desc')}
        />
        <TutorialCard
          icon={<JianIcon />}
          title={t('onboarding.tutorial.jian.title')}
          desc={t('onboarding.tutorial.jian.desc')}
        />
      </div>

      <button className="ob-finish-btn" disabled={finishing} onClick={onFinish}>
        {t('onboarding.tutorial.finish')}
      </button>
    </StepContainer>
  );
}
