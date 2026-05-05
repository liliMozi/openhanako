// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import type { ChatListItem } from '../../stores/chat-types';
import { RightWorkspacePanel } from '../../components/right-workspace/RightWorkspacePanel';
import { openFilePreview } from '../../utils/file-preview';
import { openMediaViewerForRef } from '../../utils/open-media-viewer';
import { hanaFetch } from '../../hooks/use-hana-fetch';

vi.mock('../../utils/file-preview', () => ({
  openFilePreview: vi.fn(async () => undefined),
}));

vi.mock('../../utils/open-media-viewer', () => ({
  openMediaViewerForRef: vi.fn(),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

const tMap: Record<string, string> = {
  'rightWorkspace.tabs.sessionFiles': '对话文件',
  'rightWorkspace.tabs.workspace': '工作空间',
  'rightWorkspace.sessionFiles.empty': '本对话还没有产生或上传文件',
  'rightWorkspace.sessionFiles.title': '对话文件',
  'rightWorkspace.sessionFiles.status.expired': '已过期',
  'rightWorkspace.sessionFiles.status.available': '可用',
  'rightWorkspace.sessionFiles.actions.preview': '预览',
  'rightWorkspace.sessionFiles.actions.open': '打开',
  'rightWorkspace.sessionFiles.actions.reveal': '定位',
  'rightWorkspace.sessionFiles.actions.copyPath': '复制路径',
  'rightWorkspace.sessionFiles.actions.copySelectedPaths': '复制 2 个路径',
  'rightWorkspace.sessionFiles.actions.sendToBridge': '发送到...',
  'rightWorkspace.sessionFiles.actions.sendToBridgeLoading': '正在加载 Bridge 会话...',
  'rightWorkspace.sessionFiles.actions.sendToBridgeEmpty': '没有可发送的 Bridge 会话',
  'rightWorkspace.sessionFiles.actions.sendToBridgeLoadFailed': 'Bridge 会话加载失败',
  'rightWorkspace.sessionFiles.bridgeLoadFailed': '加载 Bridge 会话失败：boom',
  'rightWorkspace.sessionFiles.sendSuccess': '已发送到 Hana：飞书 · 小群',
  'rightWorkspace.sessionFiles.sendFailed': '发送到 Hana：飞书 · 小群 失败：boom',
  'rightWorkspace.sessionFiles.list': '对话文件列表',
  'rightWorkspace.sessionFiles.sort.label': '对话文件排序',
  'rightWorkspace.sessionFiles.sort.timeDesc': '时间↓',
  'rightWorkspace.sessionFiles.sort.nameAsc': '名称↑',
  'rightWorkspace.sessionFiles.sort.nameDesc': '名称↓',
  'rightWorkspace.sessionFiles.sort.typeAsc': '类型↑',
  'rightWorkspace.jian.collapse': '收起笺',
  'rightWorkspace.jian.expand': '展开笺',
  'desk.workspaceTitle': '工作空间',
  'desk.jianLabel': '笺',
  'desk.jianPlaceholder': '写点什么...',
  'desk.openInFinder': '打开文件夹',
  'desk.sort.nameAscShort': '名称↑',
  'desk.sort.label': '排序',
  'common.noFiles': '没有文件',
  'settings.bridge.feishu': '飞书',
};

function resetStore(items: ChatListItem[] = []) {
  useStore.setState({
    currentSessionPath: '/sessions/main.jsonl',
    chatSessions: {
      '/sessions/main.jsonl': {
        items,
        hasMore: false,
        loadingMore: false,
      },
    },
    rightWorkspaceTab: 'workspace',
    jianDrawerOpen: true,
    deskBasePath: '/tmp/hana-work',
    deskCurrentPath: '',
    deskFiles: [],
    deskJianContent: '',
    agents: [{ id: 'hana', name: 'Hana', yuan: 'hanako', hasAvatar: false }],
    currentAgentId: 'hana',
    selectedFolder: null,
    homeFolder: null,
    jianView: 'desk',
  } as never);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RightWorkspacePanel', () => {
  let localStorageData: Record<string, string>;

  beforeEach(() => {
    localStorageData = {};
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => localStorageData[key] ?? null,
        setItem: (key: string, value: string) => {
          localStorageData[key] = value;
        },
        removeItem: (key: string) => {
          delete localStorageData[key];
        },
        clear: () => {
          localStorageData = {};
        },
      },
    });
    window.t = ((key: string) => tMap[key] || key) as typeof window.t;
    vi.mocked(openFilePreview).mockClear();
    vi.mocked(openMediaViewerForRef).mockClear();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(hanaFetch).mockResolvedValue(jsonResponse({ sessions: [] }));
    window.platform = {
      openFolder: () => undefined,
      openFile: vi.fn(),
      showInFinder: vi.fn(),
      watchFile: async () => true,
      unwatchFile: async () => true,
      onFileChanged: () => undefined,
      startDrag: vi.fn(),
    } as unknown as typeof window.platform;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    resetStore();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders extensible right workspace tabs and keeps workspace as the compatibility default', () => {
    const { container } = render(<RightWorkspacePanel />);

    const tabList = screen.getByRole('tablist', { name: 'rightWorkspace.tabs.label' });
    expect(tabList.closest('.jian-card')).toBe(container.querySelector('.jian-card'));
    expect(within(tabList).getByRole('tab', { name: '对话文件' })).toBeInTheDocument();
    expect(within(tabList).getByRole('tab', { name: '工作空间' })).toHaveAttribute('aria-selected', 'true');
    expect(container.querySelector('[data-right-workspace-tab-slider]')).toBeInTheDocument();
    expect((tabList as HTMLElement).style.getPropertyValue('--right-workspace-active-tab-index')).toBe('1');
    expect(screen.getByText('hana-work')).toBeInTheDocument();
    expect(screen.queryByText(/工作空间 ·/)).not.toBeInTheDocument();
  });

  it('moves the tab slider when switching between session files and workspace', () => {
    render(<RightWorkspacePanel />);

    const tabList = screen.getByRole('tablist', { name: 'rightWorkspace.tabs.label' });
    expect((tabList as HTMLElement).style.getPropertyValue('--right-workspace-active-tab-index')).toBe('1');

    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    expect((tabList as HTMLElement).style.getPropertyValue('--right-workspace-active-tab-index')).toBe('0');
    expect(screen.getByRole('tab', { name: '对话文件' })).toHaveAttribute('aria-selected', 'true');
  });

  it('uses natural empty copy without a duplicate session files heading', () => {
    render(<RightWorkspacePanel />);

    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    expect(screen.queryByRole('heading', { name: '对话文件' })).not.toBeInTheDocument();
    expect(screen.getByText('本对话还没有产生或上传文件')).toBeInTheDocument();
  });

  it('shows current session registry files from the session file selector', () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          timestamp: 1700000000000,
          blocks: [
            {
              type: 'file',
              fileId: 'sf_report',
              filePath: '/tmp/session-files/report.pdf',
              label: 'report.pdf',
              ext: 'pdf',
              status: 'available',
            },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);

    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    expect(screen.queryByRole('heading', { name: '对话文件' })).not.toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('session-block-file')).toBeInTheDocument();
    expect(screen.getByText('可用')).toBeInTheDocument();
  });

  it('wires session file actions to preview, open, reveal and copy path consumers', () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          timestamp: 1700000000000,
          blocks: [
            {
              type: 'file',
              fileId: 'sf_report',
              filePath: '/tmp/session-files/report.pdf',
              label: 'report.pdf',
              ext: 'pdf',
              status: 'available',
            },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    fireEvent.click(screen.getByRole('button', { name: '预览 report.pdf' }));
    expect(openFilePreview).toHaveBeenCalledWith('/tmp/session-files/report.pdf', 'report.pdf', 'pdf', {
      origin: 'session',
      sessionPath: '/sessions/main.jsonl',
      messageId: 'a1',
      blockIdx: 0,
    });

    fireEvent.click(screen.getByRole('button', { name: '打开 report.pdf' }));
    expect(window.platform?.openFile).toHaveBeenCalledWith('/tmp/session-files/report.pdf');

    fireEvent.click(screen.getByRole('button', { name: '定位 report.pdf' }));
    expect(window.platform?.showInFinder).toHaveBeenCalledWith('/tmp/session-files/report.pdf');

    fireEvent.click(screen.getByRole('button', { name: '复制路径 report.pdf' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/session-files/report.pdf');
  });

  it('sorts session files without a manual refresh or add entry', () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'older',
          role: 'assistant',
          timestamp: 3000,
          blocks: [
            { type: 'file', fileId: 'sf_zeta', filePath: '/tmp/session-files/zeta.md', label: 'zeta.md', ext: 'md', status: 'available' },
          ],
        },
      },
      {
        type: 'message',
        data: {
          id: 'newer',
          role: 'assistant',
          timestamp: 1000,
          blocks: [
            { type: 'file', fileId: 'sf_alpha', filePath: '/tmp/session-files/alpha.png', label: 'alpha.png', ext: 'png', status: 'available' },
          ],
        },
      },
      {
        type: 'message',
        data: {
          id: 'middle',
          role: 'assistant',
          timestamp: 2000,
          blocks: [
            { type: 'file', fileId: 'sf_beta', filePath: '/tmp/session-files/beta.pdf', label: 'beta.pdf', ext: 'pdf', status: 'available' },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    const names = () => screen.getAllByTestId('session-file-name').map(el => el.textContent);
    expect(names()).toEqual(['zeta.md', 'beta.pdf', 'alpha.png']);

    fireEvent.click(screen.getByRole('button', { name: '对话文件排序' }));
    fireEvent.click(screen.getByText('名称↑'));

    expect(names()).toEqual(['alpha.png', 'beta.pdf', 'zeta.md']);
    expect(screen.queryByText('打开文件夹')).not.toBeInTheDocument();
    expect(screen.queryByText('粘贴')).not.toBeInTheDocument();
  });

  it('copies selected session file paths by keyboard without accepting pasted files into the registry', () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          timestamp: 3000,
          blocks: [
            { type: 'file', fileId: 'sf_alpha', filePath: '/tmp/session-files/alpha.png', label: 'alpha.png', ext: 'png', status: 'available' },
          ],
        },
      },
      {
        type: 'message',
        data: {
          id: 'a2',
          role: 'assistant',
          timestamp: 2000,
          blocks: [
            { type: 'file', fileId: 'sf_beta', filePath: '/tmp/session-files/beta.pdf', label: 'beta.pdf', ext: 'pdf', status: 'available' },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    const rows = screen.getAllByTestId('session-file-row');
    fireEvent.click(rows[0]);
    fireEvent.click(rows[1], { metaKey: true });
    fireEvent.keyDown(screen.getByRole('list', { name: '对话文件列表' }), { key: 'c', metaKey: true });
    fireEvent.paste(screen.getByRole('list', { name: '对话文件列表' }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/session-files/alpha.png\n/tmp/session-files/beta.pdf');
    expect(screen.getAllByTestId('session-file-row')).toHaveLength(2);
  });

  it('supports rubber-band selection inside the session file list', async () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          timestamp: 3000,
          blocks: [
            { type: 'file', fileId: 'sf_alpha', filePath: '/tmp/session-files/alpha.png', label: 'alpha.png', ext: 'png', status: 'available' },
          ],
        },
      },
      {
        type: 'message',
        data: {
          id: 'a2',
          role: 'assistant',
          timestamp: 2000,
          blocks: [
            { type: 'file', fileId: 'sf_beta', filePath: '/tmp/session-files/beta.pdf', label: 'beta.pdf', ext: 'pdf', status: 'available' },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    const list = screen.getByRole('list', { name: '对话文件列表' });
    const rows = screen.getAllByTestId('session-file-row');
    vi.spyOn(rows[0], 'getBoundingClientRect').mockReturnValue({
      x: 10, y: 10, left: 10, top: 10, right: 90, bottom: 32, width: 80, height: 22, toJSON: () => {},
    } as DOMRect);
    vi.spyOn(rows[1], 'getBoundingClientRect').mockReturnValue({
      x: 10, y: 70, left: 10, top: 70, right: 90, bottom: 92, width: 80, height: 22, toJSON: () => {},
    } as DOMRect);

    fireEvent.mouseDown(list, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 100, clientY: 40 });
    fireEvent.mouseUp(window);

    await waitFor(() => {
      expect(rows[0]).toHaveAttribute('data-selected', 'true');
      expect(rows[1]).toHaveAttribute('data-selected', 'false');
    });

    fireEvent.keyDown(list, { key: 'c', metaKey: true });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/session-files/alpha.png');
  });

  it('uses the selected session files when dragging them out to the desktop', () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          timestamp: 3000,
          blocks: [
            { type: 'file', fileId: 'sf_alpha', filePath: '/tmp/session-files/alpha.png', label: 'alpha.png', ext: 'png', status: 'available' },
          ],
        },
      },
      {
        type: 'message',
        data: {
          id: 'a2',
          role: 'assistant',
          timestamp: 2000,
          blocks: [
            { type: 'file', fileId: 'sf_beta', filePath: '/tmp/session-files/beta.pdf', label: 'beta.pdf', ext: 'pdf', status: 'available' },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    const rows = screen.getAllByTestId('session-file-row');
    fireEvent.click(rows[0]);
    fireEvent.click(rows[1], { metaKey: true });
    fireEvent.dragStart(rows[1]);

    expect(window.platform?.startDrag).toHaveBeenCalledWith(['/tmp/session-files/alpha.png', '/tmp/session-files/beta.pdf']);
  });

  it('opens a right-click menu for session files without exposing paste/add actions', () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          timestamp: 1700000000000,
          blocks: [
            { type: 'file', fileId: 'sf_report', filePath: '/tmp/session-files/report.pdf', label: 'report.pdf', ext: 'pdf', status: 'available' },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    fireEvent.contextMenu(screen.getByTestId('session-file-row'), { clientX: 24, clientY: 48 });

    expect(screen.getByText('预览')).toBeInTheDocument();
    expect(screen.getByText('打开')).toBeInTheDocument();
    expect(screen.getByText('定位')).toBeInTheDocument();
    expect(screen.getByText('复制路径')).toBeInTheDocument();
    expect(screen.queryByText('粘贴')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('复制路径'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/session-files/report.pdf');
  });

  it('sends session files to an existing Bridge target from the context submenu', async () => {
    const sendBodies: unknown[] = [];
    vi.mocked(hanaFetch).mockImplementation(async (path, init) => {
      if (path.startsWith('/api/bridge/sessions?platform=feishu')) {
        return jsonResponse({
          sessions: [{ sessionKey: 'fs_1', chatId: 'oc_chat', displayName: '小群' }],
        });
      }
      if (path.startsWith('/api/bridge/sessions?')) {
        return jsonResponse({ sessions: [] });
      }
      if (path.startsWith('/api/bridge/send-media')) {
        sendBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ ok: true, fileId: 'sf_sent' });
      }
      return jsonResponse({});
    });
    resetStore([
      {
        type: 'message',
        data: {
          id: 'a1',
          role: 'assistant',
          timestamp: 1700000000000,
          blocks: [
            { type: 'file', fileId: 'sf_report', filePath: '/tmp/session-files/report.pdf', label: 'report.pdf', ext: 'pdf', status: 'available' },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));
    fireEvent.contextMenu(screen.getByTestId('session-file-row'), { clientX: 24, clientY: 48 });

    fireEvent.mouseEnter(screen.getByText('发送到...'));
    fireEvent.click(await screen.findByText('Hana：飞书 · 小群'));

    await waitFor(() => {
      expect(sendBodies).toEqual([
        {
          platform: 'feishu',
          chatId: 'oc_chat',
          filePath: '/tmp/session-files/report.pdf',
          label: 'report.pdf',
          sessionPath: '/sessions/main.jsonl',
        },
      ]);
    });
    expect(hanaFetch).toHaveBeenCalledWith('/api/bridge/send-media?agentId=hana', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }));
  });

  it('opens pathless screenshot files through MediaViewer and disables path actions', () => {
    resetStore([
      {
        type: 'message',
        data: {
          id: 'shot-1',
          role: 'assistant',
          timestamp: 1700000000000,
          blocks: [
            { type: 'screenshot', base64: 'iVBORw0...', mimeType: 'image/png' },
          ],
        },
      },
    ]);

    render(<RightWorkspacePanel />);
    fireEvent.click(screen.getByRole('tab', { name: '对话文件' }));

    const name = 'screenshot-shot-1-0.png';
    fireEvent.click(screen.getByRole('button', { name: `预览 ${name}` }));
    expect(openMediaViewerForRef).toHaveBeenCalledWith(expect.objectContaining({
      source: 'session-block-screenshot',
      name,
      path: '',
      inlineData: { base64: 'iVBORw0...', mimeType: 'image/png' },
    }), { origin: 'session', sessionPath: '/sessions/main.jsonl' });

    expect(screen.getByRole('button', { name: `打开 ${name}` })).toBeDisabled();
    expect(screen.getByRole('button', { name: `定位 ${name}` })).toBeDisabled();
    expect(screen.getByRole('button', { name: `复制路径 ${name}` })).toBeDisabled();
  });

  it('collapses and expands the Jian drawer without unmounting its editor state', () => {
    render(<RightWorkspacePanel />);

    const drawer = screen.getByRole('region', { name: '笺' });
    expect(drawer).toHaveAttribute('data-open', 'true');
    expect(screen.getByPlaceholderText('写点什么...')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '收起笺' }));

    expect(drawer).toHaveAttribute('data-open', 'false');
    expect(screen.getByRole('button', { name: '展开笺' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByPlaceholderText('写点什么...')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '展开笺' }));

    expect(drawer).toHaveAttribute('data-open', 'true');
    expect(screen.getByRole('button', { name: '收起笺' })).toHaveAttribute('aria-expanded', 'true');
  });
});
