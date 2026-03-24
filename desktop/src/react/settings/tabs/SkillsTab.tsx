import React, { useState, useEffect, useCallback } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { SkillRow } from './skills/SkillRow';
import { SkillCapabilities } from './skills/SkillCapabilities';
import { CompatPathDrawer } from './skills/CompatPathDrawer';
import styles from '../Settings.module.css';

const platform = window.platform;

interface ExternalPathsData {
  configured: string[];
  discovered: { dirPath: string; label: string; exists: boolean }[];
}

export function SkillsTab() {
  const { skillsList, settingsConfig, showToast, settingsAgentId } = useSettingsStore();

  const [reloading, setReloading] = useState(false);
  const [externalPathsData, setExternalPathsData] = useState<ExternalPathsData>({
    configured: [],
    discovered: [],
  });

  const loadSkills = useCallback(async () => {
    try {
      const agentId = useSettingsStore.getState().getSettingsAgentId();
      const res = await hanaFetch(`/api/skills${agentId ? `?agentId=${agentId}` : ''}`);
      const data = await res.json();
      useSettingsStore.setState({ skillsList: data.skills || [] });
    } catch (err) {
      console.error('[skills] load failed:', err);
    }
  }, []);

  const loadExternalPaths = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/skills/external-paths');
      const data = await res.json();
      setExternalPathsData({
        configured: data.configured || [],
        discovered: data.discovered || [],
      });
    } catch (err) {
      console.error('[skills] load external paths failed:', err);
    }
  }, []);

  const reloadSkills = useCallback(async () => {
    setReloading(true);
    try {
      const res = await hanaFetch('/api/skills/reload', { method: 'POST' });
      const data = await res.json();
      if (data.skills) {
        useSettingsStore.setState({ skillsList: data.skills });
      } else {
        await loadSkills();
      }
      showToast(t('settings.skills.reloaded'), 'success');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setReloading(false);
    }
  }, [loadSkills, showToast]);

  useEffect(() => {
    loadSkills();
    loadExternalPaths();
  }, [loadSkills, loadExternalPaths, settingsAgentId]);

  const visible = skillsList.filter(s => !s.hidden);
  const userSkills = visible.filter(s => s.source !== 'learned' && s.source !== 'external');
  const learnedSkills = visible.filter(s => s.source === 'learned');
  const externalSkills = visible.filter(s => s.source === 'external');

  // 后台翻译技能名
  const [nameHints, setNameHints] = useState<Record<string, string>>({});
  useEffect(() => {
    const locale = window.i18n?.locale || 'zh';
    if (locale === 'en' || visible.length === 0) return;
    const names = visible.map(s => s.name).filter(n => !nameHints[n]);
    if (names.length === 0) return;
    hanaFetch('/api/skills/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names, lang: locale }),
    })
      .then(r => r.json())
      .then(map => { if (map && typeof map === 'object') setNameHints(prev => ({ ...prev, ...map })); })
      .catch(err => console.warn('[skills] translate failed:', err));
  }, [visible.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const installSkillFromPath = async (filePath: string) => {
    try {
      const res = await hanaFetch('/api/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.skills.installSuccess', { name: data.skill?.name || '' }), 'success');
      await loadSkills();
      if (data.skill?.baseDir) {
        platform?.openSkillViewer?.({
          name: data.skill.name,
          baseDir: data.skill.baseDir,
          filePath: data.skill.filePath,
          installed: true,
        });
      }
    } catch (err: unknown) {
      showToast(t('settings.skills.installError') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const installSkill = async () => {
    const selectedPath = await platform?.selectSkill?.();
    if (!selectedPath) return;
    await installSkillFromPath(selectedPath);
  };

  const deleteSkill = async (name: string) => {
    const msg = t('settings.skills.deleteConfirm', { name });
    if (!confirm(msg)) return;
    try {
      const res = await hanaFetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.autoSaved'), 'success');
      await loadSkills();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const toggleSkill = async (name: string, enable: boolean) => {
    const updated = skillsList.map(s => s.name === name ? { ...s, enabled: enable } : s);
    useSettingsStore.setState({ skillsList: updated });
    const enabledList = updated.filter(s => s.enabled).map(s => s.name);
    try {
      const agentId = useSettingsStore.getState().getSettingsAgentId();
      const res = await hanaFetch(`/api/agents/${agentId}/skills`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabledList }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.autoSaved'), 'success');
      platform?.notifyMainWindow?.('skills-changed', {});
    } catch (err: unknown) {
      const reverted = skillsList.map(s => s.name === name ? { ...s, enabled: !enable } : s);
      useSettingsStore.setState({ skillsList: reverted });
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.remove(styles['drag-over']);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const filePath = platform?.getFilePath?.(file) || (file as File & { path?: string })?.path;
    if (filePath) await installSkillFromPath(filePath);
  };

  const addExternalPath = async () => {
    const folder = await platform?.selectFolder?.();
    if (!folder) return;
    const newPaths = [...externalPathsData.configured, folder];
    try {
      await hanaFetch('/api/skills/external-paths', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: newPaths }),
      });
      await loadExternalPaths();
      await loadSkills();
      showToast(t('settings.autoSaved'), 'success');
      platform?.notifyMainWindow?.('skills-changed', {});
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const removeExternalPath = async (pathToRemove: string) => {
    const newPaths = externalPathsData.configured.filter(p => p !== pathToRemove);
    try {
      await hanaFetch('/api/skills/external-paths', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: newPaths }),
      });
      await loadExternalPaths();
      await loadSkills();
      showToast(t('settings.autoSaved'), 'success');
      platform?.notifyMainWindow?.('skills-changed', {});
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const learnCfg = settingsConfig?.capabilities?.learn_skills || {};
  const discoveredPaths = externalPathsData.discovered;
  const configuredOnlyPaths = externalPathsData.configured.filter(
    p => !discoveredPaths.some(d => d.dirPath === p),
  );

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="skills">
      {/* User skills + drag-and-drop install */}
      <section className={styles['settings-section']}>
        <div className={styles['settings-section-header']}>
          <h2 className={styles['settings-section-title']}>{t('settings.skills.title')}</h2>
          <button
            className={styles['settings-icon-btn']}
            title={t('settings.skills.reload')}
            onClick={reloadSkills}
            disabled={reloading}
          >
            <svg
              width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              className={reloading ? styles['spin'] : ''}
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        </div>

        <div
          className={styles['skills-dropzone']}
          onClick={installSkill}
          onDragOver={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add(styles['drag-over']); }}
          onDragLeave={(e) => (e.currentTarget as HTMLElement).classList.remove(styles['drag-over'])}
          onDrop={handleDrop}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span>{t('settings.skills.dropzone')}</span>
        </div>

        {userSkills.length === 0 ? (
          <p className={`${styles['settings-desc']} ${styles['skills-empty']}`}>{t('settings.skills.noUser')}</p>
        ) : (
          <div className={styles['skills-list-block']}>
            {userSkills.map(skill => (
              <SkillRow
                key={skill.name}
                skill={skill}
                nameHint={nameHints[skill.name]}
                onDelete={deleteSkill}
                onToggle={toggleSkill}
              />
            ))}
          </div>
        )}
      </section>

      {/* Learn capabilities + learned skills */}
      <SkillCapabilities
        learnCfg={learnCfg}
        learnedSkills={learnedSkills}
        nameHints={nameHints}
        onDelete={deleteSkill}
        onToggle={toggleSkill}
      />

      {/* External / compat skills */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.skills.compatTitle')}</h2>
        <p className={styles['settings-desc']}>{t('settings.skills.compatDesc')}</p>

        <div className={styles['compat-paths-group']}>
          {discoveredPaths.map(d => (
            <CompatPathDrawer
              key={d.dirPath}
              dirPath={d.dirPath}
              label={d.label}
              exists={d.exists}
              isCustom={false}
              skills={externalSkills.filter(s => s.externalPath === d.dirPath)}
              nameHints={nameHints}
              onToggle={toggleSkill}
              onRemove={removeExternalPath}
            />
          ))}
          {configuredOnlyPaths.map(p => (
            <CompatPathDrawer
              key={p}
              dirPath={p}
              label={null}
              exists={true}
              isCustom={true}
              skills={externalSkills.filter(s => s.externalPath === p)}
              nameHints={nameHints}
              onToggle={toggleSkill}
              onRemove={removeExternalPath}
            />
          ))}
          <button className={styles['compat-add-path']} onClick={addExternalPath}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>{t('settings.skills.compatAddPath')}</span>
          </button>
        </div>
      </section>
    </div>
  );
}
