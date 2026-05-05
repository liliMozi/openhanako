/**
 * desk-actions.ts — 工作空间文件操作（纯函数，不依赖 DOM）
 *
 * 从 desk-shim.ts 提取，供 React 组件直接调用。
 */

import { useStore } from './index';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { clearChat } from './agent-actions';
import type { WorkspaceDeskState } from './desk-slice';
// @ts-expect-error — shared JS module
import { mergeWorkspaceHistory, normalizeWorkspacePath } from '../../../../shared/workspace-history.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- store setState 回调及 IPC callback data */

const t = (key: string, vars?: Record<string, string | number>) => window.t?.(key, vars) ?? key;

let _deskLoadVersion = 0;
const _deskTreeLoadVersion = new Map<string, number>();

// ── 路径工具 ──

function normalizeFolder(value: string | null | undefined): string | null {
  return normalizeWorkspacePath(value);
}

function defaultDeskRoot(s: ReturnType<typeof useStore.getState>): string | undefined {
  return normalizeFolder(s.deskBasePath)
    || normalizeFolder(s.selectedFolder)
    || normalizeFolder(s.homeFolder)
    || undefined;
}

function buildWorkspaceDeskState(s: ReturnType<typeof useStore.getState>): WorkspaceDeskState {
  return {
    deskCurrentPath: s.deskCurrentPath || '',
    deskFiles: [...(s.deskFiles || [])],
    deskTreeFilesByPath: { ...(s.deskTreeFilesByPath || {}) },
    deskExpandedPaths: [...(s.deskExpandedPaths || [])],
    deskSelectedPath: s.deskSelectedPath || '',
    deskJianContent: s.deskJianContent ?? null,
    cwdSkills: [...(s.cwdSkills || [])],
    cwdSkillsOpen: !!s.cwdSkillsOpen,
    previewOpen: !!s.previewOpen,
    openTabs: [...(s.openTabs || [])],
    activeTabId: s.activeTabId ?? null,
  };
}

export function captureCurrentWorkspaceDeskState(root?: string | null): void {
  const s = useStore.getState();
  const key = normalizeFolder(root ?? s.deskBasePath);
  if (!key) return;
  s.setWorkspaceDeskState(key, buildWorkspaceDeskState(s));
}

export async function activateWorkspaceDesk(root: string | null | undefined, options: {
  reload?: boolean;
} = {}): Promise<void> {
  // Any workspace activation owns the visible desk state. Invalidate older file
  // loads even when the caller delays the reload until after another step
  // such as persisting workspace history.
  _deskLoadVersion += 1;

  const normalized = normalizeFolder(root);
  const s = useStore.getState();
  const currentRoot = normalizeFolder(s.deskBasePath);

  if (currentRoot) {
    captureCurrentWorkspaceDeskState(currentRoot);
  }

  if (!normalized) {
    useStore.setState({
      deskBasePath: '',
      deskCurrentPath: '',
      deskFiles: [],
      deskTreeFilesByPath: {},
      deskExpandedPaths: [],
      deskSelectedPath: '',
      deskJianContent: null,
      cwdSkills: [],
      cwdSkillsOpen: false,
      previewOpen: false,
      openTabs: [],
      activeTabId: null,
    });
    updateDeskContextBtn();
    return;
  }

  const latest = useStore.getState();
  const saved = latest.workspaceDeskStateByRoot?.[normalized] || null;
  const sameRoot = currentRoot === normalized;
  const nextSubdir = sameRoot
    ? (latest.deskCurrentPath || '')
    : (saved?.deskCurrentPath || '');

  useStore.setState({
    deskBasePath: normalized,
    deskCurrentPath: nextSubdir,
    deskFiles: [],
    deskTreeFilesByPath: saved?.deskTreeFilesByPath || {},
    deskExpandedPaths: saved?.deskExpandedPaths || [],
    deskSelectedPath: saved?.deskSelectedPath || '',
    deskJianContent: null,
    cwdSkills: saved?.cwdSkills || [],
    cwdSkillsOpen: saved?.cwdSkillsOpen || false,
    previewOpen: saved?.previewOpen || false,
    openTabs: saved?.openTabs || [],
    activeTabId: saved?.activeTabId ?? null,
  });
  updateDeskContextBtn();

  if (options.reload === false) return;
  await loadDeskFiles(nextSubdir, normalized);
}

export function deskFullPath(name: string): string | null {
  const s = useStore.getState();
  if (!s.deskBasePath) return null;
  return s.deskCurrentPath
    ? s.deskBasePath + '/' + s.deskCurrentPath + '/' + name
    : s.deskBasePath + '/' + name;
}

export function deskCurrentDir(): string | null {
  const s = useStore.getState();
  if (!s.deskBasePath) return null;
  return s.deskCurrentPath
    ? s.deskBasePath + '/' + s.deskCurrentPath
    : s.deskBasePath;
}

// ── 文件操作 ──

export async function loadDeskFiles(subdir?: string, overrideDir?: string | null): Promise<void> {
  const s = useStore.getState();
  if (!s.serverPort) return;
  if (subdir !== undefined) s.setDeskCurrentPath(subdir);
  const myVersion = ++_deskLoadVersion;
  try {
    const params = new URLSearchParams();
    // overrideDir 是显式调用契约：string 表示指定根目录，null 表示不复用旧 deskBasePath。
    // undefined 才走 store 中已有 deskBasePath，避免普通刷新丢失当前根目录。
    const dir = overrideDir !== undefined
      ? (overrideDir || undefined)
      : defaultDeskRoot(s);
    if (dir) params.set('dir', dir);
    const curPath = subdir !== undefined ? subdir : s.deskCurrentPath;
    if (curPath) params.set('subdir', curPath);
    const qs = params.toString() ? `?${params}` : '';
    const res = await hanaFetch(`/api/desk/files${qs}`);
    const data = await res.json();
    if (myVersion !== _deskLoadVersion) return;
    if (data.error) throw new Error(String(data.error));
    const st = useStore.getState();
    st.setDeskFiles(data.files || []);
    st.setDeskTreeFiles(curPath || '', data.files || []);
    st.setDeskSelectedPath(curPath || '');
    if (data.basePath) st.setDeskBasePath(data.basePath);
    loadJianContent();
    updateDeskContextBtn();
  } catch (err) {
    console.error('[jian-desk] load failed:', err);
    if (myVersion !== _deskLoadVersion) return;
    const st = useStore.getState();
    st.setDeskFiles([]);
    st.setDeskTreeFiles(subdir !== undefined ? subdir : (st.deskCurrentPath || ''), []);
    st.setDeskJianContent(null);
    updateDeskContextBtn();
  }
}

function deskTreeLoadKey(root: string | undefined, subdir: string): string {
  return `${root || ''}\n${subdir}`;
}

export async function loadDeskTreeFiles(subdir = '', options: { force?: boolean; overrideDir?: string | null } = {}): Promise<void> {
  const s = useStore.getState();
  if (!s.serverPort) return;
  const dir = options.overrideDir !== undefined
    ? (options.overrideDir || undefined)
    : defaultDeskRoot(s);
  const normalizedSubdir = subdir.replace(/^\/+|\/+$/g, '');
  const cached = s.deskTreeFilesByPath?.[normalizedSubdir];
  if (cached && !options.force) return;

  const key = deskTreeLoadKey(dir, normalizedSubdir);
  const myVersion = (_deskTreeLoadVersion.get(key) || 0) + 1;
  _deskTreeLoadVersion.set(key, myVersion);

  try {
    const params = new URLSearchParams();
    if (dir) params.set('dir', dir);
    if (normalizedSubdir) params.set('subdir', normalizedSubdir);
    const qs = params.toString() ? `?${params}` : '';
    const res = await hanaFetch(`/api/desk/files${qs}`);
    const data = await res.json();
    if (_deskTreeLoadVersion.get(key) !== myVersion) return;
    if (data.error) throw new Error(String(data.error));
    const st = useStore.getState();
    if (data.basePath) st.setDeskBasePath(data.basePath);
    st.setDeskTreeFiles(normalizedSubdir, data.files || []);
  } catch (err) {
    console.error('[desk-tree] load failed:', err);
    if (_deskTreeLoadVersion.get(key) !== myVersion) return;
    useStore.getState().setDeskTreeFiles(normalizedSubdir, []);
  }
}

export async function loadJianContent(): Promise<void> {
  const s = useStore.getState();
  if (!s.serverPort) return;
  try {
    const params = new URLSearchParams();
    if (s.deskBasePath) params.set('dir', s.deskBasePath);
    if (s.deskCurrentPath) params.set('subdir', s.deskCurrentPath);
    const qs = params.toString() ? `?${params}` : '';
    const res = await hanaFetch(`/api/desk/jian${qs}`);
    const data = await res.json();
    useStore.getState().setDeskJianContent(data.content || null);
  } catch (err) {
    console.error('[jian] load jian.md failed:', err);
    useStore.getState().setDeskJianContent(null);
  }
}

export async function saveJianContent(content?: string): Promise<void> {
  const s = useStore.getState();
  if (!s.serverPort) return;
  const text = content ?? s.deskJianContent ?? '';
  try {
    await hanaFetch('/api/desk/jian', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: s.deskBasePath || undefined, subdir: s.deskCurrentPath || '', content: text }),
    });
    useStore.getState().setDeskJianContent(text || null);
    const st2 = useStore.getState();
    const params = new URLSearchParams();
    if (st2.deskBasePath) params.set('dir', st2.deskBasePath);
    if (st2.deskCurrentPath) params.set('subdir', st2.deskCurrentPath);
    const qs = params.toString() ? `?${params}` : '';
    const res2 = await hanaFetch(`/api/desk/files${qs}`);
    const data2 = await res2.json();
    const st = useStore.getState();
    st.setDeskFiles(data2.files || []);
    st.setDeskTreeFiles(st.deskCurrentPath || '', data2.files || []);
  } catch (err) {
    console.error('[jian] save jian.md failed:', err);
  }
}

export async function deskUploadFiles(paths: string[]): Promise<void> {
  const s = useStore.getState();
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'upload', dir: s.deskBasePath || undefined, subdir: s.deskCurrentPath || '', paths }),
    });
    const data = await res.json();
    if (data.files) {
      const st = useStore.getState();
      st.setDeskFiles(data.files);
      st.setDeskTreeFiles(st.deskCurrentPath || '', data.files);
    }
  } catch (err) {
    console.error('[jian-desk] upload failed:', err);
  }
}

export async function deskCreateFile(text: string): Promise<void> {
  const s = useStore.getState();
  const d = new Date();
  const ts = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const locale = window.i18n?.locale || 'zh';
  const prefix = locale.startsWith('zh') ? '备注' : locale.startsWith('ja') ? 'メモ' : locale.startsWith('ko') ? '메모' : 'note';
  const name = `${ts}-${prefix}.md`;
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', dir: s.deskBasePath || undefined, subdir: s.deskCurrentPath || '', name, content: text }),
    });
    const data = await res.json();
    if (data.files) {
      const st = useStore.getState();
      st.setDeskFiles(data.files);
      st.setDeskTreeFiles(st.deskCurrentPath || '', data.files);
    }
  } catch (err) {
    console.error('[jian-desk] create failed:', err);
  }
}

export async function deskMoveFiles(names: string[], destFolder: string): Promise<void> {
  const s = useStore.getState();
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'move', dir: s.deskBasePath || undefined, subdir: s.deskCurrentPath || '', names, destFolder }),
    });
    const data = await res.json();
    if (data.files) {
      const st = useStore.getState();
      st.setDeskFiles(data.files);
      st.setDeskTreeFiles(st.deskCurrentPath || '', data.files);
    }
  } catch (err) {
    console.error('[jian-desk] move failed:', err);
  }
}

export async function deskRemoveFile(name: string): Promise<void> {
  const s = useStore.getState();
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', dir: s.deskBasePath || undefined, subdir: s.deskCurrentPath || '', name }),
    });
    const data = await res.json();
    if (data.files) {
      const st = useStore.getState();
      st.setDeskFiles(data.files);
      st.setDeskTreeFiles(st.deskCurrentPath || '', data.files);
    }
  } catch (err) {
    console.error('[jian-desk] remove failed:', err);
  }
}

/**
 * deskMkdir — 新建文件夹，并返回新文件夹名（供调用者触发 rename）。
 */
export async function deskMkdir(): Promise<string | null> {
  const s = useStore.getState();
  let name = t('desk.newFolder');
  const existing = new Set(s.deskFiles.map((f: { name: string }) => f.name));
  if (existing.has(name)) {
    let i = 2;
    while (existing.has(`${name} ${i}`)) i++;
    name = `${name} ${i}`;
  }
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mkdir', dir: s.deskBasePath || undefined, subdir: s.deskCurrentPath || '', name }),
    });
    const data = await res.json();
    if (data.files) {
      const st = useStore.getState();
      st.setDeskFiles(data.files);
      st.setDeskTreeFiles(st.deskCurrentPath || '', data.files);
      return name;
    }
  } catch (err) {
    console.error('[desk] mkdir failed:', err);
  }
  return null;
}

export async function deskRenameFile(oldName: string, newName: string): Promise<boolean> {
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rename', dir: useStore.getState().deskBasePath || undefined, subdir: useStore.getState().deskCurrentPath || '', oldName, newName }),
    });
    const data = await res.json();
    if (data.error) { console.error('[desk] rename error:', data.error); return false; }
    if (data.files) {
      const st = useStore.getState();
      st.setDeskFiles(data.files);
      st.setDeskTreeFiles(st.deskCurrentPath || '', data.files);
    }
    return true;
  } catch (err) { console.error('[desk] rename failed:', err); return false; }
}

// ── 状态工具 ──

export function toggleMemory(): void {
  useStore.setState((s: any) => ({ memoryEnabled: !s.memoryEnabled }));
}

export async function applyFolder(folder: string): Promise<void> {
  const normalized = normalizeFolder(folder);
  if (!normalized) return;
  useStore.setState((s: any) => ({
    selectedFolder: normalized,
    cwdHistory: mergeWorkspaceHistory(s.cwdHistory, [normalized]),
    workspaceFolders: (s.workspaceFolders || []).filter((p: string) => normalizeFolder(p) !== normalized),
  }));
  void activateWorkspaceDesk(normalized, { reload: false });
  const s = useStore.getState();
  if (!s.pendingNewSession) {
    useStore.setState({ currentSessionPath: null, pendingNewSession: true });
    clearChat();
    useStore.getState().requestInputFocus();
  }
  await persistWorkspaceHistory(normalized);
  await loadDeskFiles(useStore.getState().deskCurrentPath || '', normalized);
}

async function persistWorkspaceHistory(folder: string): Promise<void> {
  const s = useStore.getState();
  if (!s.serverPort) return;
  try {
    const res = await hanaFetch('/api/config/workspaces/recent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folder }),
    });
    const data = await res.json();
    if (data.error) throw new Error(String(data.error));
    if (Array.isArray(data.cwd_history)) {
      useStore.setState({ cwdHistory: mergeWorkspaceHistory(data.cwd_history, []) });
    }
  } catch (err) {
    console.error('[workspace] persist history failed:', err);
  }
}

export function addWorkspaceFolder(folder: string): void {
  const normalized = normalizeFolder(folder);
  if (!normalized) return;
  useStore.setState((s: any) => {
    const primary = normalizeFolder(s.selectedFolder) || normalizeFolder(s.homeFolder);
    if (normalized === primary) return {};
    if ((s.workspaceFolders || []).includes(normalized)) return {};
    return { workspaceFolders: [...(s.workspaceFolders || []), normalized] };
  });
}

export function removeWorkspaceFolder(folder: string): void {
  const normalized = normalizeFolder(folder);
  if (!normalized) return;
  useStore.setState((s: any) => ({
    workspaceFolders: (s.workspaceFolders || []).filter((p: string) => p !== normalized),
  }));
}

export function updateDeskContextBtn(): void {
  const s = useStore.getState();
  const available = !!s.deskBasePath && s.deskFiles.length > 0;
  if (!available && s.deskContextAttached) {
    s.setDeskContextAttached(false);
  }
}

export function toggleJianSidebar(forceOpen?: boolean): void {
  const s = useStore.getState();
  const newOpen = forceOpen !== undefined ? forceOpen : !s.jianOpen;
  s.setJianOpen(newOpen);
  const tab = s.currentTab || 'chat';
  localStorage.setItem(`hana-jian-${tab}`, newOpen ? 'open' : 'closed');
  if (forceOpen === undefined) s.setJianAutoCollapsed(false);
}

export function initJian(): void {
  const legacy = localStorage.getItem('hana-jian');
  if (legacy && !localStorage.getItem('hana-jian-chat')) localStorage.setItem('hana-jian-chat', legacy);
  const savedJian = localStorage.getItem('hana-jian-chat');
  if (savedJian !== null) useStore.getState().setJianOpen(savedJian !== 'closed');
  const s = useStore.getState();
  void activateWorkspaceDesk(s.selectedFolder || s.homeFolder || null);
}
