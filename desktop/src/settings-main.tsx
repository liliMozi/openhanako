import { createRoot } from 'react-dom/client';
import { SettingsApp } from './react/settings/SettingsApp';

// 阻止 Electron 默认文件拖入
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// 应用已保存的主题（theme.js 通过 <script> 加载，函数在全局）
if (typeof loadSavedTheme === 'function') loadSavedTheme();
if (typeof loadSavedFont === 'function') loadSavedFont();

const el = document.getElementById('react-root');
if (el) {
  createRoot(el).render(<SettingsApp />);
}
