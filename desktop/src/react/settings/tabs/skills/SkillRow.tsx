import React from 'react';
import type { SkillInfo } from '../../store';
import { t } from '../../helpers';
import styles from '../../Settings.module.css';

function truncateDesc(raw: string): string {
  const cnMatch = raw.match(/[\u4e00-\u9fff].*$/s);
  let desc = cnMatch ? cnMatch[0] : raw;
  desc = desc.replace(/\s*MANDATORY TRIGGERS:.*$/si, '').trim();
  if (desc.length > 80) desc = desc.slice(0, 80) + '\u2026';
  return desc;
}

interface SkillRowProps {
  skill: SkillInfo;
  nameHint?: string;
  deletable?: boolean;
  onDelete?: (name: string) => void;
  onToggle: (name: string, enabled: boolean) => void;
}

export function SkillRow({ skill, nameHint, deletable = true, onDelete, onToggle }: SkillRowProps) {
  const displayDesc = truncateDesc(skill.description || '');

  return (
    <div
      className={styles['skills-list-item']}
      onClick={() => {
        if (skill.baseDir) {
          window.platform?.openSkillViewer?.({
            name: skill.name,
            baseDir: skill.baseDir,
            filePath: skill.filePath,
            installed: true,
          });
        }
      }}
    >
      <div className={styles['skills-list-info']}>
        <span className={styles['skills-list-name']}>
          {skill.name}
          {nameHint && <span className={styles['skills-list-name-hint']}>{nameHint}</span>}
        </span>
        <span className={styles['skills-list-desc']}>{displayDesc}</span>
      </div>
      <div className={styles['skills-list-actions']}>
        {deletable && onDelete && (
          <button
            className={styles['skill-card-delete']}
            title={t('settings.skills.delete')}
            onClick={(e) => { e.stopPropagation(); onDelete(skill.name); }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
        <button
          className={`hana-toggle${skill.enabled ? ' on' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggle(skill.name, !skill.enabled); }}
        />
      </div>
    </div>
  );
}
