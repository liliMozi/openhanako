import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTED_IDS,
  selectIsStreamingSession,
  selectSelectedIdsBySession,
} from '../../stores/session-selectors';

describe('session-selectors', () => {
  it('缺失 session key 时返回稳定空数组引用', () => {
    const state = {
      selectedIdsBySession: {},
      streamingSessions: [],
    };

    expect(selectSelectedIdsBySession(state, '/missing')).toBe(EMPTY_SELECTED_IDS);
    expect(selectSelectedIdsBySession(state, '/missing')).toBe(EMPTY_SELECTED_IDS);
    expect(selectSelectedIdsBySession(state, '')).toBe(EMPTY_SELECTED_IDS);
  });

  it('命中 session key 时返回该 session 自己的选中列表', () => {
    const selected = ['m-1', 'm-2'];
    const state = {
      selectedIdsBySession: {
        '/panel': selected,
        '/current': ['other'],
      },
      streamingSessions: [],
    };

    expect(selectSelectedIdsBySession(state, '/panel')).toBe(selected);
  });

  it('streaming 判断只依赖显式 sessionPath', () => {
    const state = {
      selectedIdsBySession: {},
      streamingSessions: ['/panel'],
    };

    expect(selectIsStreamingSession(state, '/panel')).toBe(true);
    expect(selectIsStreamingSession(state, '/current')).toBe(false);
    expect(selectIsStreamingSession(state, '')).toBe(false);
  });
});
