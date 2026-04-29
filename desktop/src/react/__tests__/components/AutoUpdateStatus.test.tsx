/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoUpdateStatus } from '../../components/AutoUpdateStatus';
import type { AutoUpdateState } from '../../types';

const labels: Record<string, string> = {
  'settings.about.updateDownloading': '{agentName}正在准备新家 {percent}%',
  'settings.about.updateProgress': '{percent}%',
  'settings.about.updateReadyInstall': 'v{version} 已就绪',
  'settings.about.updateInstall': '重启更新',
  'settings.about.updateInstallOnQuit': '退出 Hanako 时也会自动安装',
  'settings.about.updateInstalling': '正在安装更新，Hanako 会自动重启…',
  'settings.about.updateNeedInstall': '请先将 Hanako 移动到应用程序文件夹',
};

function translate(key: string, vars?: Record<string, string | number>): string {
  let value = labels[key] ?? key;
  for (const [name, replacement] of Object.entries(vars ?? {})) {
    value = value.replace(`{${name}}`, String(replacement));
  }
  return value;
}

function updateState(partial: Partial<AutoUpdateState>): AutoUpdateState {
  return {
    status: 'idle',
    version: null,
    releaseNotes: null,
    releaseUrl: null,
    downloadUrl: null,
    progress: null,
    error: null,
    ...partial,
  };
}

describe('AutoUpdateStatus', () => {
  beforeEach(() => {
    window.t = translate as typeof window.t;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders real-time download progress with bounded percent', () => {
    render(
      <AutoUpdateStatus
        state={updateState({
          status: 'downloading',
          progress: { percent: 42.6, bytesPerSecond: 0, transferred: 0, total: 0 },
        })}
        agentName="小花"
      />,
    );

    expect(screen.getByText('小花正在准备新家 43%')).toBeTruthy();
    expect(screen.getByText('43%')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('43');
  });

  it('keeps the restart action in-page after the update is downloaded', () => {
    const onInstall = vi.fn();

    render(
      <AutoUpdateStatus
        state={updateState({ status: 'downloaded', version: '0.118.0' })}
        onInstall={onInstall}
      />,
    );

    expect(screen.getByText('v0.118.0 已就绪')).toBeTruthy();
    expect(screen.getByText('退出 Hanako 时也会自动安装')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /重启更新/ }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it('renders installing and dmg install guidance without a modal contract', () => {
    const { rerender } = render(
      <AutoUpdateStatus state={updateState({ status: 'installing' })} />,
    );

    expect(screen.getByText('正在安装更新，Hanako 会自动重启…')).toBeTruthy();

    rerender(<AutoUpdateStatus state={updateState({ status: 'error', error: 'running_from_dmg' })} />);
    expect(screen.getByText('请先将 Hanako 移动到应用程序文件夹')).toBeTruthy();
  });
});
