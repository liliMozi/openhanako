import { hanaFetch } from '../hooks/use-hana-fetch';
import type { PreviewItem, TextFileSnapshot } from '../types';
import { useStore } from './index';
// @ts-expect-error — shared JS module
import { normalizeWorkspacePath } from '../../../../shared/workspace-history.js';

interface PersistedPreviewTab {
  id: string;
  filePath?: string;
  relativePath?: string;
  title?: string;
  type?: string;
  ext?: string;
  language?: string | null;
}

export interface PersistedWorkspaceUiState {
  updatedAt?: number;
  deskCurrentPath?: string;
  deskExpandedPaths?: string[];
  deskSelectedPath?: string;
  previewOpen?: boolean;
  openTabs?: string[];
  activeTabId?: string | null;
  previewTabs?: PersistedPreviewTab[];
}

const SAVE_DEBOUNCE_MS = 350;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeRoot(root: string | null | undefined): string | null {
  return normalizeWorkspacePath(root);
}

function normalizeSubdir(value: string | null | undefined): string {
  return (value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function joinWorkspacePath(root: string, relativePath: string): string {
  const base = root.replace(/[\\/]+$/g, '');
  const rel = normalizeSubdir(relativePath);
  return rel ? `${base}/${rel}` : base;
}

function relativePathFor(root: string, filePath: string | undefined): string {
  if (!filePath) return '';
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/g, '');
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (normalizedPath === normalizedRoot) return '';
  const prefix = `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : '';
}

function previewTabFromItem(root: string, item: PreviewItem): PersistedPreviewTab | null {
  if (!item.filePath) return null;
  const relativePath = relativePathFor(root, item.filePath);
  return {
    id: item.id,
    filePath: item.filePath,
    ...(relativePath ? { relativePath } : {}),
    title: item.title,
    type: item.type,
    ext: item.ext,
    language: item.language ?? null,
  };
}

export function buildPersistedWorkspaceUiState(root: string): PersistedWorkspaceUiState {
  const state = useStore.getState();
  const previewItemsById = new Map(state.previewItems.map(item => [item.id, item]));
  const previewTabs = (state.openTabs || [])
    .map(id => previewItemsById.get(id))
    .filter((item): item is PreviewItem => !!item)
    .map(item => previewTabFromItem(root, item))
    .filter((item): item is PersistedPreviewTab => !!item);
  const persistedIds = new Set(previewTabs.map(tab => tab.id));
  const openTabs = (state.openTabs || []).filter(id => persistedIds.has(id));
  const activeTabId = state.activeTabId && openTabs.includes(state.activeTabId)
    ? state.activeTabId
    : (openTabs[0] || null);

  return {
    deskCurrentPath: normalizeSubdir(state.deskCurrentPath),
    deskExpandedPaths: [...(state.deskExpandedPaths || [])].map(normalizeSubdir).filter(Boolean),
    deskSelectedPath: normalizeSubdir(state.deskSelectedPath),
    previewOpen: !!state.previewOpen,
    openTabs,
    activeTabId,
    previewTabs,
  };
}

export async function loadPersistedWorkspaceUiState(root: string): Promise<PersistedWorkspaceUiState | null> {
  const normalized = normalizeRoot(root);
  const state = useStore.getState();
  if (!normalized || !state.serverPort) return null;
  try {
    const res = await hanaFetch(`/api/preferences/workspace-ui-state?workspace=${encodeURIComponent(normalized)}`);
    const data = await res.json().catch(() => null);
    return data?.state && typeof data.state === 'object' ? data.state as PersistedWorkspaceUiState : null;
  } catch (err) {
    console.warn('[workspace-ui-state] load failed:', err);
    return null;
  }
}

async function readPreviewContent(filePath: string, type: string): Promise<Pick<PreviewItem, 'content' | 'fileVersion'> | null> {
  const platform = window.platform;
  if (!platform) return null;
  if (type === 'docx') {
    const content = await platform.readDocxHtml?.(filePath);
    return content == null ? null : { content };
  }
  if (type === 'xlsx') {
    const content = await platform.readXlsxHtml?.(filePath);
    return content == null ? null : { content };
  }
  if (type === 'pdf') {
    const content = await platform.readFileBase64?.(filePath);
    return content == null ? null : { content };
  }
  const snapshot = await platform.readFileSnapshot?.(filePath) as TextFileSnapshot | null | undefined;
  if (snapshot) return { content: snapshot.content, fileVersion: snapshot.version };
  const content = await platform.readFile?.(filePath);
  return content == null ? null : { content };
}

export async function hydratePersistedPreviewItems(
  root: string,
  persisted: PersistedWorkspaceUiState | null,
): Promise<PreviewItem[]> {
  const normalizedRoot = normalizeRoot(root);
  if (!normalizedRoot || !persisted?.previewTabs?.length) return [];
  const items: PreviewItem[] = [];
  for (const tab of persisted.previewTabs) {
    const filePath = tab.relativePath
      ? joinWorkspacePath(normalizedRoot, tab.relativePath)
      : (tab.filePath || '');
    if (!filePath || !tab.id) continue;
    try {
      const type = tab.type || 'file-info';
      const read = await readPreviewContent(filePath, type);
      if (!read) continue;
      items.push({
        id: tab.id,
        type,
        title: tab.title || filePath.split('/').pop() || filePath,
        content: read.content,
        filePath,
        ext: tab.ext,
        language: tab.language,
        fileVersion: read.fileVersion,
      });
    } catch (err) {
      console.warn('[workspace-ui-state] preview tab restore failed:', err);
    }
  }
  return items;
}

export function schedulePersistCurrentWorkspaceUiState(root?: string | null): void {
  const normalized = normalizeRoot(root ?? useStore.getState().deskBasePath);
  if (!normalized || !useStore.getState().serverPort) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistCurrentWorkspaceUiStateNow(normalized);
  }, SAVE_DEBOUNCE_MS);
}

export async function persistCurrentWorkspaceUiStateNow(root?: string | null): Promise<void> {
  const normalized = normalizeRoot(root ?? useStore.getState().deskBasePath);
  if (!normalized || !useStore.getState().serverPort) return;
  const state = buildPersistedWorkspaceUiState(normalized);
  try {
    await hanaFetch('/api/preferences/workspace-ui-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: normalized, state }),
    });
  } catch (err) {
    console.warn('[workspace-ui-state] save failed:', err);
  }
}
