/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useStore } from '../../stores/index';
import { DeskSkillsSection } from '../../components/desk/DeskSkillsSection';

const fetchMock = vi.fn();
vi.mock('../../hooks/use-hana-fetch', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/use-hana-fetch')>('../../hooks/use-hana-fetch');
  return {
    ...actual,
    hanaFetch: (...args: unknown[]) => fetchMock(...args),
  };
});

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

function defer<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve: resolve! };
}

beforeEach(() => {
  fetchMock.mockReset();

  // jsdom 的 localStorage 在我们这套 vitest 配置里不可用，补一个最小 mock
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    },
  });

  useStore.setState({
    currentAgentId: 'agent-a',
    currentSessionPath: '/session/a',
    deskSkills: [],
    deskStateByOwner: {},
  } as never);
});

afterEach(() => {
  cleanup();
});

describe('DeskSkillsSection fetch race guard', () => {
  it('fetch 期间用户切换了 session，就不把旧 agent 的结果写进新 owner', async () => {
    const pending = defer<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);

    render(<DeskSkillsSection />);

    // 用户在 fetch 返回前切了 session（同时 agent 也变了，真实 switchSession 会同时改两个）
    act(() => {
      useStore.setState({
        currentAgentId: 'agent-b',
        currentSessionPath: '/session/b',
      } as never);
    });

    // 模拟旧 agent 的 fetch 现在才返回
    await act(async () => {
      pending.resolve(jsonResponse({
        skills: [
          { name: 'stale-from-agent-a', enabled: true, hidden: false, source: 'external', managedBy: null },
        ],
      }));
      // 让 .then 链跑完
      await Promise.resolve();
      await Promise.resolve();
    });

    // 旧结果不能写进新 session 的 owner
    expect(useStore.getState().deskSkills).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'stale-from-agent-a' })]),
    );
  });

  it('session 没变时正常写入 deskSkills', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      skills: [
        { name: 'live-skill', enabled: true, hidden: false, source: 'external', managedBy: null },
      ],
    }));

    render(<DeskSkillsSection />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useStore.getState().deskSkills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'live-skill', enabled: true })]),
    );
  });
});
