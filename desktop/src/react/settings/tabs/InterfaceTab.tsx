import React from 'react';
import { useSettingsStore } from '../store';
import { t, VALID_THEMES, autoSaveConfig } from '../helpers';
import { SelectWidget } from '../widgets/SelectWidget';
import { Toggle } from '../widgets/Toggle';

const platform = (window as any).platform;
const setTheme = (window as any).setTheme;
const setSerifFont = (window as any).setSerifFont;
const i18n = (window as any).i18n;

export function InterfaceTab() {
  const { settingsConfig } = useSettingsStore();
  const currentTheme = localStorage.getItem('hana-theme') || 'auto';
  const serifEnabled = localStorage.getItem('hana-font-serif') !== '0';

  const locale = settingsConfig?.locale || 'zh-CN';
  const localeVal = locale.startsWith('en') ? 'en' : 'zh-CN';

  // 时区
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const commonTz = [
    'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore',
    'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Kolkata',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin',
    'America/New_York', 'America/Chicago', 'America/Denver',
    'America/Los_Angeles', 'Pacific/Auckland', 'Australia/Sydney',
  ];
  const tzSet = new Set(commonTz);
  if (browserTz && !tzSet.has(browserTz)) commonTz.unshift(browserTz);
  const currentTz = settingsConfig?.timezone || browserTz || 'Asia/Shanghai';
  if (!tzSet.has(currentTz) && currentTz !== browserTz) commonTz.unshift(currentTz);
  const tzOptions = commonTz.map(tz => {
    try {
      const offset = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' })
        .formatToParts(new Date()).find((p: any) => p.type === 'timeZoneName')?.value || '';
      return { value: tz, label: `${tz.replace(/_/g, ' ')}  (${offset})` };
    } catch { return { value: tz, label: tz.replace(/_/g, ' ') }; }
  });

  return (
    <div className="settings-tab-content active" data-tab="interface">
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.appearance.title')}</h2>

        {/* 主题 */}
        <div className="settings-field">
          <label className="settings-field-label">{t('settings.appearance.theme')}</label>
          <div className="theme-options">
            {VALID_THEMES.map(theme => {
              const nameKeys: Record<string, string> = {
                'warm-paper': 'settings.appearance.warmPaper',
                'midnight': 'settings.appearance.midnight',
                'high-contrast': 'settings.appearance.highContrast',
                'grass-aroma': 'settings.appearance.grassAroma',
                'contemplation': 'settings.appearance.contemplation',
                'auto': 'settings.appearance.auto',
              };
              const modeKeys: Record<string, string> = {
                'warm-paper': 'settings.appearance.warmPaperMode',
                'midnight': 'settings.appearance.midnightMode',
                'high-contrast': 'settings.appearance.highContrastMode',
                'grass-aroma': 'settings.appearance.grassAromaMode',
                'contemplation': 'settings.appearance.contemplationMode',
                'auto': 'settings.appearance.autoMode',
              };
              return (
                <button
                  key={theme}
                  className={`theme-card${currentTheme === theme ? ' active' : ''}`}
                  data-theme={theme}
                  onClick={() => {
                    setTheme?.(theme);
                    localStorage.setItem('hana-theme', theme);
                    platform?.settingsChanged?.('theme-changed', { theme });
                    // Force re-render for active state
                    useSettingsStore.setState({});
                  }}
                >
                  <div className="theme-card-name">{t(nameKeys[theme])}</div>
                  <div className="theme-card-mode">{t(modeKeys[theme])}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 衬线体 */}
        <div className="tool-caps-group">
          <div className="tool-caps-item">
            <div className="tool-caps-label">
              <span className="tool-caps-name">{t('settings.appearance.serifFont')}</span>
              <span className="tool-caps-desc">{t('settings.appearance.serifFontHint')}</span>
            </div>
            <Toggle
              on={serifEnabled}
              onChange={(next) => {
                setSerifFont?.(next);
                platform?.settingsChanged?.('font-changed', { serif: next });
                useSettingsStore.setState({});
              }}
            />
          </div>
        </div>

      </section>

      {/* 语言和地区 */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.locale.title')}</h2>

        <div className="settings-field">
          <label className="settings-field-label">{t('settings.locale.language')}</label>
          <SelectWidget
            options={[
              { value: 'zh-CN', label: '中文' },
              { value: 'en', label: 'English' },
            ]}
            value={localeVal}
            onChange={async (val) => {
              await autoSaveConfig({ locale: val }, { silent: true });
              await i18n?.load(val);
              if (i18n) i18n.defaultName = useSettingsStore.getState().agentName;
              useSettingsStore.getState().showToast(t('settings.autoSaved'), 'success');
              platform?.settingsChanged?.('locale-changed', { locale: val });
              useSettingsStore.setState({});
            }}
          />
          <span className="settings-field-hint">{t('settings.locale.languageHint')}</span>
        </div>

        <div className="settings-field">
          <label className="settings-field-label">{t('settings.locale.timezone')}</label>
          <SelectWidget
            options={tzOptions}
            value={currentTz}
            onChange={(val) => autoSaveConfig({ timezone: val })}
          />
          <span className="settings-field-hint">{t('settings.locale.timezoneHint')}</span>
        </div>
      </section>
    </div>
  );
}
