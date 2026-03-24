/**
 * XingCard — 行省反思卡片
 */

import { memo, useRef, useEffect, useCallback } from 'react';
import styles from './Chat.module.css';
import { renderMarkdown } from '../../utils/markdown';
import { injectCopyButtons } from '../../utils/format';

interface Props {
  title: string;
  content: string;
  sealed: boolean;
  agentName?: string;
}

export const XingCard = memo(function XingCard({ title, content, sealed, agentName }: Props) {
  const t = window.t ?? ((p: string) => p);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bodyRef.current) injectCopyButtons(bodyRef.current);
  }, [content]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).catch(() => {}); // clipboard may reject without focus/permission — non-critical
  }, [content]);

  const html = sealed ? renderMarkdown(content) : '';

  return (
    <div className={`${styles.xingCard}${sealed ? '' : ` ${styles.xingCardLoading}`}`}>
      <div className={styles.xingCardTitle}>{title}</div>
      <hr className={styles.xingCardDivider} />
      {sealed ? (
        <>
          <div
            ref={bodyRef}
            className={styles.xingCardBody}
            dangerouslySetInnerHTML={{ __html: html }}
          />
          <button className={styles.xingCardCopy} onClick={handleCopy}>{t('common.copy')}</button>
        </>
      ) : (
        <div className={styles.xingCardStatus}>
          {t('xing.thinking', { name: agentName || 'Hanako' })}
          <span className={styles.thinkingDots}><span /><span /><span /></span>
        </div>
      )}
    </div>
  );
});
