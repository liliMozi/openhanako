import React, { useState, useCallback, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { MediaProviderDetail } from './media/MediaProviderDetail';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import styles from '../Settings.module.css';

interface MediaProvider {
  providerId: string;
  displayName?: string;
  hasCredentials: boolean;
  models: { id: string; name: string }[];
  availableModels: { id: string; name: string }[];
}

interface MediaConfig {
  defaultImageModel?: { id: string; provider: string };
  providerDefaults?: Record<string, any>;
}

interface TTSVoice {
  id: string;
  name: string;
  lang: string;
  desc: string;
}

interface TTSConfig {
  voices: TTSVoice[];
  config: { defaultVoice?: string };
}

interface TTSCredentials {
  appId: string;
  accessToken: string;
  resourceId: string;
}

export function MediaTab() {
  const [providers, setProviders] = useState<Record<string, MediaProvider>>({});
  const [config, setConfig] = useState<MediaConfig>({});
  const [selected, setSelected] = useState<string | null>(null);
  const { showToast } = useSettingsStore();

  const load = useCallback(async () => {
    try {
      const agentId = useSettingsStore.getState().getSettingsAgentId();
      const res = await hanaFetch(`/api/plugins/image-gen/providers?agentId=${agentId}`);
      const data = await res.json();
      setProviders(data.providers || {});
      setConfig(data.config || {});
      // Auto-select first provider
      if (!selected) {
        const ids = Object.keys(data.providers || {});
        if (ids.length > 0) setSelected(ids[0]);
      }
    } catch { /* plugin not loaded yet */ }
  }, [selected]);

  useEffect(() => { load(); }, [load]);

  const [ttsData, setTtsData] = useState<TTSConfig | null>(null);
  const [ttsCreds, setTtsCreds] = useState<TTSCredentials>({ appId: '', accessToken: '', resourceId: 'seed-tts-2.0' });

  const loadTTS = useCallback(async () => {
    try {
      const [voicesRes, credsRes] = await Promise.all([
        hanaFetch('/api/plugins/tts/voices'),
        hanaFetch('/api/plugins/tts/credentials'),
      ]);
      const voicesData = await voicesRes.json();
      const credsData = await credsRes.json();
      setTtsData(voicesData);
      setTtsCreds(credsData);
    } catch { /* plugin not loaded yet */ }
  }, []);

  useEffect(() => { loadTTS(); }, [loadTTS]);

  const saveTTSConfig = async (updates: Record<string, any>) => {
    try {
      await hanaFetch('/api/plugins/tts/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      setTtsData(prev => prev ? { ...prev, config: { ...prev.config, ...updates } } : prev);
      showToast(t('settings.saved'), 'success');
    } catch (err: any) {
      showToast(err.message || 'Save failed', 'error');
    }
  };

  const saveTTSCredentials = async () => {
    try {
      await hanaFetch('/api/plugins/tts/credentials', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ttsCreds),
      });
      showToast(t('settings.saved'), 'success');
    } catch (err: any) {
      showToast(err.message || 'Save failed', 'error');
    }
  };

  const providerIds = Object.keys(providers);
  const allImageModels = providerIds.flatMap(pid =>
    (providers[pid].models || []).map(m => ({ ...m, provider: pid }))
  );

  const saveConfig = async (updates: Partial<MediaConfig>) => {
    try {
      const agentId = useSettingsStore.getState().getSettingsAgentId();
      await hanaFetch(`/api/plugins/image-gen/config?agentId=${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      setConfig(prev => ({ ...prev, ...updates }));
      showToast(t('settings.saved'), 'success');
    } catch (err: any) {
      showToast(err.message || 'Save failed', 'error');
    }
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="media">
      {/* pv-layout：double-column variant 做外壳，内部 DOM 保留原样 */}
      <SettingsSection variant="double-column">
        <div className={styles['pv-layout']}>
          {/* Left: Provider list */}
          <div className={styles['pv-list']}>
            <div className={styles['pv-list-section-title']}>{t('settings.media.imageGeneration')}</div>
            {providerIds.map(pid => {
              const p = providers[pid];
              return (
                <button
                  key={pid}
                  className={`${styles['pv-list-item']}${selected === pid ? ' ' + styles['selected'] : ''}${!p.hasCredentials ? ' ' + styles['dim'] : ''}`}
                  onClick={() => setSelected(pid)}
                >
                  <span className={`${styles['pv-status-dot']}${p.hasCredentials ? ' ' + styles['on'] : ''}`} />
                  <span className={styles['pv-list-item-name']}>{p.displayName || pid}</span>
                  <span className={styles['pv-list-item-count']}>{p.models.length}</span>
                </button>
              );
            })}

            {/* Placeholder sections for future capabilities */}
            <div className={styles['pv-list-divider']} />
            <div className={styles['pv-list-section-title']} style={{ color: 'var(--text-muted)' }}>
              {t('settings.media.speechRecognition')}
            </div>
            <div className={styles['pv-list-item']} style={{ opacity: 0.3, pointerEvents: 'none' }}>
              <span className={styles['pv-status-dot']} />
              <span className={styles['pv-list-item-name']} style={{ fontStyle: 'italic', fontSize: '0.7rem' }}>
                {t('settings.media.comingSoon')}
              </span>
            </div>

            <div className={styles['pv-list-divider']} />
            <div className={styles['pv-list-section-title']}>
              {t('settings.media.speechSynthesis')}
            </div>
            <div
              className={`${styles['pv-list-item']}${selected === '__tts__' ? ' ' + styles['selected'] : ''}`}
              onClick={() => setSelected('__tts__')}
            >
              <span className={`${styles['pv-status-dot']} ${styles['on']}`} />
              <span className={styles['pv-list-item-name']}>
                {t('settings.media.ttsActive')}
              </span>
            </div>
          </div>

          {/* Right: Provider detail */}
          <div className={styles['pv-detail']}>
            {selected === '__tts__' ? (
              <div className={styles['pv-provider-detail']}>
                <div className={styles['pv-provider-header']}>
                  <span className={`${styles['pv-status-dot']} ${styles['on']}`} />
                  <span className={styles['pv-provider-name']}>{t('settings.media.ttsActive')}</span>
                </div>
                <div className={styles['pv-models']}>
                  {/* 凭证配置 */}
                  <div className={styles['pv-fav-section']}>
                    <div className={styles['pv-fav-title']}>API 凭证</div>
                    <div style={{ marginTop: 'var(--space-sm)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <div>
                        <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>App ID</label>
                        <input
                          className={styles['settings-input']}
                          type="text"
                          value={ttsCreds.appId}
                          onChange={(e) => setTtsCreds(prev => ({ ...prev, appId: e.target.value }))}
                          placeholder="3280558679"
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Access Token</label>
                        <input
                          className={styles['settings-input']}
                          type="password"
                          value={ttsCreds.accessToken}
                          onChange={(e) => setTtsCreds(prev => ({ ...prev, accessToken: e.target.value }))}
                          placeholder="wfC3JAKHzZLqEb..."
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Resource ID</label>
                        <input
                          className={styles['settings-input']}
                          type="text"
                          value={ttsCreds.resourceId}
                          onChange={(e) => setTtsCreds(prev => ({ ...prev, resourceId: e.target.value }))}
                          placeholder="seed-tts-2.0"
                        />
                      </div>
                      <button
                        className={styles['settings-button']}
                        onClick={saveTTSCredentials}
                        style={{ alignSelf: 'flex-start' }}
                      >
                        保存凭证
                      </button>
                    </div>
                  </div>

                  {/* 默认音色 */}
                  <div className={styles['pv-fav-section']}>
                    <div className={styles['pv-fav-title']}>
                      {t('settings.media.ttsDefaultVoice')}
                    </div>
                    {ttsData && ttsData.voices?.length > 0 && (
                      <div style={{ marginTop: 'var(--space-sm)' }}>
                        <select
                          className={styles['settings-select']}
                          style={{ width: '100%' }}
                          value={ttsData.config.defaultVoice || ''}
                          onChange={(e) => saveTTSConfig({ defaultVoice: e.target.value })}
                        >
                          <option value="">{ttsData.config.defaultVoice ? t('settings.media.noDefault') : '—'}</option>
                          {ttsData.voices.map(v => (
                            <option key={v.id} value={v.id}>
                              {v.name} ({v.desc}) — {v.id}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : selected && providers[selected] ? (
              <MediaProviderDetail
                providerId={selected}
                provider={providers[selected]}
                config={config}
                onSaveConfig={saveConfig}
                onRefresh={load}
              />
            ) : (
              <div className={styles['pv-empty']}>
                {t('settings.media.noProvider')}
              </div>
            )}
          </div>
        </div>
      </SettingsSection>

      {/* TTS 默认音色 — 在右侧 detail 区域渲染 */}

      {/* 全局默认：标准 inline row */}
      <SettingsSection title={t('settings.media.globalDefault')}>
        <SettingsRow
          label={t('settings.media.defaultModel')}
          control={
            <select
              className={styles['settings-select']}
              value={config.defaultImageModel ? `${config.defaultImageModel.provider}/${config.defaultImageModel.id}` : ''}
              onChange={(e) => {
                const val = e.target.value;
                if (!val) {
                  saveConfig({ defaultImageModel: undefined });
                  return;
                }
                const [provider, ...rest] = val.split('/');
                saveConfig({ defaultImageModel: { id: rest.join('/'), provider } });
              }}
            >
              <option value="">—</option>
              {allImageModels.map(m => (
                <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                  {m.provider} / {m.name || m.id}
                </option>
              ))}
            </select>
          }
        />
      </SettingsSection>
    </div>
  );
}
