import React from 'react';
import type { SkillInfo } from '../../store';
import { t } from '../../helpers';
import { SkillRow } from './SkillRow';
import styles from '../../Settings.module.css';

interface LearnedSkillsBlockProps {
  learnedSkills: SkillInfo[];
  nameHints: Record<string, string>;
  onDelete: (name: string) => void;
  onToggle: (name: string, enabled: boolean) => void;
}

export function LearnedSkillsBlock({
  learnedSkills, nameHints, onDelete, onToggle,
}: LearnedSkillsBlockProps) {
  if (learnedSkills.length === 0) {
    return (
      <div className={styles['agent-skill-sub-block']}>
        <h3 className={styles['agent-skill-sub-title']}>{t('settings.skills.learnedSkillsTitle')}</h3>
        <p className={styles['agent-skill-empty']}>{t('settings.skills.learnedEmpty')}</p>
      </div>
    );
  }

  return (
    <div className={styles['agent-skill-sub-block']}>
      <h3 className={styles['agent-skill-sub-title']}>{t('settings.skills.learnedSkillsTitle')}</h3>
      <div className={styles['skills-list-block']}>
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
    </div>
  );
}
