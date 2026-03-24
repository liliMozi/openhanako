import React, { useState } from 'react';
import type { SkillInfo } from '../../store';
import { t, autoSaveConfig } from '../../helpers';
import { Toggle } from '../../widgets/Toggle';
import { loadSettingsConfig } from '../../actions';
import { SkillRow } from './SkillRow';
import styles from '../../Settings.module.css';

interface LearnConfig {
  enabled?: boolean;
  allow_github_fetch?: boolean;
  safety_review?: boolean;
}

interface SkillCapabilitiesProps {
  learnCfg: LearnConfig;
  learnedSkills: SkillInfo[];
  nameHints: Record<string, string>;
  onDelete: (name: string) => void;
  onToggle: (name: string, enabled: boolean) => void;
}

export function SkillCapabilities({
  learnCfg, learnedSkills, nameHints, onDelete, onToggle,
}: SkillCapabilitiesProps) {
  const learnEnabled = learnCfg.enabled === true;
  const githubEnabled = learnCfg.allow_github_fetch === true;
  const safetyReviewEnabled = learnCfg.safety_review !== false;

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
    <>
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.toolCaps.title')}</h2>

        {learnedSkills.length > 0 && (
          <div className={`${styles['skills-list-block']} ${styles['skills-list-block-spaced']}`}>
            {learnedSkills.map(skill => (
              <SkillRow
                key={skill.name}
                skill={skill}
                nameHint={nameHints[skill.name]}
                onDelete={onDelete}
                onToggle={onToggle}
              />
            ))}
          </div>
        )}

        <div className={styles['tool-caps-group']}>
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.skills.learnCreate')}</span>
              <span className={styles['tool-caps-desc']}>{t('settings.skills.learnCreateDesc')}</span>
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
            <div className={`${styles['tool-caps-item']} ${styles['tool-caps-sub']}`}>
              <div className={styles['tool-caps-label']}>
                <span className={styles['tool-caps-name']}>{t('settings.skills.fetchRemote')}</span>
                <span className={`${styles['tool-caps-desc']} ${styles['warn']}`}>{t('settings.skills.fetchRemoteDesc')}</span>
              </div>
              <Toggle
                on={githubEnabled}
                onChange={handleGithubToggle}
              />
            </div>
          )}
          {learnEnabled && (
            <div className={`${styles['tool-caps-item']} ${styles['tool-caps-sub']}`}>
              <div className={styles['tool-caps-label']}>
                <span className={styles['tool-caps-name']}>{t('settings.skills.safetyReview')}</span>
                <span className={styles['tool-caps-desc']}>{t('settings.skills.safetyReviewDesc')}</span>
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
        <p className={styles['settings-hint']}>{t('settings.skills.learnHint')}</p>
      </section>

      {showGithubWarning && (
        <div className="hana-warning-overlay" onClick={() => setShowGithubWarning(false)}>
          <div className="hana-warning-box" onClick={(e) => e.stopPropagation()}>
            <h3 className="hana-warning-title">{t('settings.skills.fetchWarning.title')}</h3>
            <div className="hana-warning-body">
              <p>{t('settings.skills.fetchWarning.body1')}</p>
              <p>{t('settings.skills.fetchWarning.body2')}</p>
              <p>
                1. {t('settings.skills.fetchWarning.risk1')}<br />
                2. {t('settings.skills.fetchWarning.risk2')}<br />
                3. {t('settings.skills.fetchWarning.risk3')}
              </p>
            </div>
            <div className="hana-warning-actions">
              <button className="hana-warning-cancel" onClick={() => setShowGithubWarning(false)}>
                {t('common.cancel')}
              </button>
              <button className="hana-warning-confirm" onClick={confirmGithubFetch}>
                {t('settings.skills.fetchWarning.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSafetyWarning && (
        <div className="hana-warning-overlay" onClick={() => setShowSafetyWarning(false)}>
          <div className="hana-warning-box" onClick={(e) => e.stopPropagation()}>
            <h3 className="hana-warning-title">{t('settings.skills.safetyWarning.title')}</h3>
            <div className="hana-warning-body">
              <p>{t('settings.skills.safetyWarning.body1')}</p>
              <p>
                1. {t('settings.skills.safetyWarning.risk1')}<br />
                2. {t('settings.skills.safetyWarning.risk2')}<br />
                3. {t('settings.skills.safetyWarning.risk3')}
              </p>
              <p>{t('settings.skills.safetyWarning.body2')}</p>
            </div>
            <div className="hana-warning-actions">
              <button className="hana-warning-cancel" onClick={() => setShowSafetyWarning(false)}>
                {t('common.cancel')}
              </button>
              <button className="hana-warning-confirm" onClick={async () => {
                setShowSafetyWarning(false);
                await autoSaveConfig(
                  { capabilities: { learn_skills: { safety_review: false } } },
                  { silent: true },
                );
                await loadSettingsConfig();
              }}>
                {t('settings.skills.safetyWarning.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
