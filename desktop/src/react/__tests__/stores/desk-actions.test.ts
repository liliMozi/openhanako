import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';

const mockHanaFetch = vi.fn();

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: mockHanaFetch,
}));

vi.mock('../../stores/agent-actions', () => ({
  clearChat: vi.fn(),
}));

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('desk-actions workspace roots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHanaFetch.mockReset();
    mockHanaFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/preferences/workspace-ui-state')) return jsonResponse({ state: null });
      if (url.startsWith('/api/desk/jian')) return jsonResponse({ content: null });
      return jsonResponse({});
    });
    (globalThis as any).window = {
      t: (key: string) => key,
      platform: {
        readFileSnapshot: vi.fn(async (filePath: string) => ({
          content: `content:${filePath}`,
          version: { mtimeMs: 1, size: 10, sha256: 'hash' },
        })),
      },
    };
    useStore.setState({
      serverPort: 62950,
      deskBasePath: '',
      deskCurrentPath: '',
      deskFiles: [],
      deskTreeFilesByPath: {},
      deskExpandedPaths: [],
      deskSelectedPath: '',
      deskJianContent: null,
      cwdSkills: [],
      cwdSkillsOpen: false,
      workspaceDeskStateByRoot: {},
      previewOpen: false,
      openTabs: [],
      activeTabId: null,
      selectedFolder: '/home-folder',
      homeFolder: '/fallback-home',
      workspaceFolders: [],
      pendingNewSession: true,
      currentSessionPath: null,
    } as never);
  });

  it('loads the selected/home folder when no explicit override is passed', async () => {
    mockHanaFetch
      .mockResolvedValueOnce(jsonResponse({ files: [], basePath: '/home-folder' }))
      .mockResolvedValueOnce(jsonResponse({ content: null }));

    const { loadDeskFiles } = await import('../../stores/desk-actions');
    await loadDeskFiles();

    expect(mockHanaFetch).toHaveBeenNthCalledWith(
      1,
      '/api/desk/files?dir=%2Fhome-folder',
    );
  });

  it('adds and removes extra workspace folders without changing the primary folder', async () => {
    const { addWorkspaceFolder, removeWorkspaceFolder } = await import('../../stores/desk-actions');

    addWorkspaceFolder('/reference');
    addWorkspaceFolder('/home-folder');
    addWorkspaceFolder('/reference');

    expect(useStore.getState().selectedFolder).toBe('/home-folder');
    expect(useStore.getState().workspaceFolders).toEqual(['/reference']);

    removeWorkspaceFolder('/reference');
    expect(useStore.getState().workspaceFolders).toEqual([]);
  });

  it('records the selected workspace in the local picker history when switching folders', async () => {
    useStore.setState({
      selectedFolder: '/hana',
      homeFolder: '/hana',
      cwdHistory: ['/workspace/Desktop'],
    } as never);
    mockHanaFetch
      .mockResolvedValueOnce(jsonResponse({ cwd_history: ['/workspace/Desktop'] }))
      .mockResolvedValueOnce(jsonResponse({ files: [], basePath: '/workspace/Desktop' }))
      .mockResolvedValueOnce(jsonResponse({ content: null }));

    const { applyFolder } = await import('../../stores/desk-actions');
    applyFolder('/workspace/Desktop');

    expect(useStore.getState().selectedFolder).toBe('/workspace/Desktop');
    expect(useStore.getState().cwdHistory).toEqual(['/workspace/Desktop']);
  });

  it('promotes an extra folder to primary instead of keeping it in both lists', async () => {
    useStore.setState({
      selectedFolder: '/hana',
      homeFolder: '/hana',
      cwdHistory: ['/workspace/Desktop'],
      workspaceFolders: ['/reference', '/workspace/Desktop'],
    } as never);
    mockHanaFetch
      .mockResolvedValueOnce(jsonResponse({ cwd_history: ['/workspace/Desktop'] }))
      .mockResolvedValueOnce(jsonResponse({ files: [], basePath: '/workspace/Desktop' }))
      .mockResolvedValueOnce(jsonResponse({ content: null }));

    const { applyFolder } = await import('../../stores/desk-actions');
    applyFolder('/workspace/Desktop');

    expect(useStore.getState().selectedFolder).toBe('/workspace/Desktop');
    expect(useStore.getState().cwdHistory).toEqual(['/workspace/Desktop']);
    expect(useStore.getState().workspaceFolders).toEqual(['/reference']);
  });

  it('persists the selected workspace before refreshing the visible desk root', async () => {
    const persist = deferred<Response>();
    mockHanaFetch
      .mockResolvedValueOnce(jsonResponse({ state: null }))
      .mockReturnValueOnce(persist.promise)
      .mockResolvedValueOnce(jsonResponse({ files: [{ name: 'note.md' }], basePath: '/workspace/Desktop' }))
      .mockResolvedValueOnce(jsonResponse({ content: null }));

    const { applyFolder } = await import('../../stores/desk-actions');
    const run = applyFolder('/workspace/Desktop');

    expect(useStore.getState().selectedFolder).toBe('/workspace/Desktop');
    expect(useStore.getState().deskBasePath).toBe('/workspace/Desktop');
    expect(useStore.getState().deskFiles).toEqual([]);
    expect(mockHanaFetch).toHaveBeenCalledTimes(2);
    expect(mockHanaFetch).toHaveBeenNthCalledWith(
      1,
      '/api/preferences/workspace-ui-state?workspace=%2Fworkspace%2FDesktop',
    );
    expect(mockHanaFetch).toHaveBeenNthCalledWith(
      2,
      '/api/config/workspaces/recent',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/workspace/Desktop' }),
      }),
    );

    persist.resolve(jsonResponse({ cwd_history: ['/workspace/Desktop'] }));
    await run;

    expect(mockHanaFetch).toHaveBeenNthCalledWith(
      3,
      '/api/desk/files?dir=%2Fworkspace%2FDesktop',
    );
    expect(useStore.getState().deskBasePath).toBe('/workspace/Desktop');
    expect(useStore.getState().deskFiles).toEqual([{ name: 'note.md' }]);
  });

  it('keeps visible desk state keyed by workspace root', async () => {
    useStore.setState({
      deskBasePath: '/workspace-a',
      deskCurrentPath: 'notes/daily',
      deskFiles: [{ name: 'a.md' }],
      deskTreeFilesByPath: { '': [{ name: 'notes', isDir: true }], notes: [{ name: 'a.md', isDir: false }] },
      deskExpandedPaths: ['notes'],
      deskSelectedPath: 'notes/a.md',
      deskJianContent: 'a-note',
      cwdSkills: [{ name: 'skill-a', description: '', source: 'workspace', filePath: '/workspace-a/.agents/skills/a/SKILL.md', baseDir: '/workspace-a/.agents/skills/a' }],
      cwdSkillsOpen: true,
      jianDrawerOpen: true,
      previewOpen: true,
      openTabs: ['previewItem-a'],
      activeTabId: 'previewItem-a',
    } as never);

    const { activateWorkspaceDesk } = await import('../../stores/desk-actions');

    await activateWorkspaceDesk('/workspace-b', { reload: false });

    expect(useStore.getState().deskBasePath).toBe('/workspace-b');
    expect(useStore.getState().deskCurrentPath).toBe('');
    expect(useStore.getState().previewOpen).toBe(false);
    expect(useStore.getState().jianDrawerOpen).toBe(false);

    useStore.setState({
      deskCurrentPath: 'src',
      deskFiles: [{ name: 'b.md' }],
      deskTreeFilesByPath: { '': [{ name: 'src', isDir: true }], src: [{ name: 'b.md', isDir: false }] },
      deskExpandedPaths: ['src'],
      deskSelectedPath: 'src/b.md',
      deskJianContent: 'b-note',
      previewOpen: false,
      jianDrawerOpen: true,
      openTabs: ['previewItem-b'],
      activeTabId: 'previewItem-b',
    } as never);

    await activateWorkspaceDesk('/workspace-a', { reload: false });

    expect(useStore.getState().deskBasePath).toBe('/workspace-a');
    expect(useStore.getState().deskCurrentPath).toBe('notes/daily');
    expect(useStore.getState().deskFiles).toEqual([]);
    expect(useStore.getState().deskTreeFilesByPath).toEqual({
      '': [{ name: 'notes', isDir: true }],
      notes: [{ name: 'a.md', isDir: false }],
    });
    expect(useStore.getState().deskExpandedPaths).toEqual(['notes']);
    expect(useStore.getState().deskSelectedPath).toBe('notes/a.md');
    expect(useStore.getState().deskJianContent).toBeNull();
    expect(useStore.getState().cwdSkillsOpen).toBe(true);
    expect(useStore.getState().jianDrawerOpen).toBe(true);
    expect(useStore.getState().previewOpen).toBe(true);
    expect(useStore.getState().openTabs).toEqual(['previewItem-a']);
    expect(useStore.getState().activeTabId).toBe('previewItem-a');
  });

  it('restores persisted workspace UI state from the backend when memory has no entry', async () => {
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      state: {
        deskExpandedPaths: ['src', 'src/react'],
        deskSelectedPath: 'src/react/App.tsx',
        previewOpen: true,
        openTabs: ['file-src/react/App.tsx'],
        activeTabId: 'file-src/react/App.tsx',
        previewTabs: [
          {
            id: 'file-src/react/App.tsx',
            relativePath: 'src/react/App.tsx',
            title: 'App.tsx',
            type: 'code',
            ext: 'tsx',
            language: 'tsx',
          },
        ],
      },
    }));

    const { activateWorkspaceDesk } = await import('../../stores/desk-actions');
    await activateWorkspaceDesk('/workspace', { reload: false });

    expect(mockHanaFetch).toHaveBeenCalledWith('/api/preferences/workspace-ui-state?workspace=%2Fworkspace');
    expect(useStore.getState().deskExpandedPaths).toEqual(['src', 'src/react']);
    expect(useStore.getState().deskSelectedPath).toBe('src/react/App.tsx');
    expect(useStore.getState().previewOpen).toBe(true);
    expect(useStore.getState().openTabs).toEqual(['file-src/react/App.tsx']);
    expect(useStore.getState().activeTabId).toBe('file-src/react/App.tsx');
    expect(useStore.getState().previewItems).toEqual([
      expect.objectContaining({
        id: 'file-src/react/App.tsx',
        filePath: '/workspace/src/react/App.tsx',
        title: 'App.tsx',
        content: 'content:/workspace/src/react/App.tsx',
        fileVersion: { mtimeMs: 1, size: 10, sha256: 'hash' },
      }),
    ]);
  });

  it('renames a tree item by explicit parent subdir and updates that tree cache', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [{ name: 'notes', isDir: true }],
        notes: [{ name: 'chapter.md', isDir: false }],
      },
      deskFiles: [{ name: 'notes', isDir: true }],
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      files: [{ name: 'renamed.md', isDir: false }],
    }));

    const { deskRenameTreeItem } = await import('../../stores/desk-actions');
    const ok = await deskRenameTreeItem('notes', 'chapter.md', 'renamed.md', false);

    expect(ok).toBe(true);
    expect(mockHanaFetch).toHaveBeenCalledWith('/api/desk/files', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        action: 'rename',
        dir: '/workspace',
        subdir: 'notes',
        oldName: 'chapter.md',
        newName: 'renamed.md',
      }),
    }));
    expect(useStore.getState().deskTreeFilesByPath.notes).toEqual([{ name: 'renamed.md', isDir: false }]);
  });

  it('renames expanded folder cache keys when a tree folder is renamed', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [{ name: 'notes', isDir: true }],
        notes: [{ name: 'chapter.md', isDir: false }],
        'notes/deep': [{ name: 'leaf.md', isDir: false }],
      },
      deskExpandedPaths: ['notes', 'notes/deep'],
      deskSelectedPath: 'notes/deep/leaf.md',
      deskFiles: [{ name: 'notes', isDir: true }],
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      ok: true,
      files: [{ name: 'renamed', isDir: true }],
    }));

    const { deskRenameTreeItem } = await import('../../stores/desk-actions');
    const ok = await deskRenameTreeItem('', 'notes', 'renamed', true);

    expect(ok).toBe(true);
    expect(useStore.getState().deskTreeFilesByPath['renamed/deep']).toEqual([{ name: 'leaf.md', isDir: false }]);
    expect(useStore.getState().deskTreeFilesByPath.notes).toBeUndefined();
    expect(useStore.getState().deskExpandedPaths).toEqual(['renamed', 'renamed/deep']);
    expect(useStore.getState().deskSelectedPath).toBe('renamed/deep/leaf.md');
  });

  it('trashes tree items through the platform trash API and refreshes affected parents', async () => {
    const trashItem = vi.fn(async () => true);
    (globalThis as any).window.platform = { trashItem };
    useStore.setState({
      deskBasePath: '/workspace',
      deskCurrentPath: '',
      deskTreeFilesByPath: {
        '': [{ name: 'notes', isDir: true }],
        notes: [{ name: 'chapter.md', isDir: false }],
      },
      deskExpandedPaths: ['notes'],
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      files: [],
      basePath: '/workspace',
    }));

    const { deskTrashTreeItems } = await import('../../stores/desk-actions');
    const ok = await deskTrashTreeItems([
      { sourceSubdir: 'notes', name: 'chapter.md', isDirectory: false },
    ]);

    expect(ok).toBe(true);
    expect(trashItem).toHaveBeenCalledWith('/workspace/notes/chapter.md');
    expect(mockHanaFetch).toHaveBeenCalledWith('/api/desk/files?dir=%2Fworkspace&subdir=notes');
    expect(useStore.getState().deskTreeFilesByPath.notes).toEqual([]);
  });

  it('keeps right Jian drawer state keyed by workspace root and collapses unseen roots', async () => {
    useStore.setState({
      deskBasePath: '/workspace-a',
      jianDrawerOpen: true,
      workspaceDeskStateByRoot: {},
    } as never);

    const { activateWorkspaceDesk } = await import('../../stores/desk-actions');

    await activateWorkspaceDesk('/workspace-b', { reload: false });

    expect(useStore.getState().jianDrawerOpen).toBe(false);
    expect(useStore.getState().workspaceDeskStateByRoot['/workspace-a'].jianDrawerOpen).toBe(true);

    useStore.setState({ jianDrawerOpen: true } as never);
    await activateWorkspaceDesk('/workspace-a', { reload: false });

    expect(useStore.getState().jianDrawerOpen).toBe(true);
    expect(useStore.getState().workspaceDeskStateByRoot['/workspace-b'].jianDrawerOpen).toBe(true);
  });

  it('loads tree children by explicit subdir without changing the visible current directory', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
      deskCurrentPath: 'drafts',
      deskFiles: [{ name: 'draft.md', isDir: false }],
      deskTreeFilesByPath: {},
      deskExpandedPaths: [],
      deskSelectedPath: '',
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      files: [{ name: 'chapter.md', isDir: false }],
      basePath: '/workspace',
    }));

    const { loadDeskTreeFiles } = await import('../../stores/desk-actions');
    await loadDeskTreeFiles('notes');

    expect(mockHanaFetch).toHaveBeenCalledWith('/api/desk/files?dir=%2Fworkspace&subdir=notes');
    expect(useStore.getState().deskCurrentPath).toBe('drafts');
    expect(useStore.getState().deskFiles).toEqual([{ name: 'draft.md', isDir: false }]);
    expect(useStore.getState().deskTreeFilesByPath).toEqual({
      notes: [{ name: 'chapter.md', isDir: false }],
    });
  });

  it('moves tree items by explicit source and destination subdirs without relying on the current folder', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
      deskCurrentPath: 'drafts',
      deskFiles: [{ name: 'draft.md', isDir: false }],
      deskTreeFilesByPath: {
        '': [{ name: 'notes', isDir: true }],
        notes: [{ name: 'chapter.md', isDir: false }],
        archive: [],
      },
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      filesByPath: {
        notes: [],
        archive: [{ name: 'chapter.md', isDir: false }],
      },
      files: [{ name: 'draft.md', isDir: false }],
    }));

    const { deskMoveTreeFiles } = await import('../../stores/desk-actions');
    await deskMoveTreeFiles([{ sourceSubdir: 'notes', name: 'chapter.md', isDirectory: false }], 'archive');

    expect(mockHanaFetch).toHaveBeenCalledWith('/api/desk/files', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'movePaths',
        dir: '/workspace',
        items: [{ sourceSubdir: 'notes', name: 'chapter.md', isDirectory: false }],
        destSubdir: 'archive',
        currentSubdir: 'drafts',
      }),
    }));
    expect(useStore.getState().deskCurrentPath).toBe('drafts');
    expect(useStore.getState().deskTreeFilesByPath.notes).toEqual([]);
    expect(useStore.getState().deskTreeFilesByPath.archive).toEqual([{ name: 'chapter.md', isDir: false }]);
    expect(useStore.getState().deskFiles).toEqual([{ name: 'draft.md', isDir: false }]);
  });

  it('searches workspace files against the active desk root', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
    } as never);
    mockHanaFetch.mockResolvedValueOnce(jsonResponse({
      results: [
        { name: 'DeskTree.tsx', relativePath: 'src/DeskTree.tsx', parentSubdir: 'src', isDir: false },
      ],
    }));

    const { searchDeskFiles } = await import('../../stores/desk-actions');
    const results = await searchDeskFiles('Desk');

    expect(mockHanaFetch).toHaveBeenCalledWith('/api/desk/search-files?dir=%2Fworkspace&q=Desk');
    expect(results).toEqual([
      { name: 'DeskTree.tsx', relativePath: 'src/DeskTree.tsx', parentSubdir: 'src', isDir: false },
    ]);
  });

  it('jumps to a search result by expanding ancestors and selecting the real tree path', async () => {
    useStore.setState({
      deskBasePath: '/workspace',
      deskTreeFilesByPath: {},
      deskExpandedPaths: [],
      deskSelectedPath: '',
    } as never);
    mockHanaFetch
      .mockResolvedValueOnce(jsonResponse({ files: [{ name: 'components', isDir: true }], basePath: '/workspace' }))
      .mockResolvedValueOnce(jsonResponse({ files: [{ name: 'DeskTree.tsx', isDir: false }], basePath: '/workspace' }));

    const { jumpToDeskSearchResult } = await import('../../stores/desk-actions');
    await jumpToDeskSearchResult({
      name: 'DeskTree.tsx',
      relativePath: 'src/components/DeskTree.tsx',
      parentSubdir: 'src/components',
      isDir: false,
    });

    expect(mockHanaFetch).toHaveBeenNthCalledWith(1, '/api/desk/files?dir=%2Fworkspace&subdir=src');
    expect(mockHanaFetch).toHaveBeenNthCalledWith(2, '/api/desk/files?dir=%2Fworkspace&subdir=src%2Fcomponents');
    expect(useStore.getState().deskExpandedPaths).toEqual(['src', 'src/components']);
    expect(useStore.getState().deskSelectedPath).toBe('src/components/DeskTree.tsx');
  });
});
