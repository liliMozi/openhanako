/**
 * ThinkingBlock — 可折叠的思考过程区块
 */

import { memo, useState, useCallback } from 'react';
import styles from './Chat.module.css';

interface Props {
  content: string;
  sealed: boolean;
}

export const ThinkingBlock = memo(function ThinkingBlock({ content, sealed }: Props) {
  const t = window.t ?? ((p: string) => p);
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen(v => !v), []);

  return (
    <details className={styles.thinkingBlock} open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className={styles.thinkingBlockSummary} onClick={(e) => { e.preventDefault(); toggle(); }}>
        <span className={`${styles.thinkingBlockArrow}${open ? ` ${styles.thinkingBlockArrowOpen}` : ''}`}>›</span>
        {' '}{sealed ? t('thinking.done') : (
          <>{t('thinking.active')}<span className={styles.thinkingDots}><span /><span /><span /></span></>
        )}
      </summary>
      {open && content && (
        <div className={styles.thinkingBlockBody}>{content}</div>
      )}
    </details>
  );
});
