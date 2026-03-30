import { useCallback, useEffect } from 'react';
import { useStore } from '../stores';

/**
 * Shared logic for floating panels:
 * - Visibility gated by activePanel
 * - loadFn called when panel opens
 * - close() resets activePanel to null
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
