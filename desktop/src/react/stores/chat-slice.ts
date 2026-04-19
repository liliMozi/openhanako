/**
 * chat-slice.ts — Per-session 消息数据 + 滚动位置
 */

import type { ChatListItem, ChatMessage, SessionMessages, SessionModel } from './chat-types';
import { invalidateSessionCache } from './selectors/file-refs';
import { invalidateStreamBuffer } from './stream-invalidator';

export interface ChatSlice {
  chatSessions: Record<string, SessionMessages>;
  /**
   * Per-session 模型快照。与 chatSessions 解耦：模型可以独立于消息状态存在，
   * 避免 updateSessionModel 在 chatSessions 里写 stub 骗过 hasData 判据（issue #405）。
   */
  sessionModelsByPath: Record<string, SessionModel>;
  /**
   * loadMessages 的 per-path 版本号，用于拒绝 stale 响应 clobber 新状态
   * （rapid switch / duplicate load 竞态护栏，pattern 来自 todosLiveVersionBySession）。
   */
  _loadMessagesVersion: Record<string, number>;
  scrollPositions: Record<string, number>;

  initSession: (path: string, items: ChatListItem[], hasMore: boolean) => void;
  prependItems: (path: string, items: ChatListItem[], hasMore: boolean) => void;
  appendItem: (path: string, item: ChatListItem) => void;
  updateLastMessage: (path: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  patchBlockByTaskId: (sessionPath: string, taskId: string, patch: Record<string, any>) => void;
  _pendingBlockPatches: Record<string, Record<string, any>>;

  updateSessionModel: (path: string, model: SessionModel) => void;
  bumpLoadMessagesVersion: (path: string) => number;
  setLoadingMore: (path: string, loading: boolean) => void;
  clearSession: (path: string) => void;
  saveScrollPosition: (path: string, scrollTop: number) => void;
}

const MAX_CACHED_SESSIONS = 8;

export const createChatSlice = (
  set: (partial: Partial<ChatSlice> | ((s: ChatSlice) => Partial<ChatSlice>)) => void,
  get: () => ChatSlice,
): ChatSlice => ({
  chatSessions: {},
  sessionModelsByPath: {},
  _loadMessagesVersion: {},
  scrollPositions: {},

  initSession: (path, items, hasMore) => set((s) => {
    const sessions = { ...s.chatSessions };
    sessions[path] = {
      items,
      hasMore,
      loadingMore: false,
      oldestId: items[0]?.type === 'message' ? items[0].data.id : undefined,
    };
    // LRU 淘汰：只淘汰消息缓存，不动模型快照（模型是轻量常驻数据）。
    // 被淘汰的 session 的 FileRef 缓存（含 inlineData base64）必须同步清，
    // 否则模块顶层的 cachedSession 会让载荷在 renderer 里滞留。
    const keys = Object.keys(sessions);
    if (keys.length > MAX_CACHED_SESSIONS) {
      const oldest = keys.find(k => k !== path);
      if (oldest) {
        delete sessions[oldest];
        invalidateSessionCache(oldest);
        invalidateStreamBuffer(oldest);
      }
    }
    return { chatSessions: sessions };
  }),

  prependItems: (path, items, hasMore) => set((s) => {
    const session = s.chatSessions[path];
    if (!session) return {};
    const merged = [...items, ...session.items];
    return {
      chatSessions: {
        ...s.chatSessions,
        [path]: {
          ...session,
          items: merged,
          hasMore,
          loadingMore: false,
          oldestId: items[0]?.type === 'message' ? items[0].data.id : session.oldestId,
        },
      },
    };
  }),

  appendItem: (path, item) => set((s) => {
    const session = s.chatSessions[path];
    if (!session) return {};
    return {
      chatSessions: {
        ...s.chatSessions,
        [path]: { ...session, items: [...session.items, item] },
      },
    };
  }),

  updateLastMessage: (path, updater) => set((s) => {
    const session = s.chatSessions[path];
    if (!session || session.items.length === 0) return {};
    const items = [...session.items];
    const lastIdx = items.length - 1;
    const last = items[lastIdx];
    if (last.type !== 'message') return {};
    items[lastIdx] = { type: 'message', data: updater(last.data) };
    return {
      chatSessions: {
        ...s.chatSessions,
        [path]: { ...session, items },
      },
    };
  }),

  // 缓存：block_update 到达时 block 可能还没添加到 store（时序竞争）
  _pendingBlockPatches: {} as Record<string, Record<string, any>>,

  patchBlockByTaskId: (sessionPath, taskId, patch) => {
    const session = get().chatSessions[sessionPath];
    if (!session) {
      // session 还没初始化，缓存 patch
      const pending = (get() as any)._pendingBlockPatches;
      pending[taskId] = { ...(pending[taskId] || {}), ...patch };
      return;
    }
    const items = [...session.items];
    let found = false;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type !== 'message' || item.data.role !== 'assistant') continue;
      const blocks = item.data.blocks;
      if (!blocks) continue;
      const blockIdx = blocks.findIndex((b: any) => b.type === 'subagent' && b.taskId === taskId);
      if (blockIdx === -1) continue;
      const newBlocks = [...blocks];
      newBlocks[blockIdx] = { ...newBlocks[blockIdx], ...patch };
      const newItems = [...items];
      newItems[i] = { ...item, data: { ...item.data, blocks: newBlocks } };
      set((s) => ({
        chatSessions: {
          ...s.chatSessions,
          [sessionPath]: { ...s.chatSessions[sessionPath], items: newItems },
        },
      }));
      found = true;
      break;
    }
    if (!found) {
      // block 还没被添加到 store，缓存 patch 等 content_block 到达后 apply
      const pending = (get() as any)._pendingBlockPatches;
      pending[taskId] = { ...(pending[taskId] || {}), ...patch };
    }
  },

  updateSessionModel: (path, model) => set((s) => ({
    // 只写 sessionModelsByPath，不碰 chatSessions。
    // chatSessions[path] 的存在性仍然是"消息状态已初始化"的单一语义。
    sessionModelsByPath: { ...s.sessionModelsByPath, [path]: model },
  })),

  bumpLoadMessagesVersion: (path) => {
    const next = ((get() as any)._loadMessagesVersion?.[path] ?? 0) + 1;
    set((s) => ({
      _loadMessagesVersion: { ...s._loadMessagesVersion, [path]: next },
    }));
    return next;
  },

  setLoadingMore: (path, loading) => set((s) => {
    const session = s.chatSessions[path];
    if (!session) return {};
    return {
      chatSessions: {
        ...s.chatSessions,
        [path]: { ...session, loadingMore: loading },
      },
    };
  }),

  clearSession: (path) => set((s) => {
    const sessions = { ...s.chatSessions };
    delete sessions[path];
    const models = { ...s.sessionModelsByPath };
    delete models[path];
    const versions = { ...s._loadMessagesVersion };
    delete versions[path];
    // FileRef 缓存和 streamBuffer 都绑定 session 生命周期，归属方主动清
    invalidateSessionCache(path);
    invalidateStreamBuffer(path);
    return { chatSessions: sessions, sessionModelsByPath: models, _loadMessagesVersion: versions };
  }),

  saveScrollPosition: (path, scrollTop) => set((s) => ({
    scrollPositions: { ...s.scrollPositions, [path]: scrollTop },
  })),
});
