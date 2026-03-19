/**
 * desk-actions.ts — 书桌文件操作（纯函数，不依赖 DOM）
 *
 * 从 desk-shim.ts 提取，供 React 组件直接调用。
 */

import { useStore } from './index';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { hideFloatCard, applyTbToggleState } from '../components/SidebarLayout';

/* eslint-disable @typescript-eslint/no-explicit-any */

const t = (key: string, vars?: Record<string, any>) => (window as any).t?.(key, vars) ?? key;

// ── 路径工具 ──

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

export async function loadDeskFiles(subdir?: string, overrideDir?: string): Promise<void> {
  const s = useStore.getState();
  if (!s.serverPort) return;
  if (subdir !== undefined) s.setDeskCurrentPath(subdir);
  try {
    const params = new URLSearchParams();
    if (overrideDir) params.set('dir', overrideDir);
    const curPath = subdir !== undefined ? subdir : s.deskCurrentPath;
    if (curPath) params.set('subdir', curPath);
    const qs = params.toString() ? `?${params}` : '';
    const res = await hanaFetch(`/api/desk/files${qs}`);
    const data = await res.json();
    const st = useStore.getState();
    st.setDeskFiles(data.files || []);
    if (data.basePath) st.setDeskBasePath(data.basePath);
    loadJianContent();
    updateDeskContextBtn();
  } catch (err) {
    console.error('[jian-desk] load failed:', err);
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
    useStore.getState().setDeskFiles(data2.files || []);
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
    if (data.files) useStore.getState().setDeskFiles(data.files);
  } catch (err) {
    console.error('[jian-desk] upload failed:', err);
  }
}

export async function deskCreateFile(text: string): Promise<void> {
  const s = useStore.getState();
  const ts = new Date().toISOString().slice(5, 16).replace(/[T:]/g, '-');
  const prefix = (window as any).i18n?.locale === 'en' ? 'note' : '备注';
  const name = `${prefix}_${ts}.md`;
  try {
    const res = await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', dir: s.deskBasePath || undefined, subdir: s.deskCurrentPath || '', name, content: text }),
    });
    const data = await res.json();
    if (data.files) useStore.getState().setDeskFiles(data.files);
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
    if (data.files) useStore.getState().setDeskFiles(data.files);
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
    if (data.files) useStore.getState().setDeskFiles(data.files);
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
      useStore.getState().setDeskFiles(data.files);
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
    if (data.files) useStore.getState().setDeskFiles(data.files);
    return true;
  } catch (err) { console.error('[desk] rename failed:', err); return false; }
}

// ── 状态工具 ──

export function toggleMemory(): void {
  useStore.setState((s: any) => ({ memoryEnabled: !s.memoryEnabled }));
}

export function applyFolder(folder: string): void {
  useStore.setState({ selectedFolder: folder });
  const s = useStore.getState();
  if (!s.pendingNewSession) {
    useStore.setState({ currentSessionPath: null, pendingNewSession: true });
    const { clearChat } = require('./agent-actions');
    clearChat();
    (document.getElementById('inputBox') as HTMLTextAreaElement | null)?.focus();
  }
  loadDeskFiles('', folder);
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
  const jianSidebar = document.getElementById('jianSidebar');
  if (newOpen) {
    jianSidebar?.classList.remove('collapsed');
    hideFloatCard();
  } else {
    jianSidebar?.classList.add('collapsed');
  }
  applyTbToggleState();
}

export function initJian(): void {
  const legacy = localStorage.getItem('hana-jian');
  if (legacy && !localStorage.getItem('hana-jian-chat')) localStorage.setItem('hana-jian-chat', legacy);
  const savedJian = localStorage.getItem('hana-jian-chat');
  if (savedJian !== null) useStore.getState().setJianOpen(savedJian !== 'closed');
  const jianSidebar = document.getElementById('jianSidebar');
  if (useStore.getState().jianOpen) jianSidebar?.classList.remove('collapsed');
  else jianSidebar?.classList.add('collapsed');
  const s = useStore.getState();
  loadDeskFiles('', s.selectedFolder || s.homeFolder || undefined);
}
