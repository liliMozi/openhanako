/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const listMock = vi.fn();
const restoreMock = vi.fn();
const deleteMock = vi.fn();
const cleanupMock = vi.fn();
const toastMock = vi.fn();
const loadSessionsMock = vi.fn();

vi.mock('../../stores/session-actions', () => ({
  listArchivedSessions: (...args: unknown[]) => listMock(...args),
  restoreSession: (...args: unknown[]) => restoreMock(...args),
  deleteArchivedSession: (...args: unknown[]) => deleteMock(...args),
  cleanupArchivedSessions: (...args: unknown[]) => cleanupMock(...args),
  showSidebarToast: (...args: unknown[]) => toastMock(...args),
  loadSessions: (...args: unknown[]) => loadSessionsMock(...args),
}));

vi.mock('../../hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (k: string, v?: Record<string, unknown>) =>
      v ? `${k}[${JSON.stringify(v)}]` : k,
  }),
}));

import { ArchivedSessionsModal } from '../../components/ArchivedSessionsModal';

beforeEach(() => {
  listMock.mockReset();
  restoreMock.mockReset();
  deleteMock.mockReset();
  cleanupMock.mockReset();
  toastMock.mockReset();
  loadSessionsMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ArchivedSessionsModal', () => {
  it('renders empty state when list is empty', async () => {
    listMock.mockResolvedValue([]);
    render(<ArchivedSessionsModal open={true} onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText('session.archived.empty')).toBeInTheDocument();
    });
  });

  it('renders rows for each archived session', async () => {
    listMock.mockResolvedValue([
      {
        path: '/x/a.jsonl',
        title: 'Alpha',
        archivedAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
        sizeBytes: 1024 * 1024,
        agentId: 'a',
        agentName: 'Hana',
      },
      {
        path: '/x/b.jsonl',
        title: 'Beta',
        archivedAt: new Date(Date.now() - 10 * 86400_000).toISOString(),
        sizeBytes: 2 * 1024 * 1024,
        agentId: 'b',
        agentName: 'Yuan',
      },
    ]);
    render(<ArchivedSessionsModal open={true} onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });
  });

  it('returns null when closed (no render side-effect)', () => {
    listMock.mockResolvedValue([]);
    const { container } = render(<ArchivedSessionsModal open={false} onClose={() => {}} />);
    expect(container.textContent).toBe('');
    expect(listMock).not.toHaveBeenCalled();
  });

  it('calls restoreSession with user confirmation', async () => {
    listMock.mockResolvedValue([
      {
        path: '/x/a.jsonl',
        title: 'Alpha',
        archivedAt: new Date().toISOString(),
        sizeBytes: 100,
        agentId: 'a',
        agentName: 'Hana',
      },
    ]);
    restoreMock.mockResolvedValue('ok');
    window.confirm = vi.fn(() => true);
    render(<ArchivedSessionsModal open={true} onClose={() => {}} />);
    await waitFor(() => screen.getByText('Alpha'));
    fireEvent.click(screen.getByText('session.archived.restore'));
    await waitFor(() => expect(restoreMock).toHaveBeenCalledWith('/x/a.jsonl'));
    await waitFor(() => expect(loadSessionsMock).toHaveBeenCalled());
  });

  it('skips restore when user cancels confirm', async () => {
    listMock.mockResolvedValue([
      {
        path: '/x/a.jsonl',
        title: 'Alpha',
        archivedAt: new Date().toISOString(),
        sizeBytes: 100,
        agentId: 'a',
        agentName: 'Hana',
      },
    ]);
    window.confirm = vi.fn(() => false);
    render(<ArchivedSessionsModal open={true} onClose={() => {}} />);
    await waitFor(() => screen.getByText('Alpha'));
    fireEvent.click(screen.getByText('session.archived.restore'));
    expect(restoreMock).not.toHaveBeenCalled();
  });

  it('shows conflict toast when restore returns conflict', async () => {
    listMock.mockResolvedValue([
      {
        path: '/x/a.jsonl',
        title: 'Alpha',
        archivedAt: new Date().toISOString(),
        sizeBytes: 100,
        agentId: 'a',
        agentName: 'Hana',
      },
    ]);
    restoreMock.mockResolvedValue('conflict');
    window.confirm = vi.fn(() => true);
    render(<ArchivedSessionsModal open={true} onClose={() => {}} />);
    await waitFor(() => screen.getByText('Alpha'));
    fireEvent.click(screen.getByText('session.archived.restore'));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith('session.archived.restoreConflict'),
    );
  });

  it('calls cleanupArchivedSessions(30) when 30-day button clicked', async () => {
    listMock.mockResolvedValue([
      {
        path: '/x/a.jsonl',
        title: 'A',
        archivedAt: new Date(Date.now() - 40 * 86400_000).toISOString(),
        sizeBytes: 100,
        agentId: 'a',
        agentName: 'Hana',
      },
    ]);
    cleanupMock.mockResolvedValue({ deleted: 1 });
    window.confirm = vi.fn(() => true);
    render(<ArchivedSessionsModal open={true} onClose={() => {}} />);
    await waitFor(() => screen.getByText('A'));
    fireEvent.click(screen.getByText('session.archived.cleanup30'));
    await waitFor(() => expect(cleanupMock).toHaveBeenCalledWith(30));
  });

  it('skips cleanup confirm when nothing matches', async () => {
    listMock.mockResolvedValue([
      {
        path: '/x/a.jsonl',
        title: 'A',
        archivedAt: new Date().toISOString(),
        sizeBytes: 100,
        agentId: 'a',
        agentName: 'Hana',
      },
    ]);
    window.confirm = vi.fn(() => true);
    render(<ArchivedSessionsModal open={true} onClose={() => {}} />);
    await waitFor(() => screen.getByText('A'));
    fireEvent.click(screen.getByText('session.archived.cleanup90'));
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith('session.archived.cleanupNoMatch');
  });

  it('calls deleteArchivedSession with confirmation', async () => {
    listMock.mockResolvedValue([
      {
        path: '/x/a.jsonl',
        title: 'A',
        archivedAt: new Date().toISOString(),
        sizeBytes: 100,
        agentId: 'a',
        agentName: 'Hana',
      },
    ]);
    deleteMock.mockResolvedValue(true);
    window.confirm = vi.fn(() => true);
    render(<ArchivedSessionsModal open={true} onClose={() => {}} />);
    await waitFor(() => screen.getByText('A'));
    fireEvent.click(screen.getByText('session.archived.deleteForever'));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/x/a.jsonl'));
  });
});
