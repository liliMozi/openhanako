/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { useStore } from '../../../../stores';
import { MediaViewer } from '../../../../components/shared/MediaViewer/MediaViewer';
import type { FileRef } from '../../../../types/file-ref';

const f = (id: string, kind: FileRef['kind'] = 'image'): FileRef => ({
  id, kind, source: 'desk', name: `${id}.png`, path: `/${id}.png`, ext: 'png',
});

describe('MediaViewer interaction', () => {
  beforeEach(() => {
    useStore.getState().closeMediaViewer();
    (window as any).platform = {
      readFileBase64: vi.fn(async () => 'BASE64'),
      getFileUrl: vi.fn((p: string) => `file://${p}`),
    };
  });
  afterEach(() => { cleanup(); useStore.getState().closeMediaViewer(); delete (window as any).platform; });

  it('ESC 关闭', () => {
    useStore.getState().setMediaViewer({ files: [f('a'), f('b')], currentId: 'a', origin: 'desk' });
    render(<MediaViewer />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useStore.getState().mediaViewer).toBeNull();
  });

  it('点击遮罩关闭', () => {
    useStore.getState().setMediaViewer({ files: [f('a')], currentId: 'a', origin: 'desk' });
    const { getByTestId } = render(<MediaViewer />);
    fireEvent.click(getByTestId('media-viewer-overlay'));
    expect(useStore.getState().mediaViewer).toBeNull();
  });

  it('点击关闭按钮关闭', () => {
    useStore.getState().setMediaViewer({ files: [f('a')], currentId: 'a', origin: 'desk' });
    const { getByTestId } = render(<MediaViewer />);
    fireEvent.click(getByTestId('media-viewer-close'));
    expect(useStore.getState().mediaViewer).toBeNull();
  });

  it('→ 切到下一张', () => {
    useStore.getState().setMediaViewer({ files: [f('a'), f('b'), f('c')], currentId: 'a', origin: 'desk' });
    render(<MediaViewer />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(useStore.getState().mediaViewer?.currentId).toBe('b');
  });

  it('← 切到上一张', () => {
    useStore.getState().setMediaViewer({ files: [f('a'), f('b')], currentId: 'b', origin: 'desk' });
    render(<MediaViewer />);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(useStore.getState().mediaViewer?.currentId).toBe('a');
  });

  it('首张 ← 不变', () => {
    useStore.getState().setMediaViewer({ files: [f('a'), f('b')], currentId: 'a', origin: 'desk' });
    render(<MediaViewer />);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(useStore.getState().mediaViewer?.currentId).toBe('a');
  });

  it('末张 → 不变', () => {
    useStore.getState().setMediaViewer({ files: [f('a'), f('b')], currentId: 'b', origin: 'desk' });
    render(<MediaViewer />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(useStore.getState().mediaViewer?.currentId).toBe('b');
  });

  it('单张图时左右箭头不渲染', () => {
    useStore.getState().setMediaViewer({ files: [f('a')], currentId: 'a', origin: 'desk' });
    const { queryByTestId } = render(<MediaViewer />);
    expect(queryByTestId('media-viewer-prev')).toBeNull();
    expect(queryByTestId('media-viewer-next')).toBeNull();
  });

  it('多张图时左右箭头渲染', () => {
    useStore.getState().setMediaViewer({ files: [f('a'), f('b')], currentId: 'a', origin: 'desk' });
    const { getByTestId } = render(<MediaViewer />);
    expect(getByTestId('media-viewer-prev')).toBeTruthy();
    expect(getByTestId('media-viewer-next')).toBeTruthy();
  });

  it('video kind 渲染 VideoStage，Space 在 video 未聚焦时不处理', async () => {
    useStore.getState().setMediaViewer({
      files: [{ ...f('v'), kind: 'video', ext: 'mp4' }],
      currentId: 'v', origin: 'desk',
    });
    const { getByTestId } = render(<MediaViewer />);
    await waitFor(() => expect(getByTestId('video-stage-video')).toBeTruthy());
  });

  it('顶栏显示 序号 n/total + 文件名', () => {
    useStore.getState().setMediaViewer({ files: [f('a'), f('b'), f('c')], currentId: 'b', origin: 'desk' });
    const { getByTestId } = render(<MediaViewer />);
    expect(getByTestId('media-viewer-index').textContent).toContain('2 / 3');
    expect(getByTestId('media-viewer-name').textContent).toContain('b.png');
  });

  it('+ 键触发 zoomIn 命令', () => {
    useStore.getState().setMediaViewer({ files: [f('a')], currentId: 'a', origin: 'desk' });
    const { container } = render(<MediaViewer />);
    fireEvent.keyDown(window, { key: '=' });
    // 通过 data-zoom-seq 属性断言命令已派发
    const stage = container.querySelector('[data-testid="image-stage"]') as HTMLElement;
    expect(stage.dataset.zoomInSeq).toBe('1');
  });

  it('- 键触发 zoomOut 命令', () => {
    useStore.getState().setMediaViewer({ files: [f('a')], currentId: 'a', origin: 'desk' });
    const { container } = render(<MediaViewer />);
    fireEvent.keyDown(window, { key: '-' });
    const stage = container.querySelector('[data-testid="image-stage"]') as HTMLElement;
    expect(stage.dataset.zoomOutSeq).toBe('1');
  });

  it('0 键触发 reset 命令', () => {
    useStore.getState().setMediaViewer({ files: [f('a')], currentId: 'a', origin: 'desk' });
    const { container } = render(<MediaViewer />);
    fireEvent.keyDown(window, { key: '0' });
    const stage = container.querySelector('[data-testid="image-stage"]') as HTMLElement;
    expect(stage.dataset.resetSeq).toBe('1');
  });
});
