/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent, waitFor } from '@testing-library/react';
import { ImageStage } from '../../../../components/shared/MediaViewer/ImageStage';
import type { FileRef } from '../../../../types/file-ref';

describe('ImageStage', () => {
  // 注意：prop 名必须是 `file` 不是 `ref`。React 会把 `ref` 当 forwardRef ref 截获，
  // 导致组件拿不到该 prop。
  const file: FileRef = { id: '1', kind: 'image', source: 'desk', name: 'a.png', path: '/a.png', ext: 'png' };

  beforeEach(() => {
    (window as any).platform = {
      // v0.105.1 起 image/svg 改走 getFileUrl（不再 readFileBase64 进 JS 堆）
      getFileUrl: vi.fn((p: string) => `file:///MOCK${p}`),
    };
  });
  afterEach(() => { cleanup(); delete (window as any).platform; });

  it('渲染 img 并异步加载 src（走 getFileUrl 的 file:// URL）', async () => {
    const { container } = render(<ImageStage file={file} viewport={{ width: 800, height: 600 }} />);
    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img).toBeTruthy();
      expect(img!.getAttribute('src')).toBe('file:///MOCK/a.png');
    });
    expect((window as any).platform.getFileUrl).toHaveBeenCalledWith('/a.png');
  });

  it('wheel 事件触发 transform 变化', async () => {
    const { container } = render(<ImageStage file={file} viewport={{ width: 800, height: 600 }} />);
    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img?.getAttribute('src')).toBeTruthy();
    });
    const img = container.querySelector('img')!;
    // 触发 load 让 natural size 稳定（jsdom 下默认 0，需注入）
    Object.defineProperty(img, 'naturalWidth', { value: 400, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 300, configurable: true });
    fireEvent.load(img);
    const stage = container.querySelector('[data-testid="image-stage"]')!;
    const before = (stage as HTMLElement).style.transform || '';
    fireEvent.wheel(stage, { deltaY: -100, clientX: 400, clientY: 300 });
    const after = (stage as HTMLElement).style.transform || '';
    expect(after).not.toBe(before);
  });

  it('natural size 就绪后 img 样式含 scale', async () => {
    const { container } = render(<ImageStage file={file} viewport={{ width: 1000, height: 800 }} />);
    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img?.getAttribute('src')).toBeTruthy();
    });
    const img = container.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 500, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 400, configurable: true });
    fireEvent.load(img);
    // scale(1.8) = 0.9 * min(1000/500, 800/400) = 0.9 * 2
    await waitFor(() => {
      const t = (container.querySelector('[data-testid="image-stage"]') as HTMLElement).style.transform;
      expect(t).toMatch(/scale\(1\.8\)/);
    });
  });

  it('loading 状态下显示 spinner（platform 缺失使 loadMediaSource 抛错 → src 保持 null）', () => {
    delete (window as any).platform;
    const { getByTestId } = render(<ImageStage file={file} viewport={{ width: 800, height: 600 }} />);
    expect(getByTestId('image-stage-spinner')).toBeTruthy();
  });

  it('邻图预加载也走 getFileUrl（不进 JS 堆）', async () => {
    const prev: FileRef = { id: '0', kind: 'image', source: 'desk', name: 'prev.png', path: '/prev.png', ext: 'png' };
    const next: FileRef = { id: '2', kind: 'image', source: 'desk', name: 'next.png', path: '/next.png', ext: 'png' };
    render(
      <ImageStage
        file={file}
        viewport={{ width: 800, height: 600 }}
        neighbors={{ prev, next }}
      />,
    );
    await waitFor(() => {
      // 当前图 + 前 + 后 三次调用
      expect((window as any).platform.getFileUrl).toHaveBeenCalledWith('/a.png');
      expect((window as any).platform.getFileUrl).toHaveBeenCalledWith('/prev.png');
      expect((window as any).platform.getFileUrl).toHaveBeenCalledWith('/next.png');
    });
  });
});
