import { createRoot } from 'react-dom/client';
import App from './react/App';

const el = document.getElementById('react-root');
if (el) {
  createRoot(el).render(<App />);
}
