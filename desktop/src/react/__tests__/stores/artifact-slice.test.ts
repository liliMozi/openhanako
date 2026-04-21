/**
 * artifact-slice + artifact-actions 行为测试
 *
 * 用真实的 Zustand store 测试 owner-keyed 预览状态的隔离性。
 * 覆盖三个回归点：
 *   1. Desk 模式（currentSessionPath = null）双击文件能正常显示
 *   2. Session A 的 preview 不出现在 Session B
 *   3. Session preview 不泄漏到 Desk，Desk preview 不泄漏回 Session
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createArtifactSlice, type ArtifactSlice, DESK_OWNER, getPreviewOwner, getOwnerState, selectArtifacts, selectOpenTabs, selectActiveTabId } from '../../stores/artifact-slice';
import {
  upsertArtifactForOwner,
  openTabForOwner,
  closeTabForOwner,
  setActiveTabForOwner,
  clearOwnerPreview,
  openPreview,
  closePreview,
  handleArtifact,
  syncPreviewPanelForOwner,
} from '../../stores/artifact-actions';
import type { Artifact } from '../../types';

// ── Minimal store mock ──
// artifact-actions 操作 useStore.getState() / useStore.setState()。
// 我们用 real slice + thin wrapper 来模拟完整 store 行为。

function createTestStore() {
  let state: Record<string, unknown> = {};

  const set = (partial: unknown) => {
    const patch = typeof partial === 'function' ? (partial as (s: Record<string, unknown>) => Record<string, unknown>)(state) : partial;
    state = { ...state, ...(patch as Record<string, unknown>) };
  };

  // 初始化 artifact slice
  const artifactSlice = createArtifactSlice(set as any);
  state = {
    ...artifactSlice,
    currentSessionPath: null,
    previewOpen: false,
    setPreviewOpen: (open: boolean) => set({ previewOpen: open }),
    quotedSelection: null,
    clearQuotedSelection: () => set({ quotedSelection: null }),
  };

  return {
    getState: () => state as any,
    setState: set as any,
  };
}

// 由于 artifact-actions 直接 import useStore，我们需要 mock 整个 stores/index 模块
// 指向我们的 test store。
let testStore: ReturnType<typeof createTestStore>;

vi.mock('../../stores/index', () => ({
  get useStore() {
    return Object.assign(
      // useStore 本身作为 hook 的签名（selector 参数），测试中不用
      (selector?: (s: any) => any) => selector ? selector(testStore.getState()) : testStore.getState(),
      {
        getState: () => testStore.getState(),
        setState: (partial: unknown) => testStore.setState(partial),
      },
    );
  },
}));

// Mock updateLayout (imported by artifact-actions)
vi.mock('../../components/SidebarLayout', () => ({
  updateLayout: () => {},
}));

// ── Helpers ──

function makeArtifact(id: string, title?: string): Artifact {
  return { id, type: 'code', title: title ?? id, content: `content-${id}` };
}

function stateWithSession(sessionPath: string | null) {
  return { ...testStore.getState(), currentSessionPath: sessionPath };
}

// ── Tests ──

describe('owner-keyed preview state', () => {
  beforeEach(() => {
    testStore = createTestStore();
  });

  // ─── 基础 tab 操作 ───

  describe('tab 操作（单 owner）', () => {
    const OWNER = 'session:/test/a';

    it('openTab 新增 tab 并激活', () => {
      openTabForOwner(OWNER, 'a1');
      const os = getOwnerState(testStore.getState(), OWNER);
      expect(os.openTabs).toEqual(['a1']);
      expect(os.activeTabId).toBe('a1');
    });

    it('openTab 已存在的 id 只切换激活，不重复添加', () => {
      openTabForOwner(OWNER, 'a1');
      openTabForOwner(OWNER, 'a2');
      openTabForOwner(OWNER, 'a1');
      const os = getOwnerState(testStore.getState(), OWNER);
      expect(os.openTabs).toEqual(['a1', 'a2']);
      expect(os.activeTabId).toBe('a1');
    });

    it('closeTab 移除 tab，激活前一个', () => {
      openTabForOwner(OWNER, 'a1');
      openTabForOwner(OWNER, 'a2');
      openTabForOwner(OWNER, 'a3');
      setActiveTabForOwner(OWNER, 'a2');
      closeTabForOwner(OWNER, 'a2');
      const os = getOwnerState(testStore.getState(), OWNER);
      expect(os.openTabs).toEqual(['a1', 'a3']);
      expect(os.activeTabId).toBe('a1');
    });

    it('closeTab 移除最后一个 tab，activeTabId 为 null', () => {
      openTabForOwner(OWNER, 'a1');
      closeTabForOwner(OWNER, 'a1');
      const os = getOwnerState(testStore.getState(), OWNER);
      expect(os.openTabs).toEqual([]);
      expect(os.activeTabId).toBeNull();
    });

    it('setActiveTab 切换激活', () => {
      openTabForOwner(OWNER, 'a1');
      openTabForOwner(OWNER, 'a2');
      setActiveTabForOwner(OWNER, 'a1');
      expect(getOwnerState(testStore.getState(), OWNER).activeTabId).toBe('a1');
    });
  });

  // ─── Desk 模式预览 ───

  describe('Desk 模式（currentSessionPath = null）', () => {
    it('Desk 双击文件能显示正确标题和内容', () => {
      // currentSessionPath 默认是 null（Desk 模式）
      expect(testStore.getState().currentSessionPath).toBeNull();

      const art = makeArtifact('file-/home/readme.md', 'readme.md');
      upsertArtifactForOwner(DESK_OWNER, art);
      openTabForOwner(DESK_OWNER, art.id);

      // 通过 selector 读取（模拟组件行为）
      const s = stateWithSession(null);
      expect(selectArtifacts(s)).toEqual([art]);
      expect(selectOpenTabs(s)).toEqual(['file-/home/readme.md']);
      expect(selectActiveTabId(s)).toBe('file-/home/readme.md');
    });

    it('getPreviewOwner 在 null session 时返回 DESK_OWNER', () => {
      expect(getPreviewOwner({ currentSessionPath: null })).toBe(DESK_OWNER);
    });

    it('getPreviewOwner 在有 session 时返回 session path', () => {
      expect(getPreviewOwner({ currentSessionPath: '/s/a' })).toBe('/s/a');
    });
  });

  // ─── Session 间隔离 ───

  describe('Session A 的 preview 不出现在 Session B', () => {
    it('不同 session 的 artifacts 完全独立', () => {
      const artA = makeArtifact('art-a', 'session A artifact');
      const artB = makeArtifact('art-b', 'session B artifact');

      upsertArtifactForOwner('/session/a', artA);
      openTabForOwner('/session/a', artA.id);

      upsertArtifactForOwner('/session/b', artB);
      openTabForOwner('/session/b', artB.id);

      // Session A 只看到自己的
      const sA = stateWithSession('/session/a');
      expect(selectArtifacts(sA)).toEqual([artA]);
      expect(selectOpenTabs(sA)).toEqual(['art-a']);

      // Session B 只看到自己的
      const sB = stateWithSession('/session/b');
      expect(selectArtifacts(sB)).toEqual([artB]);
      expect(selectOpenTabs(sB)).toEqual(['art-b']);
    });

    it('切换 session 只是改变 selector 指向，不做 save/restore', () => {
      const artA = makeArtifact('art-a');
      upsertArtifactForOwner('/session/a', artA);
      openTabForOwner('/session/a', artA.id);

      // 模拟切换到 session B
      testStore.setState({ currentSessionPath: '/session/b' });

      // selector 自动指向 B（空）
      const s = stateWithSession('/session/b');
      expect(selectArtifacts(s)).toEqual([]);
      expect(selectOpenTabs(s)).toEqual([]);

      // 切回 A，数据仍在
      testStore.setState({ currentSessionPath: '/session/a' });
      const sA = stateWithSession('/session/a');
      expect(selectArtifacts(sA)).toEqual([artA]);
    });
  });

  // ─── Session / Desk 交叉隔离 ───

  describe('Session 与 Desk 交叉隔离', () => {
    it('Session 的 preview 不泄漏到 Desk', () => {
      const sessionArt = makeArtifact('session-art', 'session file');
      upsertArtifactForOwner('/session/x', sessionArt);
      openTabForOwner('/session/x', sessionArt.id);

      // 切到 Desk
      testStore.setState({ currentSessionPath: null });
      const deskState = stateWithSession(null);
      expect(selectArtifacts(deskState)).toEqual([]);
      expect(selectOpenTabs(deskState)).toEqual([]);
    });

    it('Desk 的 preview 不泄漏到 Session', () => {
      const deskArt = makeArtifact('desk-art', 'desk file');
      upsertArtifactForOwner(DESK_OWNER, deskArt);
      openTabForOwner(DESK_OWNER, deskArt.id);

      // 切到 session
      testStore.setState({ currentSessionPath: '/session/y' });
      const sessionState = stateWithSession('/session/y');
      expect(selectArtifacts(sessionState)).toEqual([]);
      expect(selectOpenTabs(sessionState)).toEqual([]);
    });

    it('Desk → Session → Desk，Desk 的 tab 状态不丢失', () => {
      // 在 Desk 打开文件
      const deskArt = makeArtifact('file-/home/test.md', 'test.md');
      upsertArtifactForOwner(DESK_OWNER, deskArt);
      openTabForOwner(DESK_OWNER, deskArt.id);

      // 切到 session
      testStore.setState({ currentSessionPath: '/session/z' });
      expect(selectOpenTabs(stateWithSession('/session/z'))).toEqual([]);

      // 切回 Desk
      testStore.setState({ currentSessionPath: null });
      const back = stateWithSession(null);
      expect(selectOpenTabs(back)).toEqual(['file-/home/test.md']);
      expect(selectActiveTabId(back)).toBe('file-/home/test.md');
      expect(selectArtifacts(back)).toEqual([deskArt]);
    });
  });

  // ─── clearOwnerPreview ───

  describe('clearOwnerPreview', () => {
    it('清除指定 owner 的全部状态，不影响其他 owner', () => {
      const artA = makeArtifact('art-a');
      const artDesk = makeArtifact('art-desk');

      upsertArtifactForOwner('/session/a', artA);
      openTabForOwner('/session/a', artA.id);

      upsertArtifactForOwner(DESK_OWNER, artDesk);
      openTabForOwner(DESK_OWNER, artDesk.id);

      // 清除 session/a
      clearOwnerPreview('/session/a');

      expect(getOwnerState(testStore.getState(), '/session/a').artifacts).toEqual([]);
      expect(getOwnerState(testStore.getState(), DESK_OWNER).artifacts).toEqual([artDesk]);
    });
  });

  // ─── openPreview / closePreview ───

  describe('openPreview / closePreview', () => {
    it('openPreview upserts artifact + opens tab + sets previewOpen', () => {
      testStore.setState({ currentSessionPath: '/session/p' });
      const art = makeArtifact('art-p', 'preview test');
      openPreview(art);

      const os = getOwnerState(testStore.getState(), '/session/p');
      expect(os.artifacts).toEqual([art]);
      expect(os.openTabs).toEqual(['art-p']);
      expect(os.activeTabId).toBe('art-p');
      expect(testStore.getState().previewOpen).toBe(true);
    });

    it('closePreview sets previewOpen false but preserves owner state', () => {
      testStore.setState({ currentSessionPath: '/session/p' });
      const art = makeArtifact('art-p');
      openPreview(art);
      closePreview();

      expect(testStore.getState().previewOpen).toBe(false);
      // owner 的 tab 和 artifacts 仍在
      const os = getOwnerState(testStore.getState(), '/session/p');
      expect(os.artifacts).toEqual([art]);
      expect(os.openTabs).toEqual(['art-p']);
    });
  });

  // ─── handleArtifact ───

  describe('handleArtifact', () => {
    it('带 sessionPath 时写入对应 owner', () => {
      handleArtifact({
        artifactId: 'stream-1',
        artifactType: 'code',
        title: 'streaming',
        content: 'console.log(1)',
        sessionPath: '/session/s',
      });

      const os = getOwnerState(testStore.getState(), '/session/s');
      expect(os.artifacts).toHaveLength(1);
      expect(os.artifacts[0].id).toBe('stream-1');
    });

    it('不带 sessionPath 时跳过写入（warn + skip）', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      handleArtifact({
        artifactId: 'orphan',
        artifactType: 'code',
        title: 'orphan',
        content: '',
      });

      // 不应该写到任何 owner
      expect(testStore.getState().previewByOwner).toEqual({});
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('without sessionPath'));
      spy.mockRestore();
    });
  });

  // ─── syncPreviewPanelForOwner ───

  describe('syncPreviewPanelForOwner', () => {
    it('目标 owner 有 tabs 时展开面板', () => {
      upsertArtifactForOwner('/session/t', makeArtifact('t1'));
      openTabForOwner('/session/t', 't1');
      testStore.setState({ previewOpen: false });

      syncPreviewPanelForOwner('/session/t');
      expect(testStore.getState().previewOpen).toBe(true);
    });

    it('目标 owner 无 tabs 时收起面板', () => {
      testStore.setState({ previewOpen: true });
      syncPreviewPanelForOwner('/session/empty');
      expect(testStore.getState().previewOpen).toBe(false);
    });
  });
});
