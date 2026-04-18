import React from 'react';
import { useSettingsStore } from '../store';
import { t, VALID_THEMES, autoSaveConfig } from '../helpers';
import { SelectWidget } from '../widgets/SelectWidget';
import { Toggle } from '../widgets/Toggle';
import styles from '../Settings.module.css';

const platform = window.platform;
const i18n = window.i18n;

export function InterfaceTab() {
  const { settingsConfig } = useSettingsStore();
  const currentTheme = localStorage.getItem('hana-theme') || 'auto';
  const serifEnabled = localStorage.getItem('hana-font-serif') !== '0';
  const paperTextureEnabled = localStorage.getItem('hana-paper-texture') === '1';
  const leavesOverlayEnabled = localStorage.getItem('hana-leaves-overlay') === '1';

  const locale = settingsConfig?.locale || 'zh-CN';
  const localeVal = ['zh-CN', 'zh-TW', 'ja', 'ko', 'en'].includes(locale) ? locale
    : locale.startsWith('zh') ? 'zh-CN'
    : locale.startsWith('ja') ? 'ja'
    : locale.startsWith('ko') ? 'ko'
    : 'en';

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
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="interface">
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.appearance.title')}</h2>

        {/* 主题 */}
        <div className={styles['settings-field']}>
          <label className={styles['settings-field-label']}>{t('settings.appearance.theme')}</label>
          <div className={styles['theme-options']}>
            {VALID_THEMES.map(theme => {
              const nameKeys: Record<string, string> = {
                'warm-paper': 'settings.appearance.warmPaper',
                'midnight': 'settings.appearance.midnight',
                'high-contrast': 'settings.appearance.highContrast',
                'grass-aroma': 'settings.appearance.grassAroma',
                'contemplation': 'settings.appearance.contemplation',
                'absolutely': 'settings.appearance.absolutely',
                'delve': 'settings.appearance.delve',
                'deep-think': 'settings.appearance.deepThink',
                'auto': 'settings.appearance.auto',
              };
              const modeKeys: Record<string, string> = {
                'warm-paper': 'settings.appearance.warmPaperMode',
                'midnight': 'settings.appearance.midnightMode',
                'high-contrast': 'settings.appearance.highContrastMode',
                'grass-aroma': 'settings.appearance.grassAromaMode',
                'contemplation': 'settings.appearance.contemplationMode',
                'absolutely': 'settings.appearance.absolutelyMode',
                'delve': 'settings.appearance.delveMode',
                'deep-think': 'settings.appearance.deepThinkMode',
                'auto': 'settings.appearance.autoMode',
              };
              return (
                <button
                  key={theme}
                  className={`${styles['theme-card']}${currentTheme === theme  ? ' ' + styles['active'] : ''}`}
                  data-theme={theme}
                  onClick={() => {
                    setTheme?.(theme);
                    localStorage.setItem('hana-theme', theme);
                    platform?.settingsChanged?.('theme-changed', { theme });
                    // Force re-render for active state
                    useSettingsStore.setState({});
                  }}
                >
                  <div className={styles['theme-card-name']}>{t(nameKeys[theme])}</div>
                  <div className={styles['theme-card-mode']}>{t(modeKeys[theme])}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 衬线体 */}
        <div className={styles['tool-caps-group']}>
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.appearance.serifFont')}</span>
              <span className={styles['tool-caps-desc']}>{t('settings.appearance.serifFontHint')}</span>
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
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.appearance.paperTexture')}</span>
              <span className={styles['tool-caps-desc']}>{t('settings.appearance.paperTextureHint')}</span>
            </div>
            <Toggle
              on={paperTextureEnabled}
              onChange={(next) => {
                (window as any).setPaperTexture?.(next);
                platform?.settingsChanged?.('paper-texture-changed', { enabled: next });
                useSettingsStore.setState({});
              }}
            />
          </div>
          <div className={styles['tool-caps-item']}>
            <div className={styles['tool-caps-label']}>
              <span className={styles['tool-caps-name']}>{t('settings.appearance.leavesOverlay')}</span>
              <span className={styles['tool-caps-desc']}>{t('settings.appearance.leavesOverlayHint')}</span>
            </div>
            <Toggle
              on={leavesOverlayEnabled}
              onChange={(next) => {
                localStorage.setItem('hana-leaves-overlay', next ? '1' : '0');
                window.dispatchEvent(new CustomEvent('hana-settings', {
                  detail: { type: 'leaves-overlay-changed', enabled: next },
                }));
                platform?.settingsChanged?.('leaves-overlay-changed', { enabled: next });
                useSettingsStore.setState({});
              }}
            />
          </div>
        </div>

      </section>

      {/* 语言和地区 */}
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.locale.title')}</h2>

        <div className={styles['settings-row-2col']}>
          <div className={styles['settings-field']}>
            <label className={styles['settings-field-label']}>{t('settings.locale.language')}</label>
            <SelectWidget
              options={[
                { value: 'zh-CN', label: '简体中文' },
                { value: 'zh-TW', label: '繁體中文' },
                { value: 'ja', label: '日本語' },
                { value: 'ko', label: '한국어' },
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
            <span className={styles['settings-field-hint']}>{t('settings.locale.languageHint')}</span>
          </div>
          <div className={styles['settings-field']}>
            <label className={styles['settings-field-label']}>{t('settings.locale.timezone')}</label>
            <SelectWidget
              options={tzOptions}
              value={currentTz}
              onChange={(val) => autoSaveConfig({ timezone: val })}
            />
            <span className={styles['settings-field-hint']}>{t('settings.locale.timezoneHint')}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
