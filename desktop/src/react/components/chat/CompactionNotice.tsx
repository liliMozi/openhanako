/**
 * CompactionNotice — 上下文压缩提示（列表独立行）
 */

import { memo } from 'react';

interface Props {
  yuan: string;
}

export const CompactionNotice = memo(function CompactionNotice({ yuan }: Props) {
  return (
    <div className="compaction-notice" data-yuan={yuan}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="17 1 21 5 17 9" />
        <path d="M3 11V9a4 4 0 0 1 4-4h14" />
        <polyline points="7 23 3 19 7 15" />
        <path d="M21 13v2a4 4 0 0 1-4 4H3" />
      </svg>
      上下文压缩中
      <span className="thinking-dots"><span /><span /><span /></span>
    </div>
  );
});
