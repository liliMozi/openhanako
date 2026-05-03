/**
 * artifact-actions.ts — Artifact 预览管理
 *
 * artifacts 内容池仍是 user-level flat state；可见的 previewOpen / openTabs /
 * activeTabId 会随 workspace desk 状态保存和恢复。
 */

import { useStore } from './index';
import type { StoreState } from './index';
import { updateLayout } from '../components/SidebarLayout';
import type { Artifact } from '../types';
import type { ArtifactSlice } from './artifact-slice';

// ── Viewer spawn（派生只读窗口） ──

/** artifact 是否允许派生到 viewer 窗口：有 filePath 且类型在 viewer 支持集合里 */
const VIEWER_SUPPORTED_TYPES = new Set(['markdown', 'code', 'csv']);

export function canSpawnViewer(artifact: Artifact | null): boolean {
  if (!artifact?.filePath) return false;
  return VIEWER_SUPPORTED_TYPES.has(artifact.type);
}

/**
 * 把当前 artifact 派生到独立 viewer 窗口（只读 live）。
 * 成功后把 windowId 记入 pinnedViewers store。
 * 失败（如非可编辑类型、无 filePath、Electron 异常）静默返回。
 */
export async function spawnViewer(artifact: Artifact): Promise<void> {
  if (!canSpawnViewer(artifact)) return;
  if (!artifact.filePath) return; // TS 窄化，canSpawnViewer 已保证

  const windowId = await window.platform?.spawnViewer?.({
    filePath: artifact.filePath,
    title: artifact.title,
    type: artifact.type,
    language: artifact.language,
  });

  if (typeof windowId !== 'number') return;

  useStore.getState().addPinnedViewer({
    windowId,
    filePath: artifact.filePath,
    title: artifact.title,
  });
}

/**
 * 注册 viewer-closed 事件监听：当派生 viewer 窗口关闭时，
 * 主 renderer 从 pinnedViewers store 删掉对应条目。
 * App mount 时调用一次。
 */
export function initViewerEvents(): void {
  window.platform?.onViewerClosed?.((windowId: number) => {
    useStore.getState().removePinnedViewer(windowId);
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any -- IPC callback data */

let _artifactCounter = 0;

// ── Internal write primitive ──

function updatePreview(
  updater: (prev: Pick<ArtifactSlice, 'artifacts' | 'openTabs' | 'activeTabId' | 'markdownPreviewIds'>) =>
    Partial<Pick<ArtifactSlice, 'artifacts' | 'openTabs' | 'activeTabId' | 'markdownPreviewIds'>>,
): void {
  useStore.setState((s: StoreState) => {
    const prev = {
      artifacts: s.artifacts,
      openTabs: s.openTabs,
      activeTabId: s.activeTabId,
      markdownPreviewIds: s.markdownPreviewIds,
    };
    return updater(prev);
  });
}

// ── Public primitives ──

/** upsert 一条 artifact 到全局池 */
export function upsertArtifact(artifact: Artifact): void {
  updatePreview(prev => {
    const arts = [...prev.artifacts];
    const idx = arts.findIndex(a => a.id === artifact.id);
    if (idx >= 0) arts[idx] = artifact;
    else arts.push(artifact);
    return { artifacts: arts };
  });
}

/** 打开 tab 并激活（已存在的 id 只切换激活） */
export function openTab(id: string): void {
  updatePreview(prev => {
    const tabs = prev.openTabs.includes(id) ? prev.openTabs : [...prev.openTabs, id];
    return { openTabs: tabs, activeTabId: id };
  });
}

/** 关闭 tab；若关闭的是 active，激活前一个 */
export function closeTab(id: string): void {
  updatePreview(prev => {
    const idx = prev.openTabs.indexOf(id);
    if (idx < 0) return {};
    const tabs = prev.openTabs.filter(t => t !== id);
    let active = prev.activeTabId;
    if (active === id) {
      active = tabs[Math.max(0, idx - 1)] ?? null;
    }
    return {
      openTabs: tabs,
      activeTabId: active,
      markdownPreviewIds: prev.markdownPreviewIds.filter(previewId => previewId !== id),
    };
  });
}

/** 切换激活 tab */
export function setActiveTab(id: string): void {
  updatePreview(() => ({ activeTabId: id }));
}

/** 清空整个预览池 */
export function clearPreview(): void {
  useStore.setState({
    artifacts: [],
    openTabs: [],
    activeTabId: null,
    markdownPreviewIds: [],
  });
}

export function setMarkdownPreviewActive(id: string, active: boolean): void {
  useStore.getState().setMarkdownPreviewActive(id, active);
}

export function toggleMarkdownPreview(id: string): void {
  const s = useStore.getState();
  s.setMarkdownPreviewActive(id, !s.markdownPreviewIds.includes(id));
}

// ── High-level actions ──

/** 注册 artifact 并打开为 tab，展开面板 */
export function openPreview(artifact: Artifact): void {
  upsertArtifact(artifact);
  openTab(artifact.id);
  useStore.getState().setPreviewOpen(true);
  updateLayout();
}

/** 收起面板，保留 tabs 和 artifacts（下次打开恢复） */
export function closePreview(): void {
  const s = useStore.getState();
  s.setPreviewOpen(false);
  if (s.quotedSelection) s.clearQuotedSelection();
  updateLayout();
}

/** 流式事件：AI 生成 artifact 进全局池（不再按 sessionPath 路由） */
export function handleArtifact(data: Record<string, unknown>): void {
  const id = (data.artifactId as string) || `artifact-${++_artifactCounter}`;
  const artifact: Artifact = {
    id,
    type: data.artifactType as string,
    title: data.title as string,
    content: data.content as string,
    language: data.language as string | undefined,
    fileId: data.fileId as string | undefined,
    filePath: data.filePath as string | undefined,
    ext: data.ext as string | undefined,
    mime: data.mime as string | undefined,
    kind: data.kind as string | undefined,
    storageKind: data.storageKind as string | undefined,
    status: data.status as string | undefined,
    missingAt: data.missingAt as number | null | undefined,
  };
  upsertArtifact(artifact);
}
