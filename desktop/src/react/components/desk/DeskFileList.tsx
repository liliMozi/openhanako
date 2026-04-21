/**
 * DeskFileList — 文件网格 + 橡皮筋框选
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import {
  loadDeskFiles,
  deskCurrentDir,
  deskCreateFile,
  deskMkdir,
  deskRenameFile,
} from '../../stores/desk-actions';
import { sortDeskFiles, type SortMode, type CtxMenuState } from './desk-types';
import { DeskFileItem } from './DeskFileItem';
import s from './Desk.module.css';

const RUBBER_BAND_MIN = 4; // px threshold to start rubber band

export function DeskFileList({ sortMode, onShowMenu }: { sortMode: SortMode; onShowMenu: (state: CtxMenuState) => void }) {
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
    await deskRenameFile(renamingFile, newName);
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
    if ((e.target as HTMLElement).closest('[data-desk-item]')) return;
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
      listRef.current.querySelectorAll('[data-desk-item]').forEach(el => {
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
    if ((e.target as HTMLElement).closest('[data-desk-item]')) return;
    e.preventDefault();
    e.stopPropagation();
    const tFn = window.t ?? ((p: string) => p);
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
      className={s.list}
      data-empty-text={window.t?.('common.noFiles') || ''}
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
          className={s.rubberBand}
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
