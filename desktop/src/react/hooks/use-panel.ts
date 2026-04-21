import { useCallback, useEffect } from 'react';
import { useStore } from '../stores';

/**
 * Shared logic for floating panels:
 * - Visibility gated by activePanel
 * - loadFn called when panel opens
 * - close() resets activePanel to null
 *
 * loadFn 必须用 useCallback 包裹或是稳定引用，不在 deps 中追踪以避免死循环。
 */
export function usePanel(name: string, loadFn?: () => void, deps: any[] = []) {
  const activePanel = useStore(s => s.activePanel);
  const visible = activePanel === name;

  useEffect(() => {
    if (visible && loadFn) loadFn();
  }, [visible, ...deps]);

  const close = useCallback(() => {
    useStore.getState().setActivePanel(null);
  }, []);

  return { visible, close };
}
