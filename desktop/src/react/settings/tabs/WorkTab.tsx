import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { t, autoSaveConfig } from '../helpers';
import { Toggle } from '../widgets/Toggle';

const platform = (window as any).platform;

export function WorkTab() {
  const { settingsConfig, showToast } = useSettingsStore();
  const [homeFolder, setHomeFolder] = useState('');
  const [hbEnabled, setHbEnabled] = useState(true);
  const [hbInterval, setHbInterval] = useState(17);
  const [cronAutoApprove, setCronAutoApprove] = useState(true);

  useEffect(() => {
    if (settingsConfig) {
      setHomeFolder(settingsConfig.desk?.home_folder || '');
      setHbEnabled(settingsConfig.desk?.heartbeat_enabled !== false);
      setHbInterval(settingsConfig.desk?.heartbeat_interval ?? 17);
      setCronAutoApprove(settingsConfig.desk?.cron_auto_approve !== false);
    }
  }, [settingsConfig]);

  const pickHomeFolder = async () => {
    const folder = await platform?.selectFolder?.();
    if (!folder) return;
    setHomeFolder(folder);
    useSettingsStore.setState({ homeFolder: folder });
    await autoSaveConfig({ desk: { home_folder: folder } });
  };

  const clearHomeFolder = async () => {
    setHomeFolder('');
    useSettingsStore.setState({ homeFolder: null });
    await autoSaveConfig({ desk: { home_folder: '' } });
  };

  const toggleHeartbeat = async (on: boolean) => {
    setHbEnabled(on);
    await autoSaveConfig({ desk: { heartbeat_enabled: on } });
  };

  const toggleCronAutoApprove = async (on: boolean) => {
    setCronAutoApprove(on);
    await autoSaveConfig({ desk: { cron_auto_approve: on } });
  };

  const saveWork = async () => {
    const interval = Math.max(1, Math.min(120, hbInterval));
    await autoSaveConfig({ desk: { heartbeat_interval: interval } });
  };

  return (
    <div className="settings-tab-content active" data-tab="work">
      {/* 主文件夹 */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.work.homeFolder')}</h2>
        <p className="settings-desc settings-desc-compact">
          {t('settings.work.homeFolderDesc')}
        </p>
        <div className="settings-folder-picker">
          <input
            type="text"
            className="settings-input settings-folder-input"
            readOnly
            value={homeFolder}
            placeholder={t('settings.work.homeFolderPlaceholder')}
            onClick={pickHomeFolder}
          />
          <button className="settings-folder-browse" onClick={pickHomeFolder}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          {homeFolder && (
            <button
              className="settings-folder-clear"
              onClick={clearHomeFolder}
              title={t('settings.work.homeFolderClear')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </section>

      {/* 巡检 */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.work.title')}</h2>
        <div className="tool-caps-group">
          <div className="tool-caps-item">
            <div className="tool-caps-label">
              <span className="tool-caps-name">{t('settings.work.heartbeatEnabled')}</span>
              <span className="tool-caps-desc">{t('settings.work.heartbeatDesc')}</span>
            </div>
            <Toggle
              on={hbEnabled}
              onChange={toggleHeartbeat}
            />
          </div>
          <div className={`tool-caps-item${hbEnabled ? '' : ' settings-disabled'}`}>
            <div className="tool-caps-label">
              <span className="tool-caps-name">{t('settings.work.heartbeatInterval')}</span>
            </div>
            <div className="settings-input-group">
              <input
                type="number"
                className="settings-input small"
                min={1}
                max={120}
                value={hbInterval}
                disabled={!hbEnabled}
                onChange={(e) => setHbInterval(parseInt(e.target.value) || 15)}
              />
              <span className="settings-input-unit">{t('settings.work.heartbeatUnit')}</span>
            </div>
          </div>
          <div className="tool-caps-item">
            <div className="tool-caps-label">
              <span className="tool-caps-name">{t('settings.work.cronAutoApprove')}</span>
              <span className="tool-caps-desc">{t('settings.work.cronAutoApproveDesc')}</span>
            </div>
            <Toggle
              on={cronAutoApprove}
              onChange={toggleCronAutoApprove}
            />
          </div>
        </div>
      </section>

      <div className="settings-section-footer">
        <button className="settings-save-btn-sm" onClick={saveWork}>
          {t('settings.save')}
        </button>
      </div>
    </div>
  );
}
