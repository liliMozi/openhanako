import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../store';
import { t, autoSaveConfig } from '../helpers';
import { hanaFetch } from '../api';
import { Toggle } from '../widgets/Toggle';
import { AgentSelect } from './bridge/AgentSelect';
import styles from '../Settings.module.css';

const platform = window.platform;

export function WorkTab() {
  const { settingsConfig, showToast, agents, currentAgentId } = useSettingsStore();

  // ── Global state (from settingsConfig, saved via autoSaveConfig) ──
  const [heartbeatMaster, setHeartbeatMaster] = useState(true);
  const [cronAutoApprove, setCronAutoApprove] = useState(true);

  // ── Agent selector ──
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(currentAgentId);
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;

  // Sync initial value when store becomes ready
  useEffect(() => {
    if (selectedAgentId) return;
    if (currentAgentId) setSelectedAgentId(currentAgentId);
  }, [currentAgentId]);

  // ── Per-agent state (fetched from /api/agents/:id/config) ──
  const [homeFolder, setHomeFolder] = useState('');
  const [hbEnabled, setHbEnabled] = useState(true);
  const [hbInterval, setHbInterval] = useState(17);

  // ── Load global fields from settingsConfig ──
  useEffect(() => {
    if (settingsConfig) {
      setHeartbeatMaster(settingsConfig.desk?.heartbeat_master !== false);
      setCronAutoApprove(settingsConfig.desk?.cron_auto_approve !== false);
    }
  }, [settingsConfig]);

  // ── Load per-agent fields when selectedAgentId changes ──
  useEffect(() => {
    if (!selectedAgentId) return;
    const ac = new AbortController();
    hanaFetch(`/api/agents/${selectedAgentId}/config`, { signal: ac.signal })
      .then(r => r.json())
      .then(data => {
        if (ac.signal.aborted) return;
        setHomeFolder(data.desk?.home_folder || '');
        setHbEnabled(data.desk?.heartbeat_enabled !== false);
        setHbInterval(data.desk?.heartbeat_interval ?? 17);
      })
      .catch(err => {
        if (err?.name !== 'AbortError') console.warn('[work] fetch agent config failed:', err);
      });
    return () => ac.abort();
  }, [selectedAgentId]);

  // ── Global actions ──
  const toggleHeartbeatMaster = async (on: boolean) => {
    setHeartbeatMaster(on);
    await autoSaveConfig({ desk: { heartbeat_master: on } });
  };

  const toggleCronAutoApprove = async (on: boolean) => {
    setCronAutoApprove(on);
    await autoSaveConfig({ desk: { cron_auto_approve: on } });
  };

  // ── Per-agent actions ──
  const saveAgentConfig = async (patch: Record<string, any>) => {
    const agentId = selectedAgentIdRef.current;
    if (!agentId) return;
    try {
      const res = await hanaFetch(`/api/agents/${agentId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (selectedAgentIdRef.current === agentId) {
        showToast(t('settings.autoSaved'), 'success');
      }
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  const togglePerAgentHeartbeat = async (on: boolean) => {
    setHbEnabled(on);
    await saveAgentConfig({ desk: { heartbeat_enabled: on } });
  };

  const pickHomeFolder = async () => {
    const folder = await platform?.selectFolder?.();
    if (!folder) return;
    setHomeFolder(folder);
    await saveAgentConfig({ desk: { home_folder: folder } });
  };

  const clearHomeFolder = async () => {
    setHomeFolder('');
    await saveAgentConfig({ desk: { home_folder: '' } });
  };

  const saveInterval = async () => {
    const interval = Math.max(1, Math.min(120, hbInterval));
    await saveAgentConfig({ desk: { heartbeat_interval: interval } });
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="work">
      {/* ── Global section ── */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.work.title')}</h2>
        <div className={styles['tool-caps-group']}>
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.work.heartbeatMaster')}</span>
              <span className={styles['tool-caps-desc']}>{t('settings.work.heartbeatMasterDesc')}</span>
            </div>
            <Toggle on={heartbeatMaster} onChange={toggleHeartbeatMaster} />
          </div>
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.work.cronAutoApprove')}</span>
              <span className={styles['tool-caps-desc']}>{t('settings.work.cronAutoApproveDesc')}</span>
            </div>
            <Toggle on={cronAutoApprove} onChange={toggleCronAutoApprove} />
          </div>
        </div>
      </section>

      {/* ── Agent selector row ── */}
      <section className={styles['settings-section']}>
        <div className={styles['work-agent-row']}>
          <div className={styles['work-agent-select']}>
            <AgentSelect value={selectedAgentId} onChange={setSelectedAgentId} />
          </div>
          <div className={styles['work-agent-hb']}>
            <span className={styles['work-agent-hb-label']}>{t('settings.work.heartbeatEnabled')}</span>
            <Toggle on={hbEnabled} onChange={togglePerAgentHeartbeat} />
          </div>
        </div>
      </section>

      {/* ── Per-agent section ── */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.work.homeFolder')}</h2>
        <p className={`${styles['settings-desc']} ${styles['settings-desc-compact']}`}>
          {t('settings.work.homeFolderDesc')}
        </p>
        <div className={styles['settings-folder-picker']}>
          <input
            type="text"
            className={`${styles['settings-input']} ${styles['settings-folder-input']}`}
            readOnly
            value={homeFolder}
            placeholder={t('settings.work.homeFolderPlaceholder')}
            onClick={pickHomeFolder}
          />
          <button className={styles['settings-folder-browse']} onClick={pickHomeFolder}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          {homeFolder && (
            <button
              className={styles['settings-folder-clear']}
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

        <div className={styles['tool-caps-group']} style={{ marginTop: 16 }}>
          <div className={`${styles['tool-caps-item']}${hbEnabled ? '' : ' settings-disabled'}`}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.work.heartbeatInterval')}</span>
            </div>
            <div className={styles['settings-input-group']}>
              <input
                type="number"
                className={`${styles['settings-input']} ${styles['small']}`}
                min={1}
                max={120}
                value={hbInterval}
                disabled={!hbEnabled}
                onChange={(e) => setHbInterval(parseInt(e.target.value) || 15)}
              />
              <span className={styles['settings-input-unit']}>{t('settings.work.heartbeatUnit')}</span>
            </div>
          </div>
        </div>
      </section>

      <div className={styles['settings-section-footer']}>
        <button className={styles['settings-save-btn-sm']} onClick={saveInterval}>
          {t('settings.save')}
        </button>
      </div>
    </div>
  );
}
