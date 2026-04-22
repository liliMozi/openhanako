import { useState } from 'react';
import { useI18n } from '../hooks/use-i18n';
import { ArchivedSessionsModal } from './ArchivedSessionsModal';

/**
 * Sidebar 最底部的小方形入口：点击打开 ArchivedSessionsModal。
 * 复用 `sidebar-action-btn` 的幽灵高亮样式（默认透明，hover 才现圆角浅色底）。
 */
export function ArchivedChatsButton() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="sidebar-action-btn"
        title={t('session.archived.entry')}
        aria-label={t('session.archived.entry')}
        onClick={() => setOpen(true)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="21 8 21 21 3 21 3 8" />
          <rect x="1" y="3" width="22" height="5" />
          <line x1="10" y1="12" x2="14" y2="12" />
        </svg>
      </button>
      <ArchivedSessionsModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
