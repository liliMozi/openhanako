/**
 * 包装全局 i18n.t()
 * Phase 2+ 可以加 locale state 驱动重渲染
 */
export function useI18n() {
  return {
    t: window.t ?? ((path: string) => path),
    locale: window.i18n?.locale ?? 'zh',
    i18n: window.i18n,
  };
}
