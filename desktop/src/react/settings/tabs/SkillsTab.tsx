import React, { useState, useEffect, useCallback } from 'react';
import { useSettingsStore, type SkillInfo } from '../store';
import { hanaFetch } from '../api';
import { t, autoSaveConfig } from '../helpers';
import { Toggle } from '../widgets/Toggle';
import { loadSettingsConfig } from '../actions';

const platform = (window as any).platform;

export function SkillsTab() {
  const { skillsList, settingsConfig, showToast } = useSettingsStore();

  const [reloading, setReloading] = useState(false);

  const loadSkills = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/skills');
      const data = await res.json();
      useSettingsStore.setState({ skillsList: data.skills || [] });
    } catch (err) {
      console.error('[skills] load failed:', err);
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
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setReloading(false);
    }
  }, [loadSkills, showToast]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const visible = skillsList.filter(s => !s.hidden);
  const userSkills = visible.filter(s => s.source !== 'learned');
  const learnedSkills = visible.filter(s => s.source === 'learned');

  // 后台翻译技能名
  const [nameHints, setNameHints] = useState<Record<string, string>>({});
  useEffect(() => {
    const locale = (window as any).i18n?.locale || 'zh';
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
      .catch(() => {});
  }, [visible.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const installSkill = async () => {
    const selectedPath = await platform?.selectSkill?.();
    if (!selectedPath) return;
    await installSkillFromPath(selectedPath);
  };

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
    } catch (err: any) {
      showToast(t('settings.skills.installError') + ': ' + err.message, 'error');
    }
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
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
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
    } catch (err: any) {
      // 回滚
      const reverted = skillsList.map(s => s.name === name ? { ...s, enabled: !enable } : s);
      useSettingsStore.setState({ skillsList: reverted });
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if ((file as any)?.path) await installSkillFromPath((file as any).path);
  };

  // 工具权限
  const learnCfg = settingsConfig?.capabilities?.learn_skills || {};
  const learnEnabled = learnCfg.enabled === true;
  const githubEnabled = learnCfg.allow_github_fetch === true;
  const safetyReviewEnabled = learnCfg.safety_review !== false;

  // warning 弹窗
  const [showGithubWarning, setShowGithubWarning] = useState(false);
  const [showSafetyWarning, setShowSafetyWarning] = useState(false);

  const handleGithubToggle = async (on: boolean) => {
    if (on) {
      setShowGithubWarning(true);
    } else {
      await autoSaveConfig(
        { capabilities: { learn_skills: { allow_github_fetch: false } } },
        { silent: true },
      );
      await loadSettingsConfig();
    }
  };

  const confirmGithubFetch = async () => {
    setShowGithubWarning(false);
    await autoSaveConfig(
      { capabilities: { learn_skills: { allow_github_fetch: true } } },
      { silent: true },
    );
    await loadSettingsConfig();
  };

  return (
    <div className="settings-tab-content active" data-tab="skills">
      <section className="settings-section">
        <div className="settings-section-header">
          <h2 className="settings-section-title">{t('settings.skills.title')}</h2>
          <button
            className="settings-icon-btn"
            title={t('settings.skills.reload')}
            onClick={reloadSkills}
            disabled={reloading}
          >
            <svg
              width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              className={reloading ? 'spin' : ''}
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        </div>

        <div
          className="skills-dropzone"
          onClick={installSkill}
          onDragOver={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add('drag-over'); }}
          onDragLeave={(e) => (e.currentTarget as HTMLElement).classList.remove('drag-over')}
          onDrop={handleDrop}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span>{t('settings.skills.dropzone') || '拖入 .skill 或 .zip 文件'}</span>
        </div>

        {userSkills.length === 0 ? (
          <p className="settings-desc skills-empty">{t('settings.skills.noUser')}</p>
        ) : (
          <div className="skills-list-block">
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

      {/* 自学 Skills：权限 + 已学技能 */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.toolCaps.title') || '自学 Skills'}</h2>

        {learnedSkills.length > 0 && (
          <div className="skills-list-block skills-list-block-spaced">
            {learnedSkills.map(skill => (
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

        <div className="tool-caps-group">
          <div className="tool-caps-item">
            <div className="tool-caps-label">
              <span className="tool-caps-name">自行创建 / 安装技能</span>
              <span className="tool-caps-desc">允许 Agent 编写新技能或通过工具调用安装到自己的目录</span>
            </div>
            <Toggle
              on={learnEnabled}
              onChange={async (on) => {
                if (!on && githubEnabled) {
                  await autoSaveConfig(
                    { capabilities: { learn_skills: { enabled: false, allow_github_fetch: false } } },
                    { silent: true },
                  );
                } else {
                  await autoSaveConfig(
                    { capabilities: { learn_skills: { enabled: on } } },
                    { silent: true },
                  );
                }
                                await loadSettingsConfig();
              }}
            />
          </div>
          {learnEnabled && (
            <div className="tool-caps-item tool-caps-sub">
              <div className="tool-caps-label">
                <span className="tool-caps-name">从 GitHub / ClawHub 主动获取技能</span>
                <span className="tool-caps-desc warn">开启后 Agent 会在执行专业任务时主动搜索并安装合适的技能，请谨慎</span>
              </div>
              <Toggle
                on={githubEnabled}
                onChange={handleGithubToggle}
              />
            </div>
          )}
          {learnEnabled && (
            <div className="tool-caps-item tool-caps-sub">
              <div className="tool-caps-label">
                <span className="tool-caps-name">安装前安全审查</span>
                <span className="tool-caps-desc">安装技能前通过 AI 检测 prompt injection 等安全风险</span>
              </div>
              <Toggle
                on={safetyReviewEnabled}
                onChange={async (on) => {
                  if (!on) {
                    setShowSafetyWarning(true);
                  } else {
                    await autoSaveConfig(
                      { capabilities: { learn_skills: { safety_review: true } } },
                      { silent: true },
                    );
                    await loadSettingsConfig();
                  }
                }}
              />
            </div>
          )}
        </div>
        <p className="settings-hint">{t('settings.skills.learnHint')}</p>
      </section>

      {showGithubWarning && (
        <div className="hana-warning-overlay" onClick={() => setShowGithubWarning(false)}>
          <div className="hana-warning-box" onClick={(e) => e.stopPropagation()}>
            <h3 className="hana-warning-title">关于主动获取技能</h3>
            <div className="hana-warning-body">
              <p>开启后，Agent 在执行专业任务时会主动从 GitHub 和 ClawHub 搜索、下载并安装合适的技能。</p>
              <p>
                虽然安装前会进行自动安全审查和 star 数门槛检查，
                但仍存在以下风险：
              </p>
              <p>
                1. 技能内容未经人工审核，可能包含不当指令<br />
                2. Agent 可能安装与预期不符的技能<br />
                3. 恶意技能可能尝试操控 Agent 行为
              </p>
            </div>
            <div className="hana-warning-actions">
              <button className="hana-warning-cancel" onClick={() => setShowGithubWarning(false)}>
                取消
              </button>
              <button className="hana-warning-confirm" onClick={confirmGithubFetch}>
                我了解风险，开启
              </button>
            </div>
          </div>
        </div>
      )}

      {showSafetyWarning && (
        <div className="hana-warning-overlay" onClick={() => setShowSafetyWarning(false)}>
          <div className="hana-warning-box" onClick={(e) => e.stopPropagation()}>
            <h3 className="hana-warning-title">关闭安全审查</h3>
            <div className="hana-warning-body">
              <p>安全审查会在安装技能前检测潜在的恶意内容，包括：</p>
              <p>
                1. Prompt injection（越权指令）<br />
                2. 过于宽泛的触发条件<br />
                3. 社会工程和权限提升尝试
              </p>
              <p>关闭后，所有技能将不经审查直接安装。</p>
            </div>
            <div className="hana-warning-actions">
              <button className="hana-warning-cancel" onClick={() => setShowSafetyWarning(false)}>
                取消
              </button>
              <button className="hana-warning-confirm" onClick={async () => {
                setShowSafetyWarning(false);
                await autoSaveConfig(
                  { capabilities: { learn_skills: { safety_review: false } } },
                  { silent: true },
                );
                await loadSettingsConfig();
              }}>
                我了解风险，关闭审查
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SkillRow({ skill, nameHint, onDelete, onToggle }: {
  skill: SkillInfo;
  nameHint?: string;
  onDelete: (name: string) => void;
  onToggle: (name: string, enabled: boolean) => void;
}) {
  const rawDesc = skill.description || '';
  const cnMatch = rawDesc.match(/[\u4e00-\u9fff].*$/s);
  let displayDesc = cnMatch ? cnMatch[0] : rawDesc;
  displayDesc = displayDesc.replace(/\s*MANDATORY TRIGGERS:.*$/si, '').trim();
  if (displayDesc.length > 80) displayDesc = displayDesc.slice(0, 80) + '…';

  return (
    <div
      className="skills-list-item"
      onClick={() => {
        if (skill.baseDir) {
          (window as any).platform?.openSkillViewer?.({
            name: skill.name,
            baseDir: skill.baseDir,
            filePath: skill.filePath,
            installed: true,
          });
        }
      }}
    >
      <div className="skills-list-info">
        <span className="skills-list-name">
          {skill.name}
          {nameHint && <span className="skills-list-name-hint">{nameHint}</span>}
        </span>
        <span className="skills-list-desc">{displayDesc}</span>
      </div>
      <div className="skills-list-actions">
        <button
          className="skill-card-delete"
          title={t('settings.skills.delete')}
          onClick={(e) => { e.stopPropagation(); onDelete(skill.name); }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <button
          className={`hana-toggle${skill.enabled ? ' on' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggle(skill.name, !skill.enabled); }}
        />
      </div>
    </div>
  );
}
