import type { Artifact } from '../types';

// ── Owner 常量 ──

/** Desk 模式（无 session）的 owner key */
export const DESK_OWNER = 'desk';

// ── 内部类型 ──

interface OwnerPreviewState {
  artifacts: Artifact[];
  openTabs: string[];
  activeTabId: string | null;
}

const EMPTY_STATE: OwnerPreviewState = { artifacts: [], openTabs: [], activeTabId: null };

// ── Slice ──

export interface ArtifactSlice {
  /** 所有预览状态按 owner 分区。key 为 session path 或 DESK_OWNER */
  previewByOwner: Record<string, OwnerPreviewState>;
  editorDetached: boolean;
  setEditorDetached: (detached: boolean) => void;
}

export const createArtifactSlice = (
  set: (partial: Partial<ArtifactSlice> | ((s: ArtifactSlice) => Partial<ArtifactSlice>)) => void
): ArtifactSlice => ({
  previewByOwner: {},
  editorDetached: false,
  setEditorDetached: (detached) => set({ editorDetached: detached }),
});

// ── Owner 解析 ──

export function getPreviewOwner(s: { currentSessionPath: string | null }): string {
  return s.currentSessionPath ?? DESK_OWNER;
}

/** 读取指定 owner 的预览状态（不存在则返回空） */
export function getOwnerState(s: ArtifactSlice, owner: string): OwnerPreviewState {
  return s.previewByOwner[owner] ?? EMPTY_STATE;
}

// ── Selectors ──

type StateWithSession = ArtifactSlice & { currentSessionPath: string | null };

export const selectArtifacts = (s: StateWithSession): Artifact[] =>
  getOwnerState(s, getPreviewOwner(s)).artifacts;

export const selectOpenTabs = (s: StateWithSession): string[] =>
  getOwnerState(s, getPreviewOwner(s)).openTabs;

export const selectActiveTabId = (s: StateWithSession): string | null =>
  getOwnerState(s, getPreviewOwner(s)).activeTabId;

export const selectEditorDetached = (s: ArtifactSlice): boolean => s.editorDetached;
