import { useStore } from '../../stores';
import { selectArtifacts, selectOpenTabs, selectActiveTabId, getPreviewOwner } from '../../stores/artifact-slice';
import { closeTabForOwner, closePreview, setActiveTabForOwner } from '../../stores/artifact-actions';
import type { Artifact } from '../../types';
import styles from './TabBar.module.css';

export function TabBar() {
  const openTabs = useStore(selectOpenTabs);
  const activeTabId = useStore(selectActiveTabId);
  const artifacts = useStore(selectArtifacts);

  const getTitle = (id: string): string => {
    const a = artifacts.find((art: Artifact) => art.id === id);
    return a?.title ?? id;
  };

  const handleCloseTab = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const owner = getPreviewOwner(useStore.getState());
    closeTabForOwner(owner, id);
    const { previewByOwner } = useStore.getState();
    const after = previewByOwner[owner];
    if (!after || after.openTabs.length === 0) closePreview();
  };

  const handleSetActive = (id: string) => {
    const owner = getPreviewOwner(useStore.getState());
    setActiveTabForOwner(owner, id);
  };

  return (
    <div className={styles.tabBar}>
      <div className={styles.tabList}>
        {openTabs.map(id => (
          <div
            key={id}
            className={`${styles.tab}${id === activeTabId ? ` ${styles.tabActive}` : ''}`}
            onClick={() => handleSetActive(id)}
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
