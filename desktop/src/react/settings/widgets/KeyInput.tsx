/**
 * API Key 输入框 — password/text 切换
 */
import React, { useState } from 'react';
import styles from '../Settings.module.css';

interface KeyInputProps {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  onBlur?: () => void;
}

export function KeyInput({ value, onChange, placeholder, onBlur }: KeyInputProps) {
  const t = window.t || ((k: string) => k);
  const [visible, setVisible] = useState(false);

  return (
    <div className={styles['settings-key-wrapper']}>
      <input
        className={`${styles['settings-input']} ${styles['settings-key-input']}`}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        onBlur={onBlur}
      />
      <button
        className={styles['settings-key-toggle']}
        type="button"
        onClick={() => setVisible(!visible)}
      >
        {visible ? t('settings.api.hideKey') : t('settings.api.showKey')}
      </button>
    </div>
  );
}
