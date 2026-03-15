import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { loadSettingsConfig } from '../actions';

const platform = (window as any).platform;

export function MeTab() {
  const { settingsConfig, userAvatarUrl, showToast } = useSettingsStore();
  const [userName, setUserName] = useState('');
  const [userProfile, setUserProfile] = useState('');

  useEffect(() => {
    if (settingsConfig) {
      setUserName(settingsConfig.user?.name || '');
      setUserProfile(settingsConfig._userProfile || '');
    }
  }, [settingsConfig]);

  const save = async () => {
    const store = useSettingsStore.getState();
    try {
      const partial: Record<string, any> = {};
      if (userName && userName !== (settingsConfig?.user?.name || '')) {
        partial.user = { name: userName };
      }
      const profileChanged = userProfile !== (settingsConfig?._userProfile || '');

      if (!Object.keys(partial).length && !profileChanged) {
        showToast(t('settings.noChanges'), 'success');
        return;
      }

      const requests: Promise<Response>[] = [];
      if (Object.keys(partial).length) {
        requests.push(hanaFetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(partial),
        }));
      }
      if (profileChanged) {
        requests.push(hanaFetch('/api/user-profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: userProfile }),
        }));
      }

      const results = await Promise.all(requests);
      for (const res of results) {
        const data = await res.json();
        if (data.error) throw new Error(data.error);
      }

      showToast(t('settings.saved'), 'success');
      if (partial?.user?.name) store.set({ userName: partial.user.name });

      await loadSettingsConfig();
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  const handleAvatarClick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.addEventListener('change', () => {
      if (input.files?.[0]) {
        // Dispatch to CropOverlay
        window.dispatchEvent(new CustomEvent('hana-open-cropper', {
          detail: { role: 'user', file: input.files[0] },
        }));
      }
    });
    input.click();
  };

  return (
    <div className="settings-tab-content active" data-tab="me">
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.me.title')}</h2>

        <div className="settings-avatar-center">
          <div className="avatar-upload" onClick={handleAvatarClick} title="">
            {userAvatarUrl ? (
              <img className="avatar-preview" src={userAvatarUrl} draggable={false} />
            ) : (
              <div className="avatar-preview avatar-preview-emoji">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </div>
            )}
            <div className="avatar-upload-overlay">{t('settings.me.changeAvatar')}</div>
          </div>
        </div>

        <div className="settings-field settings-field-center">
          <span className="settings-field-hint">{t('settings.me.userNameHint')}</span>
          <input
            className="settings-input"
            type="text"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
          />
        </div>

        <div className="settings-field">
          <label className="settings-field-label">{t('settings.me.userProfile')}</label>
          <textarea
            className="settings-textarea"
            rows={8}
            spellCheck={false}
            value={userProfile}
            onChange={(e) => setUserProfile(e.target.value)}
          />
          <span className="settings-field-hint">{t('settings.me.userProfileHint')}</span>
        </div>
      </section>

      <div className="settings-section-footer">
        <button className="settings-save-btn-sm" onClick={save}>
          {t('settings.save')}
        </button>
      </div>
    </div>
  );
}
