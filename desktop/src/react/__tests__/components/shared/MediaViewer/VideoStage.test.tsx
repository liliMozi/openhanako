/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { VideoStage } from '../../../../components/shared/MediaViewer/VideoStage';
import type { FileRef } from '../../../../types/file-ref';

describe('VideoStage', () => {
  beforeEach(() => {
    (window as any).platform = {
      getFileUrl: (p: string) => `file://${p}`,
    };
  });
  afterEach(() => {
    cleanup();
    delete (window as any).platform;
  });

  it('渲染 <video controls> 带 file:// url', async () => {
    const file: FileRef = { id: 'v', kind: 'video', source: 'desk', name: 'a.mp4', path: '/a.mp4', ext: 'mp4' };
    const { container } = render(<VideoStage file={file} viewport={{ width: 800, height: 600 }} />);
    await waitFor(() => {
      const v = container.querySelector('video');
      expect(v).toBeTruthy();
      expect(v!.hasAttribute('controls')).toBe(true);
      expect(v!.getAttribute('src')).toMatch(/^file:\/\//);
    });
  });
});
