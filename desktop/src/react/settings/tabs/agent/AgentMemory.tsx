import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../../store';
import { hanaFetch } from '../../api';
import { t, autoSaveConfig, savePins } from '../../helpers';
import { PinItem } from './AgentPins';
import { SettingsSection } from '../../components/SettingsSection';
import styles from '../../Settings.module.css';

export function MemorySection({ hasUtilityModel, memoryEnabled, isViewingOther, currentPins }: {
  hasUtilityModel: boolean;
  memoryEnabled: boolean;
  isViewingOther: boolean;
  currentPins: string[];
}) {
  const [pinInput, setPinInput] = useState('');

  const addPin = () => {
    const val = pinInput.trim();
    if (!val) return;
    const newPins = [...currentPins, val];
    useSettingsStore.setState({ currentPins: newPins });
    setPinInput('');
    savePins();
  };

  const deletePin = (index: number) => {
    const newPins = [...currentPins];
    newPins.splice(index, 1);
    useSettingsStore.setState({ currentPins: newPins });
    savePins();
  };

  /* 记忆开关作为 section title 右侧 context（和 WorkTab 的 AgentSelect 作 context 同构）
   * hasUtilityModel=false 时 toggle 禁用，below 显示提示 */
  const memoryToggle = (
    <button
      className={`hana-toggle${hasUtilityModel && memoryEnabled ? ' on' : ''}${!hasUtilityModel ? ' disabled' : ''}`}
      onClick={() => hasUtilityModel && autoSaveConfig({ memory: { enabled: !memoryEnabled } })}
      disabled={!hasUtilityModel}
      title={!hasUtilityModel ? t('settings.memory.needsUtilityModel') : undefined}
    />
  );

  return (
    <SettingsSection title={t('settings.memory.sectionTitle')} context={memoryToggle}>
      <div style={{ padding: 'var(--space-sm) var(--space-md)' }}>
        {!hasUtilityModel && (
          <p className={styles['settings-hint']} style={{ opacity: 0.6, marginTop: 0, marginBottom: 'var(--space-md)' }}>{t('settings.memory.needsUtilityModel')}</p>
        )}

        <div className={!hasUtilityModel || !memoryEnabled ? 'settings-disabled' : ''}>
          <div className={styles['settings-subsection']}>
            <div className={styles['settings-subsection-header']}>
              <h3 className={styles['settings-subsection-title']}>{t('settings.pins.title')}</h3>
              <span className={styles['settings-subsection-hint']}>{t('settings.pins.hint')}</span>
            </div>
            <div className={styles['pin-list']}>
              {currentPins.length === 0 ? (
                <div className={styles['pin-empty']}>{t('settings.pins.empty')}</div>
              ) : (
                currentPins.map((pin, i) => (
                  <PinItem key={pin} text={pin} index={i} onDelete={deletePin} />
                ))
              )}
            </div>
            <div className={styles['pin-add-row']}>
              <input
                className={`${styles['settings-input']} ${styles['pin-add-input']}`}
                type="text"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPin(); } }}
                placeholder={t('settings.pins.addPlaceholder')}
              />
              <button className={styles['pin-add-btn']} onClick={addPin}>+</button>
            </div>
          </div>

          <div className={styles['settings-subsection']}>
            <div className={styles['settings-subsection-header']}>
              <h3 className={styles['settings-subsection-title']}>{t('settings.memory.compiled')}</h3>
              <span className={styles['settings-subsection-hint']}>{t('settings.memory.compiledHint')}</span>
            </div>
            <button
              className={`${styles['memory-action-btn']} ${styles['compiled-view-btn']}`}
              onClick={() => window.dispatchEvent(new Event('hana-view-compiled-memory'))}
            >
              {t('settings.memory.compiledView')}
            </button>
          </div>

          <div className={styles['settings-subsection']}>
            <h3 className={styles['settings-subsection-title']}>{t('settings.memory.allMemories')}</h3>
            <div className={`${styles['memory-actions-row']} ${styles['memory-actions-spaced']}`}>
              <button
                className={styles['memory-action-btn']}
                onClick={() => window.dispatchEvent(new Event('hana-view-memories'))}
              >
                {t('settings.memory.actions.view')}
              </button>
              <button
                className={`${styles['memory-action-btn']} ${styles['danger']}`}
                onClick={() => window.dispatchEvent(new Event('hana-show-clear-confirm'))}
              >
                {t('settings.memory.actions.clear')}
              </button>
              <MemoryMoreDropdown isViewingOther={isViewingOther} />
            </div>
          </div>
        </div>{/* settings-disabled wrapper */}
      </div>
    </SettingsSection>
  );
}

function MemoryMoreDropdown({ isViewingOther }: { isViewingOther: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const store = useSettingsStore();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [open]);

  const exportMemories = async () => {
    setOpen(false);
    try {
      const aid = store.getSettingsAgentId();
      const res = await hanaFetch(`/api/memories/export?agentId=${aid}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      // eslint-disable-next-line no-restricted-syntax -- ephemeral download link for memory export
      const a = document.createElement('a');
      a.href = url;
      a.download = `hana-memories-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      store.showToast(t('settings.memory.actions.exportSuccess'), 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      store.showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    }
  };

  const importMemories = async () => {
    setOpen(false);
    // eslint-disable-next-line no-restricted-syntax -- ephemeral file picker for memory import
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const entries = json.facts || json.memories;
        if (!Array.isArray(entries) || entries.length === 0) {
          store.showToast(t('settings.memory.actions.invalidFile'), 'error');
          return;
        }
        store.showToast(t('settings.memory.actions.importing'), 'success');
        const aid = store.getSettingsAgentId();
        const res = await hanaFetch(`/api/memories/import?agentId=${aid}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ facts: entries }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const importMsg = t('settings.memory.actions.importSuccess').replace('{count}', data.imported);
        store.showToast(importMsg, 'success');
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        store.showToast(t('settings.saveFailed') + ': ' + errMsg, 'error');
      }
    });
    input.click();
  };

  return (
    <div className={`${styles['memory-action-dropdown']}${open  ? ' ' + styles['open'] : ''}`} ref={ref}>
      <button className={`${styles['memory-action-btn']} ${styles['secondary']}`} onClick={() => setOpen(!open)}>
        <span>{t('settings.memory.actions.more')}</span>
        <svg className={styles['memory-more-arrow']} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <div className={styles['memory-more-popup']}>
        <button className={styles['memory-more-option']} onClick={exportMemories}>
          {t('settings.memory.actions.export')}
        </button>
        <button
          className={styles['memory-more-option']}
          onClick={importMemories}
          disabled={isViewingOther}
          title={isViewingOther ? t('settings.memory.activeOnly') : ''}
        >
          {t('settings.memory.actions.import')}
        </button>
      </div>
    </div>
  );
}
