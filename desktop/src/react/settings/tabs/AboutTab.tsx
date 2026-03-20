import React, { useEffect, useState, useRef } from 'react';
import { useSettingsStore } from '../store';
import { autoSaveConfig, t } from '../helpers';
import { Toggle } from '../widgets/Toggle';
import { loadSettingsConfig } from '../actions';
import iconUrl from '../../../assets/Hanako.png';

const hana = (window as any).hana;

export function AboutTab() {
  const { settingsConfig } = useSettingsStore();
  const [version, setVersion] = useState('');
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ version: string; downloadUrl: string } | null>(null);

  // 全权模式 easter egg：点击头像 5 次解锁
  const [devUnlocked, setDevUnlocked] = useState(false);
  const tapCount = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showFullAccessWarning, setShowFullAccessWarning] = useState(false);

  const sandboxEnabled = settingsConfig?.sandbox !== false;

  const handleIconTap = () => {
    tapCount.current += 1;
    if (tapTimer.current) clearTimeout(tapTimer.current);
    if (tapCount.current >= 5) {
      tapCount.current = 0;
      setDevUnlocked(prev => !prev);
    } else {
      tapTimer.current = setTimeout(() => { tapCount.current = 0; }, 1500);
    }
  };

  useEffect(() => {
    hana?.getAppVersion?.().then((v: string) => setVersion(v || ''));
    hana?.checkUpdate?.().then((info: any) => {
      if (info?.version) setUpdateInfo(info);
    });
  }, []);

  return (
    <div className="settings-tab-content active" data-tab="about">
      <div className="about-hero">
        <img
          className="about-icon about-icon-clickable"
          src={iconUrl}
          alt="Hanako"
          onClick={handleIconTap}
        />
        <div className="about-name">Hanako</div>
        <div className="about-tagline">{t('settings.about.tagline')}</div>
        {version && <div className="about-version">v{version}</div>}
        {updateInfo && (
          <div className="about-update">
            <span>{t('settings.about.updateAvailable', { version: updateInfo.version })}</span>
            <a
              className="about-update-link"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                hana?.openExternal?.(updateInfo.downloadUrl);
              }}
            >
              {t('settings.about.updateDownload')}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          </div>
        )}
      </div>

      <section className="about-info">
        <div className="about-row">
          <span className="about-label">{t('settings.about.license')}</span>
          <span className="about-value">Apache License 2.0</span>
        </div>
        <div className="about-row">
          <span className="about-label">{t('settings.about.copyright')}</span>
          <span className="about-value">&copy; 2026 liliMozi</span>
        </div>
        <div className="about-row">
          <span className="about-label">GitHub</span>
          <a
            className="about-value about-link"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              hana?.openExternal?.('https://github.com/liliMozi');
            }}
          >
            github.com/liliMozi
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </a>
        </div>
      </section>

      <button
        className="about-license-toggle"
        onClick={() => setLicenseOpen(!licenseOpen)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points={licenseOpen ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
        </svg>
        {t('settings.about.licenseToggle')}
      </button>

      {licenseOpen && (
        <pre className="about-license-text">{LICENSE_TEXT}</pre>
      )}

      {devUnlocked && (
        <section className="settings-section about-dev-section">
          <h2 className="settings-section-title">{t('settings.about.permissions')}</h2>
          <div className="tool-caps-group">
            <div className="tool-caps-item">
              <div className="tool-caps-label">
                <span className="tool-caps-name">{t('settings.about.fullAccess')}</span>
                <span className="tool-caps-desc warn">
                  {t('settings.about.fullAccessDesc')}
                </span>
              </div>
              <Toggle
                on={!sandboxEnabled}
                onChange={async (on) => {
                  if (on) {
                    setShowFullAccessWarning(true);
                  } else {
                    await autoSaveConfig({ sandbox: true }, { silent: true });
                    await loadSettingsConfig();
                  }
                }}
              />
            </div>
          </div>
        </section>
      )}

      {showFullAccessWarning && (
        <div className="hana-warning-overlay" onClick={() => setShowFullAccessWarning(false)}>
          <div className="hana-warning-box" onClick={(e) => e.stopPropagation()}>
            <h3 className="hana-warning-title">{t('settings.about.fullAccessWarningTitle')}</h3>
            <div className="hana-warning-body">
              <p>{t('settings.about.fullAccessWarningBody1')}</p>
              <p style={{ whiteSpace: 'pre-line' }}>
                {t('settings.about.fullAccessWarningBody2')}
              </p>
              <p>{t('settings.about.fullAccessWarningBody3')}</p>
            </div>
            <div className="hana-warning-actions">
              <button className="hana-warning-cancel" onClick={() => setShowFullAccessWarning(false)}>
                {t('settings.about.fullAccessCancel')}
              </button>
              <button className="hana-warning-confirm" onClick={async () => {
                setShowFullAccessWarning(false);
                await autoSaveConfig({ sandbox: false }, { silent: true });
                await loadSettingsConfig();
              }}>
                {t('settings.about.fullAccessConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const LICENSE_TEXT = `Apache License, Version 2.0

Copyright 2026 liliMozi

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.`;
