import { createRoot } from 'react-dom/client';
import { SplashApp } from './react/splash/SplashApp';

const el = document.getElementById('react-root');
if (el) {
  createRoot(el).render(<SplashApp />);
}
