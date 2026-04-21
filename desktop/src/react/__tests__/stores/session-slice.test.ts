import { describe, it, expect, beforeEach } from 'vitest';
import { createSessionSlice, type SessionSlice } from '../../stores/session-slice';

function makeSlice(): SessionSlice {
  let state: SessionSlice;
  const set = (partial: Partial<SessionSlice> | ((s: SessionSlice) => Partial<SessionSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  state = createSessionSlice(set);
  return new Proxy({} as SessionSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

describe('session-slice', () => {
  let slice: SessionSlice;

  beforeEach(() => {
    slice = makeSlice();
  });

  it('初始状态正确', () => {
    expect(slice.sessions).toEqual([]);
    expect(slice.currentSessionPath).toBeNull();
    expect(slice.sessionStreams).toEqual({});
    expect(slice.pendingNewSession).toBe(false);
    expect(slice.memoryEnabled).toBe(true);
    expect(slice.sessionTodos).toEqual([]);
  });

  it('setSessionStream 添加 stream', () => {
    slice.setSessionStream('/a', { isStreaming: true } as never);
    expect(slice.sessionStreams).toEqual({ '/a': { isStreaming: true } });
  });

  it('setSessionStream 追加不覆盖已有', () => {
    slice.setSessionStream('/a', { id: 1 } as never);
    slice.setSessionStream('/b', { id: 2 } as never);
    expect(Object.keys(slice.sessionStreams)).toEqual(['/a', '/b']);
  });

  it('removeSessionStream 删除指定 key', () => {
    slice.setSessionStream('/a', { id: 1 } as never);
    slice.setSessionStream('/b', { id: 2 } as never);
    slice.removeSessionStream('/a');
    expect(slice.sessionStreams).toEqual({ '/b': { id: 2 } });
  });

  it('removeSessionStream 对不存在的 key 无影响', () => {
    slice.setSessionStream('/a', { id: 1 } as never);
    slice.removeSessionStream('/x');
    expect(slice.sessionStreams).toEqual({ '/a': { id: 1 } });
  });

  it('setSessions 替换整个列表', () => {
    const sessions = [{ path: '/s1' }, { path: '/s2' }] as never[];
    slice.setSessions(sessions);
    expect(slice.sessions).toEqual(sessions);
  });

  it('setCurrentSessionPath 设为 null 清空', () => {
    slice.setCurrentSessionPath('/s1');
    expect(slice.currentSessionPath).toBe('/s1');
    slice.setCurrentSessionPath(null);
    expect(slice.currentSessionPath).toBeNull();
  });
});
