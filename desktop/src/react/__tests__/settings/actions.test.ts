/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockState = Record<string, any>;

const mockState: MockState = {};

vi.mock('../../settings/store', () => ({
  useSettingsStore: {
    getState: () => mockState,
    setState: (patch: MockState | ((s: MockState) => MockState)) => {
      const next = typeof patch === 'function' ? patch(mockState) : patch;
      Object.assign(mockState, next);
    },
  },
}));

const mockFetch = vi.fn();

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mockFetch(...args),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

function jsonResponse(body: unknown) {
  return { json: async () => body } as Response;
}

function resetState() {
  Object.keys(mockState).forEach((key) => delete mockState[key]);
  Object.assign(mockState, {
    currentAgentId: 'agent-a',
    settingsAgentId: null,
    settingsConfig: null,
    globalModelsConfig: null,
    homeFolder: null,
    currentPins: [],
    set: vi.fn((patch: Record<string, unknown>) => Object.assign(mockState, patch)),
    getSettingsAgentId: () => mockState.settingsAgentId || mockState.currentAgentId,
    showToast: vi.fn(),
  });
}

function buildPayload(agentId: string, endpoint: string) {
  switch (endpoint) {
    case 'config':
      return { agent: { id: agentId, name: `${agentId}-name` }, desk: { home_folder: `/${agentId}/home` } };
    case 'identity':
      return { content: `${agentId}-identity` };
    case 'ishiki':
      return { content: `${agentId}-ishiki` };
    case 'public-ishiki':
      return { content: `${agentId}-public-ishiki` };
    case 'pinned':
      return { pins: [`${agentId}-pin`] };
    case 'experience':
      return { content: `${agentId}-experience` };
    case 'user-profile':
      return { content: 'user-profile' };
    case 'models':
      return { models: { chat: { id: `${agentId}-chat`, provider: 'openai' } } };
    default:
      throw new Error(`unexpected endpoint: ${endpoint}`);
  }
}

function parseEndpoint(path: string): { agentId: string; endpoint: string } {
  if (path === '/api/user-profile') return { agentId: 'user', endpoint: 'user-profile' };
  if (path === '/api/preferences/models') return { agentId: 'global', endpoint: 'models' };
  const match = path.match(/^\/api\/agents\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`unexpected path: ${path}`);
  return { agentId: decodeURIComponent(match[1]), endpoint: match[2] };
}

describe('settings actions', () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    resetState();
    (window as any).platform = { settingsChanged: vi.fn() };
  });

  it('旧的 loadSettingsConfig 响应晚到时，不覆盖新的 settings pane', async () => {
    const deferredA = new Map<string, (value: Response) => void>();
    mockFetch.mockImplementation((path: string) => {
      const { agentId, endpoint } = parseEndpoint(path);
      if (agentId === 'agent-a') {
        return new Promise<Response>((resolve) => {
          deferredA.set(endpoint, resolve);
        });
      }
      if (agentId === 'agent-b') {
        return Promise.resolve(jsonResponse(buildPayload(agentId, endpoint)));
      }
      if (agentId === 'user') return Promise.resolve(jsonResponse(buildPayload('user', endpoint)));
      if (agentId === 'global') return Promise.resolve(jsonResponse(buildPayload('agent-b', endpoint)));
      throw new Error(`unexpected agent: ${agentId}`);
    });

    const { loadSettingsConfig } = await import('../../settings/actions');

    mockState.settingsAgentId = 'agent-a';
    const first = loadSettingsConfig();

    mockState.settingsAgentId = 'agent-b';
    await loadSettingsConfig();

    expect(mockState.settingsConfig.agent.name).toBe('agent-b-name');
    expect(mockState.currentPins).toEqual(['agent-b-pin']);
    expect(mockState.homeFolder).toBe('/agent-b/home');

    for (const [endpoint, resolve] of deferredA.entries()) {
      resolve(jsonResponse(buildPayload('agent-a', endpoint)));
    }
    await first;

    expect(mockState.settingsConfig.agent.name).toBe('agent-b-name');
    expect(mockState.currentPins).toEqual(['agent-b-pin']);
    expect(mockState.homeFolder).toBe('/agent-b/home');
  });

  it('新请求会 abort 旧的 loadSettingsConfig，且 abort 不记成加载错误', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockImplementation((path: string, opts?: { signal?: AbortSignal }) => {
      const { agentId, endpoint } = parseEndpoint(path);
      if (agentId === 'agent-a') {
        return new Promise<Response>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            (err as Error & { name: string }).name = 'AbortError';
            reject(err);
          }, { once: true });
        });
      }
      if (agentId === 'agent-b') {
        return Promise.resolve(jsonResponse(buildPayload(agentId, endpoint)));
      }
      if (agentId === 'user') return Promise.resolve(jsonResponse(buildPayload('user', endpoint)));
      if (agentId === 'global') return Promise.resolve(jsonResponse(buildPayload('agent-b', endpoint)));
      throw new Error(`unexpected agent: ${agentId}`);
    });

    const { loadSettingsConfig } = await import('../../settings/actions');

    mockState.settingsAgentId = 'agent-a';
    const first = loadSettingsConfig();

    mockState.settingsAgentId = 'agent-b';
    await loadSettingsConfig();
    await first;

    expect(mockState.settingsConfig.agent.name).toBe('agent-b-name');
    expect(consoleSpy).not.toHaveBeenCalledWith(
      '[settings] load failed:',
      expect.objectContaining({ name: 'AbortError' }),
    );
  });
});
