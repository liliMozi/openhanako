/**
 * DeskDropZone — 书桌区域的拖放包装容器
 */

import { useCallback, useState } from 'react';
import {
  deskCurrentDir,
  deskUploadFiles,
  deskCreateFile,
  deskMkdir,
} from '../../stores/desk-actions';
import type { CtxMenuState } from './desk-types';
import s from './Desk.module.css';

export function DeskDropZone({ children, onShowMenu }: { children: React.ReactNode; onShowMenu: (state: CtxMenuState) => void }) {
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
    if ((e.target as HTMLElement).closest('[data-desk-item]')) return;
    if ((e.target as HTMLElement).closest('[data-desk-editor]')) return;
    e.preventDefault();
    e.stopPropagation();
    const tFn = window.t ?? ((p: string) => p);
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
    if ((e.target as HTMLElement).closest('[data-desk-cwd-panel]')) return;

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
      className={`jian-card ${s.section}${dragging ? ` ${s.dragOver}` : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onContextMenu={handleContextMenu}
    >
      {children}
    </div>
  );
}
