import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t, escapeHtml } from '../helpers';
import styles from '../Settings.module.css';

export function MemoryViewer() {
  const [visible, setVisible] = useState(false);
  const [html, setHtml] = useState('');

  useEffect(() => {
    const handler = () => { setVisible(true); loadMemories(); };
    window.addEventListener('hana-view-memories', handler);
    return () => window.removeEventListener('hana-view-memories', handler);
  }, []);

  const loadMemories = async () => {
    setHtml(`<div class="memory-viewer-empty">${t('settings.memory.actions.importing')}</div>`);
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      const res = await hanaFetch(`/api/memories?agentId=${aid}`);
      const { memories } = await res.json();

      if (!memories || memories.length === 0) {
        setHtml(`<div class="memory-viewer-empty">${t('settings.memory.actions.empty')}</div>`);
        return;
      }

      const groups: Record<string, any[]> = {};
      for (const mem of memories) {
        const date = (mem.time || mem.created_at || '').slice(0, 10) || t('settings.memory.unknownDate');
        if (!groups[date]) groups[date] = [];
        groups[date].push(mem);
      }

      const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a));
      let result = '';
      for (const date of sortedDates) {
        result += `<div class="memory-date-group">`;
        result += `<div class="memory-date-label">${date}</div>`;
        for (const mem of groups[date]) {
          const tagsHtml = (mem.tags || []).map((tag: string) =>
            `<span class="memory-item-tag">${escapeHtml(tag)}</span>`
          ).join('');
          result += `<div class="memory-item">`;
          result += `<div class="memory-item-content">${escapeHtml(mem.fact || '')}</div>`;
          result += `<div class="memory-item-meta">${tagsHtml}</div></div>`;
        }
        result += `</div>`;
      }
      setHtml(result);
    } catch (err: any) {
      setHtml(`<div class="memory-viewer-empty">${escapeHtml(err.message)}</div>`);
    }
  };

  const close = () => setVisible(false);

  if (!visible) return null;

  return (
    <div className={`${styles['memory-viewer-overlay']} ${styles['visible']}`} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={styles['memory-viewer']}>
        <div className={styles['memory-viewer-header']}>
          <h3 className={styles['memory-viewer-title']}>{t('settings.memory.actions.viewTitle')}</h3>
          <button className={styles['memory-viewer-close']} onClick={close}>✕</button>
        </div>
        <div className={styles['memory-viewer-body']} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
