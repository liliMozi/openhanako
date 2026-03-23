import { useStore } from '../../stores';
import type { Artifact } from '../../types';
import { closePreview } from '../../stores/artifact-actions';
import styles from './TabBar.module.css';

export function TabBar() {
  const openTabs = useStore(s => s.openTabs);
  const activeTabId = useStore(s => s.activeTabId);
  const artifacts = useStore(s => s.artifacts);
  const setActiveTab = useStore(s => s.setActiveTab);
  const closeTab = useStore(s => s.closeTab);

  const getTitle = (id: string): string => {
    const a = artifacts.find((art: Artifact) => art.id === id);
    return a?.title ?? id;
  };

  const handleCloseTab = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    closeTab(id);
    const after = useStore.getState();
    if (after.openTabs.length === 0) closePreview();
  };

  return (
    <div className={styles.tabBar}>
      <div className={styles.tabList}>
        {openTabs.map(id => (
          <div
            key={id}
            className={`${styles.tab}${id === activeTabId ? ` ${styles.tabActive}` : ''}`}
            onClick={() => setActiveTab(id)}
          >
            <span className={styles.tabTitle}>{getTitle(id)}</span>
            <span className={styles.tabClose} onClick={e => handleCloseTab(e, id)}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </span>
          </div>
        ))}
      </div>
      <button className={styles.closePanel} title="Collapse" onClick={closePreview}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
    </div>
  );
}
