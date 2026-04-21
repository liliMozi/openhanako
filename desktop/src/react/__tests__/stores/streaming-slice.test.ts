import { describe, it, expect, beforeEach } from 'vitest';
import { createStreamingSlice, type StreamingSlice } from '../../stores/streaming-slice';

function makeSlice(): StreamingSlice {
  let state: StreamingSlice;
  const set = (partial: Partial<StreamingSlice> | ((s: StreamingSlice) => Partial<StreamingSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  state = createStreamingSlice(set);
  return new Proxy({} as StreamingSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

describe('streaming-slice', () => {
  let slice: StreamingSlice;

  beforeEach(() => {
    slice = makeSlice();
  });

  it('初始状态', () => {
    expect(slice.streamingSessions).toEqual([]);
  });

  it('addStreamingSession 添加 path', () => {
    slice.addStreamingSession('/s1');
    expect(slice.streamingSessions).toEqual(['/s1']);
  });

  it('addStreamingSession 去重', () => {
    slice.addStreamingSession('/s1');
    slice.addStreamingSession('/s1');
    expect(slice.streamingSessions).toEqual(['/s1']);
  });

  it('addStreamingSession 多个不同 path', () => {
    slice.addStreamingSession('/s1');
    slice.addStreamingSession('/s2');
    expect(slice.streamingSessions).toEqual(['/s1', '/s2']);
  });

  it('removeStreamingSession 移除指定 path', () => {
    slice.addStreamingSession('/s1');
    slice.addStreamingSession('/s2');
    slice.removeStreamingSession('/s1');
    expect(slice.streamingSessions).toEqual(['/s2']);
  });

  it('removeStreamingSession 对不存在的 path 无影响', () => {
    slice.addStreamingSession('/s1');
    slice.removeStreamingSession('/x');
    expect(slice.streamingSessions).toEqual(['/s1']);
  });
});
