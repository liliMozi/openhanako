import { describe, it, expect, beforeEach } from 'vitest';
import { createInputSlice, type InputSlice } from '../../stores/input-slice';

function makeSlice(): InputSlice {
  let state: InputSlice;
  const set = (partial: Partial<InputSlice> | ((s: InputSlice) => Partial<InputSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  state = createInputSlice(set);
  return new Proxy({} as InputSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

describe('input-slice quotedSelection', () => {
  let slice: InputSlice;
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
