import { useEffect, useState } from 'react';
import type { AutoUpdateState } from '../types';

export function useAutoUpdateState(): AutoUpdateState | null {
  const [state, setState] = useState<AutoUpdateState | null>(null);

  useEffect(() => {
    let alive = true;

    window.hana?.autoUpdateState?.()
      .then((nextState) => {
        if (alive && nextState) {
          setState(nextState);
        }
      })
      .catch(() => {});

    const unsubscribe = window.hana?.onAutoUpdateState?.((nextState) => {
      setState(nextState);
    });

    return () => {
      alive = false;
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, []);

  return state;
}
