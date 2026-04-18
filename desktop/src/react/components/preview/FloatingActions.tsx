import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './FloatingActions.module.css';

interface Props {
  content: string;
  editable: boolean;
  onDetach: () => void;
}

export function FloatingActions({ content, editable, onDetach }: Props) {
  const [copyLabel, setCopyLabel] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      const _t = window.t ?? ((p: string) => p);
      setCopyLabel(_t('attach.copied'));
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopyLabel(null), 1500);
    });
  }, [content]);

  const handleScreenshot = useCallback(async () => {
    const { takeArticleScreenshot } = await import('../../utils/screenshot');
    await takeArticleScreenshot(content);
  }, [content]);

  const t = window.t ?? ((p: string) => p);

  return (
    <div className={styles.floatingActions} data-react-managed>
      <button className={styles.actionBtn} onClick={handleCopy}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <span>{copyLabel ?? t('attach.copy')}</span>
      </button>
      {editable && (
        <button className={styles.actionBtn} title="Open in window" onClick={onDetach}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="7" width="15" height="15" rx="2" ry="2" />
            <path d="M7 2h15v15" />
          </svg>
        </button>
      )}
      <button className={styles.actionBtn} onClick={handleScreenshot} title={t('common.screenshot')}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      </button>
    </div>
  );
}
