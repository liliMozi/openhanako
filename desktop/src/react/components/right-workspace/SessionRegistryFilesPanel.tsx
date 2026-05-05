import { useMemo } from 'react';
import { useStore } from '../../stores';
import { selectSessionFiles } from '../../stores/selectors/file-refs';
import type { FileRef } from '../../types/file-ref';
import styles from './RightWorkspacePanel.module.css';

const EMPTY_FILES: readonly FileRef[] = Object.freeze([]);

function statusLabel(file: FileRef): string {
  const t = window.t ?? ((p: string) => p);
  if (file.status === 'expired') return t('rightWorkspace.sessionFiles.status.expired');
  return t('rightWorkspace.sessionFiles.status.available');
}

function sourceLabel(file: FileRef): string {
  return file.source;
}

function formatKind(file: FileRef): string {
  return (file.ext || file.kind || 'file').toUpperCase();
}

export function SessionRegistryFilesPanel() {
  const files = useStore(s => (
    s.currentSessionPath ? selectSessionFiles(s, s.currentSessionPath) : EMPTY_FILES
  ));
  const sortedFiles = useMemo(() => (
    [...files].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
  ), [files]);
  const t = window.t ?? ((p: string) => p);

  return (
    <section className={styles.sessionFilesPanel} aria-label={t('rightWorkspace.tabs.sessionFiles')}>
      {sortedFiles.length === 0 ? (
        <div className={styles.emptyState}>{t('rightWorkspace.sessionFiles.empty')}</div>
      ) : (
        <div className={styles.fileList}>
          {sortedFiles.map(file => (
            <article key={file.id} className={styles.fileRow}>
              <div className={styles.fileIcon} aria-hidden="true">
                {formatKind(file).slice(0, 3)}
              </div>
              <div className={styles.fileMain}>
                <div className={styles.fileName} title={file.name}>{file.name}</div>
                <div className={styles.fileMeta}>
                  <span>{sourceLabel(file)}</span>
                  <span>{formatKind(file)}</span>
                  <span>{statusLabel(file)}</span>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
