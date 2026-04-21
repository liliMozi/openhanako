import { createRoot } from 'react-dom/client';
import { OnboardingApp } from './react/onboarding/OnboardingApp';
import { initTheme, initDragPrevention } from './react/bootstrap';

const params = new URLSearchParams(window.location.search);
const preview = params.has('preview');
const skipToTutorial = params.has('skipToTutorial');

initTheme();
initDragPrevention();

const el = document.getElementById('react-root');
if (el) {
  createRoot(el).render(
    <OnboardingApp preview={preview} skipToTutorial={skipToTutorial} />
  );
}
