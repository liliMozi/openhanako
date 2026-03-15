/**
 * desk-shim.ts — 书桌文件管理 / 右键菜单 / Jian 侧边栏 / 文件夹选择
 *
 * 从 bridge.ts 提取（Phase 6D）。
 */

import { useStore } from '../stores';
import { escapeHtml } from '../utils/format';
import { hanaFetch } from '../hooks/use-hana-fetch';

/* eslint-disable @typescript-eslint/no-explicit-any */

const t = (key: string, vars?: Record<string, any>) => (window as any).t?.(key, vars) ?? key;

// ── 路径工具 ──

function deskFullPath(name: string): string | null {
  const s = useStore.getState();
  if (!s.deskBasePath) return null;
  return s.deskCurrentPath
    ? s.deskBasePath + '/' + s.deskCurrentPath + '/' + name
    : s.deskBasePath + '/' + name;
}

function deskCurrentDir(): string | null {
  const s = useStore.getState();
  if (!s.deskBasePath) return null;
  return s.deskCurrentPath
    ? s.deskBasePath + '/' + s.deskCurrentPath
    : s.deskBasePath;
}

// ── 文件操作 ──

async function loadDeskFiles(subdir?: string, overrideDir?: string): Promise<void> {
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

async function loadJianContent(): Promise<void> {
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

async function saveJianContent(content?: string): Promise<void> {
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

async function deskUploadFiles(paths: string[]): Promise<void> {
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

async function deskCreateFile(text: string): Promise<void> {
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

async function deskMoveFiles(names: string[], destFolder: string): Promise<void> {
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

async function deskRemoveFile(name: string): Promise<void> {
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

async function deskMkdir(): Promise<void> {
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
      setTimeout(() => {
        const newItem = document.querySelector(`.jian-desk-item-name[title="${escapeHtml(name)}"]`)?.parentElement;
        if (newItem) startDeskRename({ name, isDir: true }, newItem as HTMLElement);
      }, 50);
    }
  } catch (err) {
    console.error('[desk] mkdir failed:', err);
  }
}

function startDeskRename(file: { name: string; isDir: boolean }, itemEl: HTMLElement): void {
  const nameSpan = itemEl.querySelector('.jian-desk-item-name');
  if (!nameSpan) return;
  const input = document.createElement('input');
  input.className = 'jian-desk-rename-input';
  input.type = 'text';
  input.value = file.name;
  nameSpan.replaceWith(input);
  input.focus();
  const dotIdx = file.isDir ? -1 : file.name.lastIndexOf('.');
  if (dotIdx > 0) input.setSelectionRange(0, dotIdx);
  else input.select();

  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    if (!newName || newName === file.name) { input.replaceWith(nameSpan); return; }
    try {
      const res = await hanaFetch('/api/desk/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename', dir: useStore.getState().deskBasePath || undefined, subdir: useStore.getState().deskCurrentPath || '', oldName: file.name, newName }),
      });
      const data = await res.json();
      if (data.error) { console.error('[desk] rename error:', data.error); input.replaceWith(nameSpan); return; }
      if (data.files) useStore.getState().setDeskFiles(data.files);
    } catch (err) { console.error('[desk] rename failed:', err); input.replaceWith(nameSpan); }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !(e as KeyboardEvent & { isComposing: boolean }).isComposing) { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { committed = true; input.replaceWith(nameSpan); }
  });
  input.addEventListener('blur', () => commit());
}

// ── 通用右键菜单 ──

let _ctxMenu: HTMLElement | null = null;
let _ctxMenuCleanup: (() => void) | null = null;

function showContextMenu(x: number, y: number, items: Array<{ label?: string; action?: () => void; danger?: boolean; divider?: boolean }>): void {
  hideContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  for (const item of items) {
    if (item.divider) { const d = document.createElement('div'); d.className = 'context-menu-divider'; menu.appendChild(d); continue; }
    const el = document.createElement('div');
    el.className = 'context-menu-item' + (item.danger ? ' danger' : '');
    el.textContent = item.label || '';
    el.addEventListener('click', (e) => { e.stopPropagation(); hideContextMenu(); item.action?.(); });
    menu.appendChild(el);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  _ctxMenu = menu;

  const handleDocumentClick = (event: MouseEvent) => {
    if (_ctxMenu?.contains(event.target as Node)) return;
    hideContextMenu();
  };
  const handleDocumentContextMenu = (event: MouseEvent) => {
    if (_ctxMenu?.contains(event.target as Node)) return;
    hideContextMenu();
  };
  const cleanup = () => {
    document.removeEventListener('click', handleDocumentClick, true);
    document.removeEventListener('contextmenu', handleDocumentContextMenu, true);
    if (_ctxMenuCleanup === cleanup) _ctxMenuCleanup = null;
  };
  _ctxMenuCleanup = cleanup;

  setTimeout(() => {
    if (_ctxMenu !== menu) return;
    document.addEventListener('click', handleDocumentClick, true);
    document.addEventListener('contextmenu', handleDocumentContextMenu, true);
  });
}

function hideContextMenu(): void {
  if (_ctxMenu) {
    _ctxMenu.remove();
    _ctxMenu = null;
  }
  _ctxMenuCleanup?.();
}

function showDeskContextMenu(x: number, y: number, file: { name: string; isDir: boolean } | null, itemEl: HTMLElement | null, selectedNames?: string[]): void {
  const items: Array<{ label?: string; action?: () => void; danger?: boolean; divider?: boolean }> = [];
  const s = useStore.getState();
  // 如果右键的文件在选中集合里，操作整个选中集合；否则只操作单个文件
  const bulkNames = selectedNames && selectedNames.length > 1 && selectedNames.includes(file?.name || '')
    ? selectedNames : null;
  if (file) {
    if (file.isDir) {
      const sub = s.deskCurrentPath ? s.deskCurrentPath + '/' + file.name : file.name;
      items.push({ label: t('desk.ctx.open'), action: () => loadDeskFiles(sub) });
      items.push({ label: t('desk.ctx.openInFinder'), action: () => { const p = deskFullPath(file.name); if (p) (window as any).platform?.showInFinder?.(p); } });
    } else {
      items.push({ label: t('desk.ctx.open'), action: () => { const p = deskFullPath(file.name); if (p) (window as any).platform?.openFile?.(p); } });
    }
    if (!bulkNames) {
      items.push({ label: t('desk.ctx.rename'), action: () => { if (itemEl) startDeskRename(file, itemEl); } });
      items.push({ label: t('desk.ctx.copyPath'), action: () => { const p = deskFullPath(file.name); if (p) navigator.clipboard.writeText(p).catch(() => {}); } });
    }
    items.push({ divider: true });
    const deleteLabel = bulkNames ? t('desk.ctx.deleteN', { n: bulkNames.length }) : t('desk.ctx.delete');
    items.push({ label: deleteLabel, danger: true, action: async () => {
      const names = bulkNames || [file.name];
      for (const n of names) await deskRemoveFile(n);
    } });
  } else {
    items.push({ label: t('desk.ctx.newFolder'), action: () => deskMkdir() });
    items.push({ label: t('desk.ctx.openInFinder'), action: () => { const p = deskCurrentDir(); if (p) (window as any).platform?.showInFinder?.(p); } });
  }
  showContextMenu(x, y, items);
}

// ── Jian 侧边栏 ──

function toggleJianSidebar(forceOpen?: boolean): void {
  const s = useStore.getState();
  const newOpen = forceOpen !== undefined ? forceOpen : !s.jianOpen;
  s.setJianOpen(newOpen);
  const tab = s.currentTab || 'chat';
  localStorage.setItem(`hana-jian-${tab}`, newOpen ? 'open' : 'closed');
  if (forceOpen === undefined) s.setJianAutoCollapsed(false);
  const jianSidebar = document.getElementById('jianSidebar');
  if (newOpen) {
    jianSidebar?.classList.remove('collapsed');
    const sidebarMod = (window as any).HanaModules?.sidebar as { dismissFloat?: () => void } | undefined;
    sidebarMod?.dismissFloat?.();
  } else {
    jianSidebar?.classList.add('collapsed');
  }
  const sidebarMod2 = (window as any).HanaModules?.sidebar as { updateTbToggleState?: () => void } | undefined;
  sidebarMod2?.updateTbToggleState?.();
}

// React WelcomeScreen 负责 memory toggle / folder picker 渲染
function toggleMemory(): void {
  const hanaState = window.__hanaState;
  if (hanaState) hanaState.memoryEnabled = !(hanaState.memoryEnabled as boolean);
}
function updateMemoryToggle(): void { /* React 负责 */ }
function selectFolder(): void { /* React 负责 */ }
function applyFolder(folder: string): void {
  const hanaState = window.__hanaState;
  if (hanaState) hanaState.selectedFolder = folder;
  const s = useStore.getState();
  if (!s.pendingNewSession) {
    if (hanaState) { hanaState.currentSessionPath = null; hanaState.pendingNewSession = true; }
    (hanaState?.clearChat as (() => void) | undefined)?.();
    (document.getElementById('inputBox') as HTMLTextAreaElement | null)?.focus();
  }
  loadDeskFiles('', folder);
}
function updateFolderButton(): void { /* React 负责 */ }

function updateDeskContextBtn(): void {
  const s = useStore.getState();
  const available = !!s.deskBasePath && s.deskFiles.length > 0;
  if (!available && s.deskContextAttached) {
    s.setDeskContextAttached(false);
  }
}

function initJian(): void {
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

export function setupDeskShim(modules: Record<string, unknown>): void {
  modules.desk = {
    initJian, toggleJianSidebar,
    loadDeskFiles, renderDeskFiles: () => { /* React 负责渲染 */ },
    deskFullPath, deskCurrentDir,
    showContextMenu, hideContextMenu, showDeskContextMenu,
    toggleMemory, updateMemoryToggle,
    selectFolder, applyFolder, updateFolderButton,
    updateDeskContextBtn, saveJianContent,
    deskUploadFiles, deskCreateFile, deskRemoveFile, deskMoveFiles, deskMkdir,
    initDesk: () => { /* 不再需要 ctx 注入 */ },
  };
}
