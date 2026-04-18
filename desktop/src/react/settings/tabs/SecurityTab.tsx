import React, { useState, useCallback } from 'react';
import { useSettingsStore } from '../store';
import { autoSaveConfig, t } from '../helpers';
import { hanaFetch } from '../api';
import { loadSettingsConfig } from '../actions';
import { Toggle } from '../widgets/Toggle';
import styles from '../Settings.module.css';

interface Checkpoint {
  id: string;
  ts: number;
  tool: string;
  path: string;
  size: number;
}

const RETENTION_OPTIONS = [
  { value: 1, key: 'settings.security.retention1d' },
  { value: 3, key: 'settings.security.retention3d' },
  { value: 7, key: 'settings.security.retention7d' },
];

const SIZE_OPTIONS = [
  { value: 512, label: '512 KB' },
  { value: 1024, label: '1 MB' },
  { value: 5120, label: '5 MB' },
  { value: 10240, label: '10 MB' },
];

export function SecurityTab() {
  const { settingsConfig, showToast } = useSettingsStore();
  const sandboxEnabled = settingsConfig?.sandbox !== false;
  const fileBackup = settingsConfig?.file_backup || { enabled: false, retention_days: 1, max_file_size_kb: 1024 };

  const [backupsOpen, setBackupsOpen] = useState(false);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(false);

  const handleSandboxToggle = useCallback(async (on: boolean) => {
    await autoSaveConfig({ sandbox: on }, { silent: true });
    await loadSettingsConfig();
  }, []);

  const handleBackupToggle = useCallback(async (on: boolean) => {
    const current = useSettingsStore.getState().settingsConfig?.file_backup || {};
    await autoSaveConfig({ file_backup: { ...current, enabled: on } }, { silent: true });
    await loadSettingsConfig();
  }, []);

  const handleRetentionChange = useCallback(async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const days = parseInt(e.target.value, 10);
    const current = useSettingsStore.getState().settingsConfig?.file_backup || {};
    await autoSaveConfig({ file_backup: { ...current, retention_days: days } }, { silent: true });
    await loadSettingsConfig();
  }, []);

  const handleMaxSizeChange = useCallback(async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const kb = parseInt(e.target.value, 10);
    const current = useSettingsStore.getState().settingsConfig?.file_backup || {};
    await autoSaveConfig({ file_backup: { ...current, max_file_size_kb: kb } }, { silent: true });
    await loadSettingsConfig();
  }, []);

  const loadCheckpoints = useCallback(async () => {
    setLoading(true);
    try {
      const res = await hanaFetch('/api/checkpoints');
      const data = await res.json();
      setCheckpoints(data.checkpoints || []);
    } catch {
      setCheckpoints([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRestore = useCallback(async (id: string) => {
    try {
      const res = await hanaFetch(`/api/checkpoints/${id}/restore`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        showToast(t('settings.security.restoreSuccess'), 'success');
      } else {
        showToast(t('settings.security.restoreFailed'), 'error');
      }
    } catch {
      showToast(t('settings.security.restoreFailed'), 'error');
    }
  }, [showToast]);

  const toggleBackups = useCallback(() => {
    const next = !backupsOpen;
    setBackupsOpen(next);
    if (next) loadCheckpoints();
  }, [backupsOpen, loadCheckpoints]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleString();
  };

  const formatPath = (p: string) => {
    const parts = p.split('/').filter(Boolean);
    if (parts.length <= 2) return p;
    return '.../' + parts.slice(-2).join('/');
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="security">
      {/* Sandbox Section */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.security.sandbox')}</h2>
        <div className={styles['tool-caps-group']}>
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.security.sandbox')}</span>
              <span className={styles['tool-caps-desc']}>{t('settings.security.sandboxDesc')}</span>
            </div>
            <Toggle on={sandboxEnabled} onChange={handleSandboxToggle} />
          </div>
        </div>
        {!sandboxEnabled && (
          <p className={`${styles['tool-caps-desc']} ${styles['warn']} ${styles['settings-section-hint']}`}>
            {t('settings.security.sandboxWarning')}
          </p>
        )}
      </section>

      {/* File Backup Section */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.security.fileBackup')}</h2>
        <div className={styles['tool-caps-group']}>
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.security.fileBackup')}</span>
              <span className={styles['tool-caps-desc']}>{t('settings.security.fileBackupDesc')}</span>
            </div>
            <Toggle on={fileBackup.enabled} onChange={handleBackupToggle} />
          </div>

          {fileBackup.enabled && (
            <>
              <div className={styles['tool-caps-item']}>
                <span className={styles['tool-caps-name']}>{t('settings.security.retention')}</span>
                <select
                  className={styles['settings-select']}
                  value={fileBackup.retention_days}
                  onChange={handleRetentionChange}
                >
                  {RETENTION_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{t(opt.key)}</option>
                  ))}
                </select>
              </div>

              <div className={styles['tool-caps-item']}>
                <span className={styles['tool-caps-name']}>{t('settings.security.maxFileSize')}</span>
                <select
                  className={styles['settings-select']}
                  value={fileBackup.max_file_size_kb}
                  onChange={handleMaxSizeChange}
                >
                  {SIZE_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <button className={styles['settings-text-btn']} onClick={toggleBackups}>
                {backupsOpen ? t('settings.security.hideBackups') : t('settings.security.viewBackups')}
              </button>

              {backupsOpen && (
                <div className={styles['settings-backup-list']}>
                  {loading ? (
                    <span className={styles['tool-caps-desc']}>...</span>
                  ) : checkpoints.length === 0 ? (
                    <span className={styles['tool-caps-desc']}>{t('settings.security.noBackups')}</span>
                  ) : (
                    checkpoints.map(cp => (
                      <div key={cp.id} className={styles['settings-backup-item']}>
                        <span className={styles['settings-backup-time']}>{formatTime(cp.ts)}</span>
                        <span className={styles['settings-backup-path']}>{formatPath(cp.path)}</span>
                        <button
                          className={styles['settings-backup-restore-btn']}
                          onClick={() => handleRestore(cp.id)}
                        >
                          {t('settings.security.restoreBtn')}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
