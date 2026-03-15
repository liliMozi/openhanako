import React from 'react';
import { useSettingsStore } from './store';

export function Toast() {
  const { toastMessage, toastType, toastVisible } = useSettingsStore();
  return (
    <div className={`settings-toast ${toastType}${toastVisible ? ' show' : ''}`}>
      {toastMessage}
    </div>
  );
}
