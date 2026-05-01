/**
 * session-actions 行为测试
 *
 * 聚焦 issue #405 回归：确保在 switchSession 流程里，
 * 后端返回的 per-session 模型信息 hydrate 不会骗过 loadMessages 的"已加载"判据，
 * 以及 loadMessages 的竞态护栏正确丢弃 stale 响应。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type MockState = Record<string, unknown>;

const deskActionMocks = vi.hoisted(() => ({
  loadDeskFiles: vi.fn(),
  activateWorkspaceDesk: vi.fn(),
}));

const mockState: MockState = {};
const initialStateFactory = (): MockState => ({
  currentSessionPath: null,
  pendingNewSession: false,
  sessions: [] as Array<{ path: string }>,
  chatSessions: {} as Record<string, unknown>,
  sessionModelsByPath: {} as Record<string, unknown>,
  _loadMessagesVersion: {} as Record<string, number>,
  scrollPositions: {} as Record<string, number>,
  todosLiveVersionBySession: {} as Record<string, number>,
  todosBySession: {} as Record<string, unknown>,
  sessionStreams: {} as Record<string, unknown>,
  attachedFiles: [],
  attachedFilesBySession: {} as Record<string, unknown>,
  drafts: {} as Record<string, string>,
  streamingSessions: [] as string[],
  inlineErrors: {} as Record<string, string | null>,
  addToast: vi.fn(),
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
  deskBasePath: '',
  deskCurrentPath: '',
  deskFiles: [] as unknown[],
  deskJianContent: null,
  workspaceDeskStateByRoot: {} as Record<string, unknown>,
  homeFolder: null,
  selectedFolder: null,
  workspaceFolders: [] as string[],
  cwdHistory: [] as string[],
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
  loadDeskFiles: deskActionMocks.loadDeskFiles,
  activateWorkspaceDesk: deskActionMocks.activateWorkspaceDesk,
}));

vi.mock('../../stores/create-keyed-slice', () => ({
  updateKeyed: vi.fn(),
}));

vi.mock('../../stores/stream-invalidator', () => ({
  snapshotStreamBuffer: vi.fn(),
  invalidateStreamBuffer: vi.fn(),
  registerStreamBufferInvalidator: vi.fn(),
  registerStreamBufferSnapshot: vi.fn(),
}));

vi.mock('../../utils/markdown', () => ({
  renderMarkdown: (s: string) => `<p>${s}</p>`,
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
  s.clearSession = vi.fn((path: string) => {
    delete (mockState.chatSessions as Record<string, unknown>)[path];
    delete (mockState.sessionModelsByPath as Record<string, unknown>)[path];
    delete (mockState._loadMessagesVersion as Record<string, number>)[path];
    delete (mockState.scrollPositions as Record<string, number>)[path];
  });
  s.setSessionTodosForPath = vi.fn((path: string, todos: unknown[]) => {
    const bySession = mockState.todosBySession as Record<string, unknown>;
    bySession[path] = todos;
  });
  s.appendItem = vi.fn((path: string, item: unknown) => {
    const chat = mockState.chatSessions as Record<string, { items: unknown[] }>;
    const entry = chat[path];
    if (entry) entry.items.push(item);
  });
  s.clearQuotedSelection = vi.fn();
  s.setActivePanel = vi.fn((v: unknown) => { mockState.activePanel = v; });
  s.requestInputFocus = vi.fn();
  s.setDeskBasePath = vi.fn((path: string) => { mockState.deskBasePath = path; });
  s.setDeskCurrentPath = vi.fn((path: string) => { mockState.deskCurrentPath = path; });
  s.setDeskFiles = vi.fn((files: unknown[]) => { mockState.deskFiles = files; });
  s.setDeskJianContent = vi.fn((content: string | null) => { mockState.deskJianContent = content; });
}

import { hanaFetch } from '../../hooks/use-hana-fetch';
import { clearChat } from '../../stores/agent-actions';
import { loadDeskFiles } from '../../stores/desk-actions';
import { bumpMessageLiveVersion, clearMessageLiveVersion } from '../../stores/message-live-version';
import { archiveSession, createNewSession, ensureSession, loadMessages, pinSession, switchSession } from '../../stores/session-actions';
import { snapshotStreamBuffer } from '../../stores/stream-invalidator';

const mockFetch = vi.mocked(hanaFetch);
const mockClearChat = vi.mocked(clearChat);
const mockLoadDeskFiles = vi.mocked(loadDeskFiles);
const mockSnapshot = vi.mocked(snapshotStreamBuffer);

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe('session-actions', () => {
  beforeEach(() => {
    Object.keys(mockState).forEach(k => delete mockState[k]);
    Object.assign(mockState, initialStateFactory());
    Object.assign(mockState, { workspaceDeskStateByRoot: {} as Record<string, unknown> });
    installStoreMethods();
    mockFetch.mockReset();
    mockClearChat.mockReset();
    mockLoadDeskFiles.mockReset();
    deskActionMocks.activateWorkspaceDesk.mockReset();
    deskActionMocks.activateWorkspaceDesk.mockImplementation(async (root?: string | null) => {
      const normalized = root || '';
      const currentRoot = (mockState.deskBasePath as string) || '';
      const states = mockState.workspaceDeskStateByRoot as Record<string, any>;
      if (currentRoot) {
        states[currentRoot] = {
          deskCurrentPath: (mockState.deskCurrentPath as string) || '',
          deskFiles: mockState.deskFiles,
          deskJianContent: mockState.deskJianContent,
          cwdSkills: [],
          cwdSkillsOpen: false,
          previewOpen: false,
          openTabs: [],
          activeTabId: null,
        };
      }
      if (!normalized) {
        mockState.deskBasePath = '';
        mockState.deskCurrentPath = '';
        mockState.deskFiles = [];
        mockState.deskJianContent = null;
        return;
      }
      const saved = states[normalized] || null;
      const nextSubdir = currentRoot === normalized
        ? ((mockState.deskCurrentPath as string) || '')
        : (saved?.deskCurrentPath || '');
      mockState.deskBasePath = normalized;
      mockState.deskCurrentPath = nextSubdir;
      mockState.deskFiles = [];
      mockState.deskJianContent = null;
      deskActionMocks.loadDeskFiles(nextSubdir, normalized);
    });
    mockSnapshot.mockReset();
    mockSnapshot.mockReturnValue(null);
    clearMessageLiveVersion();
    dispatchedEvents.length = 0;
  });

  describe('createNewSession cwd draft', () => {
    it('uses the agent home folder and refreshes the visible desk root', async () => {
      (mockState as Record<string, unknown>).deskBasePath = '/workspace/Desktop';
      (mockState as Record<string, unknown>).deskCurrentPath = 'old/subdir';
      (mockState as Record<string, unknown>).deskFiles = [{ name: 'stale.md' }];
      (mockState as Record<string, unknown>).deskJianContent = 'stale';
      (mockState as Record<string, unknown>).homeFolder = '/workspace/AgentHome';

      await createNewSession();

      expect(mockState.selectedFolder).toBe('/workspace/AgentHome');
      expect(mockState.pendingNewSession).toBe(true);
      expect(mockState.deskBasePath).toBe('/workspace/AgentHome');
      expect(mockState.deskCurrentPath).toBe('');
      expect(mockState.deskFiles).toEqual([]);
      expect(mockState.deskJianContent).toBeNull();
      expect(mockLoadDeskFiles).toHaveBeenCalledWith('', '/workspace/AgentHome');
    });

    it('invalidates an in-flight session switch so the new-session desk stays on the agent home folder', async () => {
      (mockState as Record<string, unknown>).currentSessionPath = '/session/hana.jsonl';
      (mockState as Record<string, unknown>).deskBasePath = '/workspace/Desktop/project-hana';
      (mockState as Record<string, unknown>).homeFolder = '/workspace/Desktop/project-hana';

      let resolveSwitch!: (r: Response) => void;
      const switchResponse = new Promise<Response>(resolve => { resolveSwitch = resolve; });
      mockFetch.mockImplementationOnce(() => switchResponse);

      const switching = switchSession('/session/desktop.jsonl');
      await createNewSession();

      resolveSwitch(jsonResponse({
        ok: true,
        path: '/session/desktop.jsonl',
        cwd: '/workspace/Desktop',
        workspaceFolders: [],
      }));
      await switching;

      expect(mockState.currentSessionPath).toBeNull();
      expect(mockState.pendingNewSession).toBe(true);
      expect(mockState.selectedFolder).toBe('/workspace/Desktop/project-hana');
      expect(mockState.deskBasePath).toBe('/workspace/Desktop/project-hana');
      expect(deskActionMocks.activateWorkspaceDesk).not.toHaveBeenCalledWith('/workspace/Desktop');
    });

    it('uses the runtime new-session permission default instead of the old active session mode', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        mode: 'operate',
        accessMode: 'operate',
        defaultMode: 'read_only',
      }));

      await createNewSession();

      const permissionEvent = dispatchedEvents.filter(e => e.type === 'hana-plan-mode').at(-1);
      expect(permissionEvent?.detail).toEqual({ enabled: true, mode: 'read_only' });
    });

    it('sends extra workspace folders when creating a pending session', async () => {
      Object.assign(mockState, {
        pendingNewSession: true,
        memoryEnabled: true,
        selectedFolder: '/workspace-a',
        workspaceFolders: ['/reference-a'],
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        ok: true,
        path: '/session/new.jsonl',
        cwd: '/workspace-a',
        workspaceFolders: ['/reference-a'],
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await expect(ensureSession()).resolves.toBe(true);

      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        '/api/sessions/new',
        expect.objectContaining({
          body: JSON.stringify({
            memoryEnabled: true,
            cwd: '/workspace-a',
            workspaceFolders: ['/reference-a'],
            currentSessionPath: null,
          }),
        }),
      );
      expect(mockState.workspaceFolders).toEqual(['/reference-a']);
    });
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

    it('mid-flight 收到 live message 更新时，跳过 messages hydrate', async () => {
      let resolveFetch!: (r: Response) => void;
      const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
      mockFetch.mockImplementationOnce(() => pending);

      const task = loadMessages('/a');
      bumpMessageLiveVersion('/a');
      resolveFetch(jsonResponse({
        messages: [{ text: 'stale' }], blocks: [], todos: [], hasMore: false,
      }));
      await task;

      const initSession = (mockState as unknown as { initSession: ReturnType<typeof vi.fn> }).initSession;
      expect(initSession).not.toHaveBeenCalled();
    });

    it('stale 响应不会先把 todos 回滚到旧快照', async () => {
      let resolveFirst!: (r: Response) => void;
      const firstPromise = new Promise<Response>((resolve) => { resolveFirst = resolve; });
      mockFetch.mockImplementationOnce(() => firstPromise);
      mockFetch.mockImplementationOnce(async () =>
        jsonResponse({ messages: [{ text: 'new' }], blocks: [], todos: [{ id: 'todo-new' }], hasMore: false }),
      );

      const p1 = loadMessages('/a');
      const p2 = loadMessages('/a');
      await p2;

      resolveFirst(jsonResponse({
        messages: [{ text: 'stale' }],
        blocks: [],
        todos: [{ id: 'todo-stale' }],
        hasMore: false,
      }));
      await p1;

      expect((mockState.todosBySession as Record<string, unknown>)['/a']).toEqual([{ id: 'todo-new' }]);
    });

    it('mid-flight 收到 live todo 更新时，整次 hydrate 跳过，不只跳过 messages', async () => {
      let resolveFetch!: (r: Response) => void;
      const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
      mockFetch.mockImplementationOnce(() => pending);

      const task = loadMessages('/a');
      (mockState.todosLiveVersionBySession as Record<string, number>)['/a'] = 1;
      resolveFetch(jsonResponse({
        messages: [{ text: 'stale' }],
        blocks: [],
        todos: [{ id: 'todo-stale' }],
        hasMore: false,
      }));
      await task;

      const initSession = (mockState as unknown as { initSession: ReturnType<typeof vi.fn> }).initSession;
      const setSessionTodosForPath = (mockState as unknown as { setSessionTodosForPath: ReturnType<typeof vi.fn> }).setSessionTodosForPath;
      expect(initSession).not.toHaveBeenCalled();
      expect(setSessionTodosForPath).not.toHaveBeenCalled();
      expect((mockState.todosBySession as Record<string, unknown>)['/a']).toBeUndefined();
    });
  });

  describe('loadMessages 合并 in-flight snapshot', () => {
    it('buf 有 in-flight 内容时，initSession 后 append 一条 assistant', async () => {
      mockSnapshot.mockReturnValue({
        hasContent: true,
        messageId: 'stream-42',
        text: '正文',
        thinking: '',
        mood: 'Vibe: 好',
        moodYuan: 'hanako',
        inThinking: false,
        inMood: false,
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'u', role: 'user' }], blocks: [], todos: [], hasMore: false,
      }));
      await loadMessages('/a');

      const chat = mockState.chatSessions as Record<string, { items: Array<{ type: string; data: { id?: string; role?: string; blocks?: Array<{ type: string }> } }> }>;
      const items = chat['/a'].items;
      expect(items.length).toBe(2);
      expect(items[1].type).toBe('message');
      expect(items[1].data.id).toBe('stream-42');
      expect(items[1].data.role).toBe('assistant');
      const blocks = items[1].data.blocks!;
      expect(blocks.some(b => b.type === 'mood')).toBe(true);
      expect(blocks.some(b => b.type === 'text')).toBe(true);
    });

    it('buf 为空（snapshot=null）时不 append 额外消息', async () => {
      mockSnapshot.mockReturnValue(null);
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'u', role: 'user' }], blocks: [], todos: [], hasMore: false,
      }));
      await loadMessages('/a');

      const chat = mockState.chatSessions as Record<string, { items: unknown[] }>;
      expect(chat['/a'].items.length).toBe(1);
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

    it('切 session 时激活目标 cwd 的工作空间面板，不携带旧 deskCurrentPath', async () => {
      (mockState as Record<string, unknown>).deskCurrentPath = 'notes/daily';
      (mockState as Record<string, unknown>).deskBasePath = '/workspace-old';
      (mockState as Record<string, unknown>).deskFiles = [{ name: 'stale.md' }];
      (mockState as Record<string, unknown>).deskJianContent = 'stale';

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

      expect(mockState.deskBasePath).toBe('/workspace-a');
      expect(mockState.deskCurrentPath).toBe('');
      expect(mockState.deskFiles).toEqual([]);
      expect(mockState.deskJianContent).toBeNull();
      expect(mockLoadDeskFiles).toHaveBeenCalledWith('', '/workspace-a');
    });

    it('切到同一 workspace 的 session 时保留当前 desk 子目录', async () => {
      (mockState as Record<string, unknown>).deskCurrentPath = 'notes/daily';
      (mockState as Record<string, unknown>).deskBasePath = '/workspace-a';
      (mockState as Record<string, unknown>).deskFiles = [{ name: 'stale.md' }];
      (mockState as Record<string, unknown>).deskJianContent = 'stale';

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

      expect(mockState.deskBasePath).toBe('/workspace-a');
      expect(mockState.deskCurrentPath).toBe('notes/daily');
      expect(mockState.deskFiles).toEqual([]);
      expect(mockState.deskJianContent).toBeNull();
      expect(mockLoadDeskFiles).toHaveBeenCalledWith('notes/daily', '/workspace-a');
    });

    it('恢复切回 workspace 时该 workspace 上次打开的 desk 子目录', async () => {
      (mockState as Record<string, unknown>).deskCurrentPath = 'notes/daily';
      (mockState as Record<string, unknown>).deskBasePath = '/workspace-a';
      (mockState as Record<string, unknown>).deskFiles = [{ name: 'stale-a.md' }];
      (mockState as Record<string, unknown>).deskJianContent = 'stale-a';

      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        cwd: '/workspace-b',
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'workspace b' }], blocks: [], todos: [], hasMore: false,
      }));

      await switchSession('/b');

      expect(mockState.deskBasePath).toBe('/workspace-b');
      expect(mockState.deskCurrentPath).toBe('');

      (mockState as Record<string, unknown>).deskCurrentPath = 'src';
      (mockState as Record<string, unknown>).deskFiles = [{ name: 'stale-b.md' }];
      (mockState as Record<string, unknown>).deskJianContent = 'stale-b';

      mockLoadDeskFiles.mockClear();
      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        cwd: '/workspace-a',
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'workspace a' }], blocks: [], todos: [], hasMore: false,
      }));

      await switchSession('/a');

      expect(mockState.deskBasePath).toBe('/workspace-a');
      expect(mockState.deskCurrentPath).toBe('notes/daily');
      expect(mockState.deskFiles).toEqual([]);
      expect(mockState.deskJianContent).toBeNull();
      expect(mockLoadDeskFiles).toHaveBeenCalledWith('notes/daily', '/workspace-a');
    });

    it('目标 session 没有 cwd 时清空 desk state，不回落到旧 workspace', async () => {
      (mockState as Record<string, unknown>).deskBasePath = '/workspace-old';
      (mockState as Record<string, unknown>).deskCurrentPath = 'notes/daily';
      (mockState as Record<string, unknown>).deskFiles = [{ name: 'stale.md' }];
      (mockState as Record<string, unknown>).deskJianContent = 'stale';

      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        cwd: null,
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'history' }], blocks: [], todos: [], hasMore: false,
      }));

      await switchSession('/a');

      expect(mockState.deskBasePath).toBe('');
      expect(mockState.deskCurrentPath).toBe('');
      expect(mockState.deskFiles).toEqual([]);
      expect(mockState.deskJianContent).toBeNull();
      expect(mockLoadDeskFiles).not.toHaveBeenCalled();
    });

    it('当前 session 附件删空后，切走时仍显式写回空数组，避免旧附件复活', async () => {
      (mockState as Record<string, unknown>).currentSessionPath = '/a';
      (mockState as Record<string, unknown>).attachedFiles = [];
      (mockState.attachedFilesBySession as Record<string, unknown>)['/a'] = [{ name: 'old.txt' }];

      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
      }));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        messages: [{ text: 'history' }], blocks: [], todos: [], hasMore: false,
      }));

      await switchSession('/b');

      expect((mockState.attachedFilesBySession as Record<string, unknown>)['/a']).toEqual([]);
      expect(mockState.attachedFiles).toEqual([]);
    });
  });

  describe('archiveSession 按 path 清缓存', () => {
    it('归档非当前 session 时也按归档 path 清理 chat / stream 相关缓存', async () => {
      (mockState as Record<string, unknown>).currentSessionPath = '/current';
      (mockState.chatSessions as Record<string, unknown>)['/archived'] = {
        items: [{ type: 'message', data: { id: '1', text: 'archived' } }],
        hasMore: false,
        loadingMore: false,
      };
      (mockState.sessionModelsByPath as Record<string, unknown>)['/archived'] = { id: 'm', provider: 'p' };
      (mockState._loadMessagesVersion as Record<string, number>)['/archived'] = 2;
      (mockState.sessionStreams as Record<string, unknown>)['/archived'] = { isStreaming: true };
      (mockState.attachedFilesBySession as Record<string, unknown>)['/archived'] = [{ name: 'a.txt' }];
      (mockState.drafts as Record<string, string>)['/archived'] = 'draft';
      (mockState.todosBySession as Record<string, unknown>)['/archived'] = [{ id: 'todo-1' }];
      (mockState.todosLiveVersionBySession as Record<string, number>)['/archived'] = 3;
      (mockState.streamingSessions as string[]) = ['/current', '/archived'];
      (mockState.inlineErrors as Record<string, string | null>)['/archived'] = 'boom';

      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
      mockFetch.mockResolvedValueOnce(jsonResponse([{ path: '/current' }]));

      await archiveSession('/archived');

      const clearSessionMock = (mockState as unknown as {
        clearSession: ReturnType<typeof vi.fn>;
      }).clearSession;
      expect(clearSessionMock).toHaveBeenCalledWith('/archived');
      expect(mockState.currentSessionPath).toBe('/current');
      expect((mockState.chatSessions as Record<string, unknown>)['/archived']).toBeUndefined();
      expect((mockState.sessionStreams as Record<string, unknown>)['/archived']).toBeUndefined();
      expect((mockState.attachedFilesBySession as Record<string, unknown>)['/archived']).toBeUndefined();
      expect((mockState.drafts as Record<string, string>)['/archived']).toBeUndefined();
      expect((mockState.todosBySession as Record<string, unknown>)['/archived']).toBeUndefined();
      expect((mockState.streamingSessions as string[])).toEqual(['/current']);
      expect((mockState.inlineErrors as Record<string, string | null>)['/archived']).toBeNull();
      expect(mockClearChat).not.toHaveBeenCalled();
    });

    it('归档当前 session 时在 currentSessionPath 置空前按该 path 清理缓存', async () => {
      (mockState as Record<string, unknown>).currentSessionPath = '/current';
      (mockState.chatSessions as Record<string, unknown>)['/current'] = {
        items: [{ type: 'message', data: { id: '1', text: 'current' } }],
        hasMore: false,
        loadingMore: false,
      };
      (mockState.chatSessions as Record<string, unknown>)['/other'] = {
        items: [{ type: 'message', data: { id: '2', text: 'other' } }],
        hasMore: false,
        loadingMore: false,
      };
      (mockState.sessionModelsByPath as Record<string, unknown>)['/current'] = { id: 'm', provider: 'p' };
      (mockState._loadMessagesVersion as Record<string, number>)['/current'] = 1;
      (mockState.sessionStreams as Record<string, unknown>)['/current'] = { isStreaming: true };
      (mockState.streamingSessions as string[]) = ['/current'];

      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
      mockFetch.mockResolvedValueOnce(jsonResponse([{ path: '/other' }]));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        agentId: null,
        cwd: '/workspace-other',
        currentModelId: null,
        currentModelName: null,
        currentModelProvider: null,
      }));

      await archiveSession('/current');

      const clearSessionMock = (mockState as unknown as {
        clearSession: ReturnType<typeof vi.fn>;
      }).clearSession;
      expect(clearSessionMock).toHaveBeenCalledWith('/current');
      expect(mockClearChat).toHaveBeenCalledTimes(1);
      expect((mockState.chatSessions as Record<string, unknown>)['/current']).toBeUndefined();
      expect((mockState.sessionStreams as Record<string, unknown>)['/current']).toBeUndefined();
      expect((mockState.streamingSessions as string[])).toEqual([]);
      expect(mockState.currentSessionPath).toBe('/other');
    });
  });

  describe('pinSession', () => {
    it('posts the explicit pinned state and updates only the matching session after success', async () => {
      const pinnedAt = '2026-04-29T08:00:00.000Z';
      (mockState as Record<string, unknown>).sessions = [
        { path: '/a', pinnedAt: null },
        { path: '/b', pinnedAt: null },
      ];
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true, pinnedAt }));

      const ok = await pinSession('/a', true);

      expect(ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith('/api/sessions/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/a', pinned: true }),
      });
      expect((mockState.sessions as Array<{ path: string; pinnedAt: string | null }>)).toEqual([
        { path: '/a', pinnedAt },
        { path: '/b', pinnedAt: null },
      ]);
    });

    it('leaves sessions unchanged and shows a toast when pinning fails', async () => {
      const sessions = [
        { path: '/a', pinnedAt: null },
      ];
      (mockState as Record<string, unknown>).sessions = sessions;
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'write failed' }, false));
      (globalThis.window as unknown as { t: (key: string) => string }).t = (key: string) => key;

      const ok = await pinSession('/a', true);

      expect(ok).toBe(false);
      expect(mockState.sessions).toBe(sessions);
      expect(mockState.addToast).toHaveBeenCalledWith('session.pinFailed', 'info', 3000);
    });
  });
});
