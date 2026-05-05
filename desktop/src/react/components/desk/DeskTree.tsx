/**
 * DeskTree — Obsidian-like single-column workspace tree.
 *
 * Tree state is keyed by explicit subdir strings in desk-slice. The component
 * never derives ownership from the current focused file or session.
 */

import { useCallback, useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { useStore } from '../../stores';
import { loadDeskTreeFiles } from '../../stores/desk-actions';
import { openFilePreview } from '../../utils/file-preview';
import type { DeskFile } from '../../types';
import type { CtxMenuState, SortMode } from './desk-types';
import { ICONS, getFileIcon, sortDeskFiles } from './desk-types';
import s from './Desk.module.css';

function childSubdir(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function parentSubdir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(0, idx) : '';
}

function fullPath(basePath: string, subdir: string): string {
  if (!basePath) return subdir;
  return subdir ? `${basePath}/${subdir}` : basePath;
}

function isDescendant(path: string, parent: string): boolean {
  return path.startsWith(`${parent}/`);
}

function toggleExpanded(paths: string[], subdir: string): string[] {
  if (paths.includes(subdir)) {
    return paths.filter(path => path !== subdir && !isDescendant(path, subdir));
  }
  return [...paths, subdir];
}

function TreeNode({
  file,
  parent,
  depth,
  sortMode,
  onShowMenu,
}: {
  file: DeskFile;
  parent: string;
  depth: number;
  sortMode: SortMode;
  onShowMenu: (state: CtxMenuState) => void;
}) {
  const deskBasePath = useStore(st => st.deskBasePath);
  const treeFilesByPath = useStore(st => st.deskTreeFilesByPath);
  const expandedPaths = useStore(st => st.deskExpandedPaths);
  const selectedPath = useStore(st => st.deskSelectedPath);
  const setDeskExpandedPaths = useStore(st => st.setDeskExpandedPaths);
  const setDeskSelectedPath = useStore(st => st.setDeskSelectedPath);
  const subdir = childSubdir(parent, file.name);
  const expanded = file.isDir && expandedPaths.includes(subdir);
  const selected = selectedPath === subdir;
  const children = treeFilesByPath[subdir] || [];
  const t = window.t ?? ((p: string) => p);

  const select = useCallback(() => {
    setDeskSelectedPath(subdir);
  }, [setDeskSelectedPath, subdir]);

  const toggle = useCallback(() => {
    select();
    if (!file.isDir) return;
    setDeskExpandedPaths(toggleExpanded(expandedPaths, subdir));
    if (!expanded) void loadDeskTreeFiles(subdir);
  }, [expanded, expandedPaths, file.isDir, select, setDeskExpandedPaths, subdir]);

  const openFile = useCallback(() => {
    select();
    if (file.isDir) {
      if (!expanded) toggle();
      return;
    }
    const path = fullPath(deskBasePath, subdir);
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    openFilePreview(path, file.name, ext, { origin: 'desk' });
  }, [deskBasePath, expanded, file, select, subdir, toggle]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const path = fullPath(deskBasePath, subdir);
    onShowMenu({
      position: { x: e.clientX, y: e.clientY },
      items: [
        {
          label: t(file.isDir ? 'desk.ctx.open' : 'desk.openWithDefault'),
          action: () => {
            if (file.isDir) {
              setDeskExpandedPaths(expandedPaths.includes(subdir) ? expandedPaths : [...expandedPaths, subdir]);
              void loadDeskTreeFiles(subdir);
            } else {
              window.platform?.openFile?.(path);
            }
          },
        },
        { label: t('desk.ctx.openInFinder'), action: () => window.platform?.showInFinder?.(path) },
        { label: t('desk.ctx.copyPath'), action: () => navigator.clipboard.writeText(path).catch(() => {}) },
      ],
    });
  }, [deskBasePath, expandedPaths, file.isDir, onShowMenu, setDeskExpandedPaths, subdir, t]);

  return (
    <>
      <div
        className={`${s.treeItem}${selected ? ` ${s.treeItemSelected}` : ''}`}
        role="treeitem"
        aria-label={file.name}
        aria-expanded={file.isDir ? expanded : undefined}
        style={{ '--tree-depth': depth } as CSSProperties}
        onClick={toggle}
        onDoubleClick={openFile}
        onContextMenu={handleContextMenu}
      >
        <span className={s.treeIndent} aria-hidden="true" />
        <span className={s.treeDisclosure} aria-hidden="true">
          {file.isDir ? (expanded ? '⌄' : '›') : ''}
        </span>
        <span
          className={s.itemIcon}
          dangerouslySetInnerHTML={{ __html: file.isDir ? ICONS.folder : getFileIcon(file.name) }}
        />
        <span className={s.itemName} title={file.name}>{file.name}</span>
      </div>
      {expanded && children.length > 0 && (
        <div role="group" className={s.treeGroup}>
          {sortDeskFiles(children, sortMode).map(child => (
            <TreeNode
              key={childSubdir(subdir, child.name)}
              file={child}
              parent={subdir}
              depth={depth + 1}
              sortMode={sortMode}
              onShowMenu={onShowMenu}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function DeskTree({ sortMode, onShowMenu }: {
  sortMode: SortMode;
  onShowMenu: (state: CtxMenuState) => void;
}) {
  const deskBasePath = useStore(s => s.deskBasePath);
  const rootFiles = useStore(s => s.deskTreeFilesByPath[''] || s.deskFiles);
  const sortedRootFiles = useMemo(() => sortDeskFiles(rootFiles, sortMode), [rootFiles, sortMode]);

  useEffect(() => {
    if (!deskBasePath) return;
    void loadDeskTreeFiles('');
  }, [deskBasePath]);

  return (
    <div className={s.tree} role="tree" data-empty-text={window.t?.('common.noFiles') || ''}>
      {sortedRootFiles.map(file => (
        <TreeNode
          key={file.name}
          file={file}
          parent=""
          depth={0}
          sortMode={sortMode}
          onShowMenu={onShowMenu}
        />
      ))}
    </div>
  );
}
