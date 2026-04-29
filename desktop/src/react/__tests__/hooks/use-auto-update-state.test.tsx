/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoUpdateState } from '../../hooks/use-auto-update-state';
import type { AutoUpdateState, PlatformApi } from '../../types';

function state(status: AutoUpdateState['status']): AutoUpdateState {
  return {
    status,
    version: null,
    releaseNotes: null,
    releaseUrl: null,
    downloadUrl: null,
    progress: null,
    error: null,
  };
}

function Harness() {
  const updateState = useAutoUpdateState();
  return <div>{updateState?.status ?? 'none'}</div>;
}

describe('useAutoUpdateState', () => {
  let pushState: ((nextState: AutoUpdateState) => void) | null;
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pushState = null;
    unsubscribe = vi.fn();
    window.hana = {
      autoUpdateState: vi.fn().mockResolvedValue(state('checking')),
      onAutoUpdateState: vi.fn((callback) => {
        pushState = callback;
        return unsubscribe;
      }),
    } as unknown as PlatformApi;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('hydrates current updater state, subscribes to live updates, and unsubscribes on unmount', async () => {
    const { unmount } = render(<Harness />);

    await waitFor(() => expect(screen.getByText('checking')).toBeTruthy());

    act(() => {
      pushState?.(state('downloading'));
    });
    expect(screen.getByText('downloading')).toBeTruthy();

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
