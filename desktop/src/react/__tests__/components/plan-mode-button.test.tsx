// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { PlanModeButton } from '../../components/input/PlanModeButton';
import { useStore } from '../../stores';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

describe('PlanModeButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({ pendingNewSession: false } as never);
  });

  it('marks permission changes from the pending new-session surface explicitly', async () => {
    vi.mocked(hanaFetch).mockResolvedValueOnce(jsonResponse({ mode: 'read_only' }));
    useStore.setState({ pendingNewSession: true } as never);
    const onChange = vi.fn();

    render(<PlanModeButton mode="ask" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/session-permission-mode', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ mode: 'read_only', pendingNewSession: true }),
      }));
    });
    expect(onChange).toHaveBeenCalledWith('read_only');
  });

  it('keeps ask visually neutral, read-only accent, and operate danger colored', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/input/InputArea.module.css'),
      'utf8',
    );
    const askBlock = css.match(/\.plan-mode-ask\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const operateBlock = css.match(/\.plan-mode-operate\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';
    const readOnlyBlock = css.match(/\.plan-mode-read_only\s*\{(?<body>[^}]*)\}/)?.groups?.body || '';

    expect(askBlock).not.toMatch(/color\s*:|background\s*:|border-color\s*:/);
    expect(operateBlock).toContain('var(--danger');
    expect(readOnlyBlock).toContain('var(--accent');
    expect(readOnlyBlock).not.toContain('var(--danger');
  });
});
