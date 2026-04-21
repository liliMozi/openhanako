import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../../store';
import { hanaFetch } from '../../api';
import { t, API_FORMAT_OPTIONS } from '../../helpers';
import { loadSettingsConfig } from '../../actions';
import { SelectWidget } from '../../widgets/SelectWidget';
import { KeyInput } from '../../widgets/KeyInput';
import styles from '../../Settings.module.css';

const platform = window.platform;

export function AddCustomButton({ adding, onToggle, onDone, onCancel }: {
  adding: boolean;
  onToggle: () => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (!adding || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - 360 - 8);
    setStyle({
      left: Math.max(8, left),
      bottom: window.innerHeight - rect.top + 4,
    });
  }, [adding]);

  useEffect(() => {
    if (!adding) return;
    const handler = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (popRef.current?.contains(e.target as Node)) return;
      // SelectWidget 的下拉面板通过 portal 渲染到 body，不在 popRef 内
      if ((e.target as Element).closest?.('[data-sdw-popup]')) return;
      onCancel();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [adding, onCancel]);

  return (
    <div className={styles['pv-add-wrapper']}>
      <button ref={btnRef} className={styles['pv-add-btn']} onClick={onToggle}>
        + {t('settings.providers.addCustom')}
      </button>
      {adding && (
        <div ref={popRef} className={styles['pv-add-popover']} style={style}>
          <AddProviderForm onDone={onDone} onCancel={onCancel} />
        </div>
      )}
    </div>
  );
}

function AddProviderForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { showToast } = useSettingsStore();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [api, setApi] = useState('openai-completions');

  const submit = async () => {
    const n = name.trim().toLowerCase();
    const u = url.trim();
    if (!n) { showToast(t('settings.providers.nameRequired'), 'error'); return; }
    if (!u) { showToast(t('settings.providers.urlRequired'), 'error'); return; }
    try {
      const res = await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [n]: { base_url: u, api_key: apiKey.trim(), api, models: [] as string[] } } }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.providers.added', { name: n }), 'success');
      await loadSettingsConfig();
      platform?.settingsChanged?.('models-changed');
      useSettingsStore.setState({ selectedProviderId: n });
      onDone();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    }
  };

  return (
    <div className={styles['pv-add-form']}>
      <div className={styles['pv-add-form-field']}>
        <label className={styles['pv-add-form-label']}>{t('settings.providers.customName')}</label>
        <input className={styles['settings-input']} type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-provider" />
      </div>
      <div className={styles['pv-add-form-field']}>
        <label className={styles['pv-add-form-label']}>Base URL</label>
        <input className={styles['settings-input']} type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/v1" />
      </div>
      <div className={styles['pv-add-form-field']}>
        <label className={styles['pv-add-form-label']}>{t('settings.api.apiKey')}</label>
        <KeyInput value={apiKey} onChange={setApiKey} placeholder={t('settings.api.apiKeyPlaceholder')} />
      </div>
      <div className={styles['pv-add-form-field']}>
        <label className={styles['pv-add-form-label']}>{t('settings.providers.apiFormat')}</label>
        <SelectWidget options={API_FORMAT_OPTIONS} value={api} onChange={setApi} placeholder="API Format" />
      </div>
      <div className={styles['pv-add-form-actions']}>
        <button className={styles['pv-add-form-btn']} onClick={onCancel}>{t('settings.api.cancel')}</button>
        <button className={`${styles['pv-add-form-btn']} ${styles['primary']}`} onClick={submit}>{t('settings.providers.addBtn')}</button>
      </div>
    </div>
  );
}
