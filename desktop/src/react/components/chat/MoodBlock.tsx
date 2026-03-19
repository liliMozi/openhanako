/**
 * MoodBlock — 可折叠的 MOOD/PULSE/REFLECT 区块
 */

import { memo, useState, useCallback } from 'react';
import { moodLabel } from '../../utils/message-parser';

interface Props {
  yuan: string;
  text: string;
}

export const MoodBlock = memo(function MoodBlock({ yuan, text }: Props) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen(v => !v), []);

  return (
    <div className="mood-wrapper" data-yuan={yuan}>
      <div className="mood-summary" onClick={toggle}>
        <span className={`mood-arrow${open ? ' open' : ''}`}>›</span>
        {' '}{moodLabel(yuan)}
      </div>
      {open && (
        <div className="mood-block">{text}</div>
      )}
    </div>
  );
});
