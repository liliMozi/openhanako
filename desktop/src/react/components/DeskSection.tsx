/**
 * DeskSection — 笺侧栏的书桌内容区（编排层）
 *
 * 替代旧 desk.js 的 renderDeskFiles / initJianEditor / updateDeskEmptyOverlay 逻辑。
 * 由 App.tsx 在 .jian-chat-content 容器内直接渲染。
 *
 * 子组件拆分至 ./desk/ 目录。
 */

import { useCallback, useState } from 'react';
import { useStore } from '../stores';
import { ContextMenu } from './ContextMenu';
import { DESK_SORT_KEY, type SortMode, type CtxMenuState } from './desk/desk-types';
import { DeskOpenButton, DeskBreadcrumb, DeskSortButton } from './desk/DeskToolbar';
import { DeskFileList } from './desk/DeskFileList';
import { JianEditor } from './desk/DeskEditor';
import { DeskDropZone } from './desk/DeskDropZone';
import { DeskEmptyOverlay } from './desk/DeskEmptyOverlay';
import { DeskCwdSkillsButton, DeskCwdSkillsPanel } from './desk/DeskCwdSkills';
import { DeskSkillsSection } from './desk/DeskSkillsSection';
import s from './desk/Desk.module.css';

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
        <div className={s.header}>
          <div className={`jian-section-title ${s.sectionTitle}`}>{t('desk.title')}</div>
          <DeskCwdSkillsButton />
        </div>
        <DeskOpenButton />
        <DeskCwdSkillsPanel />
        <DeskSkillsSection />
        <div className={s.toolbar}>
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
