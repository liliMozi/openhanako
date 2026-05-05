// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../stores';
import type { ChatListItem } from '../../stores/chat-types';
import { RightWorkspacePanel } from '../../components/right-workspace/RightWorkspacePanel';

const tMap: Record<string, string> = {
  'rightWorkspace.tabs.sessionFiles': 'Session 文件',
  'rightWorkspace.tabs.workspace': '工作空间',
  'rightWorkspace.sessionFiles.empty': '本对话还没有产生或上传文件',
  'rightWorkspace.sessionFiles.title': 'Session 文件',
  'rightWorkspace.sessionFiles.status.expired': '已过期',
  'rightWorkspace.sessionFiles.status.available': '可用',
  'rightWorkspace.jian.collapse': '收起笺',
  'rightWorkspace.jian.expand': '展开笺',
  'desk.workspaceTitle': '工作空间',
  'desk.jianLabel': '笺',
  'desk.jianPlaceholder': '写点什么...',
  'desk.openInFinder': '打开文件夹',
  'desk.sort.nameAscShort': '名称↑',
  'desk.sort.label': '排序',
  'common.noFiles': '没有文件',
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
    selectedFolder: null,
    homeFolder: null,
    jianView: 'desk',
  } as never);
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
    window.platform = {
      openFolder: () => undefined,
      showInFinder: () => undefined,
      watchFile: async () => true,
      unwatchFile: async () => true,
      onFileChanged: () => undefined,
    } as unknown as typeof window.platform;
    resetStore();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders extensible right workspace tabs and keeps workspace as the compatibility default', () => {
    const { container } = render(<RightWorkspacePanel />);

    const tabList = screen.getByRole('tablist', { name: 'rightWorkspace.tabs.label' });
    expect(tabList.closest('.jian-card')).toBe(container.querySelector('.jian-card'));
    expect(within(tabList).getByRole('tab', { name: 'Session 文件' })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('tab', { name: 'Session 文件' }));

    expect((tabList as HTMLElement).style.getPropertyValue('--right-workspace-active-tab-index')).toBe('0');
    expect(screen.getByRole('tab', { name: 'Session 文件' })).toHaveAttribute('aria-selected', 'true');
  });

  it('uses natural empty copy without a duplicate session files heading', () => {
    render(<RightWorkspacePanel />);

    fireEvent.click(screen.getByRole('tab', { name: 'Session 文件' }));

    expect(screen.queryByRole('heading', { name: 'Session 文件' })).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('tab', { name: 'Session 文件' }));

    expect(screen.queryByRole('heading', { name: 'Session 文件' })).not.toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('session-block-file')).toBeInTheDocument();
    expect(screen.getByText('可用')).toBeInTheDocument();
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
