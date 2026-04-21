declare global {
  interface Window {
    setTheme: (name: string) => void;
    loadSavedTheme: () => void;
  }
}

const THEME_FILES: Record<string, string> = {
  'warm-paper': 'themes/warm-paper.css',
  'midnight': 'themes/midnight.css',
  'high-contrast': 'themes/high-contrast.css',
  'grass-aroma': 'themes/grass-aroma.css',
  'contemplation': 'themes/contemplation.css',
  'absolutely': 'themes/absolutely.css',
  'delve': 'themes/delve.css',
  'deep-think': 'themes/deep-think.css',
  'claude-design': 'themes/claude-design.css',
};

export const THEME_LIST = Object.keys(THEME_FILES);

/**
 * 包装全局 theme 系统
 * 实际主题切换由 theme.js 处理（CSS variable 驱动），React 不需要重渲染
 */
export function useTheme() {
  return {
    setTheme: window.setTheme,
    loadSavedTheme: window.loadSavedTheme,
    getSavedTheme: () => localStorage.getItem('hana-theme') || 'auto',
    themes: THEME_LIST,
  };
}
