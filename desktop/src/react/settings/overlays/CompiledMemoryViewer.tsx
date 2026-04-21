import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { renderMarkdown } from '../../utils/markdown';
import styles from '../Settings.module.css';

export function CompiledMemoryViewer() {
  const [visible, setVisible] = useState(false);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const handler = () => { setVisible(true); load(); };
    window.addEventListener('hana-view-compiled-memory', handler);
    return () => window.removeEventListener('hana-view-compiled-memory', handler);
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      const res = await hanaFetch(`/api/memories/compiled?agentId=${aid}`);
      const data = await res.json();
      setContent(data.content || '');
    } catch (err: any) {
      setContent(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const clearCompiled = async () => {
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      await hanaFetch(`/api/memories/compiled?agentId=${aid}`, { method: 'DELETE' });
      setContent('');
      useSettingsStore.getState().showToast(t('settings.memory.compiledCleared'), 'success');
    } catch (err: any) {
      useSettingsStore.getState().showToast(err.message, 'error');
    }
  };

  const close = () => setVisible(false);

  if (!visible) return null;

  return (
    <div className={`${styles['memory-viewer-overlay']} ${styles['visible']}`} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={styles['memory-viewer']}>
        <div className={styles['memory-viewer-header']}>
          <h3 className={styles['memory-viewer-title']}>{t('settings.memory.compiled')}</h3>
          <div className={styles['memory-viewer-header-actions']}>
            <button className={styles['compiled-clear-btn']} onClick={clearCompiled}>
              {t('settings.memory.compiledClear')}
            </button>
            <button className={styles['memory-viewer-close']} onClick={close}>✕</button>
          </div>
        </div>
        <div className={`${styles['memory-viewer-body']} ${styles['compiled-memory-body']}`}>
          {loading ? (
            <div className="memory-viewer-empty">Loading...</div>
          ) : content.trim() ? (
            <div className={`${styles['compiled-memory-md']} ${'md-content'}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
          ) : (
            <div className="memory-viewer-empty">{t('settings.memory.compiledEmpty')}</div>
          )}
        </div>
      </div>
    </div>
  );
}
