import React, { useState, useRef } from 'react';
import { useSettingsStore, type ProviderSummary } from '../../store';
import { useStore } from '../../../stores';
import { hanaFetch } from '../../api';
import { t } from '../../helpers';
import styles from '../../Settings.module.css';

const platform = window.platform;

export function OAuthCredentials({ providerId, summary, onRefresh }: {
  providerId: string;
  summary: ProviderSummary;
  onRefresh: () => Promise<void>;
}) {
  const { showToast } = useSettingsStore();
  const [codeInput, setCodeInput] = useState('');
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const pollingRef = useRef(false);

  const login = async () => {
    try {
      const res = await hanaFetch('/api/auth/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      platform?.openExternal?.(data.url);
      if (data.instructions) {
        setDeviceCode(data.instructions);
        setPolling(true);
        pollingRef.current = true;
        pollLogin(data.sessionId);
      } else if (data.polling) {
        setPolling(true);
        pollingRef.current = true;
        pollLogin(data.sessionId);
      } else {
        setShowCodeInput(true);
        useStore.getState().setOauthSessionId(data.sessionId);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.oauth.failed') + ': ' + msg, 'error');
    }
  };

  const submitCode = async () => {
    const code = codeInput.trim();
    if (!code) return;
    try {
      const res = await hanaFetch('/api/auth/oauth/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: useStore.getState().oauthSessionId, code }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.oauth.success'), 'success');
      setShowCodeInput(false);
      await onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.oauth.failed') + ': ' + msg, 'error');
    }
  };

  const pollLogin = async (sessionId: string) => {
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 3000));
      if (!pollingRef.current) return;
      try {
        const res = await hanaFetch(`/api/auth/oauth/poll/${sessionId}`);
        const data = await res.json();
        if (data.status === 'done') {
          showToast(t('settings.oauth.success'), 'success');
          setDeviceCode(null);
          setPolling(false);
          pollingRef.current = false;
          await onRefresh();
          return;
        }
        if (data.status === 'error') throw new Error(data.error || 'Login failed');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast(t('settings.oauth.failed') + ': ' + msg, 'error');
        setDeviceCode(null);
        setPolling(false);
        pollingRef.current = false;
        return;
      }
    }
    setDeviceCode(null);
    setPolling(false);
    pollingRef.current = false;
  };

  const logout = async () => {
    try {
      await hanaFetch('/api/auth/oauth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      showToast(t('settings.oauth.loggedOut'), 'success');
      await onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.oauth.failed') + ': ' + msg, 'error');
    }
  };

  return (
    <div className={styles['pv-credentials']}>
      <div className={styles['pv-cred-row']}>
        <span className={styles['pv-cred-label']}>OAuth</span>
        {summary.logged_in ? (
          <div className={styles['pv-oauth-status']}>
            <span className={styles['oauth-status-badge']}>{t('settings.oauth.loggedIn')}</span>
            <button className={styles['oauth-logout-btn']} onClick={logout}>{t('settings.oauth.logout')}</button>
          </div>
        ) : (
          <button className={styles['oauth-login-btn']} onClick={login}>{t('settings.oauth.login')}</button>
        )}
      </div>

      {showCodeInput && (
        <div className={styles['oauth-code-section']}>
          <input
            className={`${styles['settings-input']} ${styles['oauth-code-input']}`}
            type="text"
            placeholder={t('settings.oauth.codePlaceholder')}
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitCode(); }}
            autoFocus
          />
          <button className={styles['oauth-code-submit']} onClick={submitCode}>{t('settings.oauth.submit')}</button>
        </div>
      )}
      {deviceCode && (
        <div className={`${styles['oauth-code-section']} ${styles['oauth-device-code']}`}>
          <div
            className={styles['oauth-user-code']}
            title={t('settings.oauth.clickToCopy')}
            onClick={() => navigator.clipboard.writeText(deviceCode).then(() => useSettingsStore.getState().showToast(t('settings.oauth.codeCopied'), 'success'))}
          >
            {deviceCode}
          </div>
          <div className={styles['oauth-device-hint']}>{t('settings.oauth.deviceHint')}</div>
          <div className={styles['oauth-device-spinner']}>{t('settings.oauth.waiting')}</div>
        </div>
      )}
      {polling && !deviceCode && !showCodeInput && (
        <div className={styles['oauth-code-section']}>
          <div className={styles['oauth-device-spinner']}>{t('settings.oauth.waiting')}</div>
        </div>
      )}
    </div>
  );
}
