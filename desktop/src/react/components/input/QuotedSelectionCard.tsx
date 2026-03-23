import { useStore } from '../../stores';
import styles from './InputArea.module.css';

export function QuotedSelectionCard() {
  const quotedSelection = useStore(s => s.quotedSelection);
  const clearQuotedSelection = useStore(s => s.clearQuotedSelection);

  if (!quotedSelection) return null;

  return (
    <div className={styles['file-tag']}>
      <span className={styles['file-tag-icon']}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="6" y1="4" x2="6" y2="20" />
          <line x1="18" y1="4" x2="18" y2="20" />
          <line x1="6" y1="8" x2="18" y2="8" />
          <line x1="6" y1="16" x2="18" y2="16" />
        </svg>
      </span>
      <span className={styles['file-tag-name']}>{quotedSelection.text}</span>
      <button className={styles['file-tag-remove']} onClick={clearQuotedSelection}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
