import React from 'react';
import type { AutoUpdateState } from '../types';
import styles from './AutoUpdateStatus.module.css';

interface AutoUpdateStatusProps {
  state: AutoUpdateState | null;
  agentName?: string;
  onInstall?: () => void | Promise<unknown>;
}

const t = (key: string, vars?: Record<string, string | number>) => window.t?.(key, vars) ?? key;

function percentOf(state: AutoUpdateState): number {
  const rawPercent = state.progress?.percent ?? 0;
  return Math.max(0, Math.min(100, Math.round(rawPercent)));
}

function InstallIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

export function AutoUpdateStatus({ state, agentName = 'Hanako', onInstall }: AutoUpdateStatusProps) {
  if (!state || state.status === 'idle') {
    return null;
  }

  if (state.status === 'downloading') {
    const percent = percentOf(state);
    return (
      <div className={styles.root}>
        <div className={styles.column}>
          <div className={styles.downloadHeader}>
            <span className={styles.message}>
              {t('settings.about.updateDownloading', { agentName, percent })}
            </span>
            <span className={styles.progressValue}>{t('settings.about.updateProgress', { percent })}</span>
          </div>
          <div className={styles.barTrack} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div className={styles.barFill} style={{ width: `${percent}%` }} />
          </div>
        </div>
      </div>
    );
  }

  if (state.status === 'downloaded') {
    return (
      <div className={styles.root}>
        <div className={styles.column}>
          <div className={styles.row}>
            <span className={styles.message}>{t('settings.about.updateReadyInstall', { version: state.version ?? '' })}</span>
            {onInstall && (
              <button type="button" className={styles.action} onClick={() => void onInstall()}>
                <span>{t('settings.about.updateInstall')}</span>
                <InstallIcon />
              </button>
            )}
          </div>
          <div className={`${styles.message} ${styles.hint}`}>{t('settings.about.updateInstallOnQuit')}</div>
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    const message = state.error === 'disk_space_insufficient'
      ? t('settings.about.updateDiskSpace')
      : state.error === 'running_from_dmg'
        ? t('settings.about.updateNeedInstall')
        : t('settings.about.updateError');

    return (
      <div className={styles.root}>
        <div className={styles.row}>
          <span className={`${styles.message} ${styles.error}`}>{message}</span>
          {state.error && state.error !== 'disk_space_insufficient' && state.error !== 'running_from_dmg' && (
            <span className={styles.errorDetail} title={state.error}>{state.error}</span>
          )}
        </div>
      </div>
    );
  }

  const messages: Partial<Record<AutoUpdateState['status'], string>> = {
    checking: t('settings.about.updateChecking'),
    available: t('settings.about.updateAvailable', { version: state.version ?? '' }),
    installing: t('settings.about.updateInstalling'),
    latest: t('settings.about.updateLatest'),
  };

  const message = messages[state.status];
  if (!message) {
    return null;
  }

  return (
    <div className={styles.root}>
      <div className={styles.row}>
        <span className={styles.message}>{message}</span>
      </div>
    </div>
  );
}
