/**
 * DeskToolbar — 面包屑导航、排序按钮、Finder 打开按钮
 */

import { useCallback } from 'react';
import { useStore } from '../../stores';
import { loadDeskFiles } from '../../stores/desk-actions';
import {
  ICONS,
  getSortOptions,
  getSortShort,
  type SortMode,
  type CtxMenuState,
} from './desk-types';
import s from './Desk.module.css';

// ── Open in Finder 按钮 ──

export function DeskOpenButton() {
  const handleClick = useCallback(() => {
    const s = useStore.getState();
    if (!s.deskBasePath) return;
    const target = s.deskCurrentPath
      ? s.deskBasePath + '/' + s.deskCurrentPath
      : s.deskBasePath;
    window.platform?.openFolder?.(target);
  }, []);

  return (
    <button className={s.openBtn} onClick={handleClick}>
      <span dangerouslySetInnerHTML={{ __html: ICONS.finderOpen }} />
      <span>{(window.t ?? ((p: string) => p))('desk.openInFinder')}</span>
    </button>
  );
}

export function DeskOpenIconButton() {
  const hasDesk = useStore(s => !!s.deskBasePath);
  const label = (window.t ?? ((p: string) => p))('desk.openInFinder');
  const handleClick = useCallback(() => {
    const s = useStore.getState();
    if (!s.deskBasePath) return;
    const target = s.deskCurrentPath
      ? s.deskBasePath + '/' + s.deskCurrentPath
      : s.deskBasePath;
    window.platform?.openFolder?.(target);
  }, []);

  return (
    <button className={`${s.sortBtn} ${s.iconBtn}`} onClick={handleClick} title={label} aria-label={label} disabled={!hasDesk}>
      <span dangerouslySetInnerHTML={{ __html: ICONS.finderOpen }} />
    </button>
  );
}

// ── 面包屑导航 ──

export function DeskBreadcrumb() {
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
    <div className={s.nav}>
      <button className={s.backBtn} onClick={handleBack}>
        <span dangerouslySetInnerHTML={{ __html: ICONS.back }} />
        <span>{deskCurrentPath}</span>
      </button>
    </div>
  );
}

// ── 手动刷新按钮 ──

export function DeskRefreshButton() {
  const hasDesk = useStore(s => !!s.deskBasePath);
  const handleClick = useCallback(() => {
    if (!useStore.getState().deskBasePath) return;
    void loadDeskFiles();
  }, []);
  const label = (window.t ?? ((p: string) => p))('desk.refresh');

  return (
    <button className={`${s.sortBtn} ${s.iconBtn}`} onClick={handleClick} title={label} aria-label={label} disabled={!hasDesk}>
      <span dangerouslySetInnerHTML={{ __html: ICONS.refresh }} />
    </button>
  );
}

// ── 排序按钮 ──

export function DeskSortButton({ sortMode, onSort, onShowMenu }: {
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
        action: () => {
          localStorage.setItem('hana-desk-sort', o.key);
          onSort(o.key);
        },
      })),
    });
  }, [sortMode, onSort, onShowMenu]);

  return (
    <button className={s.sortBtn} onClick={handleClick}>
      <span dangerouslySetInnerHTML={{ __html: ICONS.sort }} />
      <span>{getSortShort(sortMode)}</span>
    </button>
  );
}
