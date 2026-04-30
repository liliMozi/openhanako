/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render } from '@testing-library/react';
import { Transaction } from '@codemirror/state';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactEditor, type ArtifactEditorHandle } from '../../components/ArtifactEditor';
import type { PlatformApi, VersionedWriteResult } from '../../types';

vi.mock('../../utils/checkpoints', () => ({
  requestUserEditCheckpoint: vi.fn(async () => undefined),
}));

describe('ArtifactEditor file sync', () => {
  let fileChangedHandler: ((filePath: string) => void) | null;
  let platform: Pick<
    PlatformApi,
    'readFile' | 'writeFile' | 'writeFileIfUnchanged' | 'watchFile' | 'unwatchFile' | 'onFileChanged'
  >;

  beforeEach(() => {
    vi.useFakeTimers();
    fileChangedHandler = null;
    window.t = ((key: string) => key) as typeof window.t;
    Range.prototype.getClientRects = vi.fn(() => [] as unknown as DOMRectList);
    Range.prototype.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    }));
    platform = {
      readFile: vi.fn(async () => 'external update'),
      writeFile: vi.fn(async () => true),
      writeFileIfUnchanged: vi.fn(async () => ({
        ok: true,
        conflict: false,
        version: { mtimeMs: 2, size: 10, sha256: 'next' },
      })),
      watchFile: vi.fn(async () => true),
      unwatchFile: vi.fn(async () => true),
      onFileChanged: vi.fn((handler: (filePath: string) => void) => {
        fileChangedHandler = handler;
      }),
    };
    window.platform = platform as PlatformApi;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('does not autosave content that arrived from a file watcher reload', async () => {
    const ref = createRef<ArtifactEditorHandle>();

    render(
      <ArtifactEditor
        ref={ref}
        content="original"
        filePath="/tmp/hana-note.md"
        mode="markdown"
      />,
    );

    await act(async () => {
      fileChangedHandler?.('/tmp/hana-note.md');
      await Promise.resolve();
    });

    expect(ref.current?.getView()?.state.doc.toString()).toBe('external update');

    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(platform.writeFile).not.toHaveBeenCalled();
  });

  it('saves user edits with the file version that was last loaded from disk', async () => {
    const ref = createRef<ArtifactEditorHandle>();
    const fileVersion = { mtimeMs: 1, size: 8, sha256: 'loaded' };
    const nextVersion = { mtimeMs: 2, size: 10, sha256: 'next' };
    const onContentChange = vi.fn();
    vi.mocked(platform.writeFileIfUnchanged!).mockResolvedValueOnce({
      ok: true,
      conflict: false,
      version: nextVersion,
    });

    render(
      <ArtifactEditor
        ref={ref}
        content="original"
        filePath="/tmp/hana-note.md"
        fileVersion={fileVersion}
        mode="markdown"
        onContentChange={onContentChange}
      />,
    );

    await act(async () => {
      ref.current?.getView()?.dispatch({
        changes: { from: 0, to: 'original'.length, insert: 'user edit' },
        annotations: Transaction.userEvent.of('input.type'),
      });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(platform.writeFileIfUnchanged).toHaveBeenCalledWith(
      '/tmp/hana-note.md',
      'user edit',
      fileVersion,
    );
    expect(onContentChange).toHaveBeenLastCalledWith('user edit', nextVersion);
    expect(platform.writeFile).not.toHaveBeenCalled();
  });

  it('preserves the cursor when parent content is refreshed', async () => {
    const ref = createRef<ArtifactEditorHandle>();

    const { rerender } = render(
      <ArtifactEditor
        ref={ref}
        content="abcdef"
        filePath="/tmp/hana-note.md"
        mode="markdown"
      />,
    );

    await act(async () => {
      ref.current?.getView()?.dispatch({ selection: { anchor: 3 } });
    });

    await act(async () => {
      rerender(
        <ArtifactEditor
          ref={ref}
          content="abcXYZdef"
          filePath="/tmp/hana-note.md"
          mode="markdown"
        />,
      );
    });

    const view = ref.current?.getView();
    expect(view?.state.doc.toString()).toBe('abcXYZdef');
    expect(view?.state.selection.main.head).toBe(3);
  });

  it('queues saves and does not publish stale save results over newer edits', async () => {
    const ref = createRef<ArtifactEditorHandle>();
    const loadedVersion = { mtimeMs: 1, size: 8, sha256: 'loaded' };
    const firstVersion = { mtimeMs: 2, size: 10, sha256: 'first' };
    const secondVersion = { mtimeMs: 3, size: 11, sha256: 'second' };
    const onContentChange = vi.fn();

    let resolveFirst!: (value: VersionedWriteResult) => void;
    const firstWrite = new Promise<VersionedWriteResult>((resolve) => {
      resolveFirst = resolve;
    });

    vi.mocked(platform.writeFileIfUnchanged!)
      .mockReturnValueOnce(firstWrite)
      .mockResolvedValueOnce({
        ok: true,
        conflict: false,
        version: secondVersion,
      });

    render(
      <ArtifactEditor
        ref={ref}
        content="original"
        filePath="/tmp/hana-note.md"
        fileVersion={loadedVersion}
        mode="markdown"
        onContentChange={onContentChange}
      />,
    );

    await act(async () => {
      ref.current?.getView()?.dispatch({
        changes: { from: 0, to: 'original'.length, insert: 'first edit' },
        annotations: Transaction.userEvent.of('input.type'),
      });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(platform.writeFileIfUnchanged).toHaveBeenCalledTimes(1);

    await act(async () => {
      ref.current?.getView()?.dispatch({
        changes: { from: 0, to: 'first edit'.length, insert: 'second edit' },
        annotations: Transaction.userEvent.of('input.type'),
      });
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(platform.writeFileIfUnchanged).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({
        ok: true,
        conflict: false,
        version: firstVersion,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(platform.writeFileIfUnchanged).toHaveBeenCalledTimes(2);
    expect(platform.writeFileIfUnchanged).toHaveBeenLastCalledWith(
      '/tmp/hana-note.md',
      'second edit',
      firstVersion,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onContentChange).not.toHaveBeenCalledWith('first edit', firstVersion);
    expect(onContentChange).toHaveBeenLastCalledWith('second edit', secondVersion);
  });
});
