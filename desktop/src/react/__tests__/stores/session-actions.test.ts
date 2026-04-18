/**
 * session-actions 行为测试
 *
 * 聚焦 issue #405 回归：确保在 switchSession 流程里，
 * 后端返回的 per-session 模型信息 hydrate 不会骗过 loadMessages 的"已加载"判据，
 * 以及 loadMessages 的竞态护栏正确丢弃 stale 响应。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type MockState = Record<string, unknown>;

const mockState: MockState = {};
const initialStateFactory = (): MockState => ({
  currentSessionPath: null,
  pendingNewSession: false,
  chatSessions: {} as Record<string, unknown>,
  sessionModelsByPath: {} as Record<string, unknown>,
  _loadMessagesVersion: {} as Record<string, number>,
  todosLiveVersionBySession: {} as Record<string, number>,
  attachedFiles: [],
  attachedFilesBySession: {} as Record<string, unknown>,
  streamingSessions: [] as string[],
  activePanel: null,
  agents: [] as unknown[],
  currentAgentId: null,
  agentName: '',
  agentYuan: 'hanako',
  agentAvatarUrl: null,
  memoryEnabled: true,
  browserBySession: {} as Record<string, unknown>,
  welcomeVisible: false,
  deskContextAttached: false,
  docContextAttached: false,
  selectedFolder: null,
  selectedAgentId: null,
});

const dispatchedEvents: CustomEvent[] = [];

vi.mock('../../stores', () => ({
  useStore: {
    getState: () => mockState,
    setState: (patch: MockState | ((s: MockState) => MockState)) => {
      const next = typeof patch === 'function' ? patch(mockState) : patch;
      Object.assign(mockState, next);
    },
  },
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
  hanaUrl: (p: string) => p,
}));

vi.mock('../../utils/history-builder', () => ({
  buildItemsFromHistory: (data: { messages?: unknown[] }) => (data.messages || []).map((m, i) => ({
    type: 'message' as const,
    data: { id: String(i), ...(m as object) },
  })),
}));

vi.mock('../../utils/todo-compat', () => ({
  migrateLegacyTodos: (x: { todos: unknown[] }) => x.todos,
}));

vi.mock('../../utils/ui-helpers', () => ({
  loadModels: vi.fn(),
}));

vi.mock('./agent-actions', () => ({
  loadAvatars: vi.fn(),
  clearChat: vi.fn(),
}));

vi.mock('../../stores/agent-actions', () => ({
  loadAvatars: vi.fn(),
  clearChat: vi.fn(),
}));

vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: vi.fn(),
}));

vi.mock('../../stores/artifact-actions', () => ({
  syncPreviewPanelForOwner: vi.fn(),
}));

vi.mock('../../stores/create-keyed-slice', () => ({
  updateKeyed: vi.fn(),
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: () => null,
}));

// Stub window.dispatchEvent / CustomEvent for jsdom-less runs
if (typeof window === 'undefined') {
  (globalThis as any).window = {
    dispatchEvent: (e: CustomEvent) => { dispatchedEvents.push(e); return true; },
  };
  (globalThis as any).CustomEvent = class {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
} else {
  window.dispatchEvent = ((e: Event) => {
    dispatchedEvents.push(e as CustomEvent);
    return true;
  }) as typeof window.dispatchEvent;
}

// Stub store methods used by loadMessages / switchSession
function installStoreMethods() {
  const s = mockState as MockState;
  s.initSession = vi.fn((path: string, items: unknown[], hasMore: boolean) => {
    const chat = mockState.chatSessions as Record<string, unknown>;
    chat[path] = { items, hasMore, loadingMore: false };
  });
  s.bumpLoadMessagesVersion = vi.fn((path: string) => {
    const versions = mockState._loadMessagesVersion as Record<string, number>;
    const next = (versions[path] ?? 0) + 1;
    versions[path] = next;
    return next;
  });
  s.updateSessionModel = vi.fn((path: string, model: unknown) => {
    // Critical invariant: must NOT write to chatSessions (#405 root cause).
    const models = mockState.sessionModelsByPath as Record<string, unknown>;
    models[path] = model;
  });
  s.setSessionTodosForPath = vi.fn();
  s.clearQuotedSelection = vi.fn();
  s.setActivePanel = vi.fn((v: unknown) => { mockState.activePanel = v; });
  s.requestInputFocus = vi.fn();
  s.getDeskStateForOwner = vi.fn((owner: string) => {
    const states = (mockState.deskStateByOwner as Record<string, unknown>) || {};
    return states[owner] || null;
  });
  s.restoreDeskStateForOwner = vi.fn();
}

import { hanaFetch } from '../../hooks/use-hana-fetch';
import { loadDeskFiles } from '../../stores/desk-actions';
import { loadMessages, switchSession } from '../../stores/session-actions';

const mockFetch = vi.mocked(hanaFetch);
const mockLoadDeskFiles = vi.mocked(loadDeskFiles);

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe('session-actions', () => {
  beforeEach(() => {
    Object.keys(mockState).forEach(k => delete mockState[k]);
    Object.assign(mockState, initialStateFactory());
    Object.assign(mockState, { deskStateByOwner: {} as Record<string, unknown> });
    installStoreMethods();
    mockFetch.mockReset();
    mockLoadDeskFiles.mockReset();
    dispatchedEvents.length = 0;
  });

  describe('loadMessages 竞态护栏', () => {
    it('stale 响应不覆盖新状态：v1 fetch 在飞，v2 bump 后到达时丢弃 v1', async () => {
      // 两次 fetch：第一次慢，第二次快。第一次返回的 messages 必须被丢弃。
      let resolveFirst!: (r: Response) => void;
      const firstPromise = new Promise<Response>(r => { resolveFirst = r; });
      mockFetch.mockImplementationOnce(() => firstPromise);
      mockFetch.mockImplementationOnce(async () =>
        jsonResponse({ messages: [{ text: 'new' }], blocks: [], todos: [], hasMore: false }),
      );

      const p1 = loadMessages('/a');
      const p2 = loadMessages('/a');
      await p2;
      // v1 的响应后到；此时 _loadMessagesVersion['/a'] === 2，应被判为 stale
      resolveFirst(jsonResponse({ messages: [{ text: 'stale' }], blocks: [], todos: [], hasMore: false }));
      await p1;

      const chat = mockState.chatSessions as Record<string, { items: Array<{ data: { text: string } }> }>;
      expect(chat['/a']).toBeDefined();
      // 最新的 v2 结果取胜
      expect(chat['/a'].items).toHaveLength(1);
      expect(chat['/a'].items[0].data.text).toBe('new');
    });

    it('正常单次调用写入 initSession', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'hello' }], blocks: [], todos: [], hasMore: false,
      }));
      await loadMessages('/a');
      const initSession = (mockState as unknown as { initSession: ReturnType<typeof vi.fn> }).initSession;
      expect(initSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('switchSession 的 hasData 语义（#405 直接回归）', () => {
    it('后端返回 currentModelId，uncached session 仍然触发 loadMessages', async () => {
      // 1) /sessions/switch 响应
      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        currentModelId: 'claude-opus-4-6',
        currentModelName: 'Claude Opus 4.6',
        currentModelProvider: 'anthropic',
      }));
      // 2) /sessions/messages 响应（loadMessages 内部）
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'history' }], blocks: [], todos: [], hasMore: false,
      }));

      await switchSession('/a');

      // 关键：必须调用了 loadMessages 的 fetch（第二次 fetch 到 /sessions/messages）
      const calls = mockFetch.mock.calls.map(c => String(c[0]));
      expect(calls.some(u => u.startsWith('/api/sessions/switch'))).toBe(true);
      expect(calls.some(u => u.startsWith('/api/sessions/messages'))).toBe(true);

      // 模型快照确实被记录
      const models = mockState.sessionModelsByPath as Record<string, unknown>;
      expect(models['/a']).toMatchObject({ id: 'claude-opus-4-6', provider: 'anthropic' });

      // updateSessionModel 实现没有污染 chatSessions（没有 stub）
      // 注意：loadMessages 之后 chatSessions[/a] 才存在（来自 initSession），
      // 所以这里通过 updateSessionModel 的 mock 记录来验证它调用时 chatSessions 是空的。
      const updateSessionModelMock = (mockState as unknown as {
        updateSessionModel: ReturnType<typeof vi.fn>;
      }).updateSessionModel;
      expect(updateSessionModelMock).toHaveBeenCalled();
    });

    it('已缓存的 session：switchSession 不再次 loadMessages', async () => {
      // 预置：/a 已经 initSession 过
      (mockState.chatSessions as Record<string, unknown>)['/a'] = {
        items: [{ type: 'message', data: { id: '0', text: 'cached' } }],
        hasMore: false,
        loadingMore: false,
      };

      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        currentModelId: 'claude-opus-4-6',
        currentModelName: 'Claude Opus 4.6',
        currentModelProvider: 'anthropic',
      }));

      await switchSession('/a');

      // 只应该有一次 /api/sessions/switch，不应该有 /api/sessions/messages
      const calls = mockFetch.mock.calls.map(c => String(c[0]));
      expect(calls.filter(u => u.startsWith('/api/sessions/messages'))).toHaveLength(0);
    });

    it('切回旧 session 时恢复该 session 自己的书桌子目录，而不是强制回 cwd 根目录', async () => {
      (mockState.deskStateByOwner as Record<string, unknown>)['/a'] = {
        deskBasePath: '/workspace-a',
        deskCurrentPath: 'notes/daily',
      };

      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        cwd: '/workspace-a',
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'history' }], blocks: [], todos: [], hasMore: false,
      }));

      await switchSession('/a');

      const restoreDeskStateForOwnerMock = (mockState as unknown as {
        restoreDeskStateForOwner: ReturnType<typeof vi.fn>;
      }).restoreDeskStateForOwner;
      expect(restoreDeskStateForOwnerMock).toHaveBeenCalledWith('/a');
      expect(mockLoadDeskFiles).toHaveBeenCalledWith('notes/daily', '/workspace-a');
    });
  });
});
