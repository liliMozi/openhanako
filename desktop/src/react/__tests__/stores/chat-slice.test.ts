import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChatSlice, type ChatSlice } from '../../stores/chat-slice';
import type { SessionModel } from '../../stores/chat-types';
import { registerStreamBufferInvalidator } from '../../stores/stream-invalidator';

function makeSlice(): ChatSlice {
  let state: ChatSlice;
  const set = (partial: Partial<ChatSlice> | ((s: ChatSlice) => Partial<ChatSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state;
  state = createChatSlice(set as never, get);
  return new Proxy({} as ChatSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
  });
}

const MODEL: SessionModel = {
  id: 'claude-opus-4-6',
  name: 'Claude Opus 4.6',
  provider: 'anthropic',
  vision: true,
  reasoning: true,
  contextWindow: 1_000_000,
};

describe('chat-slice', () => {
  let slice: ChatSlice;

  beforeEach(() => {
    slice = makeSlice();
  });

  it('初始状态：chatSessions / sessionModelsByPath / _loadMessagesVersion 均为空', () => {
    expect(slice.chatSessions).toEqual({});
    expect(slice.sessionModelsByPath).toEqual({});
    expect(slice._loadMessagesVersion).toEqual({});
  });

  describe('updateSessionModel', () => {
    it('uncached session 不在 chatSessions 里创建 stub（#405 核心回归）', () => {
      slice.updateSessionModel('/a', MODEL);
      expect(slice.chatSessions).toEqual({});
      expect(slice.sessionModelsByPath).toEqual({ '/a': MODEL });
    });

    it('顺序无关：先 updateSessionModel 再 initSession，最终状态 chatSessions 存在 且 model 保留', () => {
      slice.updateSessionModel('/a', MODEL);
      slice.initSession('/a', [], false);
      expect(slice.chatSessions['/a']).toBeDefined();
      expect(slice.chatSessions['/a']?.items).toEqual([]);
      expect(slice.sessionModelsByPath['/a']).toEqual(MODEL);
    });

    it('顺序无关：先 initSession 再 updateSessionModel，二者各自独立', () => {
      slice.initSession('/a', [], false);
      slice.updateSessionModel('/a', MODEL);
      expect(slice.chatSessions['/a']).toBeDefined();
      expect(slice.sessionModelsByPath['/a']).toEqual(MODEL);
    });

    it('多次 updateSessionModel 覆盖之前的值', () => {
      slice.updateSessionModel('/a', MODEL);
      const newer: SessionModel = { ...MODEL, id: 'claude-sonnet-4-6' };
      slice.updateSessionModel('/a', newer);
      expect(slice.sessionModelsByPath['/a']).toEqual(newer);
    });
  });

  describe('initSession', () => {
    it('不复用 chatSessions 中已有的 model 字段（model 已独立）', () => {
      // 即使下面这行在旧代码里会从 chatSessions[path].model 复用，
      // 新代码根本不会去碰 sessionModelsByPath
      slice.initSession('/a', [], false);
      expect(slice.chatSessions['/a']).toEqual({
        items: [],
        hasMore: false,
        loadingMore: false,
        oldestId: undefined,
      });
    });

    it('LRU 淘汰只影响 chatSessions，不动 sessionModelsByPath', () => {
      // 填满 8 个，且每个都写一份模型
      for (let i = 0; i < 9; i++) {
        const p = `/s${i}`;
        slice.updateSessionModel(p, MODEL);
        slice.initSession(p, [], false);
      }
      // chatSessions 最多 8 条
      expect(Object.keys(slice.chatSessions).length).toBeLessThanOrEqual(8);
      // 模型快照全量保留
      expect(Object.keys(slice.sessionModelsByPath).length).toBe(9);
    });
  });

  describe('bumpLoadMessagesVersion', () => {
    it('第一次返回 1，后续递增', () => {
      expect(slice.bumpLoadMessagesVersion('/a')).toBe(1);
      expect(slice.bumpLoadMessagesVersion('/a')).toBe(2);
      expect(slice.bumpLoadMessagesVersion('/a')).toBe(3);
    });

    it('不同 path 的版本独立', () => {
      expect(slice.bumpLoadMessagesVersion('/a')).toBe(1);
      expect(slice.bumpLoadMessagesVersion('/b')).toBe(1);
      expect(slice.bumpLoadMessagesVersion('/a')).toBe(2);
      expect(slice._loadMessagesVersion).toEqual({ '/a': 2, '/b': 1 });
    });
  });

  describe('clearSession', () => {
    it('同时清掉 chatSessions / sessionModelsByPath / _loadMessagesVersion', () => {
      slice.updateSessionModel('/a', MODEL);
      slice.initSession('/a', [], false);
      slice.bumpLoadMessagesVersion('/a');
      slice.clearSession('/a');
      expect(slice.chatSessions['/a']).toBeUndefined();
      expect(slice.sessionModelsByPath['/a']).toBeUndefined();
      expect(slice._loadMessagesVersion['/a']).toBeUndefined();
    });

    it('只清目标 path，别的不动', () => {
      slice.updateSessionModel('/a', MODEL);
      slice.updateSessionModel('/b', MODEL);
      slice.clearSession('/a');
      expect(slice.sessionModelsByPath['/a']).toBeUndefined();
      expect(slice.sessionModelsByPath['/b']).toEqual(MODEL);
    });

    it('通知 streamBufferManager invalidate 对应 session（归属方主动清）', () => {
      const invalidator = vi.fn();
      registerStreamBufferInvalidator(invalidator);
      slice.initSession('/a', [], false);
      slice.clearSession('/a');
      expect(invalidator).toHaveBeenCalledWith('/a');
    });

    it('LRU eviction 时也 invalidate 被淘汰 session 的 streamBuffer', () => {
      const invalidator = vi.fn();
      registerStreamBufferInvalidator(invalidator);
      for (let i = 0; i < 9; i++) {
        slice.initSession(`/s${i}`, [], false);
      }
      // 第 9 次 initSession 会淘汰最老的 /s0（keys.find(k => k !== path)）
      expect(invalidator).toHaveBeenCalledWith('/s0');
    });
  });
});
