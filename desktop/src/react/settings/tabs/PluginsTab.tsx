import React, { useState, useEffect, useCallback } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import styles from '../Settings.module.css';

const platform = window.platform;

interface PluginInfo {
  id: string;
  name: string;
  version?: string;
  description?: string;
  status: 'loaded' | 'failed' | 'disabled' | 'restricted';
  source: 'builtin' | 'community';
  trust: 'restricted' | 'full-access';
  contributions?: string[];
  error?: string | null;
}

/* ── Status badge ── */

function StatusBadge({ status }: { status: PluginInfo['status'] }) {
  const labelKey =
    status === 'loaded' ? 'settings.plugins.statusLoaded' :
    status === 'failed' ? 'settings.plugins.statusFailed' :
    status === 'restricted' ? 'settings.plugins.statusRestricted' :
    'settings.plugins.statusDisabled';

  const style: React.CSSProperties =
    status === 'loaded'
      ? { color: 'var(--success, #5a9)', background: 'rgba(90,170,153,0.1)' }
      : status === 'failed'
      ? { color: 'var(--danger, #c55)', background: 'rgba(204,85,85,0.1)' }
      : status === 'restricted'
      ? { color: 'var(--warning, #c90)', background: 'rgba(204,153,0,0.1)' }
      : { color: 'var(--text-muted)', background: 'var(--overlay-light, rgba(0,0,0,0.06))' };

  return (
    <span className={styles['oauth-status-badge']} style={style}>
      {t(labelKey)}
    </span>
  );
}

/* ── Contribution badges ── */

function ContributionBadges({ contributions }: { contributions?: string[] }) {
  if (!contributions || contributions.length === 0) return null;
  return (
    <span style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
      {contributions.map(c => (
        <span
          key={c}
          className={styles['skills-source-badge']}
          style={{
            marginRight: 0, opacity: 1,
            background: 'var(--overlay-light, rgba(0,0,0,0.05))',
            padding: '1px 6px', borderRadius: 'var(--radius-sm)',
          }}
        >
          {c}
        </span>
      ))}
    </span>
  );
}

/* ── Main tab ── */

export function PluginsTab() {
  const { showToast, pluginAllowFullAccess, pluginUserDir, set } = useSettingsStore();

  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState(false);

  /* ── data fetchers ── */

  const loadPlugins = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/plugins?source=community');
      const data = await res.json();
      setPlugins(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('[plugins] load failed:', err);
      setPlugins([]);
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    await loadPlugins();
    setLoading(false);
  }, [loadPlugins]);

  useEffect(() => { reload(); }, [reload]);

  /* ── full-access toggle ── */

  const toggleFullAccess = async () => {
    const next = !pluginAllowFullAccess;
    set({ pluginAllowFullAccess: next });
    try {
      const res = await hanaFetch('/api/plugins/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow_full_access: next }),
      });
      const data = await res.json();
      if (Array.isArray(data)) setPlugins(data);
      showToast(t('settings.autoSaved'), 'success');
    } catch (err: unknown) {
      set({ pluginAllowFullAccess: !next });
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  /* ── install ── */

  const installFromPath = async (filePath: string) => {
    try {
      const res = await hanaFetch('/api/plugins/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.plugins.installSuccess', { name: data.name || '' }), 'success');
      await loadPlugins();
    } catch (err: unknown) {
      showToast(
        t('settings.plugins.installError') + ': ' + (err instanceof Error ? err.message : String(err)),
        'error',
      );
    }
  };

  const installByPicker = async () => {
    const selectedPath = await platform?.selectPlugin?.();
    if (!selectedPath) return;
    await installFromPath(selectedPath);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const filePath = platform?.getFilePath?.(file) || (file as File & { path?: string })?.path;
    if (filePath) await installFromPath(filePath);
  };

  /* ── enable / disable ── */

  const togglePlugin = async (id: string, enable: boolean) => {
    // Optimistic update
    setPlugins(prev => prev.map(p => p.id === id ? { ...p, status: enable ? 'loaded' : 'disabled' } as PluginInfo : p));
    try {
      const res = await hanaFetch(`/api/plugins/${encodeURIComponent(id)}/enabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enable }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.autoSaved'), 'success');
      await loadPlugins();
    } catch (err: unknown) {
      // Revert
      setPlugins(prev => prev.map(p => p.id === id ? { ...p, status: enable ? 'disabled' : 'loaded' } as PluginInfo : p));
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  /* ── delete ── */

  const deletePlugin = async (plugin: PluginInfo) => {
    const msg = t('settings.plugins.deleteConfirm', { name: plugin.name });
    if (!confirm(msg)) return;
    try {
      const res = await hanaFetch(`/api/plugins/${encodeURIComponent(plugin.id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.autoSaved'), 'success');
      await loadPlugins();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  /* ── render ── */

  const isEnabled = (p: PluginInfo) => p.status === 'loaded' || p.status === 'failed';
  const isDimmed = (p: PluginInfo) => p.status === 'disabled' || p.status === 'restricted';

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="plugins">
      <section className={styles['settings-section']}>
        {/* Header + reload */}
        <div style={{ position: 'relative' }}>
          <h2 className={styles['settings-section-title']}>{t('settings.plugins.title')}</h2>
          <button
            className={styles['settings-icon-btn']}
            style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)' }}
            title={t('settings.plugins.reload')}
            onClick={reload}
            disabled={loading}
          >
            <svg
              width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              className={loading ? styles['spin'] : ''}
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        </div>

        <p className={styles['settings-desc']}>{t('settings.plugins.desc')}</p>

        {/* Drag-and-drop install */}
        <div
          className={`${styles['skills-dropzone']}${dragOver ? ' ' + styles['drag-over'] : ''}`}
          onClick={installByPicker}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span>{t('settings.plugins.dropzone')}</span>
        </div>

        {/* Full-access global toggle */}
        <div className={styles['tool-caps-group']} style={{ marginBottom: 'var(--space-md)' }}>
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.plugins.fullAccessToggle')}</span>
              <span className={styles['tool-caps-desc']}>{t('settings.plugins.fullAccessDesc')}</span>
            </div>
            <button
              className={`hana-toggle${pluginAllowFullAccess ? ' on' : ''}`}
              onClick={toggleFullAccess}
            />
          </div>
        </div>

        {/* Plugin list */}
        {!loading && plugins.length === 0 ? (
          <p className={`${styles['settings-desc']} ${styles['skills-empty']}`}>
            {t('settings.plugins.empty')}
          </p>
        ) : (
          <div className={styles['skills-list-block']}>
            {plugins.map(plugin => {
              const dimmed = isDimmed(plugin);
              const restricted = plugin.status === 'restricted';
              const enabled = isEnabled(plugin);

              return (
                <div
                  key={plugin.id}
                  className={styles['skills-list-item']}
                  style={dimmed ? { opacity: 0.55 } : undefined}
                >
                  <div className={styles['skills-list-info']}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <span className={styles['skills-list-name']}>{plugin.name}</span>
                      {plugin.version && (
                        <span className={styles['skills-list-name-hint']}>v{plugin.version}</span>
                      )}
                      <StatusBadge status={plugin.status} />
                      <ContributionBadges contributions={plugin.contributions} />
                    </div>
                    {plugin.description && (
                      <span className={styles['skills-list-desc']}>{plugin.description}</span>
                    )}
                    {plugin.status === 'failed' && plugin.error && (
                      <span className={styles['skills-list-desc']} style={{ color: 'var(--danger, #c55)' }}>
                        {plugin.error}
                      </span>
                    )}
                    {restricted && (
                      <span className={styles['skills-list-desc']} style={{ color: 'var(--warning, #c90)' }}>
                        {t('settings.plugins.needsFullAccess')}
                      </span>
                    )}
                  </div>

                  <div className={styles['skills-list-actions']}>
                    {/* Delete */}
                    <button
                      className={styles['skill-card-delete']}
                      title={t('settings.plugins.deleteConfirm', { name: plugin.name })}
                      onClick={() => deletePlugin(plugin)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>

                    {/* Enable/disable toggle */}
                    <button
                      className={`hana-toggle${enabled ? ' on' : ''}`}
                      disabled={restricted}
                      onClick={() => togglePlugin(plugin.id, !enabled)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Bottom hint: plugin directory path */}
        {pluginUserDir && (
          <p className={styles['settings-desc']} style={{ marginTop: '12px', fontSize: '11px', opacity: 0.6 }}>
            {t('settings.plugins.pluginsDir', { path: pluginUserDir })}
          </p>
        )}
      </section>
    </div>
  );
}
