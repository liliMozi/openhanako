/**
 * MarkdownContent — 渲染预处理好的 markdown HTML
 *
 * 用 dangerouslySetInnerHTML 设置内容，
 * useEffect 注入代码块复制按钮。
 */

import { memo, useRef, useEffect } from 'react';
import { injectCopyButtons } from '../../utils/format';

interface Props {
  html: string;
  className?: string;
}

export const MarkdownContent = memo(function MarkdownContent({ html, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) injectCopyButtons(ref.current);
  }, [html]);

  return (
    <div
      ref={ref}
      className={className || 'md-content'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
