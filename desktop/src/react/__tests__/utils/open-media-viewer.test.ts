/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../stores';
import { openMediaViewerFromContext, openMediaViewerForRef } from '../../utils/open-media-viewer';

describe('openMediaViewerFromContext', () => {
  beforeEach(() => {
    useStore.setState({
      currentSessionPath: null,
      deskFiles: [
        { name: 'a.png', isDir: false },
        { name: 'b.md', isDir: false },
        { name: 'c.jpg', isDir: false },
      ] as any,
      deskBasePath: '/d',
      deskCurrentPath: '',
      chatSessions: {},
    } as any);
  });
  afterEach(() => { useStore.getState().closeMediaViewer(); });

  it('显式 origin=desk：序列 = 当前目录所有 media', () => {
    openMediaViewerFromContext({
      filePath: '/d/a.png', label: 'a.png', ext: 'png', kind: 'image',
      origin: 'desk',
    });
    const mv = useStore.getState().mediaViewer;
    expect(mv).toBeTruthy();
    expect(mv!.files.map(f => f.name)).toEqual(['a.png', 'c.jpg']); // md 被过滤
    expect(mv!.currentId).toBe('desk:/d/a.png');
    expect(mv!.origin).toBe('desk');
  });

  it('显式 origin=session + sessionPath + messageId：从指定消息精准匹配起始项', () => {
    useStore.setState({
      currentSessionPath: '/s/1',
      chatSessions: {
        '/s/1': {
          items: [
            { type: 'message', data: { id: 'm1', role: 'user', attachments: [
              { path: '/s/x.png', name: 'x.png', isDir: false },
              { path: '/s/y.png', name: 'y.png', isDir: false },
            ] } },
          ],
          hasMore: false, loadingMore: false,
        },
      },
    } as any);
    openMediaViewerFromContext({
      filePath: '/s/y.png', label: 'y.png', ext: 'png', kind: 'image',
      origin: 'session', sessionPath: '/s/1', messageId: 'm1',
    });
    const mv = useStore.getState().mediaViewer;
    expect(mv!.files.map(f => f.name)).toEqual(['x.png', 'y.png']);
    // 按 id 匹配而非 path
    expect(mv!.currentId).toBe('sess:/s/1:m1:att:/s/y.png');
    expect(mv!.origin).toBe('session');
  });

  it('origin=session 未传 sessionPath → 序列里匹配不到 → 走 solo（不回退读 store）', () => {
    useStore.setState({
      currentSessionPath: '/s/2',
      chatSessions: {
        '/s/2': {
          items: [{ type: 'message', data: { id: 'm1', role: 'user', attachments: [
            { path: '/s/a.png', name: 'a.png', isDir: false },
          ] } }],
          hasMore: false, loadingMore: false,
        },
      },
    } as any);
    openMediaViewerFromContext({
      filePath: '/s/a.png', label: 'a.png', ext: 'png', kind: 'image',
      origin: 'session',   // sessionPath 没传
    });
    // 走 solo（sessionPath 为空 → selectSessionFiles('') → []）
    const mv = useStore.getState().mediaViewer;
    expect(mv!.files).toHaveLength(1);
    expect(mv!.files[0].path).toBe('/s/a.png');
  });

  it('**不传 origin 保守默认 desk**（即使 currentSessionPath 非 null 也不会误走 session）', () => {
    useStore.setState({
      currentSessionPath: '/s/x', // 注意：已打开过 chat 但当前触发来自 Desk
      deskFiles: [{ name: 'pic.png', isDir: false } as any],
      deskBasePath: '/d',
      deskCurrentPath: '',
    } as any);
    openMediaViewerFromContext({
      filePath: '/d/pic.png', label: 'pic.png', ext: 'png', kind: 'image',
      // 故意不传 origin —— 应当按 desk 分支执行
    });
    const mv = useStore.getState().mediaViewer;
    expect(mv!.origin).toBe('desk');
    expect(mv!.files.map(f => f.path)).toEqual(['/d/pic.png']);
  });

  it('序列里找不到 startRef 时构造 solo 序列（防御）', () => {
    openMediaViewerFromContext({
      filePath: '/outside/z.png', label: 'z.png', ext: 'png', kind: 'image',
      origin: 'desk',
    });
    const mv = useStore.getState().mediaViewer;
    expect(mv!.files).toHaveLength(1);
    expect(mv!.files[0].path).toBe('/outside/z.png');
  });

  it('openMediaViewerForRef: 按 id 匹配融入 session 序列（screenshot 场景）', () => {
    useStore.setState({
      currentSessionPath: '/s/1',
      chatSessions: {
        '/s/1': {
          items: [
            { type: 'message', data: { id: 'm1', role: 'user', attachments: [
              { path: '/s/a.png', name: 'a.png', isDir: false },
            ] } },
            { type: 'message', data: { id: 'm2', role: 'assistant', blocks: [
              { type: 'screenshot', base64: 'ABC', mimeType: 'image/png' },
            ] } },
          ],
          hasMore: false, loadingMore: false,
        },
      },
    } as any);

    const ref: any = {
      id: 'sess:/s/1:m2:block:0:screenshot',
      kind: 'image',
      source: 'session-block-screenshot',
      name: 'screenshot-m2-0.png',
      path: '',
      sessionMessageId: 'm2',
      inlineData: { base64: 'ABC', mimeType: 'image/png' },
    };
    openMediaViewerForRef(ref, { origin: 'session', sessionPath: '/s/1' });

    const mv = useStore.getState().mediaViewer;
    expect(mv!.files.length).toBe(2);
    expect(mv!.currentId).toBe('sess:/s/1:m2:block:0:screenshot');
  });
});
