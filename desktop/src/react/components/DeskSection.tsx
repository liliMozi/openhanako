/**
 * DeskSection — 笺侧栏的书桌内容区
 *
 * 替代旧 desk.js 的 renderDeskFiles / initJianEditor / updateDeskEmptyOverlay 逻辑。
 * 由 App.tsx 在 .jian-chat-content 容器内直接渲染。
 *
 * Phase B: 所有文件操作直接调用 desk-actions。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import type { DeskFile } from '../types';
import { openFilePreview } from '../utils/file-preview';
import {
  loadDeskFiles,
  deskFullPath,
  deskCurrentDir,
  deskMoveFiles,
  deskUploadFiles,
  deskCreateFile,
  deskRemoveFile,
  deskMkdir,
  deskRenameFile,
  saveJianContent,
} from '../stores/desk-actions';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

// ── SVG 图标 ──

const ICONS = {
  folder: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  doc: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>',
  image: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  code: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  pdf: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  finderOpen: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  back: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
  settings: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  sort: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="18" x2="14" y2="18"/></svg>',
};

// ── 排序 ──

const DESK_SORT_KEY = 'hana-desk-sort';

type SortMode = 'mtime-desc' | 'name-asc' | 'name-desc' | 'size-desc' | 'type-asc';

const t = (window as any).t;

function getSortOptions(): Array<{ key: SortMode; label: string }> {
  return [
    { key: 'mtime-desc', label: t('desk.sort.mtime') },
    { key: 'name-asc', label: t('desk.sort.nameAsc') },
    { key: 'name-desc', label: t('desk.sort.nameDesc') },
    { key: 'size-desc', label: t('desk.sort.size') },
    { key: 'type-asc', label: t('desk.sort.type') },
  ];
}

function getSortShort(mode: string): string {
  const map: Record<string, string> = {
    'mtime-desc': t('desk.sort.mtimeShort'),
    'name-asc': t('desk.sort.nameAscShort'),
    'name-desc': t('desk.sort.nameDescShort'),
    'size-desc': t('desk.sort.sizeShort'),
    'type-asc': t('desk.sort.typeShort'),
  };
  return map[mode] || t('desk.sort.label');
}

function getFileIcon(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['md', 'txt'].includes(ext)) return ICONS.doc;
  if (ext === 'pdf') return ICONS.pdf;
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return ICONS.image;
  if (['js', 'ts', 'py', 'json', 'yaml', 'yml', 'html', 'css'].includes(ext)) return ICONS.code;
  return ICONS.file;
}

// ── 共享 context menu 状态（提升到文件列表级别，供子组件共享） ──

interface CtxMenuState {
  items: ContextMenuItem[];
  position: { x: number; y: number };
}

// ── 子组件 ──

function DeskOpenButton() {
  const handleClick = useCallback(() => {
    const s = useStore.getState();
    if (!s.deskBasePath) return;
    const target = s.deskCurrentPath
      ? s.deskBasePath + '/' + s.deskCurrentPath
      : s.deskBasePath;
    window.platform?.showInFinder?.(target);
  }, []);

  return (
    <button className="jian-desk-open" onClick={handleClick}>
      <span dangerouslySetInnerHTML={{ __html: ICONS.finderOpen }} />
      <span>{(window.t ?? ((p: string) => p))('desk.openInFinder')}</span>
    </button>
  );
}

function DeskBreadcrumb() {
  const deskCurrentPath = useStore(s => s.deskCurrentPath);

  const handleBack = useCallback(() => {
    const s = useStore.getState();
    const cur = s.deskCurrentPath;
    if (!cur) return;
    const parent = cur.includes('/')
      ? cur.substring(0, cur.lastIndexOf('/'))
      : '';
    loadDeskFiles(parent);
  }, []);

  if (!deskCurrentPath) return null;

  return (
    <div className="jian-desk-nav">
      <button className="jian-desk-back" onClick={handleBack}>
        <span dangerouslySetInnerHTML={{ __html: ICONS.back }} />
        <span>{deskCurrentPath}</span>
      </button>
    </div>
  );
}

function DeskSortButton({ sortMode, onSort, onShowMenu }: {
  sortMode: SortMode;
  onSort: (m: SortMode) => void;
  onShowMenu: (state: CtxMenuState) => void;
}) {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onShowMenu({
      position: { x: rect.left, y: rect.bottom + 4 },
      items: getSortOptions().map(o => ({
        label: (o.key === sortMode ? '· ' : '   ') + o.label,
        action: () => { localStorage.setItem(DESK_SORT_KEY, o.key); onSort(o.key); },
      })),
    });
  }, [sortMode, onSort, onShowMenu]);

  return (
    <button className="jian-desk-sort-btn" onClick={handleClick}>
      <span dangerouslySetInnerHTML={{ __html: ICONS.sort }} />
      <span>{getSortShort(sortMode)}</span>
    </button>
  );
}

function sortDeskFiles(files: DeskFile[], mode: SortMode): DeskFile[] {
  const filtered = files.filter(f => f.name !== 'jian.md');
  const dirs = filtered.filter(f => f.isDir);
  const regular = filtered.filter(f => !f.isDir);

  const cmp = (a: DeskFile, b: DeskFile): number => {
    switch (mode) {
      case 'name-asc': return a.name.localeCompare(b.name, 'zh');
      case 'name-desc': return b.name.localeCompare(a.name, 'zh');
      case 'size-desc':
        if (a.isDir) return a.name.localeCompare(b.name, 'zh');
        return (b.size ?? 0) - (a.size ?? 0);
      case 'type-asc': {
        const extA = a.name.includes('.') ? a.name.split('.').pop()! : '';
        const extB = b.name.includes('.') ? b.name.split('.').pop()! : '';
        return extA.localeCompare(extB) || a.name.localeCompare(b.name, 'zh');
      }
      case 'mtime-desc':
      default:
        return new Date(b.mtime ?? 0).getTime() - new Date(a.mtime ?? 0).getTime();
    }
  };

  dirs.sort(cmp);
  regular.sort(cmp);
  return [...dirs, ...regular];
}

// ── 内部拖拽追踪（跨平台可靠标识，不依赖 Electron native drag 回路） ──
let _deskDragNames: string[] | null = null;

/** dataTransfer.files 回退路径：区分内部移动 vs 外部上传到子文件夹 */
async function handleExternalDropToFolder(
  e: React.DragEvent,
  folderName: string,
) {
  const s = useStore.getState();
  const basePath = s.deskBasePath;
  const curPath = s.deskCurrentPath;
  const curDir = curPath ? basePath + '/' + curPath : basePath;
  if (!curDir) return;

  const droppedFiles = e.dataTransfer.files;
  if (!droppedFiles || droppedFiles.length === 0) return;

  const paths: string[] = [];
  for (const f of Array.from(droppedFiles)) {
    const p = window.platform?.getFilePath?.(f);
    if (p) paths.push(p);
  }
  if (paths.length === 0) return;

  const toSlash = (str: string) => str.replace(/\\/g, '/');
  const curDirNorm = toSlash(curDir).replace(/\/+$/, '') + '/';
  const internalNames: string[] = [];
  const externalPaths: string[] = [];

  for (const p of paths) {
    const pNorm = toSlash(p);
    if (pNorm.startsWith(curDirNorm)) {
      const rel = pNorm.slice(curDirNorm.length);
      if (!rel.includes('/')) internalNames.push(rel);
      else externalPaths.push(p);
    } else {
      externalPaths.push(p);
    }
  }

  if (internalNames.length > 0) {
    const filtered = internalNames.filter(n => n !== folderName);
    if (filtered.length > 0) await deskMoveFiles(filtered, folderName);
  }

  if (externalPaths.length > 0) {
    const subdir = curPath ? curPath + '/' + folderName : folderName;
    await hanaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'upload', dir: basePath || undefined, subdir, paths: externalPaths }),
    });
    loadDeskFiles(curPath || '');
  }
}

// ── 文件项 ──

interface DeskFileItemProps {
  file: DeskFile;
  selected: boolean;
  onSelect: (name: string, meta: { multi: boolean; shift: boolean }) => void;
  allSelectedFiles: string[];
  renamingFile: string | null;
  renameValue: string;
  onRenameStart: (name: string) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onShowContextMenu: (state: CtxMenuState) => void;
}

function DeskFileItem({
  file, selected, onSelect, allSelectedFiles,
  renamingFile, renameValue, onRenameStart, onRenameChange, onRenameCommit, onRenameCancel,
  onShowContextMenu,
}: DeskFileItemProps) {
  const icon = file.isDir ? ICONS.folder : getFileIcon(file.name);
  const [dropTarget, setDropTarget] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isRenaming = renamingFile === file.name;

  // 当进入 rename 模式时自动聚焦并选择文件名
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      const dotIdx = file.isDir ? -1 : file.name.lastIndexOf('.');
      if (dotIdx > 0) renameInputRef.current.setSelectionRange(0, dotIdx);
      else renameInputRef.current.select();
    }
  }, [isRenaming, file.name, file.isDir]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(file.name, { multi: e.metaKey || e.ctrlKey, shift: e.shiftKey });
  }, [file.name, onSelect]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const filesToDrag = selected ? allSelectedFiles : [file.name];
    _deskDragNames = filesToDrag;
    const clearDrag = () => { _deskDragNames = null; };
    e.currentTarget.addEventListener('dragend', clearDrag, { once: true });
    setTimeout(clearDrag, 2000);

    const paths = filesToDrag
      .map(n => deskFullPath(n))
      .filter(Boolean) as string[];
    if (paths.length > 0) {
      window.platform?.startDrag?.(paths.length === 1 ? paths[0] : paths);
    }
  }, [file.name, selected, allSelectedFiles]);

  const handleDoubleClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const s = useStore.getState();

    if (file.isDir) {
      const sub = s.deskCurrentPath ? s.deskCurrentPath + '/' + file.name : file.name;
      loadDeskFiles(sub);
      return;
    }

    const full = deskFullPath(file.name);
    if (!full) return;
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    openFilePreview(full, file.name, ext);
  }, [file]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const tFn = (window as any).t ?? ((p: string) => p);
    const s = useStore.getState();
    const bulkNames = allSelectedFiles.length > 1 && allSelectedFiles.includes(file.name)
      ? allSelectedFiles : null;
    const items: ContextMenuItem[] = [];

    if (file.isDir) {
      const sub = s.deskCurrentPath ? s.deskCurrentPath + '/' + file.name : file.name;
      items.push({ label: tFn('desk.ctx.open'), action: () => loadDeskFiles(sub) });
      items.push({ label: tFn('desk.ctx.openInFinder'), action: () => { const p = deskFullPath(file.name); if (p) window.platform?.showInFinder?.(p); } });
    } else {
      items.push({ label: tFn('desk.ctx.open'), action: () => { const p = deskFullPath(file.name); if (p) window.platform?.openFile?.(p); } });
    }
    if (!bulkNames) {
      items.push({ label: tFn('desk.ctx.rename'), action: () => onRenameStart(file.name) });
      items.push({ label: tFn('desk.ctx.copyPath'), action: () => { const p = deskFullPath(file.name); if (p) navigator.clipboard.writeText(p).catch(() => {}); } });
    }
    items.push({ divider: true });
    const deleteLabel = bulkNames ? tFn('desk.ctx.deleteN', { n: bulkNames.length }) : tFn('desk.ctx.delete');
    items.push({ label: deleteLabel, danger: true, action: async () => {
      const names = bulkNames || [file.name];
      for (const n of names) await deskRemoveFile(n);
    } });
    onShowContextMenu({ position: { x: e.clientX, y: e.clientY }, items });
  }, [file, allSelectedFiles, onRenameStart, onShowContextMenu]);

  // ── 文件夹作为 drop target ──

  const handleFolderDragOver = useCallback((e: React.DragEvent) => {
    if (!file.isDir) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(true);
  }, [file.isDir]);

  const handleFolderDragLeave = useCallback((e: React.DragEvent) => {
    if (!file.isDir) return;
    const el = e.currentTarget;
    if (!el.contains(e.relatedTarget as Node)) setDropTarget(false);
  }, [file.isDir]);

  const handleFolderDrop = useCallback(async (e: React.DragEvent) => {
    if (!file.isDir) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(false);

    // 优先从 module-level 状态读取（跨平台可靠，不依赖 native drag 回路）
    if (_deskDragNames && _deskDragNames.length > 0) {
      const names = _deskDragNames.filter(n => n !== file.name);
      _deskDragNames = null;
      if (names.length > 0) await deskMoveFiles(names, file.name);
      return;
    }

    // 回退：从 dataTransfer.files 判断（外部拖入，或 Electron native drag 回到同窗口）
    await handleExternalDropToFolder(e, file.name);
  }, [file.isDir, file.name]);

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !(e.nativeEvent as KeyboardEvent & { isComposing: boolean }).isComposing) {
      e.preventDefault();
      onRenameCommit();
    }
    if (e.key === 'Escape') {
      onRenameCancel();
    }
  }, [onRenameCommit, onRenameCancel]);

  return (
    <div
      className={`jian-desk-item${file.isDir ? ' is-dir' : ''}${selected ? ' selected' : ''}${dropTarget ? ' drop-target' : ''}`}
      data-name={file.name}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      draggable
      onDragStart={handleDragStart}
      onDragOver={file.isDir ? handleFolderDragOver : undefined}
      onDragLeave={file.isDir ? handleFolderDragLeave : undefined}
      onDrop={file.isDir ? handleFolderDrop : undefined}
    >
      <span className="jian-desk-item-icon" dangerouslySetInnerHTML={{ __html: icon }} />
      {isRenaming ? (
        <input
          ref={renameInputRef}
          className="jian-desk-rename-input"
          type="text"
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={onRenameCommit}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="jian-desk-item-name" title={file.name}>{file.name}</span>
      )}
    </div>
  );
}

const RUBBER_BAND_MIN = 4; // px threshold to start rubber band

function DeskFileList({ sortMode, onShowMenu }: { sortMode: SortMode; onShowMenu: (state: CtxMenuState) => void }) {
  const deskFiles = useStore(s => s.deskFiles);
  const deskCurrentPath = useStore(s => s.deskCurrentPath);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const lastSelectedRef = useRef<string | null>(null);
  const selectedFilesRef = useRef(selectedFiles);
  selectedFilesRef.current = selectedFiles;
  const [rubberBandRect, setRubberBandRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const rubberBandRef = useRef<{ startX: number; startY: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // ── 内联 rename 状态 ──
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const sorted = useMemo(() => sortDeskFiles(deskFiles, sortMode), [deskFiles, sortMode]);

  const allSelectedArr = useMemo(() => Array.from(selectedFiles), [selectedFiles]);

  // Clear selection on directory change
  useEffect(() => {
    setSelectedFiles(new Set());
    lastSelectedRef.current = null;
    setRenamingFile(null);
  }, [deskCurrentPath]);

  // Cleanup rubber band listeners on unmount
  useEffect(() => () => cleanupRef.current?.(), []);

  const handleRenameStart = useCallback((name: string) => {
    setRenamingFile(name);
    setRenameValue(name);
  }, []);

  const handleRenameCommit = useCallback(async () => {
    if (!renamingFile) return;
    const newName = renameValue.trim();
    if (!newName || newName === renamingFile) {
      setRenamingFile(null);
      return;
    }
    const ok = await deskRenameFile(renamingFile, newName);
    if (!ok) {
      // 失败时恢复原名
    }
    setRenamingFile(null);
  }, [renamingFile, renameValue]);

  const handleRenameCancel = useCallback(() => {
    setRenamingFile(null);
  }, []);

  const handleSelect = useCallback((name: string, meta: { multi: boolean; shift: boolean }) => {
    setSelectedFiles(prev => {
      if (meta.shift && lastSelectedRef.current) {
        const names = sorted.map(f => f.name);
        const from = names.indexOf(lastSelectedRef.current);
        const to = names.indexOf(name);
        if (from >= 0 && to >= 0) {
          const start = Math.min(from, to);
          const end = Math.max(from, to);
          const range = new Set(prev);
          for (let i = start; i <= end; i++) range.add(names[i]);
          return range;
        }
      }
      if (meta.multi) {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name); else next.add(name);
        lastSelectedRef.current = name;
        return next;
      }
      lastSelectedRef.current = name;
      return new Set([name]);
    });
  }, [sorted]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.jian-desk-item')) return;
    if (e.button !== 0) return;

    const additive = e.metaKey || e.ctrlKey || e.shiftKey;
    const baseSelection = additive ? new Set(selectedFilesRef.current) : new Set<string>();
    if (!additive) {
      setSelectedFiles(new Set());
    }

    const startX = e.clientX;
    const startY = e.clientY;
    rubberBandRef.current = { startX, startY };
    let active = false;

    const handleMove = (me: MouseEvent) => {
      const start = rubberBandRef.current;
      if (!start) return;

      if (!active) {
        if (Math.abs(me.clientX - start.startX) < RUBBER_BAND_MIN &&
            Math.abs(me.clientY - start.startY) < RUBBER_BAND_MIN) return;
        active = true;
      }

      const x = Math.min(start.startX, me.clientX);
      const y = Math.min(start.startY, me.clientY);
      const w = Math.abs(me.clientX - start.startX);
      const h = Math.abs(me.clientY - start.startY);
      setRubberBandRect({ x, y, w, h });

      if (!listRef.current) return;
      const bandRect = { left: x, top: y, right: x + w, bottom: y + h };
      const hit = new Set<string>(baseSelection);
      listRef.current.querySelectorAll('.jian-desk-item').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.right > bandRect.left && r.left < bandRect.right &&
            r.bottom > bandRect.top && r.top < bandRect.bottom) {
          const name = (el as HTMLElement).dataset.name;
          if (name) hit.add(name);
        }
      });
      setSelectedFiles(hit);
    };

    const handleUp = () => {
      rubberBandRef.current = null;
      setRubberBandRect(null);
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      cleanupRef.current = null;
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    cleanupRef.current = handleUp;
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.jian-desk-item')) return;
    e.preventDefault();
    e.stopPropagation();
    const tFn = (window as any).t ?? ((p: string) => p);
    onShowMenu({
      position: { x: e.clientX, y: e.clientY },
      items: [
        { label: tFn('desk.ctx.newMdFile'), action: () => deskCreateFile('') },
        { label: tFn('desk.ctx.newFolder'), action: async () => {
          const name = await deskMkdir();
          if (name) {
            // 延迟一帧以确保 store 更新后 React 渲染了新文件夹
            setTimeout(() => handleRenameStart(name), 50);
          }
        } },
        { label: tFn('desk.ctx.openInFinder'), action: () => { const p = deskCurrentDir(); if (p) window.platform?.showInFinder?.(p); } },
      ],
    });
  }, [onShowMenu, handleRenameStart]);

  return (
    <div
      className="jian-desk-list"
      ref={listRef}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
    >
      {sorted.map(f => (
        <DeskFileItem
          key={f.name}
          file={f}
          selected={selectedFiles.has(f.name)}
          onSelect={handleSelect}
          allSelectedFiles={allSelectedArr}
          renamingFile={renamingFile}
          renameValue={renameValue}
          onRenameStart={handleRenameStart}
          onRenameChange={setRenameValue}
          onRenameCommit={handleRenameCommit}
          onRenameCancel={handleRenameCancel}
          onShowContextMenu={onShowMenu}
        />
      ))}
      {rubberBandRect && (
        <div
          className="desk-rubber-band"
          style={{
            position: 'fixed',
            left: rubberBandRect.x,
            top: rubberBandRect.y,
            width: rubberBandRect.w,
            height: rubberBandRect.h,
          }}
        />
      )}
    </div>
  );
}

function JianEditor() {
  const deskJianContent = useStore(s => s.deskJianContent);
  const [localValue, setLocalValue] = useState(deskJianContent || '');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const prevContentRef = useRef(deskJianContent);

  useEffect(() => {
    if (deskJianContent !== prevContentRef.current) {
      setLocalValue(deskJianContent || '');
      prevContentRef.current = deskJianContent;
    }
  }, [deskJianContent]);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setLocalValue(value);

    useStore.setState({ deskJianContent: value });
    prevContentRef.current = value;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveJianContent(value);
    }, 800);
  }, []);

  return (
    <div className="jian-editor">
      <div className="jian-editor-header">
        <span className="jian-editor-label">{(window.t ?? ((p: string) => p))('desk.jianLabel')}</span>
      </div>
      <span className="jian-editor-status" ref={statusRef}></span>
      <textarea
        className="jian-editor-input"
        placeholder={(window.t ?? ((p: string) => p))('desk.jianPlaceholder')}
        spellCheck={false}
        value={localValue}
        onChange={handleInput}
      />
    </div>
  );
}

function DeskEmptyOverlay() {
  const deskBasePath = useStore(s => s.deskBasePath);

  if (deskBasePath) return null;

  return (
    <div className="desk-empty-overlay">
      <p className="desk-empty-text">{(window.t ?? ((p: string) => p))('desk.emptyTitle')}</p>
      <p className="desk-empty-hint">
        {(window.t ?? ((p: string) => p))('desk.emptyHint')}
      </p>
      <button className="desk-empty-btn" onClick={() => window.platform?.openSettings('work')}>
        <span dangerouslySetInnerHTML={{ __html: ICONS.settings }} />
        {(window.t ?? ((p: string) => p))('desk.goToSettings')}
      </button>
    </div>
  );
}

// ── 拖放处理 ──

function DeskDropZone({ children, onShowMenu }: { children: React.ReactNode; onShowMenu: (state: CtxMenuState) => void }) {
  const [dragging, setDragging] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const section = e.currentTarget;
    if (!section.contains(e.relatedTarget as Node)) {
      setDragging(false);
    }
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.jian-desk-item')) return;
    if ((e.target as HTMLElement).closest('.jian-editor')) return;
    e.preventDefault();
    e.stopPropagation();
    const tFn = (window as any).t ?? ((p: string) => p);
    onShowMenu({
      position: { x: e.clientX, y: e.clientY },
      items: [
        { label: tFn('desk.ctx.newMdFile'), action: () => deskCreateFile('') },
        { label: tFn('desk.ctx.newFolder'), action: () => deskMkdir() },
        { label: tFn('desk.ctx.openInFinder'), action: () => { const p = deskCurrentDir(); if (p) window.platform?.showInFinder?.(p); } },
      ],
    });
  }, [onShowMenu]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);

    // 如果 drop 目标在技能面板内，让技能面板自己处理，这里不复制文件
    if ((e.target as HTMLElement).closest('.desk-cwd-panel')) return;

    const files = e.dataTransfer.files;
    const text = e.dataTransfer.getData('text/plain');

    if (files && files.length > 0) {
      const paths: string[] = [];
      for (const f of Array.from(files)) {
        const p = window.platform?.getFilePath?.(f);
        if (p) paths.push(p);
      }
      if (paths.length > 0) {
        await deskUploadFiles(paths);
      }
    } else if (text) {
      await deskCreateFile(text);
    }
  }, []);

  return (
    <div
      className={`jian-card jian-desk-section${dragging ? ' drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onContextMenu={handleContextMenu}
    >
      {children}
    </div>
  );
}

// ── 项目技能（CWD Skills） ──

type CwdSkill = import('../stores/desk-slice').CwdSkillInfo;

/** 加载 CWD skills（可从任何组件调用） */
async function loadCwdSkills() {
  const s = useStore.getState();
  if (!s.deskBasePath) return;
  try {
    const res = await hanaFetch(
      `/api/desk/skills?dir=${encodeURIComponent(s.deskBasePath)}`,
    );
    const data = await res.json();
    useStore.setState({ cwdSkills: data.skills || [] });
  } catch {}
}

function useCwdSkillsOpen() {
  const cwdSkills = useStore(s => s.cwdSkills);
  const cwdSkillsOpen = useStore(s => s.cwdSkillsOpen);
  return {
    open: cwdSkillsOpen,
    skills: cwdSkills,
    toggle: () => useStore.getState().toggleCwdSkillsOpen(),
    setSkills: (skills: CwdSkill[]) => useStore.setState({ cwdSkills: skills }),
  };
}

function DeskCwdSkillsButton() {
  const deskBasePath = useStore(s => s.deskBasePath);
  const { open, skills, toggle } = useCwdSkillsOpen();
  const loadedRef = useRef('');

  useEffect(() => {
    if (deskBasePath && deskBasePath !== loadedRef.current) {
      loadCwdSkills().then(() => { loadedRef.current = deskBasePath; });
    }
  }, [deskBasePath]);

  const handleClick = useCallback(() => {
    if (!open) loadCwdSkills();
    toggle();
  }, [open, toggle]);

  if (!deskBasePath) return null;

  const t = window.t ?? ((p: string) => p);
  const label = skills.length > 0
    ? `${t('desk.cwdSkills') || '项目技能'} · ${skills.length}`
    : t('desk.cwdSkills') || '项目技能';

  return (
    <button
      className={`desk-cwd-btn${open ? ' active' : ''}`}
      onClick={handleClick}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
      <span>{label}</span>
    </button>
  );
}

function DeskCwdSkillsPanel() {
  const { open, skills } = useCwdSkillsOpen();
  const t = window.t ?? ((p: string) => p);
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setVisible(true);
      setClosing(false);
    } else if (visible) {
      setClosing(true);
      const timer = setTimeout(() => { setVisible(false); setClosing(false); }, 80);
      return () => clearTimeout(timer);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const [dragging, setDragging] = useState(false);
  const [cmPos, setCmPos] = useState<{ x: number; y: number } | null>(null);
  const [cmSkill, setCmSkill] = useState<CwdSkill | null>(null);

  useEffect(() => {
    if (!cmPos) return;
    const close = () => { setCmPos(null); setCmSkill(null); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [cmPos]);

  const deleteSkill = useCallback(async (skill: CwdSkill) => {
    if (!skill.baseDir) return;
    try {
      await hanaFetch('/api/desk/delete-skill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillDir: skill.baseDir }),
      });
      await loadCwdSkills();
    } catch (err) {
      console.error('[cwd-skills] delete failed:', err);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    const dir = useStore.getState().deskBasePath;
    console.log('[cwd-skills] drop: files=', files.length, 'dir=', dir);
    if (!dir) return;
    let installed = false;
    for (const file of files) {
      const filePath = (window as any).platform?.getFilePath?.(file);
      console.log('[cwd-skills] filePath=', filePath, 'file.name=', file.name);
      if (!filePath) continue;
      try {
        const res = await hanaFetch('/api/desk/install-skill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath, dir }),
        });
        const data = await res.json();
        if (data.error) {
          console.warn('[cwd-skills] install failed:', data.error);
        } else {
          console.log('[cwd-skills] installed:', data.name);
          installed = true;
        }
      } catch (err) {
        console.error('[cwd-skills] install failed:', err);
      }
    }
    if (installed) await loadCwdSkills();
    (window as any).__loadDeskSkills?.();
  }, []);

  if (!visible) return null;

  const grouped: Record<string, CwdSkill[]> = {};
  for (const s of skills) {
    (grouped[s.source] ??= []).push(s);
  }

  return (
    <div className={`desk-cwd-panel-wrap${closing ? ' closing' : ''}`}>
      <div
        className={`desk-cwd-panel${dragging ? ' drag-over' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCmPos({ x: e.clientX, y: e.clientY });
        }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { handleDrop(e); }}
      >
        <div className="desk-cwd-desc-line">
          <span className="desk-cwd-desc-deco" />
          <span className="desk-cwd-desc-text">{t('desk.cwdSkillsDesc') || '技能跟随工作空间'}</span>
          <span className="desk-cwd-desc-deco" />
        </div>

        {skills.length === 0 ? (
          <>
            <p className="desk-cwd-empty">{t('desk.cwdSkillsEmpty') || '当前文件夹没有项目技能'}</p>
            <p className="desk-cwd-hint">{t('desk.cwdSkillsDrop') || '拖入文件夹或 .zip 安装技能'}</p>
          </>
        ) : (
          <>
            {Object.entries(grouped).map(([source, items]) => (
              <div key={source}>
                <div className="desk-cwd-group-label">{source}</div>
                {items.map(s => {
                  let desc = s.description || '';
                  if (desc.length > 60) desc = desc.slice(0, 60) + '…';
                  return (
                    <div
                      className="desk-cwd-skill-item"
                      key={s.name}
                      onDoubleClick={() => {
                        (window as any).platform?.openSkillViewer?.({
                          name: s.name,
                          baseDir: s.baseDir,
                          filePath: s.filePath,
                          installed: false,
                        });
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setCmPos({ x: e.clientX, y: e.clientY });
                        setCmSkill(s);
                      }}
                    >
                      <span className="desk-cwd-skill-name">{s.name}</span>
                      {desc && <span className="desk-cwd-skill-desc">{desc}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
            <p className="desk-cwd-hint">{t('desk.cwdSkillsDrop') || '拖入文件夹或 .zip 安装技能'}</p>
          </>
        )}
        {cmPos && (
          <div className="desk-cwd-ctx-menu" style={{ position: 'fixed', left: cmPos.x, top: cmPos.y, zIndex: 9999 }}>
            <button onClick={() => {
              const target = cmSkill?.baseDir || (useStore.getState().deskBasePath + '/.agents/skills');
              (window as any).platform?.showInFinder?.(target);
              setCmPos(null);
            }}>
              {t('desk.openInFinder')}
            </button>
            {cmSkill && (
              <button className="desk-cwd-ctx-danger" onClick={() => {
                deleteSkill(cmSkill);
                setCmPos(null);
              }}>
                {t('desk.deleteSkill') || '删除技能'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 技能快捷区 ──

const DESK_SKILLS_KEY = 'hana-desk-skills-collapsed';

function DeskSkillsSection() {
  const skills = useStore(s => s.deskSkills);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(DESK_SKILLS_KEY) === '1',
  );

  const loadDeskSkillsFn = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/skills');
      const data = await res.json();
      const all = (data.skills || []) as Array<{
        name: string; enabled: boolean; hidden?: boolean;
        source?: string; externalLabel?: string | null;
      }>;
      useStore.getState().setDeskSkills(
        all.filter(s => !s.hidden).map(s => ({
          name: s.name,
          enabled: s.enabled,
          source: s.source,
          externalLabel: s.externalLabel,
        })),
      );
    } catch {}
  }, []);

  useEffect(() => {
    loadDeskSkillsFn();
    (window as any).__loadDeskSkills = loadDeskSkillsFn;
    return () => { delete (window as any).__loadDeskSkills; };
  }, [loadDeskSkillsFn]);

  const toggleCollapse = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem(DESK_SKILLS_KEY, next ? '1' : '0');
      return next;
    });
  }, []);

  const toggleSkill = useCallback(async (name: string, enable: boolean) => {
    const prev = useStore.getState().deskSkills;
    useStore.getState().setDeskSkills(
      prev.map(s => s.name === name ? { ...s, enabled: enable } : s),
    );
    const enabledList = prev.map(s => s.name === name ? { ...s, enabled: enable } : s)
      .filter(s => s.enabled).map(s => s.name);
    try {
      const agentId = useStore.getState().currentAgentId || '';
      await hanaFetch(`/api/agents/${agentId}/skills`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabledList }),
      });
    } catch {
      useStore.getState().setDeskSkills(prev);
    }
  }, []);

  const enabledCount = skills.filter(s => s.enabled).length;
  const t = window.t ?? ((p: string) => p);

  if (skills.length === 0) return null;

  return (
    <div className="desk-skills-section">
      <button className="desk-skills-header" onClick={toggleCollapse}>
        <span>{t('desk.skills') || '技能'}</span>
        <span className="desk-skills-count">{enabledCount}</span>
        <svg
          className={`desk-skills-chevron${collapsed ? '' : ' open'}`}
          width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {!collapsed && (
        <div className="desk-skills-list">
          {skills.map(s => (
            <div className="desk-skill-item" key={s.name}>
              <span className="desk-skill-name">{s.name}</span>
              {s.externalLabel && (
                <span className="desk-skill-source">{s.externalLabel}</span>
              )}
              <button
                className={`hana-toggle mini${s.enabled ? ' on' : ''}`}
                onClick={() => toggleSkill(s.name, !s.enabled)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 主组件 ──

export function DeskSection() {
  useStore(s => s.deskFiles);
  const [sortMode, setSortMode] = useState<SortMode>(
    () => (localStorage.getItem(DESK_SORT_KEY) as SortMode) || 'mtime-desc',
  );

  // ── 共享 context menu 状态 ──
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);

  const handleShowMenu = useCallback((state: CtxMenuState) => {
    setCtxMenu(state);
  }, []);

  const handleCloseMenu = useCallback(() => {
    setCtxMenu(null);
  }, []);

  const t = window.t ?? ((p: string) => p);

  return (
    <>
      <DeskDropZone onShowMenu={handleShowMenu}>
        <div className="jian-desk-header">
          <div className="jian-section-title">{t('desk.title')}</div>
          <DeskCwdSkillsButton />
        </div>
        <DeskOpenButton />
        <DeskCwdSkillsPanel />
        <DeskSkillsSection />
        <div className="jian-desk-toolbar">
          <DeskBreadcrumb />
          <DeskSortButton sortMode={sortMode} onSort={setSortMode} onShowMenu={handleShowMenu} />
        </div>
        <DeskFileList sortMode={sortMode} onShowMenu={handleShowMenu} />
        <JianEditor />
        <DeskEmptyOverlay />
      </DeskDropZone>
      {ctxMenu && (
        <ContextMenu
          items={ctxMenu.items}
          position={ctxMenu.position}
          onClose={handleCloseMenu}
        />
      )}
    </>
  );
}
