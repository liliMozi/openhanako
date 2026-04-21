import React from 'react';
import { useSettingsStore } from './store';
import styles from './Settings.module.css';

export function Toast() {
  const { toastMessage, toastType, toastVisible } = useSettingsStore();
  const cls = [styles['settings-toast']];
  if (toastType) cls.push(styles[toastType]);
  if (toastVisible) cls.push(styles['show']);
  return (
    <div className={cls.join(' ')}>
      {toastMessage}
    </div>
  );
}
