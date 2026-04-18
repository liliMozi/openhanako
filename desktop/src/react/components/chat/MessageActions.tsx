// desktop/src/react/components/chat/MessageActions.tsx
import { memo, useCallback } from 'react';
import { useStore } from '../../stores';
import { useI18n } from '../../hooks/use-i18n';
import { selectSelectedIdsBySession } from '../../stores/session-selectors';
import styles from './Chat.module.css';

interface Props {
  messageId: string;
  sessionPath: string;
  onCopy: () => void;
  onScreenshot: () => void;
  copied: boolean;
  isStreaming: boolean;
  align?: 'left' | 'right';
}

export const MessageActions = memo(function MessageActions({
  messageId, sessionPath, onCopy, onScreenshot, copied, isStreaming, align = 'right',
}: Props) {
  const { t } = useI18n();
  const selectedIds = useStore(s => selectSelectedIdsBySession(s, sessionPath));
  const isSelected = selectedIds.includes(messageId);
  const hasSelection = selectedIds.length > 0;
  const toggle = useStore(s => s.toggleMessageSelection);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    toggle(sessionPath, messageId);
  }, [toggle, sessionPath, messageId]);

  return (
    <div
      className={`${styles.msgActions}${align === 'left' ? ` ${styles.msgActionsLeft}` : ''}${isSelected ? ` ${styles.msgActionsVisible}` : ''}`}
    >
      {/* Checkbox */}
      <button
        className={`${styles.msgActionBtn}${isSelected ? ` ${styles.msgActionBtnActive}` : ''}`}
        onClick={handleToggle}
        title={t('common.selectMessage')}
        disabled={isStreaming}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          {isSelected
            ? <>
                <rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" opacity="0.15" />
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <polyline points="9 12 11.5 14.5 16 9" />
              </>
            : <rect x="3" y="3" width="18" height="18" rx="2" />
          }
        </svg>
      </button>

      {/* Copy */}
      <button
        className={`${styles.msgActionBtn}${copied ? ` ${styles.msgActionBtnCopied}` : ''}`}
        onClick={onCopy}
        title={t('common.copyText')}
        disabled={isStreaming}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          {copied
            ? <polyline points="20 6 9 17 4 12" />
            : <>
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </>
          }
        </svg>
        {hasSelection && <span className={styles.msgActionBadge}>{selectedIds.length}</span>}
      </button>

      {/* Screenshot */}
      <button
        className={styles.msgActionBtn}
        onClick={onScreenshot}
        title={t('common.screenshot')}
        disabled={isStreaming}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
        {hasSelection && <span className={styles.msgActionBadge}>{selectedIds.length}</span>}
      </button>
    </div>
  );
});
