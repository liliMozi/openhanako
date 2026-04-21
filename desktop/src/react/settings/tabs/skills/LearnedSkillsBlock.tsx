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

/**
 * 返回"list 或 empty"的裸内容，外层 section 外壳由调用方承担。
 * 调用方通常是 SkillsTab 的 <SettingsSection title="自学 Skill">。
 */
export function LearnedSkillsBlock({
  learnedSkills, nameHints, onDelete, onToggle,
}: LearnedSkillsBlockProps) {
  if (learnedSkills.length === 0) {
    return (
      <p className={styles['agent-skill-empty']} style={{ padding: 'var(--space-md)', margin: 0 }}>
        {t('settings.skills.learnedEmpty')}
      </p>
    );
  }

  return (
    <>
      {learnedSkills.map(skill => (
        <SkillRow
          key={skill.name}
          skill={skill}
          nameHint={nameHints[skill.name]}
          onDelete={onDelete}
          onToggle={onToggle}
        />
      ))}
    </>
  );
}
