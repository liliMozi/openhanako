import React, { useState, useEffect, useRef } from 'react';
import { hanaFetch } from '../../api';
import { t } from '../../helpers';
import styles from '../../Settings.module.css';

export interface ExpCategory { name: string; entries: string[]; }

export function parseExperience(raw: string): ExpCategory[] {
  if (!raw?.trim()) return [];
  const cats: ExpCategory[] = [];
  let cur: ExpCategory | null = null;
  for (const line of raw.split('\n')) {
    const m = line.match(/^#\s+(.+)/);
    if (m) {
      cur = { name: m[1].trim(), entries: [] };
      cats.push(cur);
    } else if (cur) {
      const entry = line.replace(/^\d+\.\s*/, '').trim();
      if (entry) cur.entries.push(entry);
    }
  }
  return cats;
}

export function serializeExperience(cats: ExpCategory[]): string {
  return cats
    .filter(c => c.entries.length > 0)
    .map(c => `# ${c.name}\n${c.entries.map((e, i) => `${i + 1}. ${e}`).join('\n')}`)
    .join('\n\n') + (cats.length ? '\n' : '');
}

export async function putExperience(
  store: { getSettingsAgentId: () => string | null; showToast: (msg: string, type: 'success' | 'error') => void },
  cats: ExpCategory[],
) {
  try {
    const agentId = store.getSettingsAgentId();
    const content = serializeExperience(cats);
    const res = await hanaFetch(`/api/agents/${agentId}/experience`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.showToast(t('settings.saveFailed') + ': ' + msg, 'error');
  }
}

export function ExperienceBlock({ category, onSave, onDelete }: {
  category: ExpCategory;
  onSave: (updated: ExpCategory) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const startEdit = () => {
    setEditVal(category.entries.map((e, i) => `${i + 1}. ${e}`).join('\n'));
    setEditing(true);
  };

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [editing]);

  const saveEdit = () => {
    const entries = editVal
      .split('\n')
      .map(l => l.replace(/^\d+\.\s*/, '').trim())
      .filter(Boolean);
    onSave({ name: category.name, entries });
    setEditing(false);
  };

  return (
    <div className={styles['exp-block']}>
      <div className={styles['exp-block-header']}>
        <span className={styles['exp-block-title']}>{category.name}</span>
        <div className={styles['exp-block-actions']}>
          <button
            className={styles['exp-block-action']}
            title={t('settings.experience.edit')}
            onClick={startEdit}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          <button
            className={`${styles['exp-block-action']} ${styles['delete']}`}
            title={t('settings.experience.deleteCategory')}
            onClick={onDelete}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
      {editing ? (
        <textarea
          ref={textareaRef}
          className={styles['exp-block-editor']}
          value={editVal}
          onChange={(e) => setEditVal(e.target.value)}
          onBlur={saveEdit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setEditing(false); }
          }}
          spellCheck={false}
        />
      ) : (
        <div className={styles['exp-block-body']}>
          {category.entries.map((entry, i) => (
            <div key={`${category.name}-${i}`} className={styles['exp-entry']}>
              <span className={styles['exp-entry-num']}>{i + 1}.</span>
              <span className={styles['exp-entry-text']}>{entry}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
