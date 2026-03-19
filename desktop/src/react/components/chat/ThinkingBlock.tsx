/**
 * ThinkingBlock — 可折叠的思考过程区块
 */

import { memo, useState, useCallback } from 'react';

interface Props {
  content: string;
  sealed: boolean;
}

export const ThinkingBlock = memo(function ThinkingBlock({ content, sealed }: Props) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen(v => !v), []);

  return (
    <details className="thinking-block" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="thinking-block-summary" onClick={(e) => { e.preventDefault(); toggle(); }}>
        <span className={`thinking-block-arrow${open ? ' open' : ''}`}>›</span>
        {' '}{sealed ? '思考完成' : (
          <>思考中<span className="thinking-dots"><span /><span /><span /></span></>
        )}
      </summary>
      {open && content && (
        <div className="thinking-block-body">{content}</div>
      )}
    </details>
  );
});
