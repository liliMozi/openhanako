import { createRoot } from 'react-dom/client';
import { SettingsApp } from './react/settings/SettingsApp';
import { initTheme, initDragPrevention } from './react/bootstrap';

initTheme();
initDragPrevention();

const el = document.getElementById('react-root');
if (el) {
  createRoot(el).render(<SettingsApp />);
}
