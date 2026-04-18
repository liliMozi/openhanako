/**
 * MoodBlock — 可折叠的 MOOD/PULSE/REFLECT 区块
 */

import { memo, useState, useCallback } from 'react';
import { moodLabel } from '../../utils/message-parser';
import styles from './Chat.module.css';

interface Props {
  yuan: string;
  text: string;
}

export const MoodBlock = memo(function MoodBlock({ yuan, text }: Props) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen(v => !v), []);

  return (
    <div className={styles.moodWrapper} data-yuan={yuan}>
      <div className={styles.moodSummary} onClick={toggle}>
        <span className={`${styles.moodArrow}${open ? ` ${styles.moodArrowOpen}` : ''}`}>›</span>
        {' '}{moodLabel(yuan)}
      </div>
      {open && (
        <div className={styles.moodBlock}>{text}</div>
      )}
    </div>
  );
});
