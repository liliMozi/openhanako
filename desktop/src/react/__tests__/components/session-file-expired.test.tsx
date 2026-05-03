// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '../../components/chat/AssistantMessage';
import { UserMessage } from '../../components/chat/UserMessage';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(async () => new Response('{}', { status: 200 })),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

vi.mock('../../utils/screenshot', () => ({
  takeScreenshot: vi.fn(),
}));

describe('expired session file presentation', () => {
  beforeEach(() => {
    window.t = ((key: string) => key === 'chat.fileExpired' ? '文件已过期' : key) as typeof window.t;
    window.platform = {
      getFileUrl: vi.fn((filePath: string) => `file://${filePath}`),
      openFile: vi.fn(),
    } as unknown as typeof window.platform;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders an expired assistant file block as a disabled file card', () => {
    render(
      <AssistantMessage
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        readOnly
        message={{
          id: 'a1',
          role: 'assistant',
          blocks: [
            {
              type: 'file',
              fileId: 'sf_old',
              filePath: '/cache/old.pdf',
              label: 'old.pdf',
              ext: 'pdf',
              status: 'expired',
              missingAt: 1234,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText('old.pdf')).toBeInTheDocument();
    expect(screen.getByText('文件已过期')).toBeInTheDocument();
    expect(screen.queryByTitle('desk.openWithDefault')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('old.pdf'));
    expect(window.platform?.openFile).not.toHaveBeenCalled();
  });

  it('does not load image previews for expired user attachments', () => {
    render(
      <UserMessage
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        readOnly
        message={{
          id: 'u1',
          role: 'user',
          textHtml: '',
          attachments: [
            {
              fileId: 'sf_img',
              path: '/cache/old.png',
              name: 'old.png',
              isDir: false,
              mimeType: 'image/png',
              status: 'expired',
              missingAt: 1234,
            },
          ],
        }}
      />,
    );

    expect(screen.queryByRole('img', { name: 'old.png' })).not.toBeInTheDocument();
    expect(screen.getByText('old.png · 文件已过期')).toBeInTheDocument();
    expect(window.platform?.getFileUrl).not.toHaveBeenCalled();
  });
});
