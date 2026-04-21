import { describe, expect, it } from 'vitest';
import { selectDeskFiles, selectSessionFiles, invalidateSessionCache } from '../../../stores/selectors/file-refs';
import type { DeskFile } from '../../../types';
import type { ChatListItem } from '../../../stores/chat-types';

function makeState(deskFiles: DeskFile[], basePath = '/home/u', currentPath = '') {
  return {
    deskFiles,
    deskBasePath: basePath,
    deskCurrentPath: currentPath,
    chatSessions: {},
  } as any;
}

describe('selectDeskFiles', () => {
  it('过滤掉目录', () => {
    const state = makeState([
      { name: 'a.png', isDir: false },
      { name: 'sub', isDir: true },
      { name: 'b.mp4', isDir: false },
    ]);
    const refs = selectDeskFiles(state);
    expect(refs.map(r => r.name)).toEqual(['a.png', 'b.mp4']);
  });

  it('按扩展名推断 kind', () => {
    const state = makeState([
      { name: 'pic.jpg', isDir: false },
      { name: 'note.md', isDir: false },
      { name: 'clip.mp4', isDir: false },
      { name: 'mystery', isDir: false },
    ]);
    const refs = selectDeskFiles(state);
    expect(refs.find(r => r.name === 'pic.jpg')?.kind).toBe('image');
    expect(refs.find(r => r.name === 'note.md')?.kind).toBe('markdown');
    expect(refs.find(r => r.name === 'clip.mp4')?.kind).toBe('video');
    expect(refs.find(r => r.name === 'mystery')?.kind).toBe('other');
  });

  it('路径拼接 = basePath + currentPath + name', () => {
    const state = makeState(
      [{ name: 'a.png', isDir: false }],
      '/root',
      'sub/dir',
    );
    expect(selectDeskFiles(state)[0].path).toBe('/root/sub/dir/a.png');
  });

  it('currentPath 为空时路径 = basePath + name', () => {
    const state = makeState(
      [{ name: 'a.png', isDir: false }],
      '/root',
      '',
    );
    expect(selectDeskFiles(state)[0].path).toBe('/root/a.png');
  });

  it('UNC 前导 // 保留（Windows 网络盘）', () => {
    const state = makeState(
      [{ name: 'a.png', isDir: false }],
      '//server/share',
      'sub',
    );
    // 关键：前导 // 不能被折叠成 /，否则 pathToFileUrl 的 UNC 分支匹配不上
    expect(selectDeskFiles(state)[0].path).toBe('//server/share/sub/a.png');
  });

  it('Windows 盘符风格 basePath（仅正斜杠）保留', () => {
    const state = makeState(
      [{ name: 'a.png', isDir: false }],
      'C:/Users/foo',
      '',
    );
    expect(selectDeskFiles(state)[0].path).toBe('C:/Users/foo/a.png');
  });

  it('多余斜杠被压扁（非 UNC 场景）', () => {
    const state = makeState(
      [{ name: 'a.png', isDir: false }],
      '/root/',
      '/sub/',
    );
    expect(selectDeskFiles(state)[0].path).toBe('/root/sub/a.png');
  });

  it('同一输入多次调用返回引用稳定（memoization）', () => {
    const files: DeskFile[] = [{ name: 'a.png', isDir: false }];
    const state = makeState(files);
    const r1 = selectDeskFiles(state);
    const r2 = selectDeskFiles(state);
    expect(r1).toBe(r2);
  });

  it('id 由 buildFileRefId 构造（desk:<path>）', () => {
    const state = makeState([{ name: 'a.png', isDir: false }], '/x');
    const [ref] = selectDeskFiles(state);
    expect(ref.id).toBe('desk:/x/a.png');
    expect(ref.source).toBe('desk');
  });
});

function sessionState(items: ChatListItem[], path = '/s/1') {
  return {
    deskFiles: [],
    deskBasePath: '',
    deskCurrentPath: '',
    chatSessions: { [path]: { items, hasMore: false, loadingMore: false } },
  } as any;
}

describe('selectSessionFiles', () => {
  it('空 session 返回 []（引用稳定）', () => {
    const s = sessionState([]);
    const r1 = selectSessionFiles(s, '/s/1');
    const r2 = selectSessionFiles(s, '/s/1');
    expect(r1).toEqual([]);
    expect(r1).toBe(r2);
  });

  it('未知 sessionPath 返回 []（引用稳定）', () => {
    const r1 = selectSessionFiles(sessionState([]), '/never');
    const r2 = selectSessionFiles(sessionState([]), '/nowhere');
    expect(r1).toEqual([]);
    expect(r1).toBe(r2);
  });

  it('抽取 user attachments（过滤目录）', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'm1', role: 'user',
        attachments: [
          { path: '/a/pic.png', name: 'pic.png', isDir: false },
          { path: '/a/sub', name: 'sub', isDir: true },
          { path: '/a/clip.mp4', name: 'clip.mp4', isDir: false, mimeType: 'video/mp4' },
        ],
        timestamp: 1000,
      },
    }];
    const refs = selectSessionFiles(sessionState(items), '/s/1');
    expect(refs.map(r => r.name)).toEqual(['pic.png', 'clip.mp4']);
    expect(refs[0].source).toBe('session-attachment');
    expect(refs[0].sessionMessageId).toBe('m1');
    expect(refs[1].mime).toBe('video/mp4');
  });

  it('抽取 blocks.file', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'm2', role: 'assistant',
        blocks: [
          { type: 'file', filePath: '/out/diagram.svg', label: 'diagram.svg', ext: 'svg' },
        ],
        timestamp: 2000,
      },
    }];
    const refs = selectSessionFiles(sessionState(items), '/s/1');
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('svg');
    expect(refs[0].source).toBe('session-block-file');
    expect(refs[0].path).toBe('/out/diagram.svg');
  });

  it('抽取 blocks.screenshot（内嵌 base64，path 为空）', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'm3', role: 'assistant',
        blocks: [
          { type: 'screenshot', base64: 'iVBORw0...', mimeType: 'image/png' },
        ],
        timestamp: 3000,
      },
    }];
    const refs = selectSessionFiles(sessionState(items), '/s/1');
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('image');
    expect(refs[0].source).toBe('session-block-screenshot');
    expect(refs[0].path).toBe('');
    expect(refs[0].inlineData).toEqual({ base64: 'iVBORw0...', mimeType: 'image/png' });
  });

  it('同一消息 attachments 在前 blocks 在后', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: {
        id: 'mx', role: 'user',
        attachments: [{ path: '/a.png', name: 'a.png', isDir: false }],
        blocks: [{ type: 'file', filePath: '/b.png', label: 'b.png', ext: 'png' }],
        timestamp: 4000,
      },
    }];
    const refs = selectSessionFiles(sessionState(items), '/s/1');
    expect(refs.map(r => r.name)).toEqual(['a.png', 'b.png']);
  });

  it('跨多消息按消息顺序', () => {
    const items: ChatListItem[] = [
      { type: 'message', data: { id: '1', role: 'user', attachments: [{ path: '/1.png', name: '1.png', isDir: false }] } },
      { type: 'compaction', id: 'c1', yuan: '' },
      { type: 'message', data: { id: '2', role: 'assistant', blocks: [{ type: 'file', filePath: '/2.png', label: '2.png', ext: 'png' }] } },
    ];
    const refs = selectSessionFiles(sessionState(items), '/s/1');
    expect(refs.map(r => r.name)).toEqual(['1.png', '2.png']);
  });

  it('memoization：同一输入返回引用稳定', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: { id: 'm', role: 'user', attachments: [{ path: '/a.png', name: 'a.png', isDir: false }] },
    }];
    const state = sessionState(items);
    const r1 = selectSessionFiles(state, '/s/1');
    const r2 = selectSessionFiles(state, '/s/1');
    expect(r1).toBe(r2);
  });
});

describe('invalidateSessionCache（生命周期绑定）', () => {
  it('invalidateSessionCache(path) 后再调 selectSessionFiles 会重新计算（引用不等）', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: { id: 'm', role: 'user', attachments: [{ path: '/a.png', name: 'a.png', isDir: false }] },
    }];
    const state = sessionState(items, '/s/evict');
    const r1 = selectSessionFiles(state, '/s/evict');
    invalidateSessionCache('/s/evict');
    const r2 = selectSessionFiles(state, '/s/evict');
    expect(r1).not.toBe(r2);
    // 内容仍一致（只是重新构造了数组）
    expect(r1).toEqual(r2);
  });

  it('invalidateSessionCache() 无参清空整张 Map（跨 session）', () => {
    const itemsA: ChatListItem[] = [{
      type: 'message',
      data: { id: 'a', role: 'user', attachments: [{ path: '/a.png', name: 'a.png', isDir: false }] },
    }];
    const itemsB: ChatListItem[] = [{
      type: 'message',
      data: { id: 'b', role: 'user', attachments: [{ path: '/b.png', name: 'b.png', isDir: false }] },
    }];
    const stateA = {
      deskFiles: [], deskBasePath: '', deskCurrentPath: '',
      chatSessions: {
        '/s/a': { items: itemsA, hasMore: false, loadingMore: false },
        '/s/b': { items: itemsB, hasMore: false, loadingMore: false },
      },
    } as any;
    const a1 = selectSessionFiles(stateA, '/s/a');
    const b1 = selectSessionFiles(stateA, '/s/b');
    invalidateSessionCache();
    const a2 = selectSessionFiles(stateA, '/s/a');
    const b2 = selectSessionFiles(stateA, '/s/b');
    expect(a1).not.toBe(a2);
    expect(b1).not.toBe(b2);
  });

  it('invalidateSessionCache(unknown) 幂等，不影响其它 session', () => {
    const items: ChatListItem[] = [{
      type: 'message',
      data: { id: 'x', role: 'user', attachments: [{ path: '/x.png', name: 'x.png', isDir: false }] },
    }];
    const state = sessionState(items, '/s/keep');
    const r1 = selectSessionFiles(state, '/s/keep');
    invalidateSessionCache('/s/does-not-exist');
    const r2 = selectSessionFiles(state, '/s/keep');
    expect(r1).toBe(r2);
  });
});
