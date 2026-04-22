import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../hooks/use-i18n';
import {
  listArchivedSessions,
  restoreSession,
  deleteArchivedSession,
  cleanupArchivedSessions,
  showSidebarToast,
  loadSessions,
  type ArchivedSession,
} from '../stores/session-actions';
import styles from './ArchivedSessionsModal.module.css';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatAgo(iso: string, t: (k: string, v?: Record<string, string | number>) => string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400_000);
  if (days < 1) return t('time.today');
  if (days === 1) return t('time.yesterday');
  return t('session.archived.daysAgo', { days });
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ArchivedSessionsModal({ open, onClose }: Props) {
  const { t } = useI18n();
  const [list, setList] = useState<ArchivedSession[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setList(await listArchivedSessions());
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  if (!open) return null;

  const totalSize = list.reduce((s, x) => s + x.sizeBytes, 0);

  const handleRestore = async (p: string) => {
    if (!window.confirm(t('session.archived.restoreConfirm'))) return;
    const r = await restoreSession(p);
    if (r === 'conflict') {
      showSidebarToast(t('session.archived.restoreConflict'));
      return;
    }
    if (r === 'error') {
      showSidebarToast(t('session.archived.restoreFailed'));
      return;
    }
    await refresh();
    // 恢复后主列表应同步刷新
    await loadSessions();
  };

  const handleDelete = async (p: string) => {
    if (!window.confirm(t('session.archived.deleteConfirm'))) return;
    const ok = await deleteArchivedSession(p);
    if (ok) await refresh();
    else showSidebarToast(t('session.archived.deleteFailed'));
  };

  const handleCleanup = async (days: 30 | 90) => {
    const toDelete = list.filter(
      (x) => Date.now() - new Date(x.archivedAt).getTime() > days * 86400_000,
    );
    if (toDelete.length === 0) {
      showSidebarToast(t('session.archived.cleanupNoMatch'));
      return;
    }
    const size = toDelete.reduce((s, x) => s + x.sizeBytes, 0);
    const msg = t('session.archived.cleanupConfirm', {
      count: toDelete.length,
      size: formatBytes(size),
    });
    if (!window.confirm(msg)) return;
    const { deleted } = await cleanupArchivedSessions(days);
    showSidebarToast(t('session.archived.cleanupDone', { count: deleted }));
    await refresh();
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>{t('session.archived.title')}</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className={styles.stats}>
          <span>
            {t('session.archived.stats', {
              count: list.length,
              size: formatBytes(totalSize),
            })}
          </span>
          <div className={styles.cleanupBtns}>
            <button onClick={() => handleCleanup(30)}>
              {t('session.archived.cleanup30')}
            </button>
            <button onClick={() => handleCleanup(90)}>
              {t('session.archived.cleanup90')}
            </button>
          </div>
        </div>

        <div className={styles.list}>
          {loading ? (
            <div className={styles.loading}>{t('common.loading')}</div>
          ) : list.length === 0 ? (
            <div className={styles.empty}>{t('session.archived.empty')}</div>
          ) : (
            list.map((item) => (
              <div key={item.path} className={styles.row}>
                <div className={styles.rowMain}>
                  <div className={styles.rowTitle}>
                    {item.title || t('session.untitled')}
                  </div>
                  <div className={styles.rowMeta}>
                    {item.agentName} · {formatAgo(item.archivedAt, t)} ·{' '}
                    {formatBytes(item.sizeBytes)}
                  </div>
                </div>
                <div className={styles.rowActions}>
                  <button
                    title={t('session.archived.restore')}
                    onClick={() => handleRestore(item.path)}
                  >
                    {t('session.archived.restore')}
                  </button>
                  <button
                    title={t('session.archived.deleteForever')}
                    onClick={() => handleDelete(item.path)}
                  >
                    {t('session.archived.deleteForever')}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
