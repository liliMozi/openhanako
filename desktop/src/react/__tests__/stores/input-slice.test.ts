import { describe, it, expect, beforeEach } from 'vitest';
import { createInputSlice, type InputSlice } from '../../stores/input-slice';

type SliceState = InputSlice & { currentSessionPath?: string | null };

function makeSlice(initial?: Partial<SliceState>): SliceState {
  let state: SliceState;
  const set = (partial: Partial<InputSlice> | ((s: InputSlice) => Partial<InputSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  state = { ...createInputSlice(set), ...initial };
  return new Proxy({} as SliceState, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

describe('input-slice quotedSelection', () => {
  let slice: SliceState;
  beforeEach(() => { slice = makeSlice(); });

  it('初始状态 quotedSelection 为 null', () => {
    expect(slice.quotedSelection).toBeNull();
  });
  it('setQuotedSelection 设置引用', () => {
    const sel = {
      text: '玻色子',
      sourceTitle: '百科全书',
      sourceFilePath: '/path/to/file.md',
      lineStart: 12,
      lineEnd: 15,
      charCount: 128,
    };
    slice.setQuotedSelection(sel);
    expect(slice.quotedSelection).toEqual(sel);
  });
  it('clearQuotedSelection 清除引用', () => {
    slice.setQuotedSelection({ text: 'test', sourceTitle: 'title', charCount: 4 });
    slice.clearQuotedSelection();
    expect(slice.quotedSelection).toBeNull();
  });
  it('setQuotedSelection 覆盖旧值', () => {
    slice.setQuotedSelection({ text: 'old', sourceTitle: 'A', charCount: 3 });
    slice.setQuotedSelection({ text: 'new', sourceTitle: 'B', charCount: 3 });
    expect(slice.quotedSelection!.text).toBe('new');
    expect(slice.quotedSelection!.sourceTitle).toBe('B');
  });
});

describe('input-slice attachedFiles session ownership', () => {
  it('当前会话存在时，add/remove/clear 会同步更新 attachedFilesBySession', () => {
    const slice = makeSlice({ currentSessionPath: '/session/a' });

    slice.addAttachedFile({ path: '/tmp/a.txt', name: 'a.txt' });
    slice.addAttachedFile({ path: '/tmp/b.txt', name: 'b.txt' });
    expect(slice.attachedFilesBySession['/session/a']).toEqual([
      { path: '/tmp/a.txt', name: 'a.txt' },
      { path: '/tmp/b.txt', name: 'b.txt' },
    ]);

    slice.removeAttachedFile(0);
    expect(slice.attachedFilesBySession['/session/a']).toEqual([
      { path: '/tmp/b.txt', name: 'b.txt' },
    ]);

    slice.clearAttachedFiles();
    expect(slice.attachedFilesBySession['/session/a']).toEqual([]);
    expect(slice.attachedFiles).toEqual([]);
  });

  it('没有 currentSessionPath 时只更新当前输入区，不写 keyed 附件状态', () => {
    const slice = makeSlice();

    slice.addAttachedFile({ path: '/tmp/a.txt', name: 'a.txt' });
    expect(slice.attachedFiles).toEqual([{ path: '/tmp/a.txt', name: 'a.txt' }]);
    expect(slice.attachedFilesBySession).toEqual({});
  });
});
