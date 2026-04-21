import React, { useState } from 'react';
import type { SkillInfo } from '../../store';
import { t } from '../../helpers';
import { SkillRow } from './SkillRow';
import styles from '../../Settings.module.css';

interface CompatPathDrawerProps {
  dirPath: string;
  label: string | null;
  exists: boolean;
  isCustom: boolean;
  skills: SkillInfo[];
  nameHints: Record<string, string>;
  onToggle: (name: string, enabled: boolean) => void;
  onRemove: (path: string) => void;
}

export function CompatPathDrawer({
  dirPath, label, exists, isCustom, skills, nameHints, onToggle, onRemove,
}: CompatPathDrawerProps) {
  const [open, setOpen] = useState(false);
  const displayLabel = label || dirPath.split('/').filter(Boolean).pop() || dirPath;
  const skillCount = skills.length;

  return (
    <div className={styles['compat-drawer']}>
      <button
        className={`${styles['compat-drawer-header']}${!exists  ? ' ' + styles['disabled'] : ''}`}
        onClick={() => { if (exists && skillCount > 0) setOpen(prev => !prev); }}
      >
        <svg
          className={`${styles['compat-drawer-chevron']}${open  ? ' ' + styles['open'] : ''}`}
          width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ opacity: exists && skillCount > 0 ? 1 : 0.2 }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <div className={styles['compat-drawer-info']}>
          <span className={styles['compat-drawer-label']}>{displayLabel}</span>
          {isCustom && <span className={styles['compat-drawer-path']}>{dirPath}</span>}
        </div>
        <div className={styles['compat-drawer-meta']}>
          {!exists ? (
            <span className={`${styles['compat-path-badge']} ${styles['muted']}`}>{t('settings.skills.compatNotInstalled')}</span>
          ) : skillCount > 0 ? (
            <span className={styles['compat-path-badge']}>{skillCount}</span>
          ) : (
            <span className={`${styles['compat-path-badge']} ${styles['muted']}`}>0</span>
          )}
          {isCustom && (
            <button
              className={styles['compat-path-remove']}
              onClick={(e) => { e.stopPropagation(); onRemove(dirPath); }}
              title={t('settings.skills.compatRemove')}
              style={{ opacity: 1 }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </button>
      {open && skillCount > 0 && (
        <div className={styles['compat-drawer-skills']}>
          {skills.map(skill => (
            <SkillRow
              key={skill.name}
              skill={skill}
              nameHint={nameHints[skill.name]}
              deletable={false}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}
