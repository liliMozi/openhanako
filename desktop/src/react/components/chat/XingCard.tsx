/**
 * XingCard — 行省反思卡片
 */

import { memo, useRef, useEffect, useCallback } from 'react';
import { renderMarkdown } from '../../utils/markdown';
import { injectCopyButtons } from '../../utils/format';

interface Props {
  title: string;
  content: string;
  sealed: boolean;
  agentName?: string;
}

export const XingCard = memo(function XingCard({ title, content, sealed, agentName }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bodyRef.current) injectCopyButtons(bodyRef.current);
  }, [content]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).catch(() => {});
  }, [content]);

  const html = sealed ? renderMarkdown(content) : '';

  return (
    <div className={`xing-card${sealed ? '' : ' loading'}`}>
      <div className="xing-card-title">{title}</div>
      <hr className="xing-card-divider" />
      {sealed ? (
        <>
          <div
            ref={bodyRef}
            className="xing-card-body"
            dangerouslySetInnerHTML={{ __html: html }}
          />
          <button className="xing-card-copy" onClick={handleCopy}>复制</button>
        </>
      ) : (
        <div className="xing-card-status">
          {agentName || 'Hanako'} 正在思考
          <span className="thinking-dots"><span /><span /><span /></span>
        </div>
      )}
    </div>
  );
});
